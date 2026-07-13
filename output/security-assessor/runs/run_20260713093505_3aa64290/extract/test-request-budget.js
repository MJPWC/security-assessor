import { inspectRequestBudget } from './server/requestBudget.js';

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const normal = inspectRequestBudget({
  input: 'Design a MuleSoft integration for Salesforce to SAP with OAuth, retry policy, and rate limiting.',
  tools: ['diagram', 'raml']
});
assert(normal.allowed, 'Normal request should be allowed');

const hugeInput = inspectRequestBudget({
  input: 'A'.repeat(40_001)
});
assert(!hugeInput.allowed, 'Oversized single input should be blocked');
assert(hugeInput.blockedBy === 'request-budget', 'Oversized input should be blocked by request-budget');

const tooManyAnswers = inspectRequestBudget({
  input: 'Continue architecture',
  questionAnswers: Array.from({ length: 61 }, (_, index) => ({
    question: `Question ${index + 1}`,
    answer: 'Answer'
  }))
});
assert(!tooManyAnswers.allowed, 'Too many question answers should be blocked');

const tooManyCopies = inspectRequestBudget({
  input: 'Generate 100 RAML APIs for this architecture in one run.'
});
assert(!tooManyCopies.allowed, 'Excessive requested generated items should be blocked');

const repeatedNoise = inspectRequestBudget({
  input: 'token '.repeat(1_001)
});
assert(!repeatedNoise.allowed, 'Excessive repeated words should be blocked');

console.log('Request budget tests passed');
