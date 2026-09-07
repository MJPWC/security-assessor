# Build Package Do's and Don'ts

Use this checklist before creating `.tar`, `.tar.gz`, `.zip`, Python wheel, Python sdist, or Node.js package artifacts for security and quality checks.

The goal is simple: upload the smallest complete build artifact that represents what will actually be deployed, without local secrets, temporary files, dependency caches, generated noise, or unrelated source history.

## Golden Rules

Do:

- Build from a clean, committed source tree or a clearly reviewed release folder.
- Include only files required to build, install, run, or assess the application.
- Include dependency manifests and lock files.
- Include README, release notes, configuration templates, and test/CI evidence when available.
- Run tests, linting, dependency checks, and secret checks before packaging.
- Inspect the final archive contents before upload.
- Use `.env.example` or documented placeholder config instead of real `.env` files.
- Use a versioned artifact name, for example `my-app-1.4.2.tar.gz`.

Don't:

- Do not include real secrets, API keys, passwords, tokens, private keys, certificates with private material, or production `.env` files.
- Do not include `.git`, local branches, commit history, or developer-only metadata.
- Do not include `node_modules`, Python virtual environments, cache folders, or downloaded dependency directories unless the deployment process truly needs vendored dependencies.
- Do not include scanner outputs from previous runs, local logs, temp files, debug dumps, or screenshots.
- Do not include unrelated apps, old builds, backups, or copied reference folders.
- Do not package from your home directory or broad parent folder.
- Do not upload artifacts before checking what is inside them.

## Files Usually Required

Python apps:

- `pyproject.toml`, `setup.py`, or `setup.cfg`
- `requirements.txt` or lock file, if used
- application source files
- package modules
- `README.md`
- test files, when the quality check needs test evidence
- config templates such as `.env.example`

Node.js apps:

- `package.json`
- `package-lock.json`, `npm-shrinkwrap.json`, `yarn.lock`, or `pnpm-lock.yaml`
- application source files
- public/static assets required at runtime
- build config files needed by the app
- `README.md`
- test files, when the quality check needs test evidence
- config templates such as `.env.example`

General:

- `Dockerfile` and deployment manifests, if they are part of the release evidence
- CI config, if quality checks need build/test evidence
- license files, notices, and third-party attributions
- migration files required by the application

## Files To Exclude

Always exclude:

```text
.git/
.svn/
.hg/
.DS_Store
Thumbs.db
.env
.env.*
*.pem
*.key
*.p12
*.pfx
*.jks
*.keystore
id_rsa
id_dsa
*.log
*.tmp
*.bak
*.swp
*.swo
coverage/
.coverage
.pytest_cache/
.mypy_cache/
.ruff_cache/
__pycache__/
*.pyc
.venv/
venv/
env/
node_modules/
.npm/
.yarn/cache/
.pnpm-store/
dist/
build/
target/
out/
output/
reports/
```

Exclude `dist/` or `build/` only when you are uploading source for assessment. Include them only when the deployed artifact is specifically a compiled frontend/static build.

## Pre-Build Checks

Run these before creating the artifact.

General:

```bash
git status --short
git ls-files
```

Search for common secrets:

```bash
rg -n "password\s*=|api[_-]?key|secret|token|private key|BEGIN .*PRIVATE KEY" .
```

Python:

```bash
python3 -m pip install -r requirements.txt
python3 -m pytest
python3 -m compileall .
```

If available:

```bash
python3 -m pip_audit
ruff check .
```

Node.js:

```bash
npm ci
npm test
npm run lint
npm audit
```

Use the commands that exist in the project. If a command is missing, note it in the upload comments rather than silently skipping quality evidence.

## Python Wheel And Source Distribution

Recommended build:

```bash
python3 -m pip install --upgrade build
python3 -m build
```

Expected output:

```text
dist/<package>-<version>-py3-none-any.whl
dist/<package>-<version>.tar.gz
```

Inspect before upload:

```bash
python3 -m zipfile --list dist/*.whl
tar -tzf dist/*.tar.gz
```

Python packaging notes:

