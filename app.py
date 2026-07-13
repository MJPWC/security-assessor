#!/usr/bin/env python3
import base64
import hashlib
import json
import os
import re
import shutil
import subprocess
import tarfile
import urllib.error
import urllib.request
import uuid
import zipfile
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

APP_DIR = Path(__file__).resolve().parent
PUBLIC_DIR = APP_DIR / "public"
RUNS_DIR = APP_DIR / "output" / "security-assessor" / "runs"
PORT = int(os.getenv("SECURITY_ASSESSOR_PORT", "5050"))
MAX_UPLOAD_BYTES = int(os.getenv("SECURITY_ASSESSOR_MAX_UPLOAD_BYTES", str(50 * 1024 * 1024)))
TEXT_FILE_LIMIT_BYTES = int(os.getenv("SECURITY_ASSESSOR_TEXT_FILE_LIMIT_BYTES", str(512 * 1024)))
MAX_WALK_FILES = int(os.getenv("SECURITY_ASSESSOR_MAX_WALK_FILES", "3000"))

TEXT_EXTENSIONS = {
    ".js", ".jsx", ".ts", ".tsx", ".json", ".yaml", ".yml", ".xml", ".properties",
    ".env", ".txt", ".md", ".py", ".java", ".gradle", ".pom", ".lock", ".toml",
    ".ini", ".conf", ".cfg", ".sh", ".bat", ".ps1", ".sql", ".raml", ".html", ".css",
}

