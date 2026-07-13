import fetch from "node-fetch";
import { createChunkEmitter, readSSE } from "./streamUtils.js";

function normaliseFinishReason(reason) {
  if (reason === 'max_tokens' || reason === 'length') return 'length';
  return reason || 'stop';
}

class OpenRouterClient {
  constructor(config) {
    this.baseUrl = (config.baseUrl || "https://openrouter.ai/api/v1").replace(/\/$/, "");
    this.apiKey = config.apiKey;
    this.defaultModel = config.model;
    this.site = config.site;
    this.appName = config.appName;
  }

  async chatCompletionsCreate({ model, messages, temperature, max_tokens, onChunk, signal }) {
    const url = `${this.baseUrl}/chat/completions`;
    const headers = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${this.apiKey}`
    };
    if (this.site) headers["HTTP-Referer"] = this.site;
    if (this.appName) headers["X-Title"] = this.appName;

    const body = {
      model: model || this.defaultModel,
      messages,
      temperature,
      max_tokens,
      ...(typeof onChunk === 'function' ? { stream: true, stream_options: { include_usage: true } } : {})
    };

    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal
    });

    if (!res.ok) {
      const text = await res.text();
      const error = new Error(`OpenRouter error: ${res.status} ${text}`);
      error.status = res.status;
      throw error;
    }

    if (typeof onChunk === 'function') {
      const emitter = createChunkEmitter(onChunk);
      let content = '';
      let finishReason = 'stop';
      let usage = null;

      await readSSE(res, async dataText => {
        if (dataText === '[DONE]') return;
        const event = JSON.parse(dataText);
        const text = event?.choices?.[0]?.delta?.content || '';
        if (text) {
          content += text;
          emitter.push(text);
        }
        if (event?.choices?.[0]?.finish_reason) {
          finishReason = normaliseFinishReason(event.choices[0].finish_reason);
        }
        if (event?.usage) usage = event.usage;
      });
      emitter.flush();

      return {
        choices: [{ message: { content }, finish_reason: finishReason }],
        usage: usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
      };
    }

    const data = await res.json();
    // OpenRouter proxies many models (Anthropic, Mistral, Llama, etc.) that may
    // return non-OpenAI finish_reason values. Normalise them so that
    // BaseAgent.askWithSystemPrompt()'s continuation loop triggers correctly.
    if (data?.choices) {
      data.choices = data.choices.map(choice => ({
        ...choice,
        finish_reason: normaliseFinishReason(choice.finish_reason)
      }));
    };

    return {
      ...data,
      usage: data.usage || {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0
      }
    };
  }
}

export default OpenRouterClient;
