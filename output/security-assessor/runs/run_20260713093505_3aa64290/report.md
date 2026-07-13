# Package Security Assessment Report

Run ID: run_20260713093505_3aa64290
Generated: 2026-07-13T09:35:06.661999+00:00
Decision: Blocked

## Artifact

- File: muleGenie-security-scan-package.tar.gz
- Type: node-or-python-tarball
- Size: 550080 bytes
- SHA-256: 2e94860cb09b549cd5984db9f0bd6cc134e365c53bb8c8dab2ff4c7a047ffc0f

## Checks Performed

| Security Test Task | Details | Status |
| --- | --- | --- |
| Archive path safety | Blocks path traversal entries before extraction. | Completed |
| Secret scanning | Checks text files for hardcoded keys, tokens, private keys, credentialed URLs, and sensitive assignments. | Completed |
| Dependency inventory | Extracts npm, Python, Maven, manifest, and nested JAR component evidence where present. | Completed |
| Known vulnerability scan | Runs npm audit when a root package-lock.json is available. | Completed |
| SBOM generation | Generates a CycloneDX-lite JSON dependency inventory. | Completed |
| LLM security review | Sends only redacted findings metadata to the configured backend LLM. | Completed |

## Finding Summary

| Severity | Count |
| --- | ---: |
| critical | 2 |
| high | 37 |
| medium | 0 |
| low | 0 |
| info | 0 |

## Critical Findings

- Secret scanning: Anthropic API key detected in packaged text content.
  Evidence: `{"file": "test-guardrails.js", "matchCount": 1, "sample": "[REDACTED_ANTHROPIC_KEY]"}`
- Secret scanning: Private key block detected in packaged text content.
  Evidence: `{"file": "test-guardrails.js", "matchCount": 1, "sample": "[REDACTED_PRIVATE_KEY]"}`

## High Findings

- Secret scanning: Sensitive assignment detected in packaged text content.
  Evidence: `{"file": "test-auth.js", "matchCount": 5, "sample": "APP_AUTH_PASSWORD: [REDACTED_SECRET]"}`
- Secret scanning: Sensitive assignment detected in packaged text content.
  Evidence: `{"file": "test-session-access.js", "matchCount": 9, "sample": "sessionToken: '[REDACTED_SECRET]"}`
- Secret scanning: Bearer token detected in packaged text content.
  Evidence: `{"file": "test-guardrails.js", "matchCount": 3, "sample": "Bearer [REDACTED_TOKEN]"}`
- Secret scanning: Credentialed URL detected in packaged text content.
  Evidence: `{"file": "test-guardrails.js", "matchCount": 1, "sample": "postgres://appuser:realPassword123@"}`
- Secret scanning: Sensitive assignment detected in packaged text content.
  Evidence: `{"file": "test-guardrails.js", "matchCount": 16, "sample": "secretOutput = [REDACTED_SECRET]"}`
- Secret scanning: Bearer token detected in packaged text content.
  Evidence: `{"file": "test-artifact-validation.js", "matchCount": 1, "sample": "Bearer [REDACTED_TOKEN]"}`
- Secret scanning: Sensitive assignment detected in packaged text content.
  Evidence: `{"file": "test-artifact-validation.js", "matchCount": 14, "sample": "repairedGeneratedSecretRaml = [REDACTED_SECRET]"}`
- Secret scanning: Sensitive assignment detected in packaged text content.
  Evidence: `{"file": "README.md", "matchCount": 8, "sample": "ANTHROPIC_API_KEY=[REDACTED_SECRET]"}`
- Secret scanning: Sensitive assignment detected in packaged text content.
  Evidence: `{"file": "SECURITY_VALIDATION_SUBMISSION_REPORT.md", "matchCount": 1, "sample": "client_secret=[REDACTED_SECRET]"}`
- Secret scanning: Sensitive assignment detected in packaged text content.
  Evidence: `{"file": "SECURITY_TEST_REPORT.md", "matchCount": 6, "sample": "clientSecret: [REDACTED_SECRET]"}`
