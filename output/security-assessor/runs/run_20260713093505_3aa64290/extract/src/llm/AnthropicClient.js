import fetch from "node-fetch";
import { createChunkEmitter, readSSE } from "./streamUtils.js";

class AnthropicClient {
  constructor(config) {
    this.baseUrl = (config.baseUrl || "https://api.anthropic.com").replace(/\/$/, "");
    this.apiKey = config.apiKey;
    this.defaultModel = config.model;
    this.apiVersion = config.apiVersion || "2023-06-01";
  }

  // Normalized to OpenAI chat.completions.create-like signature
  async chatCompletionsCreate({ model, messages, temperature, max_tokens, onChunk, signal }) {
    const url = `${this.baseUrl}/v1/messages`;

    // Transform OpenAI-style messages to Anthropic Messages format.
    // Anthropic accepts system instructions as a top-level field, not as a
    // message role, so preserve system prompts instead of downgrading them to
    // ordinary user text.
    const system = (messages || [])
      .filter(m => m.role === "system" && m.content)
      .map(m => m.content)
      .join("\n\n");

    const anthropicMessages = (messages || [])
      .filter(m => m.role !== "system")
      .map(m => ({
        role: m.role === "assistant" ? "assistant" : "user",
        content: [{ type: "text", text: m.content }]
      }));

    const body = {
      model: model || this.defaultModel,
      max_tokens: max_tokens ?? 800,
      temperature: temperature,
      messages: anthropicMessages,
      ...(typeof onChunk === 'function' ? { stream: true } : {})
    };
    if (system) body.system = system;

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": this.apiVersion
      },
      body: JSON.stringify(body),
      signal
    });

    if (!res.ok) {
      const text = await res.text();
      const err = new Error(`Anthropic error: ${res.status} ${text}`);
      err.status = res.status;
      throw err;
    }

    if (typeof onChunk === 'function') {
      const emitter = createChunkEmitter(onChunk);
      let content = '';
      let stopReason = 'stop';
      let inputTokens = 0;
      let outputTokens = 0;

      await readSSE(res, async dataText => {
        const event = JSON.parse(dataText);
        if (event?.type === 'message_start') {
          inputTokens = event?.message?.usage?.input_tokens || inputTokens;
        }
        if (event?.type === 'content_block_delta' && event?.delta?.type === 'text_delta') {
          const text = event.delta.text || '';
          content += text;
          emitter.push(text);
        }
        if (event?.type === 'message_delta') {
          stopReason = event?.delta?.stop_reason || stopReason;
          outputTokens = event?.usage?.output_tokens || outputTokens;
        }
        if (event?.type === 'error') {
          const err = new Error(event?.error?.message || 'Anthropic streaming error');
          err.status = event?.error?.status;
          throw err;
        }
      });
      emitter.flush();

      return {
        choices: [{
          message: { content },
          finish_reason: stopReason === 'max_tokens' ? 'length' : (stopReason || 'stop')
        }],
        usage: {
          prompt_tokens: inputTokens,
          completion_tokens: outputTokens,
          total_tokens: inputTokens + outputTokens
        }
      };
    }

    const data = await res.json();
    // data.content is an array of blocks; concatenate text blocks
    const content = (data?.content || [])
      .map(block => (block?.text ? block.text : ""))
      .join("");

    // Extract usage data from Anthropic response
    const usage = data?.usage || {};
    const result = {
      choices: [
        {
          message: { content },
          finish_reason: data?.stop_reason === "max_tokens" ? "length" : (data?.stop_reason || "stop")
        }
      ],
      usage: {
        prompt_tokens: usage.input_tokens || 0,
        completion_tokens: usage.output_tokens || 0,
        total_tokens: (usage.input_tokens || 0) + (usage.output_tokens || 0)
      }
    };
    
    return result;
  }
}

export default AnthropicClient;
