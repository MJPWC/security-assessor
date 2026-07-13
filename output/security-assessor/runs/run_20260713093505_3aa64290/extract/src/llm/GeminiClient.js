import fetch from "node-fetch";
import { createChunkEmitter, readSSE } from "./streamUtils.js";

class GeminiClient {
  static fallbackClients = [];
  static maxRetries = 1;
  static retryDelay = 1000; // 1 second initial delay
  
  /**
   * Register a fallback client to use when Gemini fails
   * @param {Object} client - The fallback client instance
   * @param {number} priority - Lower number means higher priority
   */
  static registerFallback(client, priority = 10) {
    this.fallbackClients.push({ client, priority });
    // Sort by priority (lower number = higher priority)
    this.fallbackClients.sort((a, b) => a.priority - b.priority);
  }
  constructor(config) {
    this.baseUrl = (config.baseUrl || "https://generativelanguage.googleapis.com").replace(/\/$/, "");
    // Support multiple API keys: config.apiKeys is preferred, fallback to single apiKey
    const keys = Array.isArray(config.apiKeys) && config.apiKeys.length
      ? config.apiKeys
      : (config.apiKey ? [config.apiKey] : []);
    this.apiKeys = keys;
    this.currentKeyIndex = 0;
    this.defaultModel = config.model || "gemini-2.0-flash";
  }

  // Normalize to OpenAI chat.completions.create-like signature
  async chatCompletionsCreate({ model, messages, temperature, max_tokens, onChunk, signal }, retryCount = 0) {
    const useModel = model || this.defaultModel;

    // Pick the current Gemini API key
    if (!this.apiKeys || !this.apiKeys.length) {
      throw new Error("GeminiClient: no API keys configured");
    }
    const keyIndex = Math.min(this.currentKeyIndex, this.apiKeys.length - 1);
    const apiKey = this.apiKeys[keyIndex];
    const operation = typeof onChunk === 'function' ? 'streamGenerateContent' : 'generateContent';
    const streamParam = typeof onChunk === 'function' ? '&alt=sse' : '';
    const url = `${this.baseUrl}/v1beta/models/${encodeURIComponent(useModel)}:${operation}?key=${encodeURIComponent(apiKey)}${streamParam}`;

    // Transform OpenAI-style messages to Gemini contents.
    // Gemini uses systemInstruction for system prompts — NOT a user-role message.
    let systemInstruction = undefined;
    const filteredMessages = (messages || []).filter(m => {
      if (m.role === "system") {
        systemInstruction = (systemInstruction ? systemInstruction + "\n\n" : "") + m.content;
        return false;
      }
      return true;
    });

    const contents = filteredMessages.map(m => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }]
    }));

    const body = {
      contents,
      ...(systemInstruction ? { systemInstruction: { parts: [{ text: systemInstruction }] } } : {}),
      generationConfig: {
        temperature: temperature,
        maxOutputTokens: max_tokens
      }
    };

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal
    });

    if (!res.ok) {
      const text = await res.text();
      const errorData = { status: res.status, message: text };

      const status = res.status;

      // For quota/auth related errors, try the next Gemini key (if any)
      const isKeyExhausted = status === 429 || status === 401 || status === 403;
      if (isKeyExhausted && this.apiKeys.length > 1 && this.currentKeyIndex < this.apiKeys.length - 1) {
        console.warn(`Gemini key at index ${this.currentKeyIndex} failed with status ${status}. Switching to next Gemini key...`);
        this.currentKeyIndex += 1;
        return this.chatCompletionsCreate({ model, messages, temperature, max_tokens, onChunk, signal }, retryCount);
      }

      // If rate limited (429) and we have retries left for the last key
      if (status === 429 && retryCount < GeminiClient.maxRetries) {
        const delay = GeminiClient.retryDelay * Math.pow(2, retryCount);
        console.warn(`Rate limited. Retrying in ${delay}ms (attempt ${retryCount + 1}/${GeminiClient.maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, delay));
        return this.chatCompletionsCreate({ model, messages, temperature, max_tokens, onChunk, signal }, retryCount + 1);
      }

      const err = new Error(`Gemini error: ${status} ${text}`);
      err.status = status;
      err.data = errorData;
      throw err;
    }

    if (typeof onChunk === 'function') {
      const emitter = createChunkEmitter(onChunk);
      let content = '';
      let finishReason = 'stop';
      let usageMetadata = {};

      await readSSE(res, async dataText => {
        const event = JSON.parse(dataText);
        const parts = event?.candidates?.[0]?.content?.parts || [];
        const text = parts.map(part => part.text || '').join('');
        if (text) {
          content += text;
          emitter.push(text);
        }
        if (event?.candidates?.[0]?.finishReason) {
          finishReason = event.candidates[0].finishReason;
        }
        if (event?.usageMetadata) usageMetadata = event.usageMetadata;
      });
      emitter.flush();

      return {
        choices: [{
          message: { content },
          finish_reason: finishReason === 'MAX_TOKENS' ? 'length' : (finishReason || 'stop')
        }],
        usage: {
          prompt_tokens: usageMetadata.promptTokenCount || 0,
          completion_tokens: usageMetadata.candidatesTokenCount || 0,
          total_tokens: (usageMetadata.promptTokenCount || 0) + (usageMetadata.candidatesTokenCount || 0)
        }
      };
    }

    const data = await res.json();

    // Detect truncation: if finishReason is MAX_TOKENS the response was cut off
    const finishReason = data?.candidates?.[0]?.finishReason;
    if (finishReason === 'MAX_TOKENS') {
      console.warn(`⚠️ GeminiClient: response was truncated (finishReason=MAX_TOKENS). Consider increasing maxOutputTokens.`);
    }

    const parts = data?.candidates?.[0]?.content?.parts || [];
    const content = parts.map(p => p.text || "").join("");

    return {
      choices: [
        {
          message: { content },
          // Normalise Gemini's finish reason to the OpenAI convention that
          // BaseAgent.askWithSystemPrompt() watches ('length' = truncated).
          // Gemini returns 'MAX_TOKENS'; OpenAI/Groq return 'length'.
          finish_reason: finishReason === 'MAX_TOKENS' ? 'length' : (finishReason || 'stop')
        }
      ],
      usage: {
        prompt_tokens: data?.usageMetadata?.promptTokenCount || 0,
        completion_tokens: data?.usageMetadata?.candidatesTokenCount || 0,
        total_tokens: (data?.usageMetadata?.promptTokenCount || 0) + (data?.usageMetadata?.candidatesTokenCount || 0)
      }
    };
  }
}

export default GeminiClient;
