# Package Security Assessor

This is a Python MVP web app for assessing deployable application packages before they are promoted to an environment.

## What It Checks

- Archive path traversal before extraction.
- Hardcoded secrets in packaged text files.
- Packaged certificate, keystore, and private key review.
- npm, Python, Maven, manifest, and nested JAR dependency inventory.
- `npm audit` for every package folder that has both `package.json` and `package-lock.json`, including nested frontend apps such as `client/`.
- `pip-audit` for Python dependency manifests such as `requirements.txt` and `pyproject.toml` when the `pip-audit` command is installed.
- CycloneDX-lite SBOM generation.
- LLM security review using Security Assessor's local LLM configuration.
- Optional LLM quality review using the same Security Assessor LLM configuration.

The security LLM receives only redacted assessment metadata, not the raw uploaded package contents. Quality LLM review receives static quality findings plus bounded redacted code samples.

## LLM Configuration

Security and quality use the same local LLM client in `llm_client.py`. It loads this app's own config files in this order:

- `.env`
- `.env.local`
- `.envlocal`
- `.env.private`

Put real keys in `.env.local`, `.envlocal`, or `.env.private`:

```env
LLM_PROVIDER=anthropic_gateway

# Gateway Anthropic is tried first.
ANTHROPIC_AUTH_TOKEN=your_gateway_token_here
ANTHROPIC_GATEWAY_BASE_URL=https://your-gateway.example.com
ANTHROPIC_GATEWAY_MODEL=claude-3-7-sonnet-20250219

# Standard Anthropic is used as fallback if the gateway fails.
ANTHROPIC_API_KEY=your_standard_anthropic_key_here
ANTHROPIC_API_BASE_URL=https://api.anthropic.com
ANTHROPIC_MODEL=claude-3-7-sonnet-20250219
```

The committed `.env` is a template. Local override files are ignored by Git.

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
./py app.py
```

Optional setup command:

```bash
./py -m pip install -r requirements.txt
```

The current version uses only the Python standard library, so there are no required packages to install.

Python vulnerability scanning is optional and requires `pip-audit` on the host:

```bash
python3 -m pip install pip-audit
```

## Output

Each run creates files under:

```text
output/security-assessor/runs/<run-id>/
```

Generated files:

- `report.md`
- `report.json`
- `report.xlsx`
- `sbom.json`

## Role In The Security Process

This app owns common pre-deployment checks that can be applied to any uploaded application package. Application-specific runtime behavior tests should stay in the application being tested.

For MuleGenie, that means:

- Security-assessor runs package checks such as dependency audit, package secret scan, SBOM, and deployment report.
- MuleGenie keeps runtime checks such as prompt guardrails, session access, tool policy, request budget, generated artifact validation, log redaction, auth, and security headers.

## Current Scope

This first version is a pre-deployment assessor. It is not a replacement for enterprise SAST, DAST, VM-based runtime testing, malware sandboxing, license compliance, or cloud controls. It gives a repeatable local/security-team workflow that can be extended with those scanners.

## Known Limitations

- Secret scanning and quality checks are currently regex/line-based, not AST-based or data-flow aware.
- Semantically obfuscated secrets, such as string-concatenated keys or values built across multiple files, may be missed.
- Context-dependent code smells can be under-reported or over-reported because the MVP does not fully parse language semantics.
- Findings should be treated as pre-deployment review signals, not as proof of AST-level SAST accuracy.
