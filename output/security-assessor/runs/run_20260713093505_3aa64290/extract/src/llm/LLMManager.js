import GeminiClient from './GeminiClient.js';
import OpenAIClient from './OpenAIClient.js';
import AnthropicClient from './AnthropicClient.js';
import OpenRouterClient from './OpenRouterClient.js';
import GroqClient from './GroqClient.js';
import CSVLogger from './CSVLogger.js';
import Config from '../config/config.js';
import CorrelationIDManager from './CorrelationIDManager.js';
import TokenCategories from './TokenCategories.js';
import { inspectOutboundLlmPayload } from '../security/outboundDataGuard.js';

class LLMManager {
  static instance = null;

  constructor(initialClientConfigs = null, configOverride = null) {
    if (LLMManager.instance && !initialClientConfigs && !configOverride) { // Only return singleton if no custom configs are provided
      return LLMManager.instance;
    }

    this.config = configOverride || new Config();
    this.clients = new Map();
    this.primaryClient = null;
    this.fallbackClients = [];
    this.csvLogger = new CSVLogger();

    this.initializeClients(initialClientConfigs);

    if (!initialClientConfigs && !configOverride) { // Only set as singleton if no custom configs
      LLMManager.instance = this;
    }
  }

  // Refactored to accept custom client configurations
  initializeClients(customClientConfigs = null) {
    // Define clients in the exact fallback order.
    const clientConfigs = customClientConfigs || this.getDefaultClientConfigs();

    // Initialize clients in the specified order
    for (const { key, class: ClientClass, config, priority } of clientConfigs) {
      if (config.apiKey) {
        try {
          const client = new ClientClass(config);
          this.clients.set(key, client);

          if (!this.primaryClient) {
            this.primaryClient = client;
            console.log(`✅ Primary LLM set to: ${key}`);
          } else {
            this.fallbackClients.push({ client, priority, key });
            console.log(`✅ Added fallback LLM: ${key} (priority ${priority})`);
          }
        } catch (error) {
          console.error(`❌ Failed to initialize ${key} client:`, error.message);
        }
      }
    }

    // After all clients are initialized, if Gemini ended up as primary, register all fallbacks
    if (this.primaryClient instanceof GeminiClient && this.fallbackClients.length > 0) {
      console.log('🔗 Registering fallback clients with Gemini...');
      this.fallbackClients
        .sort((a, b) => a.priority - b.priority)
        .forEach(({ client, priority, key: fbKey }) => {
          console.log(`   - ${fbKey} (priority ${priority})`);
          GeminiClient.registerFallback(client, priority);
        });
    }
  }

  // New method to provide default client configurations
  getDefaultClientConfigs() {
    const configs = [
      {
        key: 'anthropic',
        class: AnthropicClient,
        config: {
          apiKey: this.config.anthropicApiKey,
          model: this.config.anthropicModel
        },
        priority: 1
      },
      {
        key: 'groq',
        class: GroqClient,
        config: {
          apiKey: this.config.groqApiKey,
          model: this.config.groqModel
        },
        priority: 2
      },
      {
        key: 'openai',
        class: OpenAIClient,
        config: {
          apiKey: this.config.openaiApiKey,
          model: this.config.openaiModel
        },
        priority: 3
      },
      {
        key: 'gemini',
        class: GeminiClient,
        config: {
          apiKey: this.config.geminiApiKey || (this.config.geminiApiKeys && this.config.geminiApiKeys[0]),
          apiKeys: this.config.geminiApiKeys,
          model: this.config.geminiModel
        },
        priority: 4
      },
      {
        key: 'openrouter',
        class: OpenRouterClient,
        config: {
          apiKey: this.config.openrouterApiKey,
          model: this.config.openrouterModel,
          baseUrl: this.config.openrouterBaseUrl,
          site: this.config.openrouterSite,
          appName: this.config.openrouterAppName
        },
        priority: 5
      },
    ];

    const preferredProvider = this.config.provider;
    const preferredIndex = configs.findIndex(({ key }) => key === preferredProvider);
    if (preferredIndex > 0) {
      const [preferredConfig] = configs.splice(preferredIndex, 1);
      configs.unshift(preferredConfig);
    }

    return configs;
  }

