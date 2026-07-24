# Security Assessor Process and Coverage

This file documents how the Security Assessor works today, what it covers, and what is still planned. The tool has three main workflows:

1. Package security assessment
2. Runtime prompt guardrail testing
3. Package quality assessment

## Package Security Assessment Process

Use this flow when you want to review an uploaded application package before deployment.

1. Upload the package from the UI.
   - Supported inputs include JAR, WAR, ZIP, TAR, TGZ, wheel, source files, and manifest files.

2. Identify the artifact.
   - Detect artifact type.
   - Calculate SHA-256 hash.
   - Record file name, size, and metadata.

3. Check archive safety.
   - Inspect ZIP/TAR entries before extraction.
   - Block unsafe paths such as `../`, absolute paths, and null bytes.
   - Avoid unsafe archive traversal.

4. Extract and walk files.
   - Extract files into a run-specific output folder.
   - Limit file walking to avoid resource exhaustion.

5. Scan for secrets.
   - Detect API keys, GitHub tokens, AWS keys, bearer tokens, private keys, passwords, and credentialed URLs.
   - Redact sensitive values in evidence and reports.

6. Build dependency inventory.
   - Parse dependency files such as `package.json`, `requirements.txt`, `pyproject.toml`, `pom.xml`, Java manifests, and nested JAR metadata.
   - Generate a component list for reporting.

7. Run known vulnerability checks where available.
   - Run `npm audit` when `package.json` and `package-lock.json` exist.
   - Include nested npm apps such as `client/package.json`.

8. Review certificate and TLS artifacts.
   - Detect certificate, keystore, and private key files.
   - Parse X.509 metadata when OpenSSL can read the file.
   - Flag expired certificates, soon-expiring certificates, weak signatures, and packaged private keys.

9. Generate SBOM.
   - Generate CycloneDX-lite SBOM.
   - Include artifact hash and dependency components.
   - Save as `sbom.json`.

10. Optional LLM security review.
    - Send only redacted assessment metadata to the configured LLM provider.
    - Do not send raw uploaded package content.
    - Add concise risk review and deployment recommendation when LLM is configured.

11. Generate decision and reports.
    - Critical finding: `Blocked`
    - High finding: `Blocked pending security review`
    - Medium finding: `Conditional approval`
    - Low/no major issue: `Approved for dev deployment`
    - Generate Markdown, JSON, Excel, and SBOM downloads.

## Runtime Prompt Guardrail Test Process

Use this flow when a target application is already running and you want to check whether restricted prompts are blocked.

1. Start or deploy the target application.
   - Example target URL: `http://16.16.70.70:5001`

2. Enter runtime test configuration in the UI.
   - Running app URL
   - Prompt endpoint, for example `/api/process`
   - HTTP method
   - Request body template containing `{{prompt}}`
   - Optional headers
   - Expected block signals

3. Choose prompt source.
   - Use built-in `restricted_prompts.json` and `allowed_prompts.json`.
   - Or upload a `.txt`, `.csv`, or `.json` prompt file.

4. Execute prompts one by one.
   - Restricted prompts are expected to be blocked.
   - Allowed prompts can be skipped by default to avoid unnecessary target-app actions.
   - Allowed prompts can be executed only when the endpoint is safe/no-op or intentionally configured for testing.

5. Handle rate limits.
   - Use delay between prompts.
   - Retry prompts that receive HTTP `429`.
   - Respect `Retry-After` when provided by the target API.

6. Evaluate responses.
   - Blocking HTTP statuses such as `400`, `401`, `403`, `406`, `409`, `422`, and `429` count as blocked.
   - Response text is checked for configured block signals such as `blocked`, `warning`, `restricted`, and `policy`.
   - Restricted prompts that return normal success without block signals are marked as failures.

7. Generate runtime guardrail reports.
   - `guardrail-report.xlsx`
   - `guardrail-report.md`
   - `guardrail-report.json`

## Package Quality Assessment Process

Use this flow when you want static code quality checks on an uploaded package.

1. Upload the package from the UI.
   - Supported inputs include ZIP, JAR, WAR, TAR, TGZ, wheel, and source files.

2. Identify and extract the package.
   - Detect package type.
   - Save package into a quality run folder.
   - Extract archives safely.

3. Walk extracted files.
   - Scan source/text files.
   - Skip heavy or generated folders such as `node_modules`, `dist`, `build`, `target`, `.git`, `venv`, and `__pycache__`.

4. Apply static quality rules.
   - Large files over 700 lines.
   - Long lines over 140 characters.
   - `TODO`, `FIXME`, and `HACK` markers.
   - Debug output such as `console.log` and `print`.
   - Empty catch blocks.
   - Too many functions in one JavaScript/TypeScript file.
   - Missing README.
   - Missing tests.
   - Missing JavaScript lock file.

5. Calculate quality score.
   - Critical finding: minus 30
   - High finding: minus 18
   - Medium finding: minus 8
   - Low finding: minus 2

6. Generate quality decision.
   - `Quality gate passed`
   - `Review recommended`
   - `Quality gate failed`

7. Optional LLM quality review.
   - Send redacted static findings and limited redacted code samples to the configured LLM provider.
   - LLM review is optional. Normal quality check works without LLM.

8. Generate quality reports.
   - `quality-report.xlsx`
   - `quality-report.md`
   - `quality-report.json`

## Reports Generated

Security package assessment:

- `report.xlsx`
- `report.md`
- `report.json`
- `sbom.json`

Runtime prompt guardrail test:

- `guardrail-report.xlsx`
- `guardrail-report.md`
- `guardrail-report.json`

Quality assessment:

- `quality-report.xlsx`
- `quality-report.md`
- `quality-report.json`

All run outputs are saved under:

```text
output/security-assessor/runs/<run-id>/
```

## Current Coverage

- Artifact upload and hash metadata.
- Safe archive extraction checks.
- Secret scanning with redaction.
- Dependency inventory.
- Nested npm audit support.
- CycloneDX-lite SBOM.
- Certificate, keystore, and private key checks.
- Runtime prompt guardrail testing against a running app URL.
- Prompt file upload for runtime guardrail testing.
- Rate-limit delay and `429` retry handling for runtime tests.
- Static package quality rules.
- Optional LLM security review when API keys are configured.
- Optional LLM quality review when API keys are configured.
- Markdown, JSON, Excel, and SBOM downloads.
- Readable UI summaries.

## Not Fully Covered Yet

- Java/Maven CVE scanning against a vulnerability database.
- Python package CVE scanning.
- Full SAST.
- Full DAST crawling.
- VirtualBox-based runtime sandbox execution.
- Runtime WebSocket/final-result capture for asynchronous APIs.
- Runtime logs and evidence capture beyond immediate HTTP responses.
- Container image vulnerability scanning.
- License compliance.
- Malware sandboxing.
- Cloud/IAM/Kubernetes configuration checks.
- Authenticated multi-user workflow testing.
- Full business logic security testing.
- Enterprise policy approval workflow.

