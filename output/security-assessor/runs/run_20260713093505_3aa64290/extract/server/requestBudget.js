function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const requestBudgetLimits = {
  maxInputChars: parsePositiveInt(process.env.REQUEST_BUDGET_MAX_INPUT_CHARS, 40_000),
  maxTotalTextChars: parsePositiveInt(process.env.REQUEST_BUDGET_MAX_TOTAL_TEXT_CHARS, 70_000),
  maxEstimatedInputTokens: parsePositiveInt(process.env.REQUEST_BUDGET_MAX_INPUT_TOKENS, 18_000),
  maxQuestionAnswers: parsePositiveInt(process.env.REQUEST_BUDGET_MAX_QUESTION_ANSWERS, 60),
  maxDocQuestionAnswers: parsePositiveInt(process.env.REQUEST_BUDGET_MAX_DOC_QUESTION_ANSWERS, 80),
  maxRamlTasks: parsePositiveInt(process.env.REQUEST_BUDGET_MAX_RAML_TASKS, 50),
  maxTools: parsePositiveInt(process.env.REQUEST_BUDGET_MAX_TOOLS, 20),
  maxRepeatedCharRun: parsePositiveInt(process.env.REQUEST_BUDGET_MAX_REPEATED_CHAR_RUN, 2_000),
  maxRepeatedWordCount: parsePositiveInt(process.env.REQUEST_BUDGET_MAX_REPEATED_WORD_COUNT, 1_000),
  maxRequestedCopies: parsePositiveInt(process.env.REQUEST_BUDGET_MAX_REQUESTED_COPIES, 25)
};

function collectStrings(value, collector = []) {
  if (typeof value === 'string') {
    collector.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, collector);
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectStrings(item, collector);
  }
  return collector;
}

function estimatedTokens(text) {
  return Math.ceil(String(text || '').length / 4);
}

function hasLongRepeatedCharRun(text, limit) {
  const pattern = new RegExp(`(.)\\1{${limit},}`, 's');
  return pattern.test(text);
}

function hasExcessiveRepeatedWord(text, limit) {
  const words = String(text || '').toLowerCase().match(/\b[a-z0-9_-]{2,}\b/g) || [];
  const counts = new Map();
  for (const word of words) {
    const count = (counts.get(word) || 0) + 1;
    if (count > limit) return true;
    counts.set(word, count);
  }
  return false;
}

function requestedCopies(text) {
  const matches = String(text || '').matchAll(/\b(?:repeat|generate|create|write|produce|make)\b[^.\n]{0,80}\b(\d{2,6})\b[^.\n]{0,80}\b(?:times|copies|versions|variants|apis?|files?|documents?|ramls?|endpoints?)\b/gi);
  let max = 0;
  for (const match of matches) {
    max = Math.max(max, Number.parseInt(match[1], 10) || 0);
  }
  return max;
}

function block(reason, details) {
  return {
    allowed: false,
    reason,
    blockedBy: 'request-budget',
    details
  };
}

export function inspectRequestBudget(payload = {}, limits = requestBudgetLimits) {
  const input = String(payload.input || payload.requirements || '');
  const questionAnswers = Array.isArray(payload.questionAnswers) ? payload.questionAnswers : [];
  const docQuestionAnswers = Array.isArray(payload.docQuestionAnswers) ? payload.docQuestionAnswers : [];
  const ramlTasks = Array.isArray(payload.ramlTasks) ? payload.ramlTasks : [];
  const tools = Array.isArray(payload.tools) ? payload.tools : [];
  const allText = collectStrings(payload).join('\n');
  const totalTextChars = allText.length;
  const tokenEstimate = estimatedTokens(allText);

  if (input.length > limits.maxInputChars) {
    return block('Input is too large for a single generation request. Please split it into smaller parts.', {
      inputChars: input.length,
      maxInputChars: limits.maxInputChars
    });
  }

  if (totalTextChars > limits.maxTotalTextChars || tokenEstimate > limits.maxEstimatedInputTokens) {
    return block('Request is too large and could cause excessive token spend. Please reduce the prompt, answers, or attached text.', {
      totalTextChars,
      maxTotalTextChars: limits.maxTotalTextChars,
      estimatedInputTokens: tokenEstimate,
      maxEstimatedInputTokens: limits.maxEstimatedInputTokens
    });
  }

  if (questionAnswers.length > limits.maxQuestionAnswers) {
    return block('Too many question answers were submitted in one request. Please submit a smaller set.', {
      questionAnswers: questionAnswers.length,
      maxQuestionAnswers: limits.maxQuestionAnswers
    });
  }

  if (docQuestionAnswers.length > limits.maxDocQuestionAnswers) {
    return block('Too many documentation answers were submitted in one request. Please submit a smaller set.', {
      docQuestionAnswers: docQuestionAnswers.length,
      maxDocQuestionAnswers: limits.maxDocQuestionAnswers
    });
  }

  if (ramlTasks.length > limits.maxRamlTasks) {
    return block('Too many RAML tasks were submitted in one request. Please reduce the task list.', {
      ramlTasks: ramlTasks.length,
      maxRamlTasks: limits.maxRamlTasks
    });
  }

  if (tools.length > limits.maxTools) {
    return block('Too many tools were selected in one request. Please reduce the tool list.', {
      tools: tools.length,
      maxTools: limits.maxTools
    });
  }

  if (hasLongRepeatedCharRun(allText, limits.maxRepeatedCharRun)) {
    return block('Request contains excessive repeated characters and was blocked to prevent abuse.', {
      maxRepeatedCharRun: limits.maxRepeatedCharRun
    });
  }

  if (hasExcessiveRepeatedWord(allText, limits.maxRepeatedWordCount)) {
    return block('Request contains excessive repeated words and was blocked to prevent abuse.', {
      maxRepeatedWordCount: limits.maxRepeatedWordCount
    });
  }

  const copies = requestedCopies(allText);
  if (copies > limits.maxRequestedCopies) {
    return block('Request asks for too many generated items in one run. Please reduce the count or split the work.', {
      requestedCopies: copies,
      maxRequestedCopies: limits.maxRequestedCopies
    });
  }

  return {
    allowed: true,
    details: {
      inputChars: input.length,
      totalTextChars,
      estimatedInputTokens: tokenEstimate,
      questionAnswers: questionAnswers.length,
      docQuestionAnswers: docQuestionAnswers.length,
      ramlTasks: ramlTasks.length,
      tools: tools.length
    }
  };
}

