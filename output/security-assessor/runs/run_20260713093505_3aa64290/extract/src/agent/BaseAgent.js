import Config from "../config/config.js";
import { getAgentRegistry } from "../a2a/AgentRegistry.js";
import { getMessageRouter } from "../a2a/MessageRouter.js";
import { A2AMessage } from "../a2a/Message.js";
import LLMManager from "../llm/LLMManager.js";
import TokenCategories from "../llm/TokenCategories.js";
import { redactSensitiveText } from "../security/redaction.js";
import { normalizeGeneratedSecretPlaceholders } from "../security/sampleSecretSanitizer.js";

const GENERATED_SSN_PATTERN = /\b(?!000|666|9\d{2})\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g;
const GENERATED_CARD_PATTERN = /\b(?:\d[ -]?){13,19}\b/g;

export function sanitizeGeneratedContinuationChunk(value) {
  return redactSensitiveText(
    normalizeGeneratedSecretPlaceholders(String(value ?? ''), { replaceAllSensitive: true })
      .replace(GENERATED_SSN_PATTERN, '<SSN_PLACEHOLDER>')
      .replace(GENERATED_CARD_PATTERN, '<CARD_NUMBER_PLACEHOLDER>')
  );
}

/**
 * Base Agent Class
 * Provides common functionality for all specialized agents
 * Supports A2A Protocol for agent-to-agent communication
 */
class BaseAgent {
  constructor(config = null, agentId = null, llmManager = null) {
    this.config = config || new Config();

    // A2A Protocol: Agent identification
    this.agentId = agentId || this.constructor.name.replace('Agent', '').toLowerCase() + '-agent';
    this.address = `agent://${this.agentId}`;

    // Store provided LLMManager or initialize lazily
    this._llmManager = llmManager;

    // Initialize with the first available provider
    this.initializeProvider();

    this.conversationHistory = [];
    this.maxRetries = 1; // LLMManager handles retries per provider
    this.initialBackoffMs = 2000;
    this.correlationID = '';

    // A2A Protocol: Initialize registry and router
    this.registry = getAgentRegistry();
    this.router = getMessageRouter();

    // Register message handler
    this.router.registerHandler(this.agentId, (message) => this.handleMessage(message));

  }

  async initializeProvider() {
    try {
      // Use provided LLMManager instance or the global singleton
      const llmManager = this._llmManager || new LLMManager(null, this.config);
      this.client = llmManager;
      this.defaultModel = llmManager.primaryClient?.defaultModel || 'gemini-2.0-flash';
      this.currentProvider = llmManager.getClientKey(llmManager.primaryClient);
      console.log(`✅ Agent ${this.agentId} initialized with LLMManager (Primary: ${this.currentProvider})`);
    } catch (error) {
      console.error(`❌ Error initializing provider for agent ${this.agentId}:`, error);
      throw error;
    }
  }

  /**
   * A2A Protocol: Handle incoming messages from other agents
   * Must be implemented by subclasses for specific message types
   * @param {A2AMessage} message - Incoming A2A message
   * @returns {Promise<A2AMessage>} Response message
   */
  async handleMessage(message) {
    // Default implementation - subclasses should override
    throw new Error(`Agent ${this.agentId} does not implement handleMessage`);
  }

  /**
   * A2A Protocol: Send a message to another agent
   * @param {string} toAgentId - Recipient agent ID
   * @param {string} messageType - Message type (request, notification)
   * @param {object} payload - Message payload
   * @param {object} context - Context from other agents
   * @param {object} options - Options (timeout, awaitResponse)
   * @returns {Promise<A2AMessage|null>} Response message or null
   */
  async sendMessage(toAgentId, messageType, payload, context = {}, options = {}) {
    const message = A2AMessage.createRequest(
      this.agentId,
      toAgentId,
      { type: messageType, ...payload },
      context
    );

    return await this.router.send(message, options);
  }

  /**
   * A2A Protocol: Send a response message
   * @param {string} toAgentId - Original requester agent ID
   * @param {object} payload - Response payload
   * @param {string} requestId - Original request ID
   * @param {object} context - Additional context
   * @returns {Promise<void>}
   */
  async sendResponse(toAgentId, payload, requestId, context = {}) {
    const message = A2AMessage.createResponse(
      this.agentId,
      toAgentId,
      payload,
      requestId,
      context
    );

    await this.router.send(message, { awaitResponse: false });
  }

