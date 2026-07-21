# Security Assessor Todo and Coverage

## Security Review Todo List

1. Artifact upload and identification
   - Accept JAR, WAR, TAR, TGZ, ZIP, wheel, source, and manifest files.
   - Detect artifact type.
   - Calculate SHA-256 hash.
   - Record file size and metadata.

2. Archive safety check
   - Check ZIP/TAR entries for path traversal.
   - Block unsafe paths such as `../`, absolute paths, and null bytes.
   - Avoid following unsafe symlinks and hardlinks.

3. Secret scanning
   - Scan packaged text files.
   - Detect API keys, GitHub tokens, AWS keys, bearer tokens, private keys, passwords, and credentialed URLs.
   - Redact secrets in evidence and reports.

4. Dependency inventory
   - Parse dependency files.
   - Support `package.json`, `requirements.txt`, `pyproject.toml`, `pom.xml`, Java manifests, and nested JARs.
   - Generate dependency component list.

5. Known vulnerability scan
   - Run `npm audit` when `package.json` and `package-lock.json` exist.
   - Include nested npm apps such as `client/package.json`.
   - Add npm vulnerability findings to the report.

6. SBOM generation
   - Generate CycloneDX-lite SBOM.
   - Include artifact hash and dependency components.
   - Save as `sbom.json`.

7. Certificate and TLS artifact review
   - Detect packaged certificate, keystore, and private key files.
   - Parse X.509 certificate metadata where OpenSSL can read the file.
   - Flag expired certificates, soon-expiring certificates, weak signatures, and packaged private keys.

8. LLM security review
   - Send only redacted assessment metadata to configured LLM provider.
   - Get concise risk review and deployment recommendation.
   - Do not send raw uploaded package content.

9. Decision engine
    - Critical finding: `Blocked`
    - High finding: `Blocked pending security review`
    - Medium finding: `Conditional approval`
    - Low/no major issue: `Approved for dev deployment`

10. Report generation
    - Generate readable on-screen summary.
    - Generate Markdown report.
    - Generate JSON report.
    - Generate Excel report.
    - Generate SBOM file.
    - Provide download links from UI.

## What Our Security Assessor Covers Today

- Artifact upload and hash metadata.
- Safe archive extraction checks.
- Secret scanning with redaction.
- Dependency inventory.
- Nested npm audit support.
- CycloneDX-lite SBOM.
- Certificate, keystore, and private key checks.
- LLM-based security review when API keys are configured.
- Markdown, JSON, Excel, and SBOM downloads.
- Readable UI summary.

## What It Does Not Fully Cover Yet

- Java/Maven CVE scanning against a vulnerability database.
- Python package CVE scanning.
- Full SAST.
- Full DAST crawling.
- VirtualBox-based runtime sandbox execution.
- Runtime prompt guardrail validation against a running app.
- Runtime logs and evidence capture.
- Container image vulnerability scanning.
- License compliance.
- Malware sandboxing.
- Cloud/IAM/Kubernetes configuration checks.
- Authenticated multi-user workflow testing.
- Full business logic security testing.
- Enterprise policy approval workflow.
