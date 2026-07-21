#!/usr/bin/env python3
import base64
import csv
import hashlib
import io
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
from xml.sax.saxutils import escape

APP_DIR = Path(__file__).resolve().parent
PUBLIC_DIR = APP_DIR / "public"
RUNS_DIR = APP_DIR / "output" / "security-assessor" / "runs"
RESTRICTED_PROMPTS_PATH = APP_DIR / "restricted_prompts.json"
ALLOWED_PROMPTS_PATH = APP_DIR / "allowed_prompts.json"
PORT = int(os.getenv("SECURITY_ASSESSOR_PORT", "5050"))
MAX_UPLOAD_BYTES = int(os.getenv("SECURITY_ASSESSOR_MAX_UPLOAD_BYTES", str(50 * 1024 * 1024)))
TEXT_FILE_LIMIT_BYTES = int(os.getenv("SECURITY_ASSESSOR_TEXT_FILE_LIMIT_BYTES", str(512 * 1024)))
MAX_WALK_FILES = int(os.getenv("SECURITY_ASSESSOR_MAX_WALK_FILES", "3000"))
MAX_PROMPT_FILE_BYTES = int(os.getenv("SECURITY_ASSESSOR_MAX_PROMPT_FILE_BYTES", str(1024 * 1024)))
MAX_PROMPTS_PER_RUN = int(os.getenv("SECURITY_ASSESSOR_MAX_PROMPTS_PER_RUN", "250"))

TEXT_EXTENSIONS = {
    ".js", ".jsx", ".ts", ".tsx", ".json", ".yaml", ".yml", ".xml", ".properties",
    ".env", ".txt", ".md", ".py", ".java", ".gradle", ".pom", ".lock", ".toml",
    ".ini", ".conf", ".cfg", ".sh", ".bat", ".ps1", ".sql", ".raml", ".html", ".css",
}

CERTIFICATE_EXTENSIONS = {".crt", ".cer", ".pem", ".der"}
KEYSTORE_EXTENSIONS = {".jks", ".keystore", ".p12", ".pfx"}
PRIVATE_KEY_EXTENSIONS = {".key"}
WEAK_CERT_SIGNATURE_RE = re.compile(r"Signature Algorithm:\s*(?:md5|sha1)", re.I)

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
DEFAULT_BLOCK_SIGNALS = ["blocked", "warning", "not allowed", "restricted", "policy", "cannot comply", "i can't help", "unauthorized", "forbidden"]
BLOCKING_HTTP_STATUSES = {400, 401, 403, 406, 409, 422, 429}

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


def parse_openssl_date(value):
    text = str(value or "").replace("GMT", "").strip()
    try:
        return datetime.strptime(text, "%b %d %H:%M:%S %Y").replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def openssl_x509_details(file_path):
    if not shutil.which("openssl"):
        return {"ok": False, "error": "openssl command not available"}
    commands = [
        ["openssl", "x509", "-in", str(file_path), "-noout", "-subject", "-issuer", "-serial", "-dates", "-fingerprint", "-sha256", "-text"],
    ]
    if file_path.suffix.lower() == ".der":
        commands.insert(0, ["openssl", "x509", "-inform", "DER", "-in", str(file_path), "-noout", "-subject", "-issuer", "-serial", "-dates", "-fingerprint", "-sha256", "-text"])
    last_error = ""
    for command in commands:
        try:
            result = subprocess.run(command, text=True, capture_output=True, timeout=15)
        except Exception as exc:
            last_error = str(exc)
            continue
        if result.returncode != 0:
            last_error = result.stderr.strip()
            continue
        output = result.stdout
        details = {"ok": True, "raw": output}
        for line in output.splitlines():
            if line.startswith("subject="):
                details["subject"] = line.split("=", 1)[1].strip()
            elif line.startswith("issuer="):
                details["issuer"] = line.split("=", 1)[1].strip()
            elif line.startswith("serial="):
                details["serial"] = line.split("=", 1)[1].strip()
            elif line.startswith("notBefore="):
                details["notBefore"] = line.split("=", 1)[1].strip()
            elif line.startswith("notAfter="):
                details["notAfter"] = line.split("=", 1)[1].strip()
            elif line.startswith("sha256 Fingerprint="):
                details["fingerprint"] = line.split("=", 1)[1].strip()
        return details
    return {"ok": False, "error": last_error or "Unable to parse certificate"}


