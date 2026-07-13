import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const MAX_TEXT_FILE_BYTES = 5 * 1024 * 1024;
const trackedFiles = execFileSync(
  'git',
  ['ls-files', '--cached', '-z'],
  { encoding: 'utf8' }
)
  .split('\0')
  .filter(Boolean);

const secretPatterns = [
  { name: 'Anthropic API key', pattern: /\bsk-ant-api\d{2}-[A-Za-z0-9_-]{20,}\b/g },
  { name: 'OpenAI API key', pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g },
  { name: 'Google API key', pattern: /\bAIza[A-Za-z0-9_-]{30,}\b/g },
  { name: 'GitHub token', pattern: /\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{20,}\b/g },
  { name: 'Slack token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g },
  { name: 'Private key', pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g }
];

const sensitiveEnvAssignment =
  /^[ \t]*([A-Z][A-Z0-9_]*(?:API_KEY|PASSWORD|SECRET|TOKEN|ENCRYPTION_KEY))[ \t]*=[ \t]*([^\r\n]*)$/gm;
const safeExampleValue =
  /^(?:|__REPLACE_ME__|replace_with_.*|your[-_].*|use-a-.*|paste-.*|generated-.*|example-.*|changeme|<.*>|\$\{.*\})$/i;

const findings = [];

function lineForMatch(content, index) {
  const line = content.slice(0, index).split('\n').length;
  const sourceLine = content.split('\n')[line - 1] || '';
  return { line, allowed: sourceLine.includes('secret-scan: allow') };
}

for (const file of trackedFiles) {
  let stats;
  try {
    stats = fs.statSync(file);
  } catch {
    continue;
  }
  if (!stats.isFile() || stats.size > MAX_TEXT_FILE_BYTES) continue;

  const buffer = fs.readFileSync(file);
  if (buffer.includes(0)) continue;
  const content = buffer.toString('utf8');

  for (const { name, pattern } of secretPatterns) {
    pattern.lastIndex = 0;
    for (const match of content.matchAll(pattern)) {
      const location = lineForMatch(content, match.index);
      if (!location.allowed) findings.push({ file, line: location.line, type: name });
    }
  }

  sensitiveEnvAssignment.lastIndex = 0;
  for (const match of content.matchAll(sensitiveEnvAssignment)) {
    const value = match[2].trim().replace(/^['"]|['"]$/g, '');
    if (safeExampleValue.test(value)) continue;
    const location = lineForMatch(content, match.index);
    if (!location.allowed) {
      findings.push({ file, line: location.line, type: `Committed value for ${match[1]}` });
    }
  }
}

if (findings.length) {
  console.error('Potential committed secrets found:');
  for (const finding of findings) {
    console.error(`- ${finding.file}:${finding.line} (${finding.type})`);
  }
  console.error('Remove the value, rotate it if real, and store it in .env.local or a managed secret store.');
  process.exit(1);
}

console.log(`Secret scan passed (${trackedFiles.length} tracked files checked)`);
