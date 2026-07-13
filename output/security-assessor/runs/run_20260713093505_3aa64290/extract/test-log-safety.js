import fs from 'fs';
import path from 'path';
import assert from 'assert';

const root = process.cwd();

const filesToScan = [
  'server/index.js',
  'src/llm/LLMManager.js',
  'src/raml/raml_publishing.js',
  'src/agent/DocumentationAgent.js',
  'src/agent/MuleSoftArchitectureAgent.js',
  'src/documentation/documentation.js'
];

const bannedPatterns = [
  { name: 'server text preview helper', pattern: /\bpreviewText\s*\(/ },
  { name: 'raw input preview field', pattern: /\binputPreview\b/ },
  { name: 'raw answer preview field', pattern: /\banswerPreview\b|\bpreview:\s*\(q\.answer/ },
  { name: 'raw MCP response text preview', pattern: /\btextPreview\b/ },
  { name: 'provider response preview log', pattern: /response preview/i },
  { name: 'raw input substring log', pattern: /Input:\s*\$\{input\.substring/ },
  { name: 'raw socket event data substring log', pattern: /event\.data\.substring\s*\(/ },
  { name: 'raw conversation answer substring log', pattern: /latestConversation\.answer\.substring\s*\(/ },
  { name: 'raw documentation answer log', pattern: /Processing document type answer:',\s*text/ },
  { name: 'raw context-filter question log', pattern: /Question:\s*"\$\{question\.substring/ },
  { name: 'raw follow-up question log', pattern: /Follow-up Q\$\{i\s*\+\s*1\}:\s*\$\{q\}/ },
  { name: 'raw keyword list log', pattern: /extracted keywords:\s*\$\{keywords\.slice/ }
];

const failures = [];

for (const file of filesToScan) {
  const absolutePath = path.join(root, file);
  const source = fs.readFileSync(absolutePath, 'utf8');
  for (const rule of bannedPatterns) {
    if (rule.pattern.test(source)) {
      failures.push(`${file}: ${rule.name}`);
    }
  }
}

assert.deepStrictEqual(failures, [], `Raw prompt/completion logging patterns found:\n${failures.join('\n')}`);

console.log('✅ Log safety checks passed: raw prompt/completion preview patterns are not present.');
