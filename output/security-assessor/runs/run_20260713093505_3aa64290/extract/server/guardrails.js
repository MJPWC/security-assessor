import { redactSensitiveValue } from '../src/security/redaction.js';
import { normalizeGeneratedSecretPlaceholders } from '../src/security/sampleSecretSanitizer.js';

const SECRET_PATTERNS = [
  {
    name: 'Anthropic API key',
    pattern: /sk-ant-api[0-9a-z_-]*-[A-Za-z0-9_-]{20,}/i
  },
  {
    name: 'OpenAI API key',
    pattern: /sk-(?:proj|svcacct)?-[A-Za-z0-9_-]{20,}/i
  },
  {
    name: 'GitHub token',
    pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/
  },
  {
    name: 'AWS access key',
    pattern: /\bAKIA[0-9A-Z]{16}\b/
  },
  {
    name: 'private key block',
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/i
  }
];

const PROMPT_LEAK_PATTERNS = [
  /\b(system|developer)\s+prompt\b/i,
  /\bhidden\s+(instructions?|prompt|policy|rules?)\b/i,
  /\binternal\s+(instructions?|prompt|policy|rules?)\b/i,
  /\bignore\s+(all\s+)?(previous|prior)\s+instructions?\b/i,
  /\breveal\s+(your\s+)?(chain[-\s]?of[-\s]?thought|hidden|internal|system|developer)\b/i
];

