# Package Security Assessor

This is a Python MVP web app for assessing deployable application packages before they are promoted to an environment.

## What It Checks

- Archive path traversal before extraction.
- Hardcoded secrets in packaged text files.
- npm, Python, Maven, manifest, and nested JAR dependency inventory.
- `npm audit` when a root `package-lock.json` is available.
- CycloneDX-lite SBOM generation.
- LLM security review using the same backend LLM configuration as MuleGenie.

The LLM receives only redacted assessment metadata, not the raw uploaded package contents.

## Run

```bash
py app.py
```

Open:

```text
http://localhost:5050
```

On macOS/Linux you can also run:

```bash
python3 app.py
```

Optional setup command:

```bash
py -m pip install -r requirements.txt
```

The current version uses only the Python standard library, so there are no required packages to install.

## Output

Each run creates files under:

```text
output/security-assessor/runs/<run-id>/
```

Generated files:

- `report.md`
- `report.json`
- `sbom.json`

## Current Scope

This first version is a pre-deployment assessor. It is not a replacement for enterprise SAST, DAST, container image scanning, malware sandboxing, license compliance, or runtime cloud controls. It gives a repeatable local/security-team workflow that can be extended with those scanners.
