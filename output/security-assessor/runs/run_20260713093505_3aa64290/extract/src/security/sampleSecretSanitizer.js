const ASSIGNMENT_PATTERN = /(^|\n)(\s*)(["']?)([\w.-]+)\3(\s*[:=]\s*)(["']?)([^"',\s#}]+)\6/gi;
const QUOTED_ASSIGNMENT_PATTERN = /(^|\n)(\s*)(["']?)([\w.-]+)\3(\s*[:=]\s*)(["'])([^"'\n#]+)\6/gi;
const XML_ATTRIBUTE_PATTERN = /\b([\w:-]*(?:password|secret|token|api[_-]?key|apikey|client[_-]?secret|clientsecret|authorization|x-api-key)[\w:-]*)\s*=\s*(["'])([^"']+)\2/gi;
const DIRECT_INLINE_SENSITIVE_ASSIGNMENT_PATTERN = /(^|[^\w.-])(password|token|secret|api[_-]?key|apikey|client[_-]?secret|clientsecret|authorization|x-api-key)(\s*[:=]\s*)(["']?)([^"',\s#}]+)\4/gi;
const DIRECT_INLINE_QUOTED_SENSITIVE_ASSIGNMENT_PATTERN = /(^|[^\w.-])(password|token|secret|api[_-]?key|apikey|client[_-]?secret|clientsecret|authorization|x-api-key)(\s*[:=]\s*)(["'])([^"'\n#]+)\4/gi;
const INLINE_ASSIGNMENT_PATTERN = /(^|[^\w.-])([\w.-]+)(\s*[:=]\s*)(["']?)([^"',\s#}]+)\4/gi;

const PLACEHOLDER_PATTERNS = [
  /^\$\{[^}]+\}$/,
  /^secure::/i,
  /^your[_-]/i,
  /^__[^_]+__$/i,
  /^<[^>]+>$/,
  /^(TODO|TBD|REPLACE_ME|change_me|changeme|REDACTED)$/i
];

const SAMPLE_VALUE_PATTERNS = [
  /^(?:sample|example|dummy|mock|fake|test|demo)(?:\s|$)/i,
  /^(?:sample|example|dummy|mock|fake|test)[_.:-]/i,
  /[_.:-](?:sample|example|dummy|mock|fake|test)(?:[_.:-]|$)/i,
  /^(?:abc|xyz|test|demo|dev|qa|uat)\d{0,8}$/i,
  /^(?:password|secret|token|apikey|api-key|clientsecret|client-secret)$/i,
  /^\d{1,8}$/
];

function normalizeKey(key) {
  return String(key || '').trim().replace(/^["']|["']$/g, '');
}

function isPlaceholderValue(value) {
  const text = String(value || '').trim();
  if (!text) return true;
  return PLACEHOLDER_PATTERNS.some(pattern => pattern.test(text));
}

function isSampleLikeValue(value) {
  const text = String(value || '').trim();
  if (!text) return false;
  return SAMPLE_VALUE_PATTERNS.some(pattern => pattern.test(text));
}

function isNonSecretKey(key) {
  const normalized = normalizeKey(key).replace(/[-_:.\s]/g, '').toLowerCase();
  return (
    /(?:uri|url)$/.test(normalized) ||
    normalized === 'tokentype' ||
    normalized === 'expiresin'
  );
}

function isSensitiveKey(key) {
  const normalized = normalizeKey(key).replace(/[-_.\s]/g, '').toLowerCase();
  return (
    normalized.includes('apikey') ||
    normalized.includes('token') ||
    normalized.includes('secret') ||
    normalized.includes('password') ||
    normalized.includes('authorization') ||
    normalized.includes('xapikey')
  );
}

function placeholderForKey(key) {
  const normalized = normalizeKey(key)
    .replace(/[^a-z0-9_.-]+/gi, '.')
    .replace(/^\.+|\.+$/g, '')
    .toLowerCase();
  return `\${secure::${normalized || 'secret'}}`;
}

export function normalizeGeneratedSecretPlaceholders(value, options = {}) {
  const replaceAllSensitive = options.replaceAllSensitive === true;
  const quotedLineNormalized = String(value ?? '').replace(
    QUOTED_ASSIGNMENT_PATTERN,
    (match, lineStart, indent, quoteKey, key, separator, quoteValue, rawValue) => {
      if (
        !isSensitiveKey(key) ||
        isNonSecretKey(key) ||
        isPlaceholderValue(rawValue) ||
        (!replaceAllSensitive && !isSampleLikeValue(rawValue))
      ) {
        return match;
      }
      return `${lineStart}${indent}${quoteKey}${key}${quoteKey}${separator}${quoteValue}${placeholderForKey(key)}${quoteValue}`;
    }
  );
  const lineNormalized = quotedLineNormalized.replace(
    ASSIGNMENT_PATTERN,
    (match, lineStart, indent, quoteKey, key, separator, quoteValue, rawValue) => {
      if (
        !isSensitiveKey(key) ||
        isNonSecretKey(key) ||
        isPlaceholderValue(rawValue) ||
        (!replaceAllSensitive && !isSampleLikeValue(rawValue))
      ) {
        return match;
      }
      return `${lineStart}${indent}${quoteKey}${key}${quoteKey}${separator}${quoteValue}${placeholderForKey(key)}${quoteValue}`;
    }
  );
  const directInlineQuotedNormalized = lineNormalized.replace(
    DIRECT_INLINE_QUOTED_SENSITIVE_ASSIGNMENT_PATTERN,
    (match, prefix, key, separator, quoteValue, rawValue) => {
      if (isNonSecretKey(key) || isPlaceholderValue(rawValue) || (!replaceAllSensitive && !isSampleLikeValue(rawValue))) {
        return match;
      }
      return `${prefix}${key}${separator}${quoteValue}${placeholderForKey(key)}${quoteValue}`;
    }
  );
  const directInlineNormalized = directInlineQuotedNormalized.replace(
    DIRECT_INLINE_SENSITIVE_ASSIGNMENT_PATTERN,
    (match, prefix, key, separator, quoteValue, rawValue) => {
      if (isNonSecretKey(key) || isPlaceholderValue(rawValue) || (!replaceAllSensitive && !isSampleLikeValue(rawValue))) {
        return match;
      }
      return `${prefix}${key}${separator}${quoteValue}${placeholderForKey(key)}${quoteValue}`;
    }
  );
  const inlineNormalized = directInlineNormalized.replace(
    INLINE_ASSIGNMENT_PATTERN,
    (match, prefix, key, separator, quoteValue, rawValue) => {
      if (
        !isSensitiveKey(key) ||
        isNonSecretKey(key) ||
        isPlaceholderValue(rawValue) ||
        (!replaceAllSensitive && !isSampleLikeValue(rawValue))
      ) {
        return match;
      }
      return `${prefix}${key}${separator}${quoteValue}${placeholderForKey(key)}${quoteValue}`;
    }
  );
  return inlineNormalized.replace(
    XML_ATTRIBUTE_PATTERN,
    (match, key, quoteValue, rawValue) => {
      if (isNonSecretKey(key) || isPlaceholderValue(rawValue) || (!replaceAllSensitive && !isSampleLikeValue(rawValue))) {
        return match;
      }
      return `${key}=${quoteValue}${placeholderForKey(key)}${quoteValue}`;
    }
  );
}

export function isGeneratedSecretPlaceholderValue(value) {
  return isPlaceholderValue(value);
}

export function isGeneratedSecretNonSecretKey(key) {
  return isNonSecretKey(key);
}