  /**
   * A2A Protocol: Discover another agent
   * @param {string} agentId - Agent ID to discover
   * @returns {object|null} Agent instance or null
   */
  discoverAgent(agentId) {
    return this.registry.discover(agentId);
  }

  /**
   * A2A Protocol: Get agent metadata
   * @param {string} agentId - Agent ID
   * @returns {object|null} Agent metadata
   */
  getAgentMetadata(agentId) {
    return this.registry.getMetadata(agentId);
  }

  /**
   * A2A Protocol: Register this agent in the registry
   * Should be called after agent is fully initialized
   * @param {object} metadata - Agent metadata
   */
  register(metadata = {}) {
    this.registry.register(this.agentId, this, {
      name: metadata.name || this.agentId,
      description: metadata.description || '',
      capabilities: metadata.capabilities || [],
      ...metadata
    });
  }

  /**
   * Set correlation ID for token tracking across a workflow.
   * @param {string} correlationID
   */
  setCorrelationID(correlationID) {
    this.correlationID = correlationID || '';
  }

  /**
   * Get correlation ID for token tracking.
   * @returns {string}
   */
  getCorrelationID() {
    return this.correlationID || '';
  }

  /**
   * Get token category for this agent. Specialized agents can override this.
   * @returns {string}
   */
  getTokenCategory() {
    return TokenCategories.getCategoryFromAgentType(this.agentId);
  }

  /**
   * Send a prompt to the LLM
   * @param {string} prompt - The user's prompt
   * @param {object} options - Additional options
   * @returns {Promise<string>} The LLM's response
   */
  async ask(prompt, options = {}) {
    const messages = this.buildMessages(prompt);
    const params = {
      model: options.model || this.defaultModel,
      messages,
      temperature: options.temperature ?? this.config.temperature,
      max_tokens: options.maxTokens ?? this.config.maxTokens ?? 16000,
      timeoutMs: options.timeoutMs,
      onChunk: options.onChunk,
      onStreamReset: options.onStreamReset,
      signal: options.signal
    };

    const response = await this.requestWithRetry(params);
    const answer = response.choices[0].message.content;
    this.addToHistory(prompt, answer);
    return answer;
  }