def evaluate_certificate_details(details, rel, findings, source):
    if not details.get("ok"):
        add_finding(findings, "low", "Certificate inventory", "Certificate-like file could not be parsed as an X.509 certificate.", {
            "file": rel,
            "source": source,
            "error": details.get("error"),
        })
        return
    not_after = parse_openssl_date(details.get("notAfter"))
    now = datetime.now(timezone.utc)
    days_left = None
    if not_after:
        days_left = (not_after - now).days
        if days_left < 0:
            add_finding(findings, "high", "Certificate and TLS security", "Expired certificate found.", {
                "file": rel,
                "source": source,
                "subject": details.get("subject"),
                "notAfter": details.get("notAfter"),
            })
        elif days_left <= 30:
            add_finding(findings, "medium", "Certificate and TLS security", "Certificate expires within 30 days.", {
                "file": rel,
                "source": source,
                "subject": details.get("subject"),
                "notAfter": details.get("notAfter"),
                "daysRemaining": days_left,
            })
    if details.get("subject") and details.get("issuer") and details.get("subject") == details.get("issuer"):
        add_finding(findings, "medium", "Certificate and TLS security", "Self-signed certificate found.", {
            "file": rel,
            "source": source,
            "subject": details.get("subject"),
        })
    if WEAK_CERT_SIGNATURE_RE.search(details.get("raw", "")):
        add_finding(findings, "high", "Certificate and TLS security", "Certificate uses a weak signature algorithm.", {
            "file": rel,
            "source": source,
            "subject": details.get("subject"),
        })


def scan_certificates(files, extract_dir, findings):
    inventory = []
    for file_path in files:
        suffix = file_path.suffix.lower()
        rel = str(file_path.relative_to(extract_dir))
        if suffix in PRIVATE_KEY_EXTENSIONS:
            add_finding(findings, "critical", "Certificate and TLS security", "Private key file is packaged with the application artifact.", {"file": rel})
            inventory.append({"file": rel, "type": "private-key", "parsed": False})
        elif suffix in KEYSTORE_EXTENSIONS:
            add_finding(findings, "medium", "Certificate and TLS security", "Keystore file is packaged with the application artifact. Review password handling and certificate contents.", {
                "file": rel,
                "type": suffix.lstrip("."),
            })
            inventory.append({"file": rel, "type": "keystore", "parsed": False})
        elif suffix in CERTIFICATE_EXTENSIONS:
            details = openssl_x509_details(file_path)
            evaluate_certificate_details(details, rel, findings, "package")
            inventory.append({
                "file": rel,
                "type": suffix.lstrip("."),
                "parsed": details.get("ok", False),
                "subject": details.get("subject"),
                "issuer": details.get("issuer"),
                "notAfter": details.get("notAfter"),
                "fingerprint": details.get("fingerprint"),
                "error": details.get("error"),
            })
    return {"scannedFiles": len(files), "certificateFiles": inventory}


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


def find_npm_audit_targets(extract_dir):
    targets = []
    for current, dirs, names in os.walk(extract_dir):
        dirs[:] = [
            name for name in dirs
            if name not in {"node_modules", ".git", "dist", "build", "coverage"}
        ]
        current_path = Path(current)
        if "package.json" in names and "package-lock.json" in names:
            targets.append(current_path)
    return targets


def run_npm_audit_if_possible(extract_dir, findings):
    targets = find_npm_audit_targets(extract_dir)
    if not targets:
        return {"attempted": False, "targets": [], "reason": "No package.json + package-lock.json pairs found"}

    results = []
    total_vulnerabilities = 0
    attempted = False

    for target in targets:
        attempted = True
        rel_target = "." if target == extract_dir else str(target.relative_to(extract_dir))
        target_vulnerabilities = 0
        target_ok = False
        error_message = None
        try:
            result = subprocess.run(
                ["npm", "audit", "--omit=dev", "--json", "--package-lock-only"],
                cwd=target,
                text=True,
                capture_output=True,
                timeout=60,
            )
            data = json.loads(result.stdout or "{}")
            vulnerabilities = data.get("vulnerabilities") or {}
            target_vulnerabilities = len(vulnerabilities)
            total_vulnerabilities += target_vulnerabilities
            target_ok = True
            for name, vuln in vulnerabilities.items():
                severity = vuln.get("severity") if vuln.get("severity") in SEVERITY_RANK else "medium"
                add_finding(findings, severity, "Known vulnerability scan", f"npm audit reported {vuln.get('severity', 'a')} vulnerability for {name}.", {
                    "package": name,
                    "project": rel_target,
                    "fixAvailable": vuln.get("fixAvailable"),
                })
        except Exception as exc:
            error_message = str(exc)
            add_finding(findings, "medium", "Known vulnerability scan", "npm audit did not return parseable output.", {
                "project": rel_target,
                "error": error_message,
            })

        results.append({
            "project": rel_target,
            "ok": target_ok,
            "vulnerabilityCount": target_vulnerabilities,
            "error": error_message,
        })

    return {
        "attempted": attempted,
        "targets": results,
        "vulnerabilityCount": total_vulnerabilities,
    }

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
        "certificateScan": assessment.get("certificateScan"),
    })
    try:
        return redact_text(call_llm([
            {"role": "system", "content": "You are a secure software release reviewer. Review only the sanitized scan summary. Do not ask for secrets or source code. Return concise risk assessment, missing checks, and deployment recommendation."},
            {"role": "user", "content": "Review this sanitized package security assessment and respond in Markdown:\n\n" + json.dumps(safe_assessment, indent=2)},
        ]))
    except Exception as exc:
        return "LLM review unavailable: " + redact_text(str(exc))