const AGENT_HIJACK_PATTERNS = [
  /\b(?:disregard|forget|override|bypass|disable|skip)\b[^.\n]{0,120}\b(?:instructions?|rules?|guardrails?|safety|polic(?:y|ies)|system|developer)\b/i,
  /\b(?:you are now|act as|pretend to be|roleplay as)\b[^.\n]{0,120}\b(?:developer mode|jailbreak|unrestricted|uncensored|unfiltered|no[-\s]?policy|no[-\s]?guardrails?)\b/i,
  /\b(?:new|updated|replacement|higher[-\s]?priority)\s+(?:system|developer)\s+(?:prompt|instructions?|message|rules?)\b/i,
  /\b(?:from now on|for the rest of this conversation)\b[^.\n]{0,120}\b(?:ignore|disregard|do not follow|don't follow|bypass|disable)\b/i,
  /\b(?:treat|consider|interpret)\b[^.\n]{0,100}\b(?:following|below|next|document|uploaded content)\b[^.\n]{0,100}\b(?:system|developer)\s+(?:message|instructions?|prompt|rules?)\b/i,
  /\b(?:do not|don't)\b[^.\n]{0,100}\b(?:run|apply|use|follow|enforce)\b[^.\n]{0,100}\b(?:guardrails?|safety|polic(?:y|ies)|validation|security checks?)\b/i,
  /\b(?:respond|answer|output|return)\b[^.\n]{0,120}\b(?:without|with no|ignoring)\b[^.\n]{0,80}\b(?:guardrails?|safety|polic(?:y|ies)|restrictions?|validation)\b/i
];

const DOWNSTREAM_INJECTION_PATTERNS = [
  /\b(?:next|downstream|following|later)\s+(?:agent|model|llm|tool|step|processor)\b[^.\n]{0,160}\b(?:ignore|disregard|override|bypass|disable|skip|do not follow|don't follow)\b[^.\n]{0,100}\b(?:instructions?|rules?|guardrails?|validation|security checks?|policy|policies)\b/i,
  /\b(?:when|before|after)\s+(?:this|the)\s+(?:output|document|architecture|raml|content)\s+(?:is|gets)\s+(?:read|processed|consumed|parsed|used)\b[^.\n]{0,180}\b(?:ignore|disregard|override|bypass|disable|skip|do not validate|don't validate)\b/i,
  /\b(?:this|the)\s+(?:output|document|architecture|raml|content)\s+(?:is|should be|must be)\s+(?:treated|considered|interpreted)\s+as\s+(?:system|developer|higher[-\s]?priority)\s+(?:instructions?|message|prompt|rules?)\b/i,
  /\b(?:instruction|directive|command)\s+for\s+(?:the\s+)?(?:next|downstream|following|later)\s+(?:agent|model|llm|tool|step|processor)\s*:/i,
  /\b(?:write|save|create|append|overwrite|modify)\b[^.\n]{0,220}(?:\/etc\/|~\/|\.ssh\/|\.env\b|package\.json\b|server\/index\.js\b|client\/src\/|scripts?\/|\.github\/workflows\/|\.\.\/)/i,
  /(?:^|\n)\s*(?:system|developer|assistant)\s*:\s*(?:ignore|disregard|override|bypass|disable|skip|you are now|from now on)/i,
  /(?:<!--|#|\/\/|\/\*)\s*(?:system|developer|downstream|next agent)\s*:\s*(?:ignore|disregard|override|bypass|disable|skip|you are now|from now on)/i
];

const SECRET_REQUEST_PATTERNS = [
  /\b(print|show|reveal|dump|list|exfiltrate|expose|return|send)\b[^.\n]{0,120}\b(env|environment variables?|api keys?|tokens?|secrets?|credentials?|passwords?)\b/i,
  /\b(env|environment variables?|api keys?|tokens?|secrets?|credentials?|passwords?)\b[^.\n]{0,120}\b(print|show|reveal|dump|list|exfiltrate|expose|return|send)\b/i
];

const COMPLIANCE_CONTEXT_PATTERN = /\b(?:anti[-\s]?money[-\s]?laundering|aml|fraud detection|fraud prevention|risk scoring|transaction monitoring|suspicious activity|sar|compliance|regulatory|audit(?:ing)?|controlled[-\s]?substance compliance|sanctions screening|kyc verification|identity verification)\b/i;

const ILLEGAL_ACTIVITY_PATTERNS = [
  /\b(?:design|develop|build|create|generate|architect|implement|automate)\b[^.\n]{0,160}\b(?:money laundering|launder(?:ing)? money|drug trafficking|trafficking drugs|(?:transfer|transferring|move|moving|route|routing)\s+drugs?|illegal drugs?|prohibited goods?|smuggling|sanctions evasion|evade sanctions|illegal payment routing|fake kyc|identity fraud|fraudulent transactions?)\b/i,
  /\b(?:money laundering|launder(?:ing)? money|drug trafficking|trafficking drugs|(?:transfer|transferring|move|moving|route|routing)\s+drugs?|illegal drugs?|prohibited goods?|smuggling|sanctions evasion|evade sanctions|illegal payment routing|fake kyc|identity fraud|fraudulent transactions?)\b[^.\n]{0,160}\b(?:workflow|architecture|api|integration|system|pipeline|transfer|route|process|automate|application)\b/i
];

const CYBER_ABUSE_PATTERNS = [
  /\b(?:build|create|generate|write|develop|design|implement)\b[^.\n]{0,160}\b(?:malware|ransomware|phishing|phising|spear[-\s]?phishing|credential theft|keylogger|backdoor|botnet|exploit|payload|data exfiltration|exfiltrate data|bypass authentication|bypass security controls?)\b/i,
  /\b(?:build|create|generate|write|develop|design|implement|automate|send|deliver|distribute)\b[^.\n]{0,180}\b(?:phishing|phising|spear[-\s]?phishing|scam|fraudulent|credential[-\s]?harvesting)\b[^.\n]{0,80}\b(?:emails?|messages?|links?|campaign|api|automation|workflow)\b/i,
  /\b(?:api|automation|workflow|system|service|script|integration)\b[^.\n]{0,120}\b(?:send|deliver|distribute|generate)\b[^.\n]{0,120}\b(?:phishing|phising|spear[-\s]?phishing|scam|fraudulent|credential[-\s]?harvesting)\b[^.\n]{0,80}\b(?:emails?|messages?|links?)\b/i,
  /\b(?:steal|harvest|phish|exfiltrate|bypass|disable)\b[^.\n]{0,120}\b(?:passwords?|credentials?|tokens?|mfa|2fa|authentication|security controls?|audit logs?)\b/i
];

const SENSITIVE_DATA_EXPOSURE_PATTERNS = [
  /\b(?:dump|export|extract|print|show|reveal|send|list)\b[^.\n]{0,120}\b(?:ssn|social security numbers?|credit card numbers?|cardholder data|bank account numbers?|customer pii|patient data|phi|personal health information|private customer data)\b/i,
  /\b(?:ssn|social security numbers?|credit card numbers?|cardholder data|bank account numbers?|customer pii|patient data|phi|personal health information|private customer data)\b[^.\n]{0,120}\b(?:dump|export|extract|print|show|reveal|send|list)\b/i
];

const COMPLIANCE_EVASION_PATTERNS = [
  /\b(?:hide|hides|hiding|bypass|bypasses|evade|evades|disable|disables|remove|removes|avoid|avoids|suppress|suppresses)\b[^.\n]{0,120}\b(?:audit logs?|monitoring|compliance checks?|kyc|aml|sanctions screening|fraud checks?|approval|review)\b/i
];

function compact(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

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

function isDiagramUrl(text) {
  return /^https:\/\/app\.diagrams\.net\/#R/i.test(String(text || '').trim());
}

export function inspectUserInput(value) {
  const text = compact(collectStrings(value).join('\n'));
  if (!text) return { allowed: true };

  const asksForSecrets = SECRET_REQUEST_PATTERNS.some(pattern => pattern.test(text));
  if (asksForSecrets) {
    return {
      allowed: false,
      reason: 'Request appears to ask for secrets, credentials, API keys, tokens, or environment variables.'
    };
  }

  const asksForPromptLeak = PROMPT_LEAK_PATTERNS.some(pattern => pattern.test(text));
  if (asksForPromptLeak) {
    return {
      allowed: false,
      reason: 'Request appears to ask for hidden prompts, internal instructions, or policy text.'
    };
  }

  const asksForAgentHijack = AGENT_HIJACK_PATTERNS.some(pattern => pattern.test(text));
  if (asksForAgentHijack) {
    return {
      allowed: false,
      reason: 'Request appears to contain prompt injection or agent-hijacking instructions.'
    };
  }

  const hasComplianceContext = COMPLIANCE_CONTEXT_PATTERN.test(text);
  const asksForIllegalEnablement = ILLEGAL_ACTIVITY_PATTERNS.some(pattern => pattern.test(text));
  if (asksForIllegalEnablement && !hasComplianceContext) {
    return {
      allowed: false,
      reason: 'Request appears to ask for architecture or automation that enables illegal activity.'
    };
  }

  const asksForCyberAbuse = CYBER_ABUSE_PATTERNS.some(pattern => pattern.test(text));
  if (asksForCyberAbuse) {
    return {
      allowed: false,
      reason: 'Request appears to ask for cyber abuse, credential theft, malware, phishing, or security bypass assistance.'
    };
  }

  const asksForSensitiveDataExposure = SENSITIVE_DATA_EXPOSURE_PATTERNS.some(pattern => pattern.test(text));
  if (asksForSensitiveDataExposure) {
    return {
      allowed: false,
      reason: 'Request appears to ask for unsafe exposure of sensitive personal, financial, or health data.'
    };
  }

  const asksForComplianceEvasion = COMPLIANCE_EVASION_PATTERNS.some(pattern => pattern.test(text));
  if (asksForComplianceEvasion) {
    return {
      allowed: false,
      reason: 'Request appears to ask for bypassing compliance, monitoring, audit, or review controls.'
    };
  }

  return { allowed: true };
}

export function scanGeneratedText(value) {
  const text = String(value ?? '');
  if (!text || isDiagramUrl(text)) return { allowed: true };

  for (const { name, pattern } of SECRET_PATTERNS) {
    if (pattern.test(text)) {
      return {
        allowed: false,
        reason: `Generated output appears to contain a secret-like value (${name}).`
      };
    }
  }

  const promptLeakSignals = PROMPT_LEAK_PATTERNS.filter(pattern => pattern.test(text)).length;
  if (promptLeakSignals >= 2 || /\bI (?:was|am) instructed to\b[^.\n]{0,100}\b(system|developer|hidden)\b/i.test(text)) {
    return {
      allowed: false,
      reason: 'Generated output appears to contain hidden prompt or internal instruction text.'
    };
  }

  const downstreamInjection = DOWNSTREAM_INJECTION_PATTERNS.some(pattern => pattern.test(text));
  if (downstreamInjection) {
    return {
      allowed: false,
      reason: 'Generated output appears to contain instructions that could hijack downstream agents, tools, or file handling.'
    };
  }

  return { allowed: true };
}

export function guardGeneratedValue(value, context = 'generated output') {
  if (typeof value === 'string') {
    const result = scanGeneratedText(value);
    if (!result.allowed) {
      return {
        value: `[Blocked by security guardrails: ${result.reason}]`,
        blocked: true,
        reason: result.reason,
        context
      };
    }
    return { value: redactSensitiveValue(normalizeGeneratedSecretPlaceholders(value)), blocked: false };
  }

  if (Array.isArray(value)) {
    let blocked = false;
    const reasons = [];
    const guarded = value.map((item, index) => {
      const result = guardGeneratedValue(item, `${context}[${index}]`);
      if (result.blocked) {
        blocked = true;
        reasons.push(result.reason);
      }
      return result.value;
    });
    return { value: guarded, blocked, reason: reasons.find(Boolean) };
  }

  if (value && typeof value === 'object') {
    let blocked = false;
    const reasons = [];
    const guarded = {};
    for (const [key, item] of Object.entries(value)) {
      const result = guardGeneratedValue(item, `${context}.${key}`);
      if (result.blocked) {
        blocked = true;
        reasons.push(result.reason);
      }
      guarded[key] = result.value;
    }
    return { value: guarded, blocked, reason: reasons.find(Boolean) };
  }

  return { value: redactSensitiveValue(value), blocked: false };
}

export function guardProgressEvent(event) {
  const guarded = guardGeneratedValue(event, 'progress event');
  return {
    event: guarded.value,
    blocked: guarded.blocked,
    reason: guarded.reason
  };
}