SECRET_PATTERNS = [
    ("OpenAI API key", "critical", re.compile(r"sk-(?:proj|svcacct)?-[A-Za-z0-9_-]{20,}")),
    ("Anthropic API key", "critical", re.compile(r"sk-ant-api[0-9a-z_-]*-[A-Za-z0-9_-]{20,}")),
    ("GitHub token", "critical", re.compile(r"\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}\b")),
    ("AWS access key", "critical", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    ("Private key block", "critical", re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----")),
    ("Bearer token", "high", re.compile(r"\bBearer\s+[A-Za-z0-9._~+/=-]{16,}")),
    ("Credentialed URL", "high", re.compile(r"\b(?:https?|mongodb(?:\+srv)?|postgres(?:ql)?|mysql|mssql|redis)://[^:\s/@]+:[^@\s]+@", re.I)),
    ("Sensitive assignment", "high", re.compile(r"\b[\w.-]*(?:api[_-]?key|apikey|token|secret|password|client[_-]?secret|authorization|x-api-key)[\w.-]*\b\s*[:=]\s*[\"']?(?!\$\{)(?!<)(?!REDACTED)(?!change_me)(?!changeme)(?!TODO)(?!TBD)[^\"',\s}]{8,}", re.I)),
]

SEVERITY_RANK = {"critical": 4, "high": 3, "medium": 2, "low": 1, "info": 0}
SENSITIVE_KEY_RE = re.compile(r"(api[_-]?key|apikey|token|secret|password|client[_-]?secret|clientSecret|authorization|x-api-key)", re.I)


def load_env_file(path):
    if not path.exists():
        return
    for line in path.read_text(errors="ignore").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


for env_name in [".env", ".env.local", ".env.private"]:
    load_env_file(APP_DIR / env_name)


def redact_text(value):
    text = str(value or "")
    replacements = [
        (re.compile(r"sk-(?:proj|svcacct)?-[A-Za-z0-9_-]{20,}", re.I), "[REDACTED_OPENAI_KEY]"),
        (re.compile(r"sk-ant-api[0-9a-z_-]*-[A-Za-z0-9_-]{20,}", re.I), "[REDACTED_ANTHROPIC_KEY]"),
        (re.compile(r"\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}\b"), "[REDACTED_GITHUB_TOKEN]"),
        (re.compile(r"\bAKIA[0-9A-Z]{16}\b"), "[REDACTED_AWS_ACCESS_KEY]"),
        (re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----", re.I), "[REDACTED_PRIVATE_KEY]"),
        (re.compile(r"\bBearer\s+[A-Za-z0-9._~+/=-]{16,}", re.I), "Bearer [REDACTED_TOKEN]"),
    ]
    for pattern, replacement in replacements:
        text = pattern.sub(replacement, text)
    text = re.sub(
        r"\b([\w.-]*(?:api[_-]?key|apikey|token|secret|password|client[_-]?secret|clientSecret|authorization|x-api-key)[\w.-]*\b\s*[:=]\s*[\"']?)([^\"',\s}]+)",
        r"\1[REDACTED_SECRET]",
        text,
        flags=re.I,
    )
    return text


def redact_value(value):
    if isinstance(value, str):
        return redact_text(value)
    if isinstance(value, list):
        return [redact_value(item) for item in value]
    if isinstance(value, dict):
        return {
            key: "[REDACTED_SECRET]" if SENSITIVE_KEY_RE.search(str(key)) else redact_value(item)
            for key, item in value.items()
        }
    return value


def add_finding(findings, severity, task, details, evidence=None):
    findings.append({
        "id": f"{re.sub(r'[^a-z0-9]+', '-', task.lower()).strip('-')}-{len(findings) + 1}",
        "severity": severity,
        "task": task,
        "details": details,
        "evidence": redact_value(evidence or {}),
    })


def safe_name(file_name):
    return re.sub(r"[^A-Za-z0-9._-]", "_", Path(file_name).name or "uploaded-artifact")


def detect_artifact_type(file_name):
    lower = file_name.lower()
    if lower.endswith(".jar"):
        return "java-jar"
    if lower.endswith(".war"):
        return "java-war"
    if lower.endswith(".zip"):
        return "zip"
    if lower.endswith(".tgz") or lower.endswith(".tar.gz"):
        return "node-or-python-tarball"
    if lower.endswith(".tar"):
        return "tar"
    if lower.endswith(".whl"):
        return "python-wheel"
    if lower.endswith(".py"):
        return "python-source"
    if lower.endswith(".js"):
        return "node-source"
    if lower.endswith(".json"):
        return "json"
    return "unknown"


def is_safe_archive_entry(name):
    normalized = str(name).replace("\\", "/").strip()
    if not normalized or normalized.startswith("/") or "\x00" in normalized:
        return False
    return ".." not in normalized.split("/")


def safe_extract_zip(archive_path, extract_dir, findings):
    with zipfile.ZipFile(archive_path) as package:
        names = package.namelist()
        unsafe = [name for name in names if not is_safe_archive_entry(name)]
        if unsafe:
            add_finding(findings, "critical", "Archive path safety", "Archive contains unsafe paths that could write outside the extraction directory.", {"entries": unsafe[:10]})
            return {"extracted": False, "entries": names[:500]}
        package.extractall(extract_dir)
        return {"extracted": True, "entries": names[:500]}


def safe_extract_tar(archive_path, extract_dir, findings):
    with tarfile.open(archive_path) as package:
        members = package.getmembers()
        names = [member.name for member in members]
        unsafe = [name for name in names if not is_safe_archive_entry(name)]
        if unsafe:
            add_finding(findings, "critical", "Archive path safety", "Tar archive contains unsafe paths that could write outside the extraction directory.", {"entries": unsafe[:10]})
            return {"extracted": False, "entries": names[:500]}
        safe_members = [member for member in members if not member.issym() and not member.islnk()]
        package.extractall(extract_dir, members=safe_members)
        return {"extracted": True, "entries": names[:500]}


def extract_artifact(artifact_path, extract_dir, artifact_type, findings):
    extract_dir.mkdir(parents=True, exist_ok=True)
    try:
        if artifact_type in {"java-jar", "java-war", "zip", "python-wheel"}:
            return safe_extract_zip(artifact_path, extract_dir, findings)
        if artifact_type in {"node-or-python-tarball", "tar"}:
            return safe_extract_tar(artifact_path, extract_dir, findings)
        shutil.copy2(artifact_path, extract_dir / artifact_path.name)
        return {"extracted": True, "entries": [artifact_path.name]}
    except Exception as exc:
        add_finding(findings, "medium", "Archive extraction", "Unable to extract artifact. Raw file copy scan still ran where possible.", {"error": str(exc)})
        shutil.copy2(artifact_path, extract_dir / artifact_path.name)
        return {"extracted": False, "entries": [artifact_path.name]}


def walk_files(root_dir):
    files = []
    for current, dirs, names in os.walk(root_dir):
        dirs[:] = [name for name in dirs if not (Path(current) / name).is_symlink()]
        for name in names:
            if len(files) >= MAX_WALK_FILES:
                return files
            path = Path(current) / name
            if not path.is_symlink() and path.is_file():
                files.append(path)
    return files


def should_read_as_text(file_path):
    try:
        if file_path.stat().st_size > TEXT_FILE_LIMIT_BYTES:
            return False
    except OSError:
        return False
    return file_path.suffix.lower() in TEXT_EXTENSIONS or file_path.name.lower() in {"requirements.txt", "pipfile"} or file_path.name.lower().startswith(".env")


def scan_secrets(files, extract_dir, findings):
    scanned = 0
    for file_path in files:
        if not should_read_as_text(file_path):
            continue
        scanned += 1
        text = file_path.read_text(errors="ignore")
        rel = str(file_path.relative_to(extract_dir))
        for name, severity, pattern in SECRET_PATTERNS:
            matches = pattern.findall(text)
            if matches:
                sample = matches[0] if isinstance(matches[0], str) else str(matches[0])
                add_finding(findings, severity, "Secret scanning", f"{name} detected in packaged text content.", {
                    "file": rel,
                    "matchCount": len(matches),
                    "sample": redact_text(sample)[:160],
                })
    return {"scannedFiles": scanned}


def dependency_component(name, version, ecosystem, source_file):
    return {"name": name, "version": version or "unspecified", "ecosystem": ecosystem, "sourceFile": source_file}


def collect_dependency_inventory(files, extract_dir, findings):
    components = []
    for file_path in files:
        rel = str(file_path.relative_to(extract_dir))
        lower = file_path.name.lower()
        if file_path.name == "package.json":
            try:
                pkg = json.loads(file_path.read_text(errors="ignore"))
                for group in ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]:
                    for name, version in (pkg.get(group) or {}).items():
                        components.append(dependency_component(name, version, f"npm:{group}", rel))
            except Exception:
                add_finding(findings, "medium", "Dependency inventory", "Unable to parse package.json.", {"file": rel})
        elif lower == "requirements.txt":
            for line in file_path.read_text(errors="ignore").splitlines():
                trimmed = line.strip()
                if not trimmed or trimmed.startswith("#") or trimmed.startswith("-"):
                    continue
                match = re.match(r"^([A-Za-z0-9_.-]+)\s*(?:==|~=|>=|<=|>|<)?\s*([^;#\s]+)?", trimmed)
                if match:
                    components.append(dependency_component(match.group(1), match.group(2), "python:pip", rel))
        elif lower == "pyproject.toml":
            text = file_path.read_text(errors="ignore")
            block = re.search(r"dependencies\s*=\s*\[([\s\S]*?)\]", text)
            if block:
                for dep in re.findall(r"[\"']([^\"']+)[\"']", block.group(1)):
                    components.append(dependency_component(re.split(r"[<>=~!]", dep)[0].strip(), dep, "python:pyproject", rel))
        elif lower == "pom.xml":
            text = file_path.read_text(errors="ignore")
            for group_id, artifact_id, version in re.findall(r"<dependency>[\s\S]*?<groupId>(.*?)</groupId>[\s\S]*?<artifactId>(.*?)</artifactId>[\s\S]*?(?:<version>(.*?)</version>)?[\s\S]*?</dependency>", text):
                components.append(dependency_component(f"{group_id}:{artifact_id}", version, "maven", rel))
        elif str(file_path).replace("\\", "/").endswith("META-INF/MANIFEST.MF"):
            text = file_path.read_text(errors="ignore")
            title = re.search(r"^Implementation-Title:\s*(.+)$", text, re.M)
            version = re.search(r"^Implementation-Version:\s*(.+)$", text, re.M)
            if title or version:
                components.append(dependency_component(title.group(1) if title else "java-artifact", version.group(1) if version else None, "java-manifest", rel))
        elif lower.endswith(".jar"):
            components.append(dependency_component(file_path.name, None, "java-nested-jar", rel))

    if not components:
        add_finding(findings, "low", "Dependency inventory", "No dependency manifest was found in the uploaded artifact.", {})
    return components


def run_npm_audit_if_possible(extract_dir, findings):
    if not (extract_dir / "package.json").exists() or not (extract_dir / "package-lock.json").exists():
        return {"attempted": False, "reason": "package-lock.json and package.json not found at artifact root"}
    try:
        result = subprocess.run(
            ["npm", "audit", "--omit=dev", "--json", "--package-lock-only"],
            cwd=extract_dir,
            text=True,
            capture_output=True,
            timeout=60,
        )
        data = json.loads(result.stdout or "{}")
        vulnerabilities = data.get("vulnerabilities") or {}
        for name, vuln in vulnerabilities.items():
            severity = vuln.get("severity") if vuln.get("severity") in SEVERITY_RANK else "medium"
            add_finding(findings, severity, "Known vulnerability scan", f"npm audit reported {vuln.get('severity', 'a')} vulnerability for {name}.", {
                "package": name,
                "fixAvailable": vuln.get("fixAvailable"),
            })
        return {"attempted": True, "ok": True, "vulnerabilityCount": len(vulnerabilities)}
    except Exception as exc:
        add_finding(findings, "medium", "Known vulnerability scan", "npm audit did not return parseable output.", {"error": str(exc)})
        return {"attempted": True, "ok": False}


def decision_for(findings):
    worst = max([SEVERITY_RANK.get(item["severity"], 0) for item in findings] or [0])
    if worst >= SEVERITY_RANK["critical"]:
        return "Blocked"
    if worst >= SEVERITY_RANK["high"]:
        return "Blocked pending security review"
    if worst >= SEVERITY_RANK["medium"]:
        return "Conditional approval"
    return "Approved for dev deployment"


def create_sbom(artifact, components):
    return {
        "bomFormat": "CycloneDX-lite",
        "specVersion": "1.5",
        "serialNumber": f"urn:uuid:{uuid.uuid4()}",
        "metadata": {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "component": {
                "type": "application",
                "name": artifact["fileName"],
                "version": "uploaded-artifact",
                "hashes": [{"alg": "SHA-256", "content": artifact["sha256"]}],
            },
        },
        "components": [
            {
                "type": "library",
                "name": item["name"],
                "version": item["version"],
                "properties": [
                    {"name": "ecosystem", "value": item["ecosystem"]},
                    {"name": "sourceFile", "value": item["sourceFile"]},
                ],
            }
            for item in components
        ],
    }


def provider_configs():
    configs = [
        ("anthropic", os.getenv("ANTHROPIC_API_KEY"), os.getenv("ANTHROPIC_MODEL", "claude-3-7-sonnet-20250219")),
        ("groq", os.getenv("GROQ_API_KEY"), os.getenv("GROQ_MODEL", "openai/gpt-oss-120b")),
        ("openai", os.getenv("OPENAI_API_KEY"), os.getenv("OPENAI_MODEL", "gpt-4o-mini")),
        ("gemini", os.getenv("GEMINI_API_KEY") or os.getenv("GEMINI_API_KEY_1"), os.getenv("GEMINI_MODEL", "gemini-2.0-flash")),
        ("openrouter", os.getenv("OPENROUTER_API_KEY"), os.getenv("OPENROUTER_MODEL", "meta-llama/llama-3.1-8b-instruct")),
    ]
    available = [item for item in configs if item[1]]
    preferred = os.getenv("LLM_PROVIDER", "").lower()
    available.sort(key=lambda item: 0 if item[0] == preferred else 1)
    return available


def http_json(url, headers, body):
    request = urllib.request.Request(url, data=json.dumps(body).encode("utf-8"), headers=headers, method="POST")
    with urllib.request.urlopen(request, timeout=60) as response:
        return json.loads(response.read().decode("utf-8"))


def call_llm(messages):
    errors = []
    for provider, api_key, model in provider_configs():
        try:
            if provider == "anthropic":
                data = http_json(
                    "https://api.anthropic.com/v1/messages",
                    {"Content-Type": "application/json", "x-api-key": api_key, "anthropic-version": os.getenv("ANTHROPIC_API_VERSION", "2023-06-01")},
                    {"model": model, "system": messages[0]["content"], "messages": messages[1:], "temperature": 0.2, "max_tokens": 900},
                )
                return "\n".join(part.get("text", "") for part in data.get("content", []))
            if provider == "gemini":
                data = http_json(
                    f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}",
                    {"Content-Type": "application/json"},
                    {"contents": [{"role": "user", "parts": [{"text": "\n\n".join(message["content"] for message in messages)}]}], "generationConfig": {"temperature": 0.2, "maxOutputTokens": 900}},
                )
                return "\n".join(part.get("text", "") for part in data.get("candidates", [{}])[0].get("content", {}).get("parts", []))
            endpoint = "https://api.openai.com/v1/chat/completions"
            headers = {"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"}
            if provider == "groq":
                endpoint = "https://api.groq.com/openai/v1/chat/completions"
            if provider == "openrouter":
                endpoint = os.getenv("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1/chat/completions")
            data = http_json(endpoint, headers, {"model": model, "messages": messages, "temperature": 0.2, "max_tokens": 900})
            return data.get("choices", [{}])[0].get("message", {}).get("content", "")
        except Exception as exc:
            errors.append(f"{provider}: {redact_text(str(exc))}")
    raise RuntimeError("LLM request failed for all configured providers. " + " | ".join(errors))


def run_llm_review(assessment):
    safe_assessment = redact_value({
        "artifact": assessment["artifact"],
        "decision": assessment["decision"],
        "findingCounts": assessment["findingCounts"],
        "findings": assessment["findings"],
        "dependencySample": assessment["components"][:60],
    })
    try:
        return redact_text(call_llm([
            {"role": "system", "content": "You are a secure software release reviewer. Review only the sanitized scan summary. Do not ask for secrets or source code. Return concise risk assessment, missing checks, and deployment recommendation."},
            {"role": "user", "content": "Review this sanitized package security assessment and respond in Markdown:\n\n" + json.dumps(safe_assessment, indent=2)},
        ]))
    except Exception as exc:
        return "LLM review unavailable: " + redact_text(str(exc))


def deployment_recommendation(decision):
    if decision == "Approved for dev deployment":
        return "No blocking issue was found by the automated checks. Use normal environment-specific validation before release."
    if decision == "Conditional approval":
        return "Resolve or accept the medium findings before deployment. A security owner should approve the exception."
    return "Do not deploy this artifact until the blocking findings are remediated and the assessment is rerun."


def build_markdown_report(assessment):
    lines = [
        "# Package Security Assessment Report",
        "",
        f"Run ID: {assessment['runId']}",
        f"Generated: {assessment['generatedAt']}",
        f"Decision: {assessment['decision']}",
        "",
        "## Artifact",
        "",
        f"- File: {assessment['artifact']['fileName']}",
        f"- Type: {assessment['artifact']['type']}",
        f"- Size: {assessment['artifact']['sizeBytes']} bytes",
        f"- SHA-256: {assessment['artifact']['sha256']}",
        "",
        "## Checks Performed",
        "",
        "| Security Test Task | Details | Status |",
        "| --- | --- | --- |",
        f"| Archive path safety | Blocks path traversal entries before extraction. | {'Completed' if assessment['archive']['extracted'] else 'Completed with limitation'} |",
        "| Secret scanning | Checks text files for hardcoded keys, tokens, private keys, credentialed URLs, and sensitive assignments. | Completed |",
        "| Dependency inventory | Extracts npm, Python, Maven, manifest, and nested JAR component evidence where present. | Completed |",
        f"| Known vulnerability scan | Runs npm audit when a root package-lock.json is available. | {'Completed' if assessment['npmAudit']['attempted'] else 'Not applicable'} |",
        "| SBOM generation | Generates a CycloneDX-lite JSON dependency inventory. | Completed |",
        "| LLM security review | Sends only redacted findings metadata to the configured backend LLM. | Completed |",
        "",
        "## Finding Summary",
        "",
        "| Severity | Count |",
        "| --- | ---: |",
    ]
    for severity in ["critical", "high", "medium", "low", "info"]:
        lines.append(f"| {severity} | {assessment['findingCounts'].get(severity, 0)} |")
    for severity in ["critical", "high", "medium", "low", "info"]:
        items = [item for item in assessment["findings"] if item["severity"] == severity]
        if not items:
            continue
        lines.extend(["", f"## {severity.title()} Findings", ""])
        for item in items:
            lines.append(f"- {item['task']}: {item['details']}")
            if item["evidence"]:
                lines.append(f"  Evidence: `{json.dumps(item['evidence'])}`")
    lines.extend([
        "",
        "## Dependency Inventory",
        "",
        f"Total components found: {len(assessment['components'])}",
        "",
        "| Ecosystem | Name | Version | Source |",
        "| --- | --- | --- | --- |",
    ])
    for component in assessment["components"][:150]:
        lines.append(f"| {component['ecosystem']} | {component['name']} | {component['version']} | {component['sourceFile']} |")
    lines.extend([
        "",
        "## LLM Review",
        "",
        assessment["llmReview"],
        "",
        "## Deployment Recommendation",
        "",
        deployment_recommendation(assessment["decision"]),
        "",
        "## Evidence Files",
        "",
        "- JSON report: report.json",
        "- SBOM: sbom.json",
    ])
    return "\n".join(lines)


def make_run_id():
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
    return f"run_{stamp}_{uuid.uuid4().hex[:8]}"


def assess_artifact(file_name, content_base64):
    data = base64.b64decode(content_base64)
    if not data:
        raise ValueError("Uploaded artifact is empty.")
    if len(data) > MAX_UPLOAD_BYTES:
        raise ValueError(f"Uploaded artifact exceeds {MAX_UPLOAD_BYTES} bytes.")

    run_id = make_run_id()
    run_dir = RUNS_DIR / run_id
    upload_dir = run_dir / "upload"
    extract_dir = run_dir / "extract"
    upload_dir.mkdir(parents=True, exist_ok=True)
    extract_dir.mkdir(parents=True, exist_ok=True)

    cleaned_name = safe_name(file_name)
    artifact_path = upload_dir / cleaned_name
    artifact_path.write_bytes(data)
    findings = []
    artifact = {
        "fileName": cleaned_name,
        "originalFileName": Path(file_name).name,
        "type": detect_artifact_type(file_name),
        "sizeBytes": len(data),
        "sha256": hashlib.sha256(data).hexdigest(),
    }
    archive = extract_artifact(artifact_path, extract_dir, artifact["type"], findings)
    files = walk_files(extract_dir)
    if len(files) >= MAX_WALK_FILES:
        add_finding(findings, "medium", "Archive size guard", f"File walk stopped at {MAX_WALK_FILES} files to avoid resource exhaustion.", {})
    secret_scan = scan_secrets(files, extract_dir, findings)
    components = collect_dependency_inventory(files, extract_dir, findings)
    npm_audit = run_npm_audit_if_possible(extract_dir, findings)
    finding_counts = {}
    for item in findings:
        finding_counts[item["severity"]] = finding_counts.get(item["severity"], 0) + 1
    assessment = {
        "runId": run_id,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "artifact": artifact,
        "archive": archive,
        "secretScan": secret_scan,
        "npmAudit": npm_audit,
        "components": components,
        "findings": findings,
        "findingCounts": finding_counts,
        "decision": decision_for(findings),
    }
    assessment["sbom"] = create_sbom(artifact, components)
    assessment["llmReview"] = run_llm_review(assessment)
    assessment["reportMarkdown"] = build_markdown_report(assessment)
    (run_dir / "report.md").write_text(assessment["reportMarkdown"])
    (run_dir / "report.json").write_text(json.dumps(redact_value(assessment), indent=2))
    (run_dir / "sbom.json").write_text(json.dumps(assessment["sbom"], indent=2))
    assessment["reportPath"] = str(run_dir / "report.md")
    assessment["jsonPath"] = str(run_dir / "report.json")
    assessment["sbomPath"] = str(run_dir / "sbom.json")
    return assessment


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(PUBLIC_DIR), **kwargs)

    def send_json(self, status, payload):
        body = json.dumps(redact_value(payload)).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if self.path != "/api/assess":
            self.send_json(HTTPStatus.NOT_FOUND, {"error": "Route not found."})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            result = assess_artifact(payload.get("fileName"), payload.get("contentBase64"))
            self.send_json(HTTPStatus.OK, {
                "runId": result["runId"],
                "decision": result["decision"],
                "findingCounts": result["findingCounts"],
                "findings": result["findings"],
                "components": result["components"][:150],
                "componentCount": len(result["components"]),
                "llmReview": result["llmReview"],
                "reportMarkdown": result["reportMarkdown"],
                "reportPath": result["reportPath"],
                "jsonPath": result["jsonPath"],
                "sbomPath": result["sbomPath"],
            })
        except Exception as exc:
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": redact_text(str(exc))})

    def do_GET(self):
        match = re.match(r"^/api/reports/([^/]+)/(report\.md|report\.json|sbom\.json)$", self.path)
        if match:
            run_id, file_name = match.groups()
            file_path = (RUNS_DIR / run_id / file_name).resolve()
            if RUNS_DIR.resolve() in file_path.parents and file_path.exists():
                content_type = "application/json" if file_name.endswith(".json") else "text/markdown"
                data = file_path.read_bytes()
                self.send_response(HTTPStatus.OK)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
                return
            self.send_json(HTTPStatus.NOT_FOUND, {"error": "Report file not found."})
            return
        super().do_GET()


def main():
    RUNS_DIR.mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"Security assessor running at http://localhost:{PORT}")
    server.serve_forever()


if __name__ == "__main__":
    main()