def load_prompt_file(path, default_severity="info"):
    if not path.exists():
        raise ValueError(f"Prompt file not found: {path}")
    prompts = json.loads(path.read_text())
    if not isinstance(prompts, list):
        raise ValueError(f"{path.name} must contain a JSON array.")
    normalized = []
    for index, item in enumerate(prompts, start=1):
        if not isinstance(item, dict) or not str(item.get("prompt") or "").strip():
            continue
        normalized.append({
            "id": str(item.get("id") or f"prompt_{index}"),
            "name": str(item.get("name") or item.get("id") or f"Prompt {index}"),
            "severity": str(item.get("severity") or default_severity).lower() if str(item.get("severity") or default_severity).lower() in SEVERITY_RANK else default_severity,
            "prompt": str(item.get("prompt")),
        })
    if not normalized:
        raise ValueError(f"{path.name} does not contain any usable prompts.")
    return normalized


def load_restricted_prompts():
    return load_prompt_file(RESTRICTED_PROMPTS_PATH, "medium")


def load_allowed_prompts():
    return load_prompt_file(ALLOWED_PROMPTS_PATH, "info")


def normalize_uploaded_prompt(item, index):
    if isinstance(item, str):
        item = {"prompt": item}
    if not isinstance(item, dict):
        raise ValueError(f"Prompt item {index} must be a string or object.")
    prompt = str(item.get("prompt") or item.get("input") or item.get("text") or "").strip()
    if not prompt:
        raise ValueError(f"Prompt item {index} does not contain prompt text.")
    prompt_type = str(item.get("type") or item.get("category") or "").strip().lower()
    expected = str(item.get("expected") or "").strip().lower()
    if expected in {"pass", "passed", "accept", "accepted"}:
        expected = "allowed"
    if expected in {"block", "blocked", "deny", "denied", "reject", "rejected"}:
        expected = "blocked"
    if not expected:
        expected = "allowed" if prompt_type == "allowed" else "blocked"
    if expected not in {"blocked", "allowed"}:
        raise ValueError(f"Prompt item {index} has unsupported expected value: {expected}")
    prompt_type = "allowed" if expected == "allowed" else "restricted"
    default_severity = "info" if prompt_type == "allowed" else "medium"
    severity = str(item.get("severity") or default_severity).strip().lower()
    if severity not in SEVERITY_RANK:
        severity = default_severity
    return {
        "id": str(item.get("id") or f"uploaded_prompt_{index}"),
        "name": str(item.get("name") or item.get("id") or f"Uploaded prompt {index}"),
        "severity": severity,
        "prompt": prompt,
        "type": prompt_type,
        "expected": expected,
    }


def parse_uploaded_prompt_file(file_name, content_base64):
    if not content_base64:
        return None
    data = base64.b64decode(content_base64)
    if len(data) > MAX_PROMPT_FILE_BYTES:
        raise ValueError(f"Prompt file is too large. Limit is {MAX_PROMPT_FILE_BYTES // 1024} KB.")
    name = str(file_name or "uploaded-prompts.txt")
    suffix = Path(name).suffix.lower()
    text = data.decode("utf-8-sig", errors="replace")
    if suffix == ".json":
        parsed = json.loads(text)
        if isinstance(parsed, dict):
            parsed = parsed.get("prompts") or parsed.get("tests") or parsed.get("testCases")
        if not isinstance(parsed, list):
            raise ValueError("Prompt JSON must be an array or an object with prompts/tests/testCases array.")
        raw_items = parsed
    elif suffix == ".csv":
        rows = list(csv.DictReader(io.StringIO(text)))
        if rows and "prompt" in {key.strip().lower() for key in rows[0].keys() if key}:
            raw_items = []
            for row in rows:
                normalized_row = {str(key).strip().lower(): value for key, value in row.items() if key}
                raw_items.append(normalized_row)
        else:
            raw_items = [line.strip() for line in text.splitlines() if line.strip()]
    else:
        raw_items = [line.strip() for line in text.splitlines() if line.strip() and not line.lstrip().startswith("#")]
    prompts = [normalize_uploaded_prompt(item, index) for index, item in enumerate(raw_items, start=1)]
    if not prompts:
        raise ValueError("Prompt file does not contain any usable prompts.")
    if len(prompts) > MAX_PROMPTS_PER_RUN:
        raise ValueError(f"Prompt file contains {len(prompts)} prompts. Limit is {MAX_PROMPTS_PER_RUN} per run.")
    return {"source": name, "prompts": prompts}


