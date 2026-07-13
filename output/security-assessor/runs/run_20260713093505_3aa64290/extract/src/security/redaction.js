const REDACTION = '[REDACTED_SECRET]';

const SECRET_VALUE_PATTERNS = [
  {
    name: 'Anthropic API key',
    pattern: /sk-ant-api[0-9a-z_-]*-[A-Za-z0-9_-]{20,}/gi,
    replacement: '[REDACTED_ANTHROPIC_KEY]'
  },
  {
    name: 'OpenAI API key',
    pattern: /sk-(?:proj|svcacct)?-[A-Za-z0-9_-]{20,}/gi,
    replacement: '[REDACTED_OPENAI_KEY]'
  },
  {
    name: 'GitHub token',
    pattern: /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}\b/g,
    replacement: '[REDACTED_GITHUB_TOKEN]'
  },
  {
    name: 'AWS access key',
    pattern: /\bAKIA[0-9A-Z]{16}\b/g,
    replacement: '[REDACTED_AWS_ACCESS_KEY]'
  },
  {
    name: 'Private key block',
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/gi,
    replacement: '[REDACTED_PRIVATE_KEY]'
  },
  {
    name: 'Bearer token',
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi,
    replacement: 'Bearer [REDACTED_TOKEN]'
  }
];

const SENSITIVE_KEY_PATTERN = /(?:api[_-]?key|apikey|token|secret|password|client[_-]?secret|clientSecret|authorization|x-api-key)/i;
const SENSITIVE_KEY_VALUE_PATTERN = new RegExp(
  String.raw`(\b[\w.-]*(?:api[_-]?key|apikey|token|secret|password|client[_-]?secret|clientSecret|authorization|x-api-key)[\w.-]*\b\s*[:=]\s*["']?)(\$\{[^}]+\}|[^"',\s}]+)`,
  'gi'
);

function redactKeyValuePairs(text) {
  return text.replace(SENSITIVE_KEY_VALUE_PATTERN, (match, prefix, rawValue) => {
    const value = String(rawValue || '').trim();
    if (
      /^\$\{secure::[^}]+\}$/i.test(value) ||
      /^__MULEGENIE_SECURE_PLACEHOLDER_\d+__$/i.test(value) ||
      /^your[_-]/i.test(value) ||
      /^<[^>]+>$/i.test(value) ||
      /^(TODO|TBD|REPLACE_ME|change_me|changeme|REDACTED)$/i.test(value)
    ) {
      return match;
    }
    return `${prefix}${REDACTION}`;
  });
}

export function redactSensitiveText(value) {
  let redacted = String(value ?? '');
  const securePlaceholders = [];
  redacted = redacted.replace(/\$\{secure::[^}]+\}/gi, (match) => {
    const token = `__MULEGENIE_SECURE_PLACEHOLDER_${securePlaceholders.length}__`;
    securePlaceholders.push(match);
    return token;
  });
  for (const { pattern, replacement } of SECRET_VALUE_PATTERNS) {
    redacted = redacted.replace(pattern, replacement);
  }
  redacted = redactKeyValuePairs(redacted);
  securePlaceholders.forEach((placeholder, index) => {
    redacted = redacted.replace(`__MULEGENIE_SECURE_PLACEHOLDER_${index}__`, placeholder);
  });
  return redacted;
}

export function isSensitiveKey(key) {
  return SENSITIVE_KEY_PATTERN.test(String(key || ''));
}

export function redactSensitiveValue(value, seen = new WeakSet()) {
  if (typeof value === 'string') {
    return redactSensitiveText(value);
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactSensitiveText(value.message),
      stack: value.stack ? redactSensitiveText(value.stack) : undefined
    };
  }

  if (Array.isArray(value)) {
    return value.map(item => redactSensitiveValue(item, seen));
  }

  if (value && typeof value === 'object') {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);

    const redacted = {};
    for (const [key, item] of Object.entries(value)) {
      redacted[key] = isSensitiveKey(key) ? REDACTION : redactSensitiveValue(item, seen);
    }
    return redacted;
  }

  return value;
}

export function redactForLog(args) {
  return args.map(arg => redactSensitiveValue(arg));
}