  /**
   * Ask with system prompt.
   * Automatically detects truncation (finish_reason === 'length') and retries
   * with a continuation prompt up to MAX_CONTINUATION_ATTEMPTS times, then
   * stitches all parts together into a single complete response.
   *
   * Why responses get trimmed — root causes this loop defends against:
   *  1. Groq hard cap: 8 192 output tokens per request regardless of max_tokens
   *  2. Gemini MAX_TOKENS finish reason (normalised to 'length' by GeminiClient)
   *  3. Any provider hitting the max_tokens limit on long docs/arch/estimation
   *  4. Architecture, Documentation, Estimation outputs routinely exceed 8 k tokens
   */
  async askWithSystemPrompt(systemPrompt, userPrompt, options = {}) {
    // Increase to 8 continuation attempts for very long outputs
    // (architecture + estimation + documentation can exceed 32 k chars)
    const MAX_CONTINUATION_ATTEMPTS = 8;

    const messages = [
      { role: "system", content: systemPrompt },
      ...this.buildMessages(userPrompt)
    ];

    const params = {
      model: options.model || this.defaultModel,
      messages,
      temperature: options.temperature ?? this.config.temperature,
      max_tokens: options.maxTokens ?? this.config.maxTokens ?? 16000,
      timeoutMs: options.timeoutMs,
      onChunk: options.onChunk,
      onStreamReset: options.onStreamReset,
      signal: options.signal
    };
    console.log(`Requested model: ${params.model} (LLMManager may override per provider)`);

    const response = await this.requestWithRetry(params);
    let answer = response.choices[0].message.content ?? '';
    let finishReason = response.choices[0].finish_reason;

    // ── Continuation loop ────────────────────────────────────────────────────
    // Triggered when finish_reason === 'length' (all providers normalised to this).
    // We send only the LATEST chunk as the assistant turn each time so the context
    // window stays bounded — the full stitched answer is accumulated in `answer`
    // but only the most-recent chunk is passed back to the model.
    const continuationUserPrompt =
      "Your previous response was cut off because you reached the output token limit. " +
      "Continue EXACTLY from where you left off — pick up from the last word or character. " +
      "Do NOT repeat anything already written. Do NOT add any preamble, apology, or heading. " +
      "Just continue the content seamlessly as if never interrupted.";

    // Start from the original messages; we will push only 2 entries per iteration
    // (previous chunk as assistant + continuation prompt) rather than re-spreading
    // the entire array, keeping memory and context-window usage linear.
    const continuationMessages = [...messages];
    let latestChunk = answer; // track the most-recent chunk to feed back
    let continuationAttempt = 0;

    while (
      finishReason === 'length' &&
      continuationAttempt < MAX_CONTINUATION_ATTEMPTS
    ) {
      continuationAttempt++;
      console.warn(
        `⚠️ Response truncated (finish_reason=length). ` +
        `Continuation attempt ${continuationAttempt}/${MAX_CONTINUATION_ATTEMPTS}. ` +
        `Partial length so far: ${answer.length} chars`
      );

      // Push only the latest chunk + continuation prompt — NOT the full accumulated answer.
      continuationMessages.push(
        { role: "assistant", content: sanitizeGeneratedContinuationChunk(latestChunk) },
        { role: "user", content: continuationUserPrompt }
      );

      const continuationParams = {
        ...params,
        messages: continuationMessages,
        // Each continuation gets the full token budget again
        max_tokens: params.max_tokens
      };

      const continuationResponse = await this.requestWithRetry(continuationParams);
      latestChunk = continuationResponse.choices[0].message.content ?? '';
      finishReason = continuationResponse.choices[0].finish_reason;

      // Stitch — add a single space if the split happened mid-word at whitespace
      const needsSpace =
        answer.length > 0 &&
        latestChunk.length > 0 &&
        !/\s$/.test(answer) &&
        !/^\s/.test(latestChunk);

      answer = answer + (needsSpace ? ' ' : '') + latestChunk;
      console.log(
        `✅ Continuation ${continuationAttempt} received. ` +
        `Chunk: ${latestChunk.length} chars. ` +
        `Total: ${answer.length} chars. ` +
        `finish_reason: ${finishReason}`
      );
    }

    if (continuationAttempt >= MAX_CONTINUATION_ATTEMPTS && finishReason === 'length') {
      console.warn(
        `⚠️ Response still truncated after ${MAX_CONTINUATION_ATTEMPTS} continuations ` +
        `(total length: ${answer.length} chars). Consider increasing maxTokens or splitting the prompt.`
      );
    }

    if (continuationAttempt > 0) {
      console.log(
        `✅ Final stitched response: ${answer.length} chars after ${continuationAttempt} continuation(s).`
      );
    }

    this.addToHistory(userPrompt, answer);
    return answer;
  }

  /**
   * Build messages array
   */
  buildMessages(prompt) {
    const messages = [];

    this.conversationHistory.forEach(entry => {
      messages.push({ role: "user", content: entry.prompt });
      messages.push({ role: "assistant", content: entry.answer });
    });

    messages.push({ role: "user", content: prompt });
    return messages;
  }

  /**
   * Add to conversation history
   */
  addToHistory(prompt, answer) {
    this.conversationHistory.push({ prompt, answer });

    if (this.conversationHistory.length > 10) {
      this.conversationHistory.shift();
    }
  }

  /**
   * Clear conversation history
   */
  clearHistory() {
    this.conversationHistory = [];
  }

  /**
   * Get conversation history
   */
  getHistory() {
    return this.conversationHistory;
  }

  /**
   * Internal: Request with retry/backoff on 429/5xx
   */
  /*async requestWithRetry(params) {
    let attempt = 0;
    let lastError;
    let currentProviderIndex = this.providerOrder.findIndex(p => p === this.currentProvider);

    while (attempt <= this.maxRetries) {
      try {
        return await this.client.chatCompletionsCreate(params);
      } catch (error) {
        lastError = error;
        const status = error?.status || error?.response?.status;
        const isRateLimited = status === 429;
        const isServerError = status >= 500 && status < 600;

        // If it's a provider-specific error, try to switch providers
        if (isServerError || isRateLimited) {
          console.warn(`Provider ${this.client.constructor.name} failed, trying next provider...`);
          try {
            await this.initializeProvider(); // This will try the next provider
            // After switching provider, ensure params use the new provider's default model
            if (params && this.defaultModel) {
              params.model = this.defaultModel;
            }
            attempt = 0; // Reset attempt counter for the new provider
            continue;
          } catch (e) {
            // If we couldn't switch providers, continue with normal retry logic
            console.error('Failed to switch providers:', e);
          }
        }

        if (attempt === this.maxRetries) {
          break;
        }

        const backoffMs = this.computeBackoffMs(attempt);
        await this.sleep(backoffMs);
        attempt += 1;
      }
    }

    throw new Error(`LLM request failed after ${this.maxRetries} retries. Last error: ${lastError?.message}`);
  }*/

