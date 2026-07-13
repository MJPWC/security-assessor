# Security Check Steps

## Purpose

Use this guide to run the MuleGenie security checks on any system after the project dependencies are installed.

## Prerequisites

- Node.js and npm are installed.
- Project dependencies are installed with `npm install`.
- Client dependencies are installed with `cd client && npm install`.
- Commands are run from the project root.

## Run Security Checks

Run each security check individually:

```bash
npm run test:guardrails
npm run test:request-budget
npm run test:tool-policy
npm run test:session-access
npm run test:llm-fallback-security
npm run test:log-safety
npm run test:artifacts
npm run test:auth
npm run test:security-headers
npm run test:secure-store
npm run security:secrets
npm run security:audit
npm run security:sbom
npm run security:report
```

Or run all checks and regenerate evidence files in sequence:

```bash
npm run security:check
```

If you only want pass/fail tests without regenerating SBOM/report artifacts, run:

```bash
npm run security:test
```

## Expected Passing Output

Each command should complete with exit code `0`.

Expected success messages:

```text
Guardrail tests passed
Request budget tests passed
Tool policy tests passed
Artifact validation tests passed
Authentication tests passed
Security header tests passed
Secure store tests passed
Secret scan passed
```

The dependency audit should complete without high-severity production vulnerabilities under the configured threshold. Moderate advisories may still be reported and should be reviewed separately.

The SBOM command should generate:

```text
output/sbom-root.json
output/sbom-client.json
```

The report command should regenerate:

```text
outputs/security-checks/MuleGenie_Master_Security_Report.xlsx
```

## What Each Check Covers

| Command | Purpose |
| --- | --- |
| `npm run test:guardrails` | Verifies AI/LLM misuse, prompt/output, secret-leak, prompt-injection, agent-hijacking, downstream generated-output injection, illegal-activity, cyber-abuse, sensitive-data exposure, and compliance-evasion guardrails. |
| `npm run test:request-budget` | Verifies denial-of-wallet and DoS controls for oversized inputs, excessive token estimates, too many answers/tasks/tools, repeated content, and high generated-item counts. |
| `npm run test:tool-policy` | Verifies MCP/tool execution allowlisting, trusted MCP server URL enforcement, and `publish-raml` payload validation. |
| `npm run test:artifacts` | Verifies generated RAML/Mule artifacts block unsafe paths, scripts, unsupported files, and real hardcoded credentials. |
| `npm run test:auth` | Verifies login/session authentication behavior. |
| `npm run test:security-headers` | Verifies important HTTP security headers are configured. |
| `npm run test:secure-store` | Verifies secure session store behavior. |
| `npm run security:secrets` | Scans tracked files for committed secret-like values. |
| `npm run security:audit` | Checks production dependencies for known vulnerabilities at the configured high-severity threshold. |
| `npm run security:sbom` | Generates CycloneDX dependency inventories for the root and client projects under `output/`. |
| `npm run security:report` | Regenerates the merged Excel security report under `outputs/security-checks/`. |
| `npm run security:test` | Runs the local pass/fail security test suite, secret scan, and dependency audit in sequence. |
| `npm run security:check` | Runs `security:test`, regenerates SBOM files, and regenerates the merged Excel security report. |

## Supply Chain Security Notes

`npm audit` is only a baseline known-vulnerability check. It does not fully detect typosquatting, dependency confusion, poisoned packages, suspicious maintainer behavior, malicious install scripts, or compromised package provenance.

The project includes these repeatable supply-chain controls:

- Lockfile installs in CI using `npm ci`.
- Fixed npm registry configuration in `.npmrc`.
- Dependency audit through `npm run security:audit`.
- GitHub dependency review for pull requests.
- Dependabot update checks for root and client npm dependencies.
- SBOM generation through `npm run security:sbom`.
- Full evidence regeneration through `npm run security:check`.

Manual or external tool-assisted review is still required for:

- Reviewing `package-lock.json` changes in pull requests.
- Checking for suspicious new packages or typosquatted names.
- Reviewing package source, maintainer reputation, and release history.
- Deciding whether `npm ci --ignore-scripts` is safe for a given environment.
- Using additional tools such as Socket.dev, Snyk, OSV Scanner, or GitHub Advanced Security when available.

## Provider Secret Leak Controls

The project includes repeatable checks for provider API key and secret leakage:

- `npm run test:guardrails` verifies redaction of provider API keys, bearer tokens, authorization headers, password/secret/token fields, generated output, and progress event values.
- `npm run security:secrets` verifies tracked source files do not contain committed secret-like values.

The redaction control is applied to server console logs, generated output/progress event values, and token usage CSV error fields. External provider dashboards, terminal scrollback from older runs, and third-party observability systems must be reviewed separately if they are used.

## AI/LLM Misuse Guardrails Covered

The guardrail tests block requests that ask the app to help with:

- Illegal activity enablement, such as money laundering, drug trafficking, prohibited-goods transfer, fake KYC, or sanctions evasion.
- Cyber abuse, such as phishing, credential theft, malware, data exfiltration, or bypassing authentication/security controls.
- Unsafe exposure of sensitive data, such as SSNs, cardholder data, PHI, bank account data, or private customer data.
- Compliance evasion, such as hiding transactions from audit logs or bypassing AML, sanctions, fraud, approval, or review controls.
- Secret extraction and prompt injection, such as asking for environment variables, API keys, hidden prompts, or internal instructions.
- Agent hijacking via untrusted input, such as fake replacement system instructions, developer-mode requests, instructions to disable guardrails, or attempts to treat uploaded document text as higher-priority developer/system instructions.
- Downstream generated-output injection, such as generated architecture/RAML/documentation text telling the next agent or tool to ignore validation, bypass guardrails, treat generated text as system/developer instructions, or write unsafe files.

Legitimate compliance-oriented requests remain allowed, such as AML transaction monitoring, suspicious activity reporting, fraud detection, sanctions screening, audit logging, and risk scoring.

## Denial Of Wallet And DoS Controls

The app rejects over-budget requests before starting LLM workflows. Covered controls include:

- Explicit JSON body size limit through `JSON_BODY_LIMIT` with a default of `1mb`.
- Single input character limit through `REQUEST_BUDGET_MAX_INPUT_CHARS`.
- Total request text and estimated input token limits through `REQUEST_BUDGET_MAX_TOTAL_TEXT_CHARS` and `REQUEST_BUDGET_MAX_INPUT_TOKENS`.
- Limits for submitted question answers, documentation answers, RAML tasks, and selected tools.
- Repetition checks for suspicious repeated characters or words.
- Blocking prompts that ask for too many generated items in one run.

Run:

```bash
npm run test:request-budget
```

## Tool Execution Controls

The app does not allow the LLM to freely choose arbitrary tools. MCP calls are checked by a central policy before execution. Covered controls include:

- Allowed tool names only. Current approved tool: `publish-raml`.
- Trusted MCP server URLs only, configured through `MCP_RAML_SERVER_URL`, `MCP_SERVER_URL`, or `MCP_ALLOWED_SERVER_URLS`.
- `publish-raml` project name validation.
- `publish-raml` file path traversal blocking.
- Allowed `publish-raml` file types only: `.raml`, `.yaml`, `.yml`, `.json`.
- File count, per-file size, and total payload size limits.

Run:

```bash
npm run test:tool-policy
```

## If A Check Fails

Review the command output, fix the reported issue, and rerun the failed command. After the fix passes, rerun the full security check sequence before sharing or deploying the code.
