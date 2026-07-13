# Package Security Assessment Report

Run ID: run_20260713031608_94e7bf2d
Generated: 2026-07-13T03:16:08.566503+00:00
Decision: Approved for dev deployment

## Artifact

- File: requirements.txt
- Type: unknown
- Size: 148 bytes
- SHA-256: 1422c1d5f7609bf58f3b87afe560c1d6028f7b19bea262ea09f607d635bff24b

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
| low | 1 |
| info | 0 |

## Low Findings

- Dependency inventory: No dependency manifest was found in the uploaded artifact.

## Dependency Inventory

Total components found: 0

| Ecosystem | Name | Version | Source |
| --- | --- | --- | --- |

## LLM Review

LLM review unavailable: LLM request failed for all configured providers. 

## Deployment Recommendation

No blocking issue was found by the automated checks. Use normal environment-specific validation before release.

## Evidence Files

- JSON report: report.json
- SBOM: sbom.json