def normalize_endpoint(path):
    text = str(path or "").strip()
    if not text:
        return "/"
    return text if text.startswith("/") else "/" + text


def parse_header_text(text):
    headers = {}
    for line in str(text or "").splitlines():
        if ":" not in line:
            continue
        key, value = line.split(":", 1)
        key = key.strip()
        value = value.strip()
        if key:
            headers[key] = value
    return headers


def parse_signal_text(text):
    signals = [line.strip().lower() for line in str(text or "").splitlines() if line.strip()]
    return signals or DEFAULT_BLOCK_SIGNALS


def replace_prompt_value(value, prompt):
    if isinstance(value, str):
        return value.replace("{{prompt}}", prompt)
    if isinstance(value, list):
        return [replace_prompt_value(item, prompt) for item in value]
    if isinstance(value, dict):
        return {key: replace_prompt_value(item, prompt) for key, item in value.items()}
    return value


def request_body_from_template(template, prompt):
    text = str(template or "").strip()
    if not text:
        text = '{"message":"{{prompt}}"}'
    try:
        return json.dumps(replace_prompt_value(json.loads(text), prompt)).encode("utf-8")
    except json.JSONDecodeError:
        return text.replace("{{prompt}}", prompt).encode("utf-8")


def evaluate_guardrail_block(response, expected_signals):
    status = response.get("status")
    body = str(response.get("body") or "").lower()
    if status in BLOCKING_HTTP_STATUSES:
        return True, f"Blocked by HTTP status {status}"
    for signal in expected_signals:
        if signal and signal in body:
            return True, f"Matched block signal: {signal}"
    return False, "No blocking status or expected warning text was observed"


def send_guardrail_prompt(config, prompt):
    data = None
    method = config["method"]
    headers = {"Content-Type": "application/json", **config["headers"]}
    url = config["targetUrl"].rstrip("/") + config["endpoint"]
    if method != "GET":
        data = request_body_from_template(config["bodyTemplate"], prompt)
    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=config["timeoutSeconds"]) as response:
            body = response.read(12000).decode("utf-8", errors="ignore")
            return {"ok": True, "status": response.status, "body": redact_text(body), "error": ""}
    except urllib.error.HTTPError as exc:
        body = exc.read(12000).decode("utf-8", errors="ignore")
        return {"ok": False, "status": exc.code, "body": redact_text(body), "error": redact_text(str(exc))}
    except Exception as exc:
        return {"ok": False, "status": None, "body": "", "error": redact_text(str(exc))}


def guardrail_decision(failure_count, warning_count):
    if failure_count:
        return "Failed: guardrail behavior mismatch"
    if warning_count:
        return "Review warnings"
    return "Passed: guardrail behavior expected"


def build_guardrail_markdown(result):
    lines = [
        "# Runtime Guardrail Test Report",
        "",
        f"Run ID: {result['runId']}",
        f"Generated: {result['generatedAt']}",
        f"Target URL: {result['targetUrl']}",
        f"Endpoint: {result['endpoint']}",
        f"Prompt Source: {result.get('promptSource', '')}",
        f"Decision: {result['decision']}",
        "",
        "## Summary",
        "",
        f"- Total prompts: {result['summary']['total']}",
        f"- Restricted blocked: {result['summary']['restrictedBlocked']}",
        f"- Restricted failed: {result['summary']['restrictedFailed']}",
        f"- Allowed passed: {result['summary']['allowedPassed']}",
        f"- Allowed failed: {result['summary']['allowedFailed']}",
        f"- Warnings: {result['summary']['warnings']}",
        "",
        "## Prompt Results",
        "",
        "| Prompt | Type | Severity | Result | HTTP | Reason |",
        "| --- | --- | --- | --- | ---: | --- |",
    ]
    for item in result["tests"]:
        lines.append(f"| {item['name']} | {item['type']} | {item['severity']} | {item['result']} | {item.get('status') or ''} | {item['reason']} |")
    lines.extend([
        "",
        "## Evidence Notes",
        "",
        "Response samples are redacted and truncated in the JSON report.",
    ])
    return "\n".join(lines)


def guardrail_rows(result):
    rows = [style_header(["Prompt", "Type", "Severity", "Expected", "Result", "HTTP Status", "Reason", "Response Sample", "Error"])]
    for item in result.get("tests", []):
        rows.append([
            item.get("name", ""),
            item.get("type", ""),
            item.get("severity", ""),
            item.get("expected", ""),
            item.get("result", ""),
            item.get("status") or "",
            item.get("reason", ""),
            item.get("responseSample", ""),
            item.get("error", ""),
        ])
    return rows


