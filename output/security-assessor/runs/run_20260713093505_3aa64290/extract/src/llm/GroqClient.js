import fetch from "node-fetch";
import { createChunkEmitter, readSSE } from "./streamUtils.js";

class GroqClient {
  constructor(config) {
    this.baseUrl = (config.baseUrl || "https://api.groq.com").replace(/\/$/, "");
    this.apiKey = config.apiKey;
    this.defaultModel = config.model || "openai/gpt-oss-120b";
  }

  async chatCompletionsCreate({ model, messages, temperature, max_tokens, onChunk, signal }) {
    const url = `${this.baseUrl}/openai/v1/chat/completions`;
    const headers = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${this.apiKey}`
    };

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
      const err = new Error(`Groq error: ${res.status} ${text}`);
      err.status = res.status;
      throw err;
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
        if (event?.choices?.[0]?.finish_reason) finishReason = event.choices[0].finish_reason;
        if (event?.usage) usage = event.usage;
        if (event?.x_groq?.usage) usage = event.x_groq.usage;
      });
      emitter.flush();

      return {
        choices: [{ message: { content }, finish_reason: finishReason }],
        usage: usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
      };
    }

    const data = await res.json();
    
    // Ensure usage data is present in response (Groq typically returns it)
    if (!data.usage) {
      data.usage = {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0
      };
    }
    
    return data; // OpenAI-compatible shape
  }
}

export default GroqClient;