- Secret scanning: Sensitive assignment detected in packaged text content.
  Evidence: `{"file": "server/auth.js", "matchCount": 5, "sample": "password = [REDACTED_SECRET]"}`
- Secret scanning: Sensitive assignment detected in packaged text content.
  Evidence: `{"file": "server/index.js", "matchCount": 16, "sample": "sessionToken: [REDACTED_SECRET]"}`
- Secret scanning: Sensitive assignment detected in packaged text content.
  Evidence: `{"file": "server/guardrails.js", "matchCount": 1, "sample": "asksForSecrets = [REDACTED_SECRET]"}`
- Secret scanning: Sensitive assignment detected in packaged text content.
  Evidence: `{"file": "server/requestBudget.js", "matchCount": 5, "sample": "maxEstimatedInputTokens: [REDACTED_SECRET]"}`
- Secret scanning: Sensitive assignment detected in packaged text content.
  Evidence: `{"file": "server/artifactValidation.js", "matchCount": 3, "sample": "SECRET_ASSIGNMENT_PATTERN = [REDACTED_SECRET]"}`
- Secret scanning: Sensitive assignment detected in packaged text content.
  Evidence: `{"file": "server/tokenUsageParser.js", "matchCount": 3, "sample": "hasTokenCategory: [REDACTED_SECRET]"}`
- Secret scanning: Sensitive assignment detected in packaged text content.
  Evidence: `{"file": "client/src/App.js", "matchCount": 9, "sample": "SESSION_TOKENS_STORAGE_KEY = '[REDACTED_SECRET]"}`
- Secret scanning: Sensitive assignment detected in packaged text content.
  Evidence: `{"file": "client/src/components/TokenUtilizationDashboard.js", "matchCount": 3, "sample": "fetchTokenData = [REDACTED_SECRET]"}`
- Secret scanning: Sensitive assignment detected in packaged text content.
  Evidence: `{"file": "client/src/components/ExpandableTableRow.jsx", "matchCount": 4, "sample": "totalTokens = [REDACTED_SECRET]"}`
- Secret scanning: Sensitive assignment detected in packaged text content.
  Evidence: `{"file": "src/documentation/documentation.js", "matchCount": 7, "sample": "apiKey: [REDACTED_SECRET]"}`
- Secret scanning: Sensitive assignment detected in packaged text content.
  Evidence: `{"file": "src/llm/AnthropicClient.js", "matchCount": 10, "sample": "this.apiKey = [REDACTED_SECRET]"}`
- Secret scanning: Sensitive assignment detected in packaged text content.
  Evidence: `{"file": "src/llm/GroqClient.js", "matchCount": 1, "sample": "this.apiKey = [REDACTED_SECRET]"}`
- Secret scanning: Sensitive assignment detected in packaged text content.
  Evidence: `{"file": "src/llm/OpenRouterClient.js", "matchCount": 1, "sample": "this.apiKey = [REDACTED_SECRET]"}`
- Secret scanning: Sensitive assignment detected in packaged text content.
  Evidence: `{"file": "src/llm/TokenTracker.js", "matchCount": 7, "sample": "promptTokens     = [REDACTED_SECRET]"}`
- Secret scanning: Sensitive assignment detected in packaged text content.
  Evidence: `{"file": "src/llm/OpenAIClient.js", "matchCount": 1, "sample": "apiKey: [REDACTED_SECRET]"}`
- Secret scanning: Sensitive assignment detected in packaged text content.
  Evidence: `{"file": "src/llm/LLMManager.js", "matchCount": 6, "sample": "apiKey: [REDACTED_SECRET]"}`
- Secret scanning: Sensitive assignment detected in packaged text content.
  Evidence: `{"file": "src/llm/GeminiClient.js", "matchCount": 9, "sample": "config.apiKeys\n      : [REDACTED_SECRET]"}`