def build_guardrail_xlsx(result):
    rows = [
        [{"value": "Runtime Guardrail Test Report", "style": 2}],
        [],
        style_header(["Field", "Value"]),
        ["Run ID", result["runId"]],
        ["Generated", result["generatedAt"]],
        ["Target URL", result["targetUrl"]],
        ["Endpoint", result["endpoint"]],
        ["Prompt Source", result.get("promptSource", "")],
        ["Decision", result["decision"]],
        [],
        style_header(["Metric", "Count"]),
        ["Total prompts", result["summary"]["total"]],
        ["Restricted blocked", result["summary"]["restrictedBlocked"]],
        ["Restricted failed", result["summary"]["restrictedFailed"]],
        ["Allowed passed", result["summary"]["allowedPassed"]],
        ["Allowed failed", result["summary"]["allowedFailed"]],
        ["Warnings", result["summary"]["warnings"]],
    ]
    sheets = [
        ("Summary", rows, [28, 90]),
        ("Prompt Results", guardrail_rows(result), [34, 14, 14, 18, 18, 14, 52, 80, 60]),
    ]
    content_types = [
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
        '<Default Extension="xml" ContentType="application/xml"/>',
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>',
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>',
    ]
    for index in range(1, len(sheets) + 1):
        content_types.append(f'<Override PartName="/xl/worksheets/sheet{index}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>')
    content_types.append("</Types>")
    workbook_sheets = "".join(
        f'<sheet name="{escape(name)}" sheetId="{index}" r:id="rId{index}"/>'
        for index, (name, _, _) in enumerate(sheets, start=1)
    )
    workbook_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        f"<sheets>{workbook_sheets}</sheets></workbook>"
    )
    rels_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
        "</Relationships>"
    )
    workbook_rels = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
                     '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">']
    for index in range(1, len(sheets) + 1):
        workbook_rels.append(f'<Relationship Id="rId{index}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet{index}.xml"/>')
    workbook_rels.append(f'<Relationship Id="rId{len(sheets) + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>')
    workbook_rels.append("</Relationships>")
    styles_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        '<fonts count="3"><font><sz val="11"/><name val="Calibri"/></font>'
        '<font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Calibri"/></font>'
        '<font><b/><sz val="16"/><color rgb="FF1F1F1F"/><name val="Calibri"/></font></fonts>'
        '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>'
        '<fill><patternFill patternType="solid"><fgColor rgb="FFD04A02"/><bgColor indexed="64"/></patternFill></fill></fills>'
        '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
        '<cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
        '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>'
        '<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>'
        '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>'
    )
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as package:
        package.writestr("[Content_Types].xml", "".join(content_types))
        package.writestr("_rels/.rels", rels_xml)
        package.writestr("xl/workbook.xml", workbook_xml)
        package.writestr("xl/_rels/workbook.xml.rels", "".join(workbook_rels))
        package.writestr("xl/styles.xml", styles_xml)
        for index, (_, sheet_rows, widths) in enumerate(sheets, start=1):
            package.writestr(f"xl/worksheets/sheet{index}.xml", xlsx_sheet_xml(sheet_rows, widths))
    return buffer.getvalue()


