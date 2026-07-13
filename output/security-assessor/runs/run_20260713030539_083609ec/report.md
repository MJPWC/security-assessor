# Package Security Assessment Report

Run ID: run_20260713030539_083609ec
Generated: 2026-07-13T03:05:39.026Z
Decision: Approved for dev deployment

## Artifact

- File: package.json
- Type: json
- Size: 474 bytes
- SHA-256: 76fb229fe945186ad8cd4315e55ee9100add6a014f8a108f2c0718fa0c920fae

## Checks Performed

| Security Test Task | Details | Status |
| --- | --- | --- |
| Archive path safety | Blocks path traversal entries before extraction. | Completed |
| Secret scanning | Checks text files for hardcoded keys, tokens, private keys, credentialed URLs, and sensitive assignments. | Completed |
| Dependency inventory | Extracts npm, Python, Maven, manifest, and nested JAR component evidence where present. | Completed |
| Known vulnerability scan | Runs npm audit when a root package-lock.json is available. | Not applicable |
| SBOM generation | Generates a CycloneDX-lite JSON dependency inventory. | Completed |
| LLM security review | Sends only redacted findings metadata to the configured backend LLM. | Completed |

## Finding Summary

| Severity | Count |
| --- | ---: |
| critical | 0 |
| high | 0 |
| medium | 0 |
| low | 0 |
| info | 0 |

## Dependency Inventory

Total components found: 2

| Ecosystem | Name | Version | Source |
| --- | --- | --- | --- |
| npm:dependencies | dotenv | ^16.3.1 | package.json |
| npm:dependencies | express | ^4.22.2 | package.json |


## LLM Review

LLM review unavailable: No LLM provider key configured. Set one of GROQ_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY, or OPENROUTER_API_KEY.

## Deployment Recommendation

No blocking issue was found by the automated checks. Use normal environment-specific validation before release.

## Evidence Files

- JSON report: report.json
- SBOM: sbom.json