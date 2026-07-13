# Security Test Report

## Project

MuleGenie

## Date

July 8, 2026

## Summary

Security validation was performed for input misuse guardrails, prompt/output guardrails, downstream generated-output injection controls, tool execution policy, provider secret redaction, token spend/request budget limits, generated artifact validation, authentication, security headers, secure session storage, secret scanning, dependency audit checks, SBOM generation, and final report generation. All local security tests passed. Root and client production dependency audits reported zero vulnerabilities.

## Tests Executed

| Area | Command | Result |
| --- | --- | --- |
| AI/LLM misuse and guardrails | `npm run test:guardrails` | Passed |
| Request budget and denial-of-wallet limits | `npm run test:request-budget` | Passed |
| Tool execution policy | `npm run test:tool-policy` | Passed |
| Artifact validation | `npm run test:artifacts` | Passed |
| Authentication | `npm run test:auth` | Passed |
| Security headers | `npm run test:security-headers` | Passed |
| Secure store | `npm run test:secure-store` | Passed |
| Secret scan | `npm run security:secrets` | Passed |
| Dependency audit | `npm run security:audit` | Passed; zero production vulnerabilities reported |
| SBOM generation | `npm run security:sbom` | Passed |
| Merged Excel security report | `npm run security:report` | Passed |

## Security Test Checklist

| Security Test Task | Details | Status |
| --- | --- | --- |
| AI/LLM misuse guardrails | Blocks prompts that request illegal activity enablement, cyber abuse, sensitive data exposure, or compliance evasion. Allows legitimate compliance prompts such as AML monitoring and suspicious activity reporting. | Passed |
| Prompt injection and agent hijacking guardrails | Blocks attempts to ignore instructions, reveal hidden prompts, expose internal policy, install replacement system/developer instructions, enable developer mode, disable guardrails, or treat untrusted document text as higher-priority instructions. | Passed |
| Downstream generated-output injection guardrails | Blocks generated output that attempts to instruct the next agent/tool/model to ignore validation, override guardrails, treat generated text as system/developer instructions, or write unsafe files/paths. | Passed |
| Unrestricted tool execution prevention | Restricts MCP tool calls to approved tool names and configured MCP server URLs. Validates `publish-raml` project names, file paths, file types, file counts, and payload sizes before execution. | Passed |
| Secret extraction guardrails | Blocks requests asking the app to print, reveal, dump, list, exfiltrate, or send environment variables, API keys, tokens, credentials, or passwords. | Passed |
| Generated secret detection | Blocks generated output containing secret-like values such as API keys, GitHub tokens, AWS access keys, or private key blocks. | Passed |
| Provider API key and secret redaction | Redacts provider API keys, bearer tokens, authorization headers, password/secret/token fields, and private-key blocks before server console logging, progress/model output forwarding, and token usage CSV persistence. | Passed |
| Token spend and request budget limits | Blocks oversized single inputs, excessive total text/token estimates, too many answers/tasks/tools, suspicious repetition, and requests for too many generated items in one run. API JSON bodies are capped before routing. | Passed |
| RAML/Mule hardcoded credential validation | Blocks generated RAML and Mule artifacts with hardcoded credential-like values such as `clientSecret: real-secret-value`, `authToken: real-token-value`, `db.password=superSecret123`, or XML password attributes. | Passed |
| RAML OAuth false-positive handling | Allows safe RAML/OAuth fields such as `accessTokenUri`, `access_token: string`, and `token_type: string` while still blocking real hardcoded secrets. | Passed |
| Unsafe generated file path validation | Blocks unsafe artifact paths such as absolute paths, backslashes, empty paths, or path traversal like `../evil.txt`. | Passed |
| Unsupported generated file type validation | Allows only expected Mule/RAML artifact file types and known project files; rejects unsupported generated file types. | Passed |
| Script markup validation | Blocks generated artifacts containing script markup such as `<script>`. | Passed |
| Artifact size limits | Enforces RAML and Mule artifact file/total size limits to reduce unsafe or excessive generated output. | Passed |
| Authentication tests | Verifies login/session authentication behavior. | Passed |
| Security header tests | Verifies HTTP security headers such as `X-Content-Type-Options`, `X-Frame-Options`, referrer policy, permissions policy, and CSP report-only policy. | Passed |
| Secure store tests | Verifies secure session store behavior. | Passed |
| Secret scan | Scans tracked files for committed secret-like values. Latest run checked 126 tracked files. | Passed |
| Dependency audit | Runs production dependency audit at the configured high-severity threshold. Root and client production audits currently report zero vulnerabilities after the `uuid` override fix. | Passed |
| Supply chain dependency controls | Adds lockfile-based CI installs, fixed npm registry config, GitHub dependency review, Dependabot checks, and SBOM generation. `npm audit` remains a known-vulnerability baseline and does not fully cover typosquatting, poisoned packages, dependency confusion, or package provenance. | Partially covered |
| SBOM generation | Generates CycloneDX dependency inventories at `output/sbom-root.json` and `output/sbom-client.json` with `npm run security:sbom`. | Passed |
| Merged Excel security report | Regenerates `outputs/security-checks/MuleGenie_Master_Security_Report.xlsx` with final control coverage and evidence using `npm run security:report`. | Passed |
| Frontend error handling | Replaced browser `alert()` popups with the in-app error overlay for frontend and backend workflow failures. Confirmed no `alert(` calls remain in `client/src` or `client/build`. | Passed |