def run_guardrail_test(payload):
    target_url = str(payload.get("targetUrl") or "").strip().rstrip("/")
    if not target_url.startswith(("http://", "https://")):
        raise ValueError("Target app URL must start with http:// or https://")
    body_template = str(payload.get("bodyTemplate") or '{"input":"{{prompt}}","apiName":"SecurityGuardrailTest","saveFiles":false}')
    if "{{prompt}}" not in body_template:
        raise ValueError("Request body template must contain {{prompt}}. Do not type a single prompt there; the assessor inserts each prompt from the prompt files.")
    config = {
        "targetUrl": target_url,
        "endpoint": normalize_endpoint(payload.get("endpoint") or "/api/process"),
        "method": str(payload.get("method") or "POST").upper(),
        "bodyTemplate": body_template,
        "headers": parse_header_text(payload.get("headers")),
        "expectedSignals": parse_signal_text(payload.get("expectedSignals")),
        "timeoutSeconds": max(3, min(120, int(payload.get("timeoutSeconds") or 30))),
    }
    uploaded_prompt_file = parse_uploaded_prompt_file(payload.get("promptFileName"), payload.get("promptFileContentBase64"))
    if uploaded_prompt_file:
        prompts = uploaded_prompt_file["prompts"]
        prompt_source = uploaded_prompt_file["source"]
    else:
        prompts = [
            {**item, "type": "restricted", "expected": "blocked"}
            for item in load_restricted_prompts()
        ] + [
            {**item, "type": "allowed", "expected": "allowed"}
            for item in load_allowed_prompts()
        ]
        prompt_source = "Built-in restricted_prompts.json and allowed_prompts.json"
    tests = []
    restricted_failed = 0
    restricted_blocked = 0
    allowed_failed = 0
    allowed_passed = 0
    warnings = 0
    for prompt_item in prompts:
        response = send_guardrail_prompt(config, prompt_item["prompt"])
        was_blocked, reason = evaluate_guardrail_block(response, config["expectedSignals"])
        if response.get("status") is None:
            result = "warning"
            passed = False
            warnings += 1
            result_reason = response.get("error") or reason
        elif prompt_item["expected"] == "blocked" and was_blocked:
            result = "blocked"
            passed = True
            restricted_blocked += 1
            result_reason = reason
        elif prompt_item["expected"] == "blocked":
            result = "failed"
            passed = False
            restricted_failed += 1
            result_reason = reason
        elif was_blocked:
            result = "failed"
            passed = False
            allowed_failed += 1
            result_reason = "Allowed prompt was blocked: " + reason
        else:
            result = "allowed"
            passed = True
            allowed_passed += 1
            result_reason = "Allowed prompt was accepted"
        tests.append({
            "id": prompt_item["id"],
            "name": prompt_item["name"],
            "type": prompt_item["type"],
            "expected": prompt_item["expected"],
            "severity": prompt_item.get("severity", "info"),
            "result": result,
            "passed": passed,
            "status": response.get("status"),
            "reason": result_reason,
            "responseSample": redact_text(response.get("body") or "")[:1000],
            "error": response.get("error") or "",
        })

    run_id = make_run_id()
    run_dir = RUNS_DIR / run_id
    run_dir.mkdir(parents=True, exist_ok=True)
    result = {
        "runId": run_id,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "targetUrl": target_url,
        "endpoint": config["endpoint"],
        "method": config["method"],
        "promptSource": prompt_source,
        "summary": {
            "total": len(tests),
            "restrictedBlocked": restricted_blocked,
            "restrictedFailed": restricted_failed,
            "allowedPassed": allowed_passed,
            "allowedFailed": allowed_failed,
            "failed": restricted_failed + allowed_failed,
            "warnings": warnings,
        },
        "decision": guardrail_decision(restricted_failed + allowed_failed, warnings),
        "tests": tests,
    }
    result["reportMarkdown"] = build_guardrail_markdown(result)
    report_excel = build_guardrail_xlsx(result)
    (run_dir / "guardrail-report.md").write_text(result["reportMarkdown"])
    (run_dir / "guardrail-report.json").write_text(json.dumps(redact_value(result), indent=2))
    (run_dir / "guardrail-report.xlsx").write_bytes(report_excel)
    result["markdownPath"] = str(run_dir / "guardrail-report.md")
    result["jsonPath"] = str(run_dir / "guardrail-report.json")
    result["excelPath"] = str(run_dir / "guardrail-report.xlsx")
    return result


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
        "| Certificate and TLS security | Checks packaged certificates, private keys, and keystores. | Completed |",
        "| Dependency inventory | Extracts npm, Python, Maven, manifest, and nested JAR component evidence where present. | Completed |",
        f"| Known vulnerability scan | Runs npm audit for every package.json + package-lock.json pair found, including nested client apps. | {'Completed' if assessment['npmAudit']['attempted'] else 'Not applicable'} |",
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
        "## npm Audit Targets",
        "",
        "| Project | Status | Vulnerabilities |",
        "| --- | --- | ---: |",
    ])
    audit_targets = assessment["npmAudit"].get("targets") or []
    if audit_targets:
        for target in audit_targets:
            status = "Completed" if target.get("ok") else "Failed"
            lines.append(f"| {target.get('project', '.')} | {status} | {target.get('vulnerabilityCount', 0)} |")
    else:
        lines.append(f"| Not applicable | {assessment['npmAudit'].get('reason', 'No npm audit targets found')} | 0 |")

    certificate_scan = assessment.get("certificateScan") or {}
    lines.extend([
        "",
        "## Certificate Inventory",
        "",
        "| File | Type | Parsed | Subject | Issuer | Not After |",
        "| --- | --- | --- | --- | --- | --- |",
    ])
    cert_files = certificate_scan.get("certificateFiles") or []
    if cert_files:
        for item in cert_files:
            lines.append(f"| {item.get('file', '')} | {item.get('type', '')} | {item.get('parsed', False)} | {item.get('subject', '') or ''} | {item.get('issuer', '') or ''} | {item.get('notAfter', '') or ''} |")
    else:
        lines.append("| Not found |  |  |  |  |  |")

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


def excel_col_name(index):
    name = ""
    index += 1
    while index:
        index, remainder = divmod(index - 1, 26)
        name = chr(65 + remainder) + name
    return name


def xlsx_cell(value, row, col, style=None):
    ref = f"{excel_col_name(col)}{row}"
    style_attr = f' s="{style}"' if style is not None else ""
    if isinstance(value, bool):
        return f'<c r="{ref}"{style_attr} t="b"><v>{1 if value else 0}</v></c>'
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return f'<c r="{ref}"{style_attr}><v>{value}</v></c>'
    text = escape(redact_text("" if value is None else value))
    return f'<c r="{ref}"{style_attr} t="inlineStr"><is><t xml:space="preserve">{text}</t></is></c>'