  async requestWithRetry(params) {
    let attempt = 0;
    let lastError;

    // Ensure LLMManager is initialized as the client
    if (!this.client) {
      await this.initializeProvider();
    }

    // Per-request timeout — prevents silent hangs when a provider stalls.
    // Estimation and documentation prompts are large; 3 minutes per LLM call
    // is generous but catches genuine provider failures vs slow-but-working calls.
    // The continuation loop adds calls on top of this, but each call is bounded.
    const configuredTimeout = Number.parseInt(process.env.LLM_REQUEST_TIMEOUT_MS || '', 10);
    const REQUEST_TIMEOUT_MS = params.timeoutMs || (Number.isFinite(configuredTimeout) && configuredTimeout > 0
      ? configuredTimeout
      : 420_000); // 7 minutes default

    while (attempt <= this.maxRetries) {
      try {
        console.log(`LLM request attempt ${attempt + 1}...`);

        // Ignore late chunks from a timed-out request before a retry begins.
        let requestActive = true;
        let emittedCharacters = 0;
        const abortController = new AbortController();
        const abortFromParent = () => abortController.abort();
        if (params.signal?.aborted) {
          abortController.abort();
        } else if (params.signal) {
          params.signal.addEventListener('abort', abortFromParent, { once: true });
        }
        const requestParams = {
          ...params,
          model: params.model || this.defaultModel,
          signal: abortController.signal,
          ...(typeof params.onChunk === 'function'
            ? {
                onChunk: chunk => {
                  if (!requestActive) return;
                  emittedCharacters += String(chunk || '').length;
                  params.onChunk(chunk);
                }
              }
            : {}),
          ...(typeof params.onStreamReset === 'function'
            ? {
                onStreamReset: () => {
                  if (!requestActive) return;
                  emittedCharacters = 0;
                  params.onStreamReset();
                }
              }
            : {})
        };

        const llmCall = this.client.chatCompletionsCreate(
          requestParams,
          this.getCorrelationID(),
          this.getTokenCategory()
        );

        let timeoutId;
        const timeoutPromise = new Promise((_, reject) => {
          timeoutId = setTimeout(
            () => {
              abortController.abort();
              reject(new Error(`LLM request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`));
            },
            REQUEST_TIMEOUT_MS
          );
        });

        try {
          const result = await Promise.race([llmCall, timeoutPromise]);
          requestActive = false;
          return result;
        } catch (error) {
          requestActive = false;
          if (emittedCharacters > 0 && typeof params.onStreamReset === 'function') {
            params.onStreamReset();
          }
          throw error;
        } finally {
          clearTimeout(timeoutId);
          params.signal?.removeEventListener('abort', abortFromParent);
        }

      } catch (error) {
        lastError = error;
        const status = error?.status || error?.response?.status;
        const isRateLimited = status === 429;
        // Guard against undefined status: only treat as server error when status is a number
        const isServerError = typeof status === 'number' && status >= 500 && status < 600;
        // Retry on rate-limit, server errors, AND network errors (no status code at all).
        // Break immediately only for definitive client errors (4xx except 429).
        const isClientError = typeof status === 'number' && status >= 400 && status < 500 && !isRateLimited;

        if (attempt === this.maxRetries || isClientError) {
          break;
        }

        const backoffMs = this.computeBackoffMs(attempt);
        console.warn(`Transient error (${status}). Retrying in ${backoffMs}ms...`);
        await this.sleep(backoffMs);
        attempt++;
      }
    }

    throw new Error(`LLM request failed after ${this.maxRetries + 1} attempts. Last error: ${lastError?.message || 'Unknown error'}`);
  }

  computeBackoffMs(attempt) {
    const base = this.initialBackoffMs * Math.pow(2, attempt);
    const jitter = Math.floor(Math.random() * 500);
    return base + jitter;
  }

  async sleep(ms) {
    await new Promise(resolve => setTimeout(resolve, ms));
  }
}

export default BaseAgent;