## Key Findings

- No hardcoded secrets were detected in tracked files.
- Provider API keys and secret-like values are redacted before server logs, generated output/progress events, and token usage CSV error fields.
- Prompt-injection guardrails now include agent-hijacking patterns from untrusted input, including fake replacement system messages, developer-mode requests, guardrail-disabling instructions, and document-priority escalation.
- Generated-output guardrails now block downstream injection payloads before generated text is stored, emitted, or reused by later workflow steps.
- MCP tool execution is now controlled by a central allowlist and payload policy; arbitrary tool names and untrusted MCP server URLs are blocked.
- Token spend and denial-of-wallet controls now block over-budget requests before any LLM workflow starts.
- AI/LLM misuse guardrails block prompts that ask the app to enable illegal activity, cyber abuse, sensitive data exposure, or compliance evasion.
- Legitimate compliance workflows such as AML transaction monitoring and suspicious activity reporting are allowed.
- Generated artifacts are checked for unsafe paths, unsupported file types, script markup, and hardcoded credential-like values.
- RAML validation allows safe OAuth/RAML placeholder fields while still blocking real hardcoded credential values.
- Authentication checks passed.
- Security header checks passed.
- Secure session store checks passed.
- Root and client production dependency audits reported zero vulnerabilities.
- The previous moderate `uuid` advisory through `exceljs` was remediated by overriding transitive `uuid` to `^11.1.1` without downgrading `exceljs`.
- Supply-chain checks now include CI dependency review, SBOM generation, lockfile-based installs, and fixed npm registry config.
- Supply-chain risk remains partially covered because detecting typosquatting, poisoned packages, malicious maintainers, and dependency confusion requires manual review and/or external tools beyond `npm audit`.

## Fix Applied

RAML artifact validation was updated to avoid false positives for safe RAML fields such as:

- `accessTokenUri`
- `access_token: string`
- `token_type: string`

The validator still blocks unsafe values such as:

- `clientSecret: real-secret-value`
- `authToken: real-token-value`
- `db.password=superSecret123`

Secret redaction was added for:

- Server console output through a startup console wrapper.
- Generated output and progress events through guardrail value sanitization.
- Token usage CSV error fields before persistence.

Request budget controls were added for:

- Oversized single input and total text size.
- Estimated input token budget.
- Too many question answers, documentation answers, RAML tasks, or selected tools.
- Excessive repeated characters or repeated words.
- Prompts asking for too many generated items in one run.
- Explicit JSON body size limit before request routing.

Downstream generated-output injection controls were added for:

- Generated text instructing the next agent/model/tool to ignore validation or bypass guardrails.
- Generated text claiming it should be treated as system/developer or higher-priority instructions.
- Hidden/comment-style injected system/developer directives inside generated content.
- Unsafe generated instructions to write, overwrite, or append sensitive project or filesystem paths.

Tool execution policy controls were added for:

- Allowed MCP tool names.
- Allowed MCP server URLs.
- `publish-raml` project name validation.
- `publish-raml` file path traversal prevention.
- `publish-raml` file type, file count, per-file size, and total payload size limits.

## Verification

Commands completed successfully:

```bash
npm run test:guardrails
npm run test:request-budget
npm run test:tool-policy
npm run test:artifacts
npm run test:auth
npm run test:security-headers
npm run test:secure-store
npm run security:secrets
npm run security:audit
npm run security:sbom
npm run security:report
```

Secret scan result:

```text
Secret scan passed (126 tracked files checked)
```

Dependency audit result:

```text
found 0 vulnerabilities
found 0 vulnerabilities
```

SBOM generation result:

```text
output/sbom-root.json generated successfully (CycloneDX 1.6, 273 components).
output/sbom-client.json generated successfully (CycloneDX 1.6, 1166 components).
```

Merged Excel report result:

```text
outputs/security-checks/MuleGenie_Master_Security_Report.xlsx regenerated successfully.
```

## Conclusion

The application passed the current local security test suite. No production dependency vulnerabilities were reported by the configured audit. Provider API keys and secret-like values are now covered by both blocking guardrails and redaction in log/output persistence paths. Supply-chain dependency risk is partially covered by automated controls and still requires manual or external tool-assisted review for malicious-package scenarios beyond known CVEs.