def xlsx_sheet_xml(rows, widths=None):
    sheet_rows = []
    for row_index, row in enumerate(rows, start=1):
        cells = []
        for col_index, item in enumerate(row):
            value = item
            style = None
            if isinstance(item, dict):
                value = item.get("value")
                style = item.get("style")
            cells.append(xlsx_cell(value, row_index, col_index, style))
        sheet_rows.append(f'<row r="{row_index}">{"".join(cells)}</row>')
    cols = ""
    if widths:
        col_defs = []
        for index, width in enumerate(widths, start=1):
            col_defs.append(f'<col min="{index}" max="{index}" width="{width}" customWidth="1"/>')
        cols = f"<cols>{''.join(col_defs)}</cols>"
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        f"{cols}<sheetData>{''.join(sheet_rows)}</sheetData></worksheet>"
    )


def style_header(values):
    return [{"value": value, "style": 1} for value in values]


def finding_rows(findings):
    rows = [style_header(["Severity", "Task", "Details", "Evidence"])]
    for item in findings:
        rows.append([
            item.get("severity", ""),
            item.get("task", ""),
            item.get("details", ""),
            json.dumps(item.get("evidence", {})),
        ])
    return rows


def certificate_rows(certificate_scan):
    rows = [style_header(["Source", "File", "Type", "Parsed", "Subject", "Issuer", "Not After", "Fingerprint/Error"])]
    for item in (certificate_scan.get("certificateFiles") or []):
        rows.append([
            "package",
            item.get("file", ""),
            item.get("type", ""),
            item.get("parsed", False),
            item.get("subject", ""),
            item.get("issuer", ""),
            item.get("notAfter", ""),
            item.get("fingerprint") or item.get("error") or "",
        ])
    if len(rows) == 1:
        rows.append(["not found", "", "", False, "", "", "", ""])
    return rows


def component_rows(components):
    rows = [style_header(["Ecosystem", "Name", "Version", "Source File"])]
    for item in components:
        rows.append([item.get("ecosystem", ""), item.get("name", ""), item.get("version", ""), item.get("sourceFile", "")])
    return rows


def npm_audit_rows(npm_audit):
    rows = [style_header(["Project", "Status", "Vulnerabilities", "Error"])]
    targets = npm_audit.get("targets") or []
    if not targets:
        rows.append(["Not applicable", npm_audit.get("reason", "No npm audit targets found"), 0, ""])
        return rows
    for target in targets:
        rows.append([
            target.get("project", "."),
            "Completed" if target.get("ok") else "Failed",
            target.get("vulnerabilityCount", 0),
            target.get("error") or "",
        ])
    return rows


