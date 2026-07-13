import OpenAI from "openai";
import { createChunkEmitter } from "./streamUtils.js";

class OpenAIClient {
  constructor(config) {
    const openaiConfig = { apiKey: config.apiKey };
    if (config.baseUrl && config.baseUrl !== "https://api.openai.com") {
      openaiConfig.baseURL = config.baseUrl;
    }
    this.client = new OpenAI(openaiConfig);
    this.defaultModel = config.model;
  }

  async chatCompletionsCreate({ model, messages, temperature, max_tokens, onChunk, signal }) {
    if (typeof onChunk === 'function') {
      const stream = await this.client.chat.completions.create(
        {
          model: model || this.defaultModel,
          messages,
          temperature,
          max_tokens,
          stream: true,
          stream_options: { include_usage: true }
        },
        { signal }
      );

      const emitter = createChunkEmitter(onChunk);
      let content = '';
      let finishReason = 'stop';
      let usage = null;

      for await (const part of stream) {
        const text = part?.choices?.[0]?.delta?.content || '';
        if (text) {
          content += text;
          emitter.push(text);
        }
        if (part?.choices?.[0]?.finish_reason) finishReason = part.choices[0].finish_reason;
        if (part?.usage) usage = part.usage;
      }
      emitter.flush();

      return {
        choices: [{ message: { content }, finish_reason: finishReason }],
        usage: usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
      };
    }

    const response = await this.client.chat.completions.create(
      {
        model: model || this.defaultModel,
        messages,
        temperature,
        max_tokens
      },
      { signal }
    );
    
    // Ensure usage data is present in response
    if (!response.usage) {
      response.usage = {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0
      };
    }
    
    return response;
  }
}

export default OpenAIClient;