- Secret scanning: Sensitive assignment detected in packaged text content.
  Evidence: `{"file": "src/config/config.js", "matchCount": 14, "sample": "this.maxTokens = [REDACTED_SECRET]"}`
- Secret scanning: Sensitive assignment detected in packaged text content.
  Evidence: `{"file": "src/config/agentConfigs.js", "matchCount": 7, "sample": "password=[REDACTED_SECRET]"}`
- Secret scanning: Sensitive assignment detected in packaged text content.
  Evidence: `{"file": "src/security/redaction.js", "matchCount": 1, "sample": "token = [REDACTED_SECRET]"}`
- Secret scanning: Sensitive assignment detected in packaged text content.
  Evidence: `{"file": "src/agent/AgentManager.js", "matchCount": 1, "sample": "maxTokens: [REDACTED_SECRET]"}`
- Secret scanning: Sensitive assignment detected in packaged text content.
  Evidence: `{"file": "src/agent/GeneralQnAAgent.js", "matchCount": 1, "sample": "max_tokens: [REDACTED_SECRET]"}`
- Secret scanning: Sensitive assignment detected in packaged text content.
  Evidence: `{"file": "src/agent/MuleSoftArchitectureAgent.js", "matchCount": 5, "sample": "firstToken = [REDACTED_SECRET]"}`
- Secret scanning: Sensitive assignment detected in packaged text content.
  Evidence: `{"file": "src/agent/BaseAgent.js", "matchCount": 3, "sample": "max_tokens: [REDACTED_SECRET]"}`
- Secret scanning: Sensitive assignment detected in packaged text content.
  Evidence: `{"file": "src/agent/EstimationAgent.js", "matchCount": 1, "sample": "maxTokens: [REDACTED_SECRET]"}`
- Secret scanning: Sensitive assignment detected in packaged text content.
  Evidence: `{"file": "src/agent/MuleCodeGenerationAgent.js", "matchCount": 30, "sample": "apiKey: [REDACTED_SECRET]"}`
- Secret scanning: Sensitive assignment detected in packaged text content.
  Evidence: `{"file": "src/agent/DiagramGenerationAgent.js", "matchCount": 6, "sample": "apiKey: [REDACTED_SECRET]"}`

## Dependency Inventory

Total components found: 20

| Ecosystem | Name | Version | Source |
| --- | --- | --- | --- |
| npm:dependencies | @modelcontextprotocol/sdk | ^1.22.0 | package.json |
| npm:dependencies | archiver | ^7.0.1 | package.json |
| npm:dependencies | axios | ^1.7.7 | package.json |
| npm:dependencies | cors | ^2.8.5 | package.json |
| npm:dependencies | dotenv | ^16.3.1 | package.json |
| npm:dependencies | exceljs | ^4.4.0 | package.json |
| npm:dependencies | express | ^4.22.2 | package.json |
| npm:dependencies | fast-xml-parser | ^5.9.3 | package.json |
| npm:dependencies | fs-extra | ^11.1.1 | package.json |
| npm:dependencies | node-fetch | ^3.3.2 | package.json |
| npm:dependencies | openai | ^4.20.0 | package.json |
| npm:dependencies | pdf-parse | ^1.1.1 | package.json |
| npm:dependencies | socket.io | ^4.6.1 | package.json |
| npm:devDependencies | concurrently | ^8.2.2 | package.json |
| npm:dependencies | axios | ^1.6.2 | client/package.json |
| npm:dependencies | exceljs | ^4.4.0 | client/package.json |
| npm:dependencies | react | ^18.2.0 | client/package.json |
| npm:dependencies | react-dom | ^18.2.0 | client/package.json |
| npm:dependencies | socket.io-client | ^4.6.1 | client/package.json |
| npm:devDependencies | react-scripts | ^5.0.1 | client/package.json |

## LLM Review

LLM review unavailable: LLM request failed for all configured providers. 

## Deployment Recommendation

Do not deploy this artifact until the blocking findings are remediated and the assessment is rerun.

## Evidence Files

- JSON report: report.json
- SBOM: sbom.json