def build_xlsx_report(assessment):
    summary_rows = [
        [{"value": "Package Security Assessment Report", "style": 2}],
        [],
        style_header(["Field", "Value"]),
        ["Run ID", assessment["runId"]],
        ["Generated", assessment["generatedAt"]],
        ["Decision", assessment["decision"]],
        ["File", assessment["artifact"]["fileName"]],
        ["Type", assessment["artifact"]["type"]],
        ["Size bytes", assessment["artifact"]["sizeBytes"]],
        ["SHA-256", assessment["artifact"]["sha256"]],
        [],
        style_header(["Severity", "Count"]),
    ]
    for severity in ["critical", "high", "medium", "low", "info"]:
        summary_rows.append([severity, assessment["findingCounts"].get(severity, 0)])
    summary_rows.extend([
        [],
        style_header(["Check", "Status"]),
        ["Archive path safety", "Completed" if assessment["archive"].get("extracted") else "Completed with limitation"],
        ["Secret scanning", "Completed"],
        ["Certificate and TLS security", "Completed"],
        ["Dependency inventory", "Completed"],
        ["npm audit", "Completed" if assessment["npmAudit"].get("attempted") else "Not applicable"],
        ["SBOM generation", "Completed"],
    ])
    sheets = [
        ("Summary", summary_rows, [32, 90]),
        ("Findings", finding_rows(assessment["findings"]), [16, 28, 80, 80]),
        ("Certificates", certificate_rows(assessment.get("certificateScan") or {}), [16, 42, 18, 12, 50, 50, 24, 60]),
        ("Components", component_rows(assessment["components"]), [24, 42, 22, 48]),
        ("npm Audit", npm_audit_rows(assessment["npmAudit"]), [36, 18, 18, 60]),
    ]
    content_types = [
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
        '<Default Extension="xml" ContentType="application/xml"/>',
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>',
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>',
    ]
    for index in range(1, len(sheets) + 1):
        content_types.append(f'<Override PartName="/xl/worksheets/sheet{index}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>')
    content_types.append("</Types>")
    workbook_sheets = "".join(
        f'<sheet name="{escape(name)}" sheetId="{index}" r:id="rId{index}"/>'
        for index, (name, _, _) in enumerate(sheets, start=1)
    )
    workbook_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        f"<sheets>{workbook_sheets}</sheets></workbook>"
    )
    rels_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
        "</Relationships>"
    )
    workbook_rels = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
                     '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">']
    for index in range(1, len(sheets) + 1):
        workbook_rels.append(f'<Relationship Id="rId{index}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet{index}.xml"/>')
    workbook_rels.append(f'<Relationship Id="rId{len(sheets) + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>')
    workbook_rels.append("</Relationships>")
    styles_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        '<fonts count="3"><font><sz val="11"/><name val="Calibri"/></font>'
        '<font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Calibri"/></font>'
        '<font><b/><sz val="16"/><color rgb="FF1F1F1F"/><name val="Calibri"/></font></fonts>'
        '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>'
        '<fill><patternFill patternType="solid"><fgColor rgb="FFD04A02"/><bgColor indexed="64"/></patternFill></fill></fills>'
        '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
        '<cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
        '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>'
        '<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>'
        '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>'
    )
    import io
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as package:
        package.writestr("[Content_Types].xml", "".join(content_types))
        package.writestr("_rels/.rels", rels_xml)
        package.writestr("xl/workbook.xml", workbook_xml)
        package.writestr("xl/_rels/workbook.xml.rels", "".join(workbook_rels))
        package.writestr("xl/styles.xml", styles_xml)
        for index, (_, rows, widths) in enumerate(sheets, start=1):
            package.writestr(f"xl/worksheets/sheet{index}.xml", xlsx_sheet_xml(rows, widths))
    return buffer.getvalue()


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
    certificate_scan = scan_certificates(files, extract_dir, findings)
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
        "certificateScan": certificate_scan,
        "npmAudit": npm_audit,
        "components": components,
        "findings": findings,
        "findingCounts": finding_counts,
        "decision": decision_for(findings),
    }
    assessment["sbom"] = create_sbom(artifact, components)
    assessment["llmReview"] = run_llm_review(assessment)
    assessment["reportMarkdown"] = build_markdown_report(assessment)
    report_excel = build_xlsx_report(assessment)
    (run_dir / "report.md").write_text(assessment["reportMarkdown"])
    (run_dir / "report.json").write_text(json.dumps(redact_value(assessment), indent=2))
    (run_dir / "sbom.json").write_text(json.dumps(assessment["sbom"], indent=2))
    (run_dir / "report.xlsx").write_bytes(report_excel)
    assessment["reportPath"] = str(run_dir / "report.md")
    assessment["jsonPath"] = str(run_dir / "report.json")
    assessment["sbomPath"] = str(run_dir / "sbom.json")
    assessment["excelPath"] = str(run_dir / "report.xlsx")
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
        if self.path not in {"/api/assess", "/api/guardrail-test"}:
            self.send_json(HTTPStatus.NOT_FOUND, {"error": "Route not found."})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            if self.path == "/api/guardrail-test":
                result = run_guardrail_test(payload)
                self.send_json(HTTPStatus.OK, {
                    "runId": result["runId"],
                    "decision": result["decision"],
                    "summary": result["summary"],
                    "promptSource": result["promptSource"],
                    "tests": result["tests"],
                    "reportMarkdown": result["reportMarkdown"],
                    "markdownPath": result["markdownPath"],
                    "jsonPath": result["jsonPath"],
                    "excelPath": result["excelPath"],
                })
                return
            result = assess_artifact(payload.get("fileName"), payload.get("contentBase64"))
            self.send_json(HTTPStatus.OK, {
                "runId": result["runId"],
                "decision": result["decision"],
                "findingCounts": result["findingCounts"],
                "findings": result["findings"],
                "components": result["components"][:150],
                "componentCount": len(result["components"]),
                "certificateScan": result["certificateScan"],
                "llmReview": result["llmReview"],
                "reportMarkdown": result["reportMarkdown"],
                "reportPath": result["reportPath"],
                "jsonPath": result["jsonPath"],
                "sbomPath": result["sbomPath"],
                "excelPath": result["excelPath"],
            })
        except Exception as exc:
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": redact_text(str(exc))})

    def do_GET(self):
        match = re.match(r"^/api/reports/([^/]+)/(report\.md|report\.json|report\.xlsx|sbom\.json|guardrail-report\.md|guardrail-report\.json|guardrail-report\.xlsx)$", self.path)
        if match:
            run_id, file_name = match.groups()
            file_path = (RUNS_DIR / run_id / file_name).resolve()
            if RUNS_DIR.resolve() in file_path.parents and file_path.exists():
                if file_name.endswith(".xlsx"):
                    content_type = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                elif file_name.endswith(".json"):
                    content_type = "application/json"
                else:
                    content_type = "text/markdown"
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
