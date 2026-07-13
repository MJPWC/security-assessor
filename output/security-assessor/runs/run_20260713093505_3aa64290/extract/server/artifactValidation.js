import path from 'path';
import { scanGeneratedText } from './guardrails.js';
import {
  isGeneratedSecretNonSecretKey,
  isGeneratedSecretPlaceholderValue,
  normalizeGeneratedSecretPlaceholders
} from '../src/security/sampleSecretSanitizer.js';

const MAX_RAML_BYTES = 2 * 1024 * 1024;
const MAX_MULE_FILE_BYTES = 1024 * 1024;
const MAX_MULE_TOTAL_BYTES = 5 * 1024 * 1024;
const MAX_MULE_FILES = 200;

const ALLOWED_EXACT_FILES = new Set([
  '.gitignore',
  '.muleignore',
  '.gitkeep',
  'pom.xml',
  'mule-artifact.json'
]);

const ALLOWED_EXTENSIONS = new Set([
  '.xml',
  '.dwl',
  '.yaml',
  '.yml',
  '.properties',
  '.raml',
  '.json',
  '.md',
  '.txt'
]);

const SECRET_ASSIGNMENT_PATTERN = /^\s*(?!#)(?!\/\/)["']?([\w.-]*(?:password|secret|token|apikey|api-key|clientsecret|client-secret)[\w.-]*)["']?\s*[:=]\s*["']?([^"'\s#]+)["']?/i;
const SECRET_ATTRIBUTE_PATTERN = /\b([\w:-]*(?:password|secret|token|apikey|api-key|clientsecret|client-secret)[\w:-]*)\s*=\s*["']([^"']+)["']/i;

function byteLength(value) {
  return Buffer.byteLength(String(value ?? ''), 'utf8');
}

function isPlaceholderValue(value) {
  return isGeneratedSecretPlaceholderValue(value) || /\}$/.test(String(value || '').trim());
}

function normalizeSecretKey(key) {
  return String(key || '').trim().replace(/^["']|["']$/g, '').toLowerCase();
}

function isNonSecretRamlKey(key) {
  return isGeneratedSecretNonSecretKey(key);
}

function isSchemaTypeValue(value) {
  return /^(string|number|integer|boolean|datetime|date-only|time-only|datetime-only|nil|object|array|file)$/i.test(
    String(value || '').trim()
  );
}

function isHardcodedSecretMatch(match, allowSchemaTypes = false) {
  const [, key, value] = match;
  if (isNonSecretRamlKey(key)) return false;
  if (isPlaceholderValue(value)) return false;
  if (allowSchemaTypes && isSchemaTypeValue(value)) return false;
  return true;
}

function findHardcodedSecret(content) {
  const lines = String(content || '').split(/\r?\n/);
  for (const line of lines) {
    const assignmentMatch = line.match(SECRET_ASSIGNMENT_PATTERN);
    if (assignmentMatch && isHardcodedSecretMatch(assignmentMatch, true)) {
      return 'Artifact appears to contain a hardcoded credential value.';
    }

    const attributeMatch = line.match(SECRET_ATTRIBUTE_PATTERN);
    if (attributeMatch && isHardcodedSecretMatch(attributeMatch)) {
      return 'Artifact appears to contain a hardcoded credential value.';
    }
  }
  return null;
}

function collectContentIssues(content, context) {
  const issues = [];
  const scanned = scanGeneratedText(content);
  if (!scanned.allowed) issues.push(scanned.reason);

  const secretIssue = findHardcodedSecret(content);
  if (secretIssue) issues.push(secretIssue);

  if (/<script\b/i.test(String(content || ''))) {
    issues.push(`${context} contains script markup, which is not allowed in generated artifacts.`);
  }

  return issues;
}

function normalizeArtifactPath(filePath) {
  const raw = String(filePath || '').trim();
  if (!raw || raw.includes('\0') || raw.includes('\\') || path.isAbsolute(raw)) {
    return null;
  }

  const normalized = path.posix.normalize(raw);
  if (
    normalized === '.' ||
    normalized.startsWith('../') ||
    normalized.includes('/../')
  ) {
    return null;
  }

  return normalized;
}

function isAllowedMuleFile(filePath) {
  const basename = path.posix.basename(filePath);
  if (ALLOWED_EXACT_FILES.has(basename)) return true;
  return ALLOWED_EXTENSIONS.has(path.posix.extname(filePath).toLowerCase());
}

export function validateRamlArtifact(content, context = 'RAML artifact') {
  const value = normalizeGeneratedSecretPlaceholders(content, { replaceAllSensitive: true });
  const issues = [];

  if (!value.trim()) {
    issues.push(`${context} is empty.`);
  }

  if (byteLength(value) > MAX_RAML_BYTES) {
    issues.push(`${context} exceeds the ${MAX_RAML_BYTES} byte size limit.`);
  }

  if (!/#%RAML\s+1\.0/i.test(value)) {
    issues.push(`${context} does not contain a RAML 1.0 header.`);
  }

  issues.push(...collectContentIssues(value, context));

  return {
    valid: issues.length === 0,
    value,
    issues
  };
}

export function validateMuleProjectArtifact(project, context = 'Mule project') {
  const issues = [];

  if (!project || typeof project !== 'object' || !Array.isArray(project.files)) {
    return {
      valid: false,
      value: project,
      issues: [`${context} must contain a files array.`]
    };
  }

  if (project.files.length === 0) {
    issues.push(`${context} has no files.`);
  }

  if (project.files.length > MAX_MULE_FILES) {
    issues.push(`${context} exceeds the ${MAX_MULE_FILES} file limit.`);
  }

  let totalBytes = 0;
  const normalizedFiles = [];

  for (const [index, file] of project.files.entries()) {
    const normalizedPath = normalizeArtifactPath(file?.path);
    if (!normalizedPath) {
      issues.push(`${context} contains an unsafe file path at index ${index}.`);
      continue;
    }

    if (!isAllowedMuleFile(normalizedPath)) {
      issues.push(`${context} contains unsupported file type: ${normalizedPath}.`);
    }

    const content = normalizeGeneratedSecretPlaceholders(file?.content);
    const fileBytes = byteLength(content);
    totalBytes += fileBytes;

    if (fileBytes > MAX_MULE_FILE_BYTES) {
      issues.push(`${normalizedPath} exceeds the ${MAX_MULE_FILE_BYTES} byte file limit.`);
    }

    for (const issue of collectContentIssues(content, normalizedPath)) {
      issues.push(`${normalizedPath}: ${issue}`);
    }

    normalizedFiles.push({ ...file, path: normalizedPath, content });
  }

  if (totalBytes > MAX_MULE_TOTAL_BYTES) {
    issues.push(`${context} exceeds the ${MAX_MULE_TOTAL_BYTES} byte total size limit.`);
  }

  return {
    valid: issues.length === 0,
    value: { ...project, files: normalizedFiles },
    issues
  };
}