  async chatCompletionsCreate(params, correlationID = '', tokenCategory = 'General') {
    const cloneMessages = (messages = []) => messages.map(message => (
      message && typeof message === 'object' ? { ...message } : message
    ));
    const baseParams = {
      ...params,
      messages: cloneMessages(params.messages || [])
    };
    const createProviderParams = (requestParams, model) => ({
      ...requestParams,
      model,
      messages: cloneMessages(requestParams.messages || [])
    });
    const assertSafeOutboundPayload = (requestParams) => {
      const outboundInspection = inspectOutboundLlmPayload(requestParams);
      if (!outboundInspection.allowed) {
        const error = new Error(outboundInspection.reason);
        error.code = 'OUTBOUND_LLM_DATA_BLOCKED';
        throw error;
      }
    };

    assertSafeOutboundPayload(baseParams);

    const createAttemptParams = (baseParams) => {
      let emittedCharacters = 0;
      const attemptParams = {
        ...baseParams,
        ...(typeof baseParams.onChunk === 'function'
          ? {
              onChunk: chunk => {
                emittedCharacters += String(chunk || '').length;
                baseParams.onChunk(chunk);
              }
            }
          : {})
      };
      return {
        attemptParams,
        resetPartialStream() {
          if (emittedCharacters > 0 && typeof baseParams.onStreamReset === 'function') {
            baseParams.onStreamReset();
          }
          emittedCharacters = 0;
        }
      };
    };

    // Try primary client first
    if (this.primaryClient) {
      const provider = this.getClientKey(this.primaryClient) || 'primary';
      console.log(`🔄 Using LLM provider: ${provider}`);

      try {
        const primaryParams = createProviderParams(baseParams, baseParams.model || this.primaryClient.defaultModel);
        console.log(`🔧 Using model: ${primaryParams.model} for provider: ${provider}`);
        assertSafeOutboundPayload(primaryParams);
        const primaryAttempt = createAttemptParams(primaryParams);
        let result;
        try {
          result = await this.primaryClient.chatCompletionsCreate(primaryAttempt.attemptParams);
        } catch (error) {
          primaryAttempt.resetPartialStream();
          throw error;
        }
        try {
          const contentLength = (result?.choices?.[0]?.message?.content || '').length;
          console.log(`📤 Provider ${provider} response received`, { contentLength });
        } catch (_) { /* noop */ }
        
        // Log token usage
        const userInstLength = baseParams.messages?.reduce((sum, msg) => sum + (msg.content?.length || 0), 0) || 0;
        this.csvLogger.logUsage(provider, primaryParams.model, result, userInstLength, 'success', '', correlationID, tokenCategory);
        
        return result;
      } catch (error) {
        console.error(`❌ ${provider} failed: ${error.message}`);
        if (error.response) {
          console.error('Response status:', error.response.status);
          console.error('Response data:', error.response.data);
        }

        // Fall back for retryable statuses AND authentication errors
        const status = error?.status || error?.response?.status;
        const isRetryable = status === 429 || status === 413 || (status >= 500 && status < 600) || status === 401;
        if (!isRetryable) {
          // Log error
          const userInstLength = baseParams.messages?.reduce((sum, msg) => sum + (msg.content?.length || 0), 0) || 0;
          const model = baseParams.model || this.primaryClient?.defaultModel || 'unknown';
          this.csvLogger.logUsage(provider, model, {}, userInstLength, 'error', error.message, correlationID, tokenCategory);
          throw error; // Stop fallback chain on non-retryable client error
        }
      }
    }

    // Try fallback clients in priority order
    const sortedFallbacks = [...this.fallbackClients].sort((a, b) => a.priority - b.priority);

    for (const { client, key } of sortedFallbacks) {
      let providerAttempts = 0;
      let lastProviderError = null;
      
      // Retry each provider up to 3 times
      while (providerAttempts < 3) {
        providerAttempts++;
        try {
          console.log(`🔄 Trying fallback LLM: ${key} (attempt ${providerAttempts}/3)`);
          // Create a new params object with the client's default model
          const fallbackParams = createProviderParams(baseParams, client.defaultModel);
          console.log(`🔧 Using model: ${fallbackParams.model} for fallback: ${key}`);
          assertSafeOutboundPayload(fallbackParams);
          const fallbackAttempt = createAttemptParams(fallbackParams);
          let result;
          try {
            result = await client.chatCompletionsCreate(fallbackAttempt.attemptParams);
          } catch (error) {
            fallbackAttempt.resetPartialStream();
            throw error;
          }
          try {
            const contentLength = (result?.choices?.[0]?.message?.content || '').length;
            console.log(`📤 Fallback ${key} response received`, { contentLength });
          } catch (_) { /* noop */ }
          
          // Log token usage
          const userInstLength = baseParams.messages?.reduce((sum, msg) => sum + (msg.content?.length || 0), 0) || 0;
          this.csvLogger.logUsage(key, fallbackParams.model, result, userInstLength, 'success', '', correlationID, tokenCategory);
          
          return result;
        } catch (error) {
          lastProviderError = error;
          console.error(`❌ Fallback ${key} failed (attempt ${providerAttempts}/3): ${error.message}`);
          
          // If not the last attempt, add backoff and retry same provider
          if (providerAttempts < 3) {
            const backoffMs = 1000 * providerAttempts; // 1s, 2s, 3s
            console.warn(`Retrying ${key} in ${backoffMs}ms...`);
            await new Promise(resolve => setTimeout(resolve, backoffMs));
            continue; // Retry same provider
          }
        }
      }
      
      // Log the provider failure (after all 3 attempts failed)
      const userInstLength = baseParams.messages?.reduce((sum, msg) => sum + (msg.content?.length || 0), 0) || 0;
      this.csvLogger.logUsage(key, client.defaultModel, {}, userInstLength, 'error', lastProviderError.message, correlationID, tokenCategory);
      
      // After 3 attempts, check if we should stop or continue
      const status = lastProviderError?.status || lastProviderError?.response?.status;
      const isRetryable = status === 429 || status === 413 || (status >= 500 && status < 600) || status === 401;
      if (!isRetryable) {
        throw lastProviderError; // Stop fallback chain on non-retryable client error
      }
      console.log(`🔄 Moving to next LLM provider after ${key} failed 3 times`);
    }

    // Log final failure
    const userInstLength = baseParams.messages?.reduce((sum, msg) => sum + (msg.content?.length || 0), 0) || 0;
    const lastKey = this.fallbackClients.length > 0 ? this.fallbackClients[this.fallbackClients.length - 1].key : 'unknown';
    const lastModel = this.fallbackClients.length > 0 ? this.fallbackClients[this.fallbackClients.length - 1].client.defaultModel : 'unknown';
    this.csvLogger.logUsage(lastKey, lastModel, {}, userInstLength, 'error', 'All LLM providers failed', correlationID, tokenCategory);
    
    throw new Error('All LLM providers failed. Please check your API keys and network connection.');
  }

  // Helper to get client key from the clients map
  getClientKey(client) {
    if (!client) return 'unknown';
    for (const [key, value] of this.clients.entries()) {
      if (value === client) return key;
    }
    return 'unknown';
  }

  static getInstance() {
    if (!LLMManager.instance) {
      LLMManager.instance = new LLMManager();
    }
    return LLMManager.instance;
  }
}

export default LLMManager;