- Prefer `pyproject.toml` with an explicit package configuration.
- Keep generated files and test cache folders out of the wheel.
- Use `MANIFEST.in` carefully for source distributions.
- Do not include `.env`, private keys, certificates, local SQLite databases, or uploaded user files.
- Include tests in the source distribution if the quality process expects test evidence.
- Do not include virtual environments inside the package.

## Node.js Package Or Tarball

Check what npm would package:

```bash
npm pack --dry-run
```

Create package:

```bash
npm pack
```

Inspect before upload:

```bash
tar -tzf *.tgz
```

Node packaging notes:

- Use the `files` field in `package.json` to allowlist package content.
- Use `.npmignore` when `files` is not enough.
- Keep `package-lock.json` or the relevant lock file for security review.
- Do not include `node_modules`.
- Do not include local `.env` files, debug logs, or prior coverage reports.
- Include compiled `dist/` only when the package is meant to ship compiled output.

Useful `package.json` allowlist example:

```json
{
  "files": [
    "src",
    "public",
    "dist",
    "package.json",
    "package-lock.json",
    "README.md"
  ]
}
```

## Manual Tarball For Upload

Use this when the scanner expects a source or deployment folder archive.

From the application root:

```bash
tar \
  --exclude='.git' \
  --exclude='.env' \
  --exclude='.env.*' \
  --exclude='node_modules' \
  --exclude='venv' \
  --exclude='.venv' \
  --exclude='__pycache__' \
  --exclude='.pytest_cache' \
  --exclude='*.pyc' \
  --exclude='*.log' \
  --exclude='*.tmp' \
  --exclude='*.bak' \
  --exclude='*.pem' \
  --exclude='*.key' \
  --exclude='output' \
  -czf app-upload.tar.gz .
```

Inspect the result:

```bash
tar -tzf app-upload.tar.gz
```

If the list contains secrets, caches, unrelated directories, old artifacts, or previous scanner output, delete the tarball and rebuild it with tighter excludes.

## Manual Zip For Upload

Use this when the scanner requires ZIP.

```bash
zip -r app-upload.zip . \
  -x '.git/*' \
  -x '.env' \
  -x '.env.*' \
  -x 'node_modules/*' \
  -x 'venv/*' \
  -x '.venv/*' \
  -x '__pycache__/*' \
  -x '.pytest_cache/*' \
  -x '*.pyc' \
  -x '*.log' \
  -x '*.tmp' \
  -x '*.bak' \
  -x '*.pem' \
  -x '*.key' \
  -x 'output/*'
```

Inspect the result:

```bash
unzip -l app-upload.zip
```

## Scanner Upload Checklist

Before upload, confirm:

- Artifact opens successfully.
- Archive does not contain unsafe paths such as `../` or absolute paths.
- Archive contains dependency manifests and lock files.
- Archive contains application code needed for assessment.
- Archive does not contain `.git`.
- Archive does not contain `.env` or local config files with real values.
- Archive does not contain private keys such as `.pem`, `.key`, `.p12`, `.pfx`, `.jks`, or `.keystore`.
- Archive does not contain `node_modules`, `.venv`, `venv`, cache folders, or old scanner output.
- Artifact name includes app name and version.
- Checks run before upload are recorded.

## Common Mistakes

- Uploading a whole project folder that includes `.git`, `.env`, and old outputs.
- Building a wheel that accidentally includes test credentials.
- Uploading a Node app without `package-lock.json`, which weakens dependency review.
- Uploading only compiled frontend files when the quality review needs source code.
- Uploading source code when deployment actually ships compiled output only.
- Including sample private keys or test certificates that look real. Even test keys create avoidable security findings.
- Forgetting to inspect the final archive after packaging.

## Recommended Local Workflow

1. Clean the workspace or create a dedicated release folder.
2. Run tests and dependency checks.
3. Search for secrets.
4. Build the wheel, npm package, tarball, or zip.
5. List archive contents.
6. Rebuild if anything unnecessary or sensitive is present.
7. Upload only the final reviewed artifact.
