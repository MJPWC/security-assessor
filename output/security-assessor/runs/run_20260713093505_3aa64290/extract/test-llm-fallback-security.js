import assert from 'node:assert/strict';
import LLMManager from './src/llm/LLMManager.js';

class MutatingRetryablePrimary {
  constructor() {
    this.defaultModel = 'primary-model';
  }

  async chatCompletionsCreate(params) {
    params.messages[0].content = 'mutated secret SSN 123-45-6789';
    const error = new Error('primary retryable failure');
    error.status = 500;
    throw error;
  }
}

class FallbackRecorder {
  static calls = [];

  constructor() {
    this.defaultModel = 'fallback-model';
  }

  async chatCompletionsCreate(params) {
    FallbackRecorder.calls.push({
      model: params.model,
      messages: params.messages.map(message => ({ ...message }))
    });
    return {
      choices: [{ message: { content: 'fallback success' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
    };
  }
}

class SensitivePrimary {
  static calls = 0;

  constructor() {
    this.defaultModel = 'sensitive-primary';
  }

  async chatCompletionsCreate() {
    SensitivePrimary.calls += 1;
    return {
      choices: [{ message: { content: 'should not happen' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
    };
  }
}

class StreamingFailurePrimary {
  constructor() {
    this.defaultModel = 'stream-primary';
  }

  async chatCompletionsCreate(params) {
    params.onChunk?.('partial unsafe-to-keep');
    const error = new Error('stream interrupted');
    error.status = 500;
    throw error;
  }
}

class StreamingFallback {
  constructor() {
    this.defaultModel = 'stream-fallback';
  }

  async chatCompletionsCreate(params) {
    params.onChunk?.('fallback replacement');
    return {
      choices: [{ message: { content: 'fallback replacement' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
    };
  }
}

const manager = new LLMManager([
  { key: 'primary', class: MutatingRetryablePrimary, config: { apiKey: 'test' }, priority: 1 },
  { key: 'fallback', class: FallbackRecorder, config: { apiKey: 'test' }, priority: 2 }
], {});

const originalMessages = [{ role: 'user', content: 'Design a safe Mule API using placeholders only.' }];
const result = await manager.chatCompletionsCreate({ messages: originalMessages, temperature: 0, max_tokens: 20 });
assert.equal(result.choices[0].message.content, 'fallback success');
assert.equal(originalMessages[0].content, 'Design a safe Mule API using placeholders only.', 'Original caller messages should not be mutated');
assert.equal(FallbackRecorder.calls.length, 1, 'Fallback should be called once');
assert.equal(FallbackRecorder.calls[0].messages[0].content, 'Design a safe Mule API using placeholders only.', 'Fallback should receive the original safe message snapshot');
assert.equal(FallbackRecorder.calls[0].model, 'fallback-model', 'Fallback should use its own default model');

const blockedManager = new LLMManager([
  { key: 'primary', class: SensitivePrimary, config: { apiKey: 'test' }, priority: 1 }
], {});

await assert.rejects(
  () => blockedManager.chatCompletionsCreate({
    messages: [{ role: 'user', content: 'Use customer SSN 123-45-6789 in this prompt.' }],
    temperature: 0,
    max_tokens: 20
  }),
  error => error.code === 'OUTBOUND_LLM_DATA_BLOCKED'
);
assert.equal(SensitivePrimary.calls, 0, 'Sensitive outbound payload should be blocked before any provider call');

const streamManager = new LLMManager([
  { key: 'stream-primary', class: StreamingFailurePrimary, config: { apiKey: 'test' }, priority: 1 },
  { key: 'stream-fallback', class: StreamingFallback, config: { apiKey: 'test' }, priority: 2 }
], {});

const chunks = [];
let resetCount = 0;
const streamResult = await streamManager.chatCompletionsCreate({
  messages: [{ role: 'user', content: 'Generate a safe summary.' }],
  temperature: 0,
  max_tokens: 20,
  onChunk: chunk => chunks.push(chunk),
  onStreamReset: () => {
    resetCount += 1;
    chunks.length = 0;
  }
});

assert.equal(resetCount, 1, 'Partial primary stream should be reset before fallback output');
assert.deepEqual(chunks, ['fallback replacement'], 'Only fallback stream output should remain after reset');
assert.equal(streamResult.choices[0].message.content, 'fallback replacement');

console.log('LLM fallback security tests passed');
