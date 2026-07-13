const PLACEHOLDER_PATTERNS = [
  /^\$\{[^}]+\}$/,
  /^your[_-]/i,
  /^example[_-]/i,
  /^sample[_-]/i,
  /^\[[A-Z0-9_ -]+\]$/i,
  /^<[^>]+>$/,
  /^secure::/i,
  /^REDACTED/i
];

const SENSITIVE_ASSIGNMENT_PATTERN = /\b([\w.-]*(?:api[_-]?key|apikey|token|secret|password|client[_-]?secret|clientSecret|authorization|x-api-key)[\w.-]*)\b[^\S\r\n]*[:=][^\S\r\n]*["']?([^"',\s}]{6,})/gi;

const RAML_SCHEMA_TYPE_VALUES = new Set([
  'any',
  'array',
  'boolean',
  'date-only',
  'datetime',
  'datetime-only',
  'file',
  'integer',
  'nil',
  'number',
  'object',
  'string',
  'time-only'
]);

const HIGH_RISK_PATTERNS = [
  {
    type: 'private key',
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/i
  },
  {
    type: 'bearer token',
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/i
  },
  {
    type: 'OpenAI API key',
    pattern: /sk-(?:proj|svcacct)?-[A-Za-z0-9_-]{20,}/i
  },
  {
    type: 'Anthropic API key',
    pattern: /sk-ant-api[0-9a-z_-]*-[A-Za-z0-9_-]{20,}/i
  },
  {
    type: 'GitHub token',
    pattern: /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}\b/i
  },
  {
    type: 'AWS access key',
    pattern: /\bAKIA[0-9A-Z]{16}\b/
  },
  {
    type: 'US SSN',
    pattern: /\b(?!000|666|9\d{2})\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/
  },
  {
    type: 'credentialed connection string',
    pattern: /\b(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|mssql|redis):\/\/[^:\s/@]+:[^@\s]+@/i
  },
  {
    type: 'URL embedded credentials',
    pattern: /\bhttps?:\/\/[^:\s/@]+:[^@\s]+@/i
  }
];

function isPlaceholder(value) {
  const normalized = String(value || '').trim();
  if (!normalized) return true;
  if (normalized.startsWith('${')) return true;
  return PLACEHOLDER_PATTERNS.some(pattern => pattern.test(normalized));
}

function normalizeAssignmentKey(key) {
  return String(key || '').trim().replace(/["']/g, '').replace(/[-_:.\s]/g, '').toLowerCase();
}

function isNonSecretMetadataKey(key) {
  const normalized = normalizeAssignmentKey(key);
  return (
    normalized.endsWith('uri') ||
    normalized.endsWith('url') ||
    ['tokentype', 'granttype', 'expiresin', 'scope', 'scopes'].includes(normalized)
  );
}

function isSchemaTypeValue(value) {
  return RAML_SCHEMA_TYPE_VALUES.has(String(value || '').trim().toLowerCase());
}

function isAuthorizationSchemeOnly(key, value) {
  return normalizeAssignmentKey(key) === 'authorization' && /^(Bearer|Basic|OAuth|JWT)$/i.test(String(value || '').trim());
}

function hasValidLuhnChecksum(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  if (/^(\d)\1+$/.test(digits)) return false;

  let sum = 0;
  let shouldDouble = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index]);
    if (shouldDouble) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    shouldDouble = !shouldDouble;
  }
  return sum % 10 === 0;
}

function findCreditCard(text) {
  const candidates = String(text || '').match(/\b(?:\d[ -]?){13,19}\b/g) || [];
  return candidates.find(candidate => hasValidLuhnChecksum(candidate));
}

function collectText(value, parts = []) {
  if (typeof value === 'string') {
    parts.push(value);
    return parts;
  }

  if (Array.isArray(value)) {
    value.forEach(item => collectText(item, parts));
    return parts;
  }

  if (value && typeof value === 'object') {
    Object.values(value).forEach(item => collectText(item, parts));
  }

  return parts;
}

function inspectText(text) {
  const findings = [];
  const content = String(text || '');

  for (const { type, pattern } of HIGH_RISK_PATTERNS) {
    if (pattern.test(content)) findings.push(type);
  }

  SENSITIVE_ASSIGNMENT_PATTERN.lastIndex = 0;
  let match;
  while ((match = SENSITIVE_ASSIGNMENT_PATTERN.exec(content)) !== null) {
    const key = match[1];
    const value = match[2];
    if (
      !isNonSecretMetadataKey(key) &&
      !isSchemaTypeValue(value) &&
      !isAuthorizationSchemeOnly(key, value) &&
      !isPlaceholder(value)
    ) {
      findings.push(`sensitive ${match[1]} assignment`);
    }
  }

  if (findCreditCard(content)) findings.push('payment card number');

  return findings;
}

export function inspectOutboundLlmPayload(params = {}) {
  const texts = collectText(params.messages || []);
  const findings = [];

  texts.forEach((text, index) => {
    const textFindings = inspectText(text);
    for (const finding of textFindings) {
      findings.push({ messageIndex: index, finding });
    }
  });

  if (findings.length > 0) {
    const summary = [...new Set(findings.map(item => item.finding))].join(', ');
    return {
      allowed: false,
      reason: `Outbound LLM request contains sensitive tenant data: ${summary}.`,
      findings
    };
  }

  return { allowed: true, findings: [] };
}
