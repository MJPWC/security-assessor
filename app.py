#!/usr/bin/env python3
import base64
import csv
import hashlib
import io
import json
import math
import os
import re
import shutil
import subprocess
import tarfile
import tempfile
import time
import traceback
import urllib.error
import urllib.request
import uuid
import zipfile
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from xml.sax.saxutils import escape

from llm_client import call_llm, llm_status, redact_text, redact_value
from quality_assessor import assess_quality
from security_tools.common import dedupe_vulnerabilities
from security_tools.dependency_check import run_dependency_check_scan
from security_tools.java_analysis import analyze_java_bytecode
from security_tools.llm_security import run_structured_security_llm
from security_tools.trivy_scanner import run_trivy_scan

APP_DIR = Path(__file__).resolve().parent
PUBLIC_DIR = APP_DIR / "public"

# RUNS_DIR intentionally lives OUTSIDE the app's own source tree.
#
# It used to be APP_DIR / "output" / "security-assessor" / "runs" -- i.e. inside
# this repo's own working directory. That meant every uploaded build's extracted
# contents, and every quality-check run's extracted contents, were written back
# into the assessor's own folder. If anyone ever packaged *this* repo up (e.g. to
# scan the assessor with itself, or a CI step that just tars the whole workspace)
# without explicitly excluding output/, the new upload contained every prior run,
# which then got extracted into yet another run under the same tree -- producing
# unbounded, recursively-nested output (observed locally at 150MB+ before this fix).
#
# Default: a directory outside the repo (OS temp dir). Override with
# SECURITY_ASSESSOR_RUNS_DIR for a persistent location if desired, but keep it
# outside any directory that might itself get zipped up and re-uploaded.
_DEFAULT_RUNS_DIR = Path(tempfile.gettempdir()) / "security-assessor-runs"
RUNS_DIR = Path(os.getenv("SECURITY_ASSESSOR_RUNS_DIR", str(_DEFAULT_RUNS_DIR))).resolve()

RESTRICTED_PROMPTS_PATH = APP_DIR / "restricted_prompts.json"
ALLOWED_PROMPTS_PATH = APP_DIR / "allowed_prompts.json"
PORT = int(os.getenv("SECURITY_ASSESSOR_PORT", "5050"))
MAX_UPLOAD_BYTES = int(os.getenv("SECURITY_ASSESSOR_MAX_UPLOAD_BYTES", str(50 * 1024 * 1024)))
# Cap on total bytes written to disk while extracting an archive. This bounds
# decompression ("zip bomb") blowup that MAX_UPLOAD_BYTES does not catch, since
# MAX_UPLOAD_BYTES only limits the size of the compressed file received over the
# wire, not what it expands to once extracted.
MAX_EXTRACTED_BYTES = int(os.getenv("SECURITY_ASSESSOR_MAX_EXTRACTED_BYTES", str(500 * 1024 * 1024)))
TEXT_FILE_LIMIT_BYTES = int(os.getenv("SECURITY_ASSESSOR_TEXT_FILE_LIMIT_BYTES", str(512 * 1024)))
MAX_WALK_FILES = int(os.getenv("SECURITY_ASSESSOR_MAX_WALK_FILES", "3000"))
MAX_PROMPT_FILE_BYTES = int(os.getenv("SECURITY_ASSESSOR_MAX_PROMPT_FILE_BYTES", str(1024 * 1024)))
MAX_PROMPTS_PER_RUN = int(os.getenv("SECURITY_ASSESSOR_MAX_PROMPTS_PER_RUN", "250"))
DELETE_RAW_FILES_AFTER_RUN = (os.getenv("SECURITY_ASSESSOR_DELETE_RAW_FILES_AFTER_RUN") or "").strip().lower() in {"1", "true", "yes"}
# A build package should never legitimately contain the assessor's own run
# output. If it does, it's a strong signal the upload was packaged from this
# app's own working directory without excluding output/ -- which is exactly
# the pattern that causes runaway recursive nesting. We flag and skip these
# paths rather than extracting them.
SELF_REFERENTIAL_PATH_MARKER = "security-assessor/output/security-assessor/runs"

TEXT_EXTENSIONS = {
    ".js", ".jsx", ".ts", ".tsx", ".json", ".yaml", ".yml", ".xml", ".properties",
    ".env", ".txt", ".md", ".py", ".java", ".gradle", ".pom", ".lock", ".toml",
    ".ini", ".conf", ".cfg", ".sh", ".bat", ".ps1", ".sql", ".raml", ".html", ".css",
}
CONFIG_FILE_NAMES = {
    ".env", ".env.local", "application.properties", "application.yml", "application.yaml",
    "bootstrap.properties", "bootstrap.yml", "bootstrap.yaml", "config.json", "settings.py",
}
# Extensions where an *unquoted* `KEY=value` is the normal way to write a
# literal string (.env, properties, shell exports, ini/conf/yaml-as-flat-kv,
# etc). Outside these, in real source code, a string literal must be quoted
# by the language's own syntax -- so an unquoted right-hand side there is
# always a variable, function/method call, number, boolean, or other
# expression, never a hardcoded secret string. Rather than pattern-matching
# every possible shape of "code" (which is an open-ended, ever-growing list),
# unquoted assignments are only treated as potential literal secrets when the
# file itself uses unquoted-literal syntax.
LITERAL_VALUE_FILE_EXTENSIONS = {
    ".env", ".properties", ".ini", ".conf", ".cfg", ".toml", ".sh", ".bat", ".ps1",
    ".yml", ".yaml",
}
LITERAL_VALUE_FILE_NAMES = {
    "dockerfile", "makefile", "envfile", "env",
}


def is_literal_value_file(rel):
    """True for files where an unquoted KEY=value is a real literal string
    (.env, shell scripts, ini/properties/toml, Dockerfiles), as opposed to
    source code files where an unquoted RHS is a code expression, not a
    string literal."""
    name = Path(str(rel or "")).name.lower()
    if name in LITERAL_VALUE_FILE_NAMES or name.startswith(".env"):
        return True
    suffix = Path(str(rel or "")).suffix.lower()
    return suffix in LITERAL_VALUE_FILE_EXTENSIONS

DEV_ENV_RE = re.compile(r"\b(dev|development|local|localhost|127\.0\.0\.1|staging|test|qa|sandbox)\b", re.I)
URL_RE = re.compile(r"\bhttps?://[^\s\"'<>)}]+", re.I)
COPYLEFT_LICENSE_RE = re.compile(r"\b(AGPL|GPL|LGPL|SSPL)\b", re.I)
PERMISSIVE_LICENSE_RE = re.compile(r"\b(MIT|Apache|BSD|ISC|MPL)\b", re.I)
UNPINNED_VERSION_RE = re.compile(r"^\s*(?:latest|\*|x|>=|>|~|\^)", re.I)

CERTIFICATE_EXTENSIONS = {".crt", ".cer", ".pem", ".der"}
KEYSTORE_EXTENSIONS = {".jks", ".keystore", ".p12", ".pfx"}
PRIVATE_KEY_EXTENSIONS = {".key"}
WEAK_CERT_SIGNATURE_RE = re.compile(r"Signature Algorithm:\s*(?:md5|sha1)", re.I)


def is_loopback_url(value):
    try:
        host = (urllib.parse.urlparse(str(value or "")).hostname or "").lower()
    except ValueError:
        return False
    return host in {"localhost", "::1", "0.0.0.0"} or host.startswith("127.")


def remove_loopback_urls(value):
    return URL_RE.sub(lambda match: "" if is_loopback_url(match.group(0)) else match.group(0), str(value or ""))

SECRET_PATTERNS = [
    ("OpenAI API key", "critical", re.compile(r"sk-(?:proj|svcacct)?-[A-Za-z0-9_-]{20,}")),
    ("Anthropic API key", "critical", re.compile(r"sk-ant-api[0-9a-z_-]*-[A-Za-z0-9_-]{20,}")),
    ("Groq API key", "critical", re.compile(r"\bgsk_[A-Za-z0-9_-]{20,}\b")),
    ("GitHub token", "critical", re.compile(r"\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}\b")),
    ("AWS access key", "critical", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    ("JWT", "high", re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b")),
    ("Private key block", "critical", re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----")),
    ("Bearer token", "high", re.compile(r"\bBearer\s+[A-Za-z0-9._~+/=-]{16,}")),
    ("Credentialed URL", "high", re.compile(r"\b(?:https?|mongodb(?:\+srv)?|postgres(?:ql)?|mysql|mssql|redis)://[^:\s/@]+:[^@\s]+@", re.I)),
]

SENSITIVE_ASSIGNMENT_RE = re.compile(
    r"\b(?P<key>[\w.-]*(?:api[_-]?key|apikey|token|secret|password|client[_-]?secret|authorization|x-api-key)[\w.-]*)\b"
    r"[ \t]*[:=][ \t]*(?:(?P<quote>[\"'`])(?P<quoted_value>[^\r\n]*?)(?P=quote)|(?P<config_value>\$\{[^}\r\n]+\}|#\{[^}\r\n]+\}|\{\{[^}\r\n]+\}\}|%[A-Z_][A-Z0-9_]*%|\$[A-Z_][A-Z0-9_]*)|(?P<value>[^\"'`,\s}\\)]+))",
    re.I,
)
CLIENT_ID_ASSIGNMENT_RE = re.compile(
    r"\b(?P<key>[\w.-]*(?:client[_-]?id|clientId)[\w.-]*)\b"
    r"[ \t]*[:=][ \t]*(?:(?P<quote>[\"'`])(?P<quoted_value>[^\r\n]*?)(?P=quote)|(?P<config_value>\$\{[^}\r\n]+\}|#\{[^}\r\n]+\}|\{\{[^}\r\n]+\}\}|%[A-Z_][A-Z0-9_]*%|\$[A-Z_][A-Z0-9_]*)|(?P<value>[^\"'`,\s}\\)]+))",
    re.I,
)
TOKEN_METRIC_ASSIGNMENT_RE = re.compile(
    r"\b[\w.-]*(?:token|tokens)[\w.-]*\b\s*[:=]\s*[\"']?"
    r"(?:usage\.|[\w.]*[_-](?:prompt|completion|input|output|total|cached|reasoning)[_-]?tokens?\b|\d+\b)",
    re.I,
)
NON_SECRET_TOKEN_KEY_RE = re.compile(
    r"(?:^|[_\-.])(?:token|tokens)?(?:count|counts|usage|used|limit|budget|remaining|total|prompt|completion|input|output|cached|reasoning|byday|bydate|daily|monthly|estimate|estimated|created|created_at|expires|resolved|el)(?:s|tokens)?(?:$|[_\-.])|"
    r"(?:prompt|completion|input|output|total|cached|reasoning|usage|count|counts|limit|budget|remaining|byday|bydate|daily|monthly|estimate|estimated|created|expires|resolved).*tokens?",
    re.I,
)
# Compound identifiers that happen to contain a sensitive substring (token,
# secret, auth, password, key) as part of an unrelated English word, not as a
# standalone "secret-like" variable name. Without this, `token` matches inside
# `tokenizer`/`tokenize`, `secret` inside `secretary`, etc. -- flagging things
# like `cls.tokenizer = ...` as if it were a credential assignment. This is a
# secondary/defense-in-depth check on top of the file-type-aware unquoted-
# value rule below, since compound words can theoretically show up in .env/
# .yaml files too.
NON_SECRET_COMPOUND_KEY_RE = re.compile(
    r"(?:token(?:s)?(?:izer|ize[rd]?|ization|izing)|secretar(?:y|iat)|passwordless)",
    re.I,
)
NON_SECRET_STORAGE_KEY_RE = re.compile(
    r"(?:^|[_\-.])(?:local|session)?[_\-.]*(?:storage|storeage|store|cache|cookie)[_\-.]*(?:key|name|id)s?(?:$|[_\-.])|"
    r"(?:^|[_\-.])(?:key|name|id)[_\-.]*(?:for[_\-.]*)?(?:local|session)?[_\-.]*(?:storage|storeage|store|cache|cookie)(?:$|[_\-.])",
    re.I,
)
NON_SECRET_URI_KEY_RE = re.compile(r"(?:uri|url|endpoint|host|domain|issuer|audience)$", re.I)
NON_SECRET_AUTH_CONFIG_KEY_RE = re.compile(r"(?:grant|grants|granttypes|grant_types|scopes|methods|flows)$", re.I)
PLACEHOLDER_SECRET_RE = re.compile(
    r"^(?:<[^>]+>|\$\{?.*}?\)?|process\.env\.[\w.]+|import\.meta\.env\.[\w.]+|env\.[\w.]+|os\.environ(?:\.get)?\(?[\"']?[\w.]+|"
    r"your[_-]?[a-z0-9_-]*|my[_-]?[a-z0-9_-]*|change_?me|changeme|todo|tbd|redacted|example|sample|dummy|placeholder|"
    r"abc(?:123)?|xyz(?:789)?|foo|bar|baz|null|none|undefined|true|false)$",
    re.I,
)
OAUTH_GRANT_VALUE_RE = re.compile(r"^(?:authorization_code|client_credentials|refresh_token|password|implicit|urn:[\w:.-]+)$", re.I)
FRONTEND_REFERENCE_RE = re.compile(r"(?:document\.getElementById|querySelector|input\.value|event\.target\.value|formData\.get|localStorage\.getItem|sessionStorage\.getItem)", re.I)
RUNTIME_VALUE_REFERENCE_RE = re.compile(
    r"(?:"
    r"\b(?:data|entry|session|request|credentials|payload|headers|params|query|body|form|response|response_data|res|req|[\w]+_data)\.get\s*\(|"
    r"\b(?:response|res)\.json\s*\(|"
    r"\bos\.environ(?:\.get)?\s*\(|"
    r"\b(?:config|settings)\.[A-Za-z_][\w.]*|"
    r"\b(?:str|int|float|bool)\s*\("
    r")",
    re.I,
)
CONFIG_REFERENCE_RE = re.compile(
    r"^(?:"
    r"\$\{[^}]+\}|"
    r"#\{[^}]+\}|"
    r"\{\{[^}]+\}\}|"
    r"%[A-Z_][A-Z0-9_]*%|"
    r"\$[A-Z_][A-Z0-9_]*"
    r")$",
    re.I,
)
CONFIG_REFERENCE_FRAGMENT_RE = re.compile(
    r"(?:\\?\$\{[^}]+\}|#\{[^}]+\}|\{\{[^}]+\}\}|%[A-Z_][A-Z0-9_]*%|\$[A-Z_][A-Z0-9_]*)",
    re.I,
)
GENERIC_QUOTED_LITERAL_RE = re.compile(r"(?P<quote>[\"'])(?P<value>[A-Za-z0-9][A-Za-z0-9._~+/=-]{15,})(?P=quote)")
SENSITIVE_LITERAL_CONTEXT_RE = re.compile(
    r"(?:api[_-]?key|apikey|x-api-key|token|secret|password|authorization|bearer|client[_-]?secret|clientSecret|os\.environ|getenv)",
    re.I,
)
ENV_VAR_NAME_RE = re.compile(r"^[A-Z][A-Z0-9_]{5,}$")
LOW_VALUE_SECRET_LITERAL_RE = re.compile(
    r"^(?:secret123|password123|changeme123|example[_-]?secret|dummy[_-]?token|"
    r"abc(?:1234567890)?|xyz(?:789)?|[a-z]{1,4}123(?:4567890)?)$",
    re.I,
)
MODEL_OR_VERSION_LITERAL_RE = re.compile(
    r"^(?:[a-z0-9_.-]+/)?(?:gpt|claude|gemini|llama|mistral|mixtral|deepseek|qwen|command|cohere|openai|anthropic|groq|model)[a-z0-9_.:/-]*$",
    re.I,
)
MEDIA_TYPE_LITERAL_RE = re.compile(r"^[a-z][a-z0-9.+-]*/[a-z0-9][a-z0-9.+-]*(?:;[a-z0-9=_.+ -]+)?$", re.I)

SEVERITY_RANK = {"critical": 4, "high": 3, "medium": 2, "low": 1, "info": 0}
SEVERITY_SORT = {"critical": 0, "high": 1, "medium": 2, "low": 3, "info": 4}
DEFAULT_BLOCK_SIGNALS = ["blocked", "warning", "not allowed", "restricted", "policy", "cannot comply", "i can't help", "unauthorized", "forbidden"]
BLOCKING_HTTP_STATUSES = {400, 401, 403, 406, 409, 422, 429}
DOCUMENTATION_OR_RULE_PATH_RE = re.compile(r"(?:^|/)(?:docs?|examples?|samples?|rulesets?|readme|changelog|release-notes?|.*\.md|.*\.txt)(?:/|$)", re.I)


def add_finding(findings, severity, task, details, evidence=None):
    findings.append({
        "id": f"{re.sub(r'[^a-z0-9]+', '-', task.lower()).strip('-')}-{len(findings) + 1}",
        "severity": severity,
        "task": task,
        "details": details,
        "evidence": redact_value(evidence or {}),
    })


def sorted_security_findings(findings):
    return sorted(
        findings,
        key=lambda item: (
            SEVERITY_SORT.get(item.get("severity", "info"), 9),
            item.get("task", ""),
            item.get("details", ""),
            item.get("id", ""),
        ),
    )


def group_security_findings(findings):
    grouped = {}
    order = []
    for item in findings:
        key = (item.get("severity", ""), item.get("task", ""), item.get("details", ""))
        evidence = item.get("evidence") or {}
        if key not in grouped:
            grouped[key] = {
                **item,
                "count": 0,
                "occurrences": [],
                "_occurrenceKeys": set(),
            }
            order.append(key)
        occurrence_key = json.dumps(evidence, sort_keys=True, default=str)
        if occurrence_key in grouped[key]["_occurrenceKeys"]:
            continue
        grouped[key]["_occurrenceKeys"].add(occurrence_key)
        grouped[key]["occurrences"].append(evidence)
        grouped[key]["count"] += 1

    results = []
    for key in order:
        item = grouped[key]
        item.pop("_occurrenceKeys", None)
        if item["count"] <= 1:
            item.pop("occurrences", None)
            item.pop("count", None)
        else:
            item["evidence"] = {"occurrences": item["occurrences"][:50]}
        results.append(item)
    return results


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


def is_self_referential_entry(name):
    """True if this archive entry looks like the assessor's own prior run
    output (see SELF_REFERENTIAL_PATH_MARKER). Such entries are dropped from
    extraction rather than written to disk, to prevent an upload that was
    accidentally packaged from this app's own working directory from causing
    recursive, ever-growing nested output."""
    normalized = str(name).replace("\\", "/").lower()
    return SELF_REFERENTIAL_PATH_MARKER in normalized


class ExtractedSizeLimitExceeded(Exception):
    pass


def safe_extract_zip(archive_path, extract_dir, findings):
    with zipfile.ZipFile(archive_path) as package:
        infos = package.infolist()
        names = [info.filename for info in infos]
        unsafe = [name for name in names if not is_safe_archive_entry(name)]
        if unsafe:
            add_finding(findings, "critical", "Archive path safety", "Archive contains unsafe paths that could write outside the extraction directory.", {"entries": unsafe[:10]})
            return {"extracted": False, "entries": names[:500]}

        self_referential = [name for name in names if is_self_referential_entry(name)]
        if self_referential:
            add_finding(
                findings, "medium", "Self-referential upload",
                "Archive contains the security assessor's own prior run output "
                "(output/security-assessor/runs/...). These entries were skipped "
                "during extraction to avoid recursive nesting. Repackage the build "
                "without including that directory.",
                {"entries": self_referential[:10], "skippedCount": len(self_referential)},
            )

        total_declared = sum(info.file_size for info in infos if not info.is_dir())
        if total_declared > MAX_EXTRACTED_BYTES:
            add_finding(findings, "critical", "Archive extraction", "Archive's uncompressed size exceeds the extraction limit; extraction was aborted.", {
                "declaredUncompressedBytes": total_declared,
                "limitBytes": MAX_EXTRACTED_BYTES,
            })
            return {"extracted": False, "entries": names[:500]}

        written_bytes = 0
        for info in infos:
            if info.is_dir() or is_self_referential_entry(info.filename):
                continue
            written_bytes += info.file_size
            if written_bytes > MAX_EXTRACTED_BYTES:
                add_finding(findings, "critical", "Archive extraction", "Extraction aborted after exceeding the maximum allowed extracted size.", {
                    "limitBytes": MAX_EXTRACTED_BYTES,
                })
                return {"extracted": False, "entries": names[:500]}
            package.extract(info, extract_dir)
        return {"extracted": True, "entries": names[:500]}


def safe_extract_tar(archive_path, extract_dir, findings):
    with tarfile.open(archive_path) as package:
        members = package.getmembers()
        names = [member.name for member in members]
        unsafe = [name for name in names if not is_safe_archive_entry(name)]
        if unsafe:
            add_finding(findings, "critical", "Archive path safety", "Tar archive contains unsafe paths that could write outside the extraction directory.", {"entries": unsafe[:10]})
            return {"extracted": False, "entries": names[:500]}

        self_referential = [name for name in names if is_self_referential_entry(name)]
        if self_referential:
            add_finding(
                findings, "medium", "Self-referential upload",
                "Archive contains the security assessor's own prior run output "
                "(output/security-assessor/runs/...). These entries were skipped "
                "during extraction to avoid recursive nesting. Repackage the build "
                "without including that directory.",
                {"entries": self_referential[:10], "skippedCount": len(self_referential)},
            )

        safe_members = [
            member for member in members
            if (member.isfile() or member.isdir()) and not is_self_referential_entry(member.name)
        ]

        total_declared = sum(member.size for member in safe_members if member.isfile())
        if total_declared > MAX_EXTRACTED_BYTES:
            add_finding(findings, "critical", "Archive extraction", "Archive's uncompressed size exceeds the extraction limit; extraction was aborted.", {
                "declaredUncompressedBytes": total_declared,
                "limitBytes": MAX_EXTRACTED_BYTES,
            })
            return {"extracted": False, "entries": names[:500]}

        written_bytes = 0
        for member in safe_members:
            if member.isfile():
                written_bytes += member.size
                if written_bytes > MAX_EXTRACTED_BYTES:
                    add_finding(findings, "critical", "Archive extraction", "Extraction aborted after exceeding the maximum allowed extracted size.", {
                        "limitBytes": MAX_EXTRACTED_BYTES,
                    })
                    return {"extracted": False, "entries": names[:500]}
            package.extract(member, extract_dir)
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


def walk_files(root_dir, findings=None):
    files = []
    truncated = False
    for current, dirs, names in os.walk(root_dir):
        dirs[:] = [name for name in dirs if not (Path(current) / name).is_symlink()]
        for name in names:
            if len(files) >= MAX_WALK_FILES:
                truncated = True
                break
            path = Path(current) / name
            if not path.is_symlink() and path.is_file():
                files.append(path)
        if truncated:
            break
    if truncated and findings is not None:
        # Previously this cap was hit silently: the report would look complete
        # (e.g. "Approved for dev deployment") while a large fraction of the
        # build was never actually scanned. Surface it as a finding instead.
        add_finding(
            findings, "medium", "Scan coverage",
            f"File scan limit reached ({MAX_WALK_FILES} files). Some files in this "
            "build were not scanned; results below may be incomplete. Increase "
            "SECURITY_ASSESSOR_MAX_WALK_FILES to scan the full build.",
            {"maxWalkFiles": MAX_WALK_FILES},
        )
    return files


def should_read_as_text(file_path):
    try:
        if file_path.stat().st_size > TEXT_FILE_LIMIT_BYTES:
            return False
    except OSError:
        return False
    return file_path.suffix.lower() in TEXT_EXTENSIONS or file_path.name.lower() in {"requirements.txt", "pipfile", "license", "copying"} or file_path.name.lower().startswith(".env")


def line_number_for_offset(text, offset):
    """1-indexed line number for a character offset into text."""
    return text.count("\n", 0, offset) + 1


def line_text_at_offset(text, offset):
    """The full source line (trimmed) containing the given character offset,
    used to show *where* a match sits -- e.g. the variable/field name it was
    assigned to -- without needing a second file read."""
    line_start = text.rfind("\n", 0, offset) + 1
    line_end = text.find("\n", offset)
    if line_end == -1:
        line_end = len(text)
    return text[line_start:line_end].strip()


def scan_secrets(files, extract_dir, findings):
    scanned = 0
    false_positives = []
    needs_review = []
    for file_path in files:
        if not should_read_as_text(file_path):
            continue
        scanned += 1
        text = file_path.read_text(errors="ignore")
        rel = str(file_path.relative_to(extract_dir))
        known_secret_spans = []
        for name, severity, pattern in SECRET_PATTERNS:
            pattern_matches = list(pattern.finditer(text))
            matches = [match.group(0) for match in pattern_matches]
            known_secret_spans.extend((match.start(), match.end()) for match in pattern_matches)
            if matches:
                sample = matches[0] if isinstance(matches[0], str) else str(matches[0])
                first_match = pattern_matches[0]
                match_lines = sorted({line_number_for_offset(text, m.start()) for m in pattern_matches})
                add_finding(findings, severity, "Secret scanning", f"{name} detected in packaged text content.", {
                    "file": rel,
                    "line": match_lines[0],
                    "lines": match_lines[:50],
                    "matchCount": len(matches),
                    "classification": "TRUE_POSITIVE",
                    "confidence": "high",
                    "context": redact_text(line_text_at_offset(text, first_match.start()))[:200],
                    "sample": redact_text(sample)[:160],
                })
        sensitive_matches = list(SENSITIVE_ASSIGNMENT_RE.finditer(text))
        sensitive_assignment_spans = [(match.start(), match.end()) for match in sensitive_matches]
        for analysis in scan_generic_secret_literals(text, rel, known_secret_spans + sensitive_assignment_spans):
            if analysis["classification"] == "FALSE_POSITIVE":
                false_positives.append(analysis)
                continue
            if analysis["classification"] == "NEEDS_REVIEW":
                needs_review.append(analysis)
            add_finding(findings, analysis["severity"], "Secret scanning", analysis["details"], {
                "file": rel,
                "line": analysis["line"],
                "matchCount": 1,
                "classification": analysis["classification"],
                "confidence": analysis["confidence"],
                "reason": analysis["reason"],
                "sample": redact_text(analysis["sample"])[:160],
            })
        sensitive_assignments = []
        client_secret_analyses = []
        client_id_analyses = []
        for match in sensitive_matches:
            analysis = analyze_sensitive_assignment(match.group("key"), assignment_match_value(match), match.group(0), match.group("quote"), rel)
            if not analysis:
                continue
            analysis["file"] = rel
            analysis["line"] = line_number_for_offset(text, match.start())
            if analysis["classification"] == "FALSE_POSITIVE":
                false_positives.append(analysis)
            elif analysis["classification"] == "NEEDS_REVIEW":
                if "client" in analysis["key"].lower() and "secret" in analysis["key"].lower():
                    client_secret_analyses.append(analysis)
                needs_review.append(analysis)
                sensitive_assignments.append(analysis)
            else:
                if "client" in analysis["key"].lower() and "secret" in analysis["key"].lower():
                    client_secret_analyses.append(analysis)
                sensitive_assignments.append(analysis)
        for match in CLIENT_ID_ASSIGNMENT_RE.finditer(text):
            analysis = analyze_client_id_assignment(match.group("key"), assignment_match_value(match), match.group(0), match.group("quote"), rel)
            if analysis:
                analysis["file"] = rel
                analysis["line"] = line_number_for_offset(text, match.start())
                client_id_analyses.append(analysis)
        if client_id_analyses and client_secret_analyses:
            client_pair = client_id_analyses[0]
            sensitive_assignments.append({
                "severity": "high",
                "classification": "TRUE_POSITIVE",
                "confidence": "high",
                "reason": "Non-placeholder clientId/clientSecret pair appears hardcoded in the same file.",
                "key": client_pair["key"],
                "sample": client_pair["sample"],
                "file": rel,
                "line": client_pair["line"],
            })
        by_assignment_type = {}
        for analysis in sensitive_assignments:
            if analysis["classification"] == "FALSE_POSITIVE":
                continue
            key = (analysis["severity"], analysis["classification"], analysis["key"])
            by_assignment_type.setdefault(key, []).append(analysis)
        for (severity, classification, assignment_key), analyses in by_assignment_type.items():
            sample = analyses[0]
            details = "Possible secret-like assignment detected in packaged text content."
            if classification == "NEEDS_REVIEW":
                details = "Ambiguous secret-like assignment needs review."
            elif assignment_key:
                details = f"Possible secret-like assignment detected for `{assignment_key}`."
            match_lines = sorted({a["line"] for a in analyses if a.get("line")})
            add_finding(findings, severity, "Secret scanning", details, {
                "file": rel,
                "line": match_lines[0] if match_lines else None,
                "lines": match_lines[:50],
                "matchCount": len(analyses),
                "key": sample["key"],
                "classification": classification,
                "confidence": sample["confidence"],
                "reason": sample["reason"],
                "sample": redact_text(sample["sample"])[:160],
            })
    return {
        "scannedFiles": scanned,
        "falsePositiveCount": len(false_positives),
        "needsReviewCount": len(needs_review),
        "falsePositives": [
            {
                "file": item["file"],
                "line": item.get("line"),
                "key": item["key"],
                "classification": item["classification"],
                "reason": item["reason"],
                "sample": redact_text(item["sample"])[:160],
            }
            for item in false_positives[:100]
        ],
    }


def shannon_entropy(value):
    text = str(value or "")
    if not text:
        return 0.0
    return -sum((text.count(char) / len(text)) * math.log2(text.count(char) / len(text)) for char in set(text))


def spans_overlap(start, end, spans):
    return any(start < span_end and end > span_start for span_start, span_end in spans)


def is_low_value_secret_literal(value):
    text = str(value or "").strip()
    if not text:
        return True
    if LOW_VALUE_SECRET_LITERAL_RE.fullmatch(text):
        return True
    repeated_chars = len(set(text)) <= 3 and len(text) >= 8
    return repeated_chars


def is_env_var_name(value):
    return bool(ENV_VAR_NAME_RE.fullmatch(str(value or "").strip()))


def is_probably_secret_literal(value):
    text = str(value or "").strip()
    if len(text) < 16:
        return False
    if (
        is_env_var_name(text)
        or is_low_value_secret_literal(text)
        or PLACEHOLDER_SECRET_RE.fullmatch(text)
        or CONFIG_REFERENCE_RE.fullmatch(text)
        or re.fullmatch(r"https?://[^\s]+", text, re.I)
        or re.fullmatch(r"[a-z0-9.-]+\.[a-z]{2,}(?::\d+)?(?:/[^\s]*)?", text, re.I)
        or MODEL_OR_VERSION_LITERAL_RE.fullmatch(text)
        or MEDIA_TYPE_LITERAL_RE.fullmatch(text)
    ):
        return False
    if not (re.search(r"[A-Za-z]", text) and re.search(r"\d", text)):
        return False
    return shannon_entropy(text) >= 3.5


def scan_generic_secret_literals(text, rel, known_secret_spans):
    analyses = []
    for match in GENERIC_QUOTED_LITERAL_RE.finditer(text):
        if spans_overlap(match.start(), match.end(), known_secret_spans):
            continue
        value = match.group("value")
        line_start = text.rfind("\n", 0, match.start()) + 1
        line_end = text.find("\n", match.end())
        if line_end == -1:
            line_end = len(text)
        context = text[line_start:line_end]
        if not SENSITIVE_LITERAL_CONTEXT_RE.search(context):
            continue
        if not is_probably_secret_literal(value):
            continue
        context_is_strong = re.search(r"(?:authorization|bearer|api[_-]?key|apikey|x-api-key|client[_-]?secret|clientSecret)", context, re.I)
        analyses.append({
            "severity": "high",
            "classification": "TRUE_POSITIVE" if context_is_strong else "NEEDS_REVIEW",
            "confidence": "high" if context_is_strong else "medium",
            "reason": "High-entropy literal appears in a sensitive context.",
            "details": "Possible hardcoded secret literal detected in sensitive code context.",
            "key": "literal",
            "sample": context.strip(),
            "file": rel,
            "line": line_number_for_offset(text, match.start()),
        })
    return analyses


def is_code_reference_value(value):
    text = str(value or "").strip()
    return bool(
        CONFIG_REFERENCE_RE.fullmatch(text)
        or CONFIG_REFERENCE_FRAGMENT_RE.search(text)
        or text.startswith(("{", "["))
        or re.search(r"\b(?:process\.env|import\.meta\.env|env\.|os\.environ|config\.|settings\.|usage\.|response\.|request\.|req\.|res\.)", text, re.I)
        or FRONTEND_REFERENCE_RE.search(text)
        or RUNTIME_VALUE_REFERENCE_RE.search(text)
        or re.fullmatch(r"[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+", text)
        # A dotted identifier chain immediately followed by "(" -- e.g.
        # `tiktok.getEncoding(` or `cls.estimate_token(rules` -- is the start
        # of a function/method call, not a literal value. This shape shows up
        # because the value-capture group in SENSITIVE_ASSIGNMENT_RE excludes
        # the closing ")" (and any quote), so `foo.bar("x")` gets truncated to
        # `foo.bar(` and `foo.bar(x)` gets truncated to `foo.bar(x`. Match on
        # the *prefix* (identifier chain + open paren) rather than requiring
        # the whole captured text to be just that prefix, so both truncation
        # shapes -- with or without a captured argument -- are recognized.
        or re.match(r"^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\(", text)
    )


def assignment_match_value(match):
    return match.group("quoted_value") if match.group("quote") else (match.group("config_value") or match.group("value"))


def normalized_identifier(value):
    return re.sub(r"[^a-z0-9]", "", str(value or "").lower())


def is_same_identifier_reference(key, value):
    key_norm = normalized_identifier(key.split(".")[-1])
    value_norm = normalized_identifier(str(value or "").strip().split(".")[-1])
    return bool(key_norm and value_norm and key_norm == value_norm)


def classified_false_positive(key, sample, reason):
    return {
        "severity": "info",
        "classification": "FALSE_POSITIVE",
        "confidence": "none",
        "reason": reason,
        "key": str(key or ""),
        "sample": sample,
    }


def analyze_client_id_assignment(key, value, sample, quote="", source_file=""):
    value_text = str(value or "").strip().strip("\"'`;")
    if not value_text:
        return None
    if not quote and not is_literal_value_file(source_file) and not re.fullmatch(r"[+-]?\d+(?:\.\d+)?|true|false|null|none|nil|undefined", value_text, re.I):
        return None
    if (
        PLACEHOLDER_SECRET_RE.fullmatch(value_text)
        or is_code_reference_value(value_text)
        or is_same_identifier_reference(key, value_text)
        or RUNTIME_VALUE_REFERENCE_RE.search(sample)
    ):
        return None
    if re.fullmatch(r"\d+(?:\.\d+)?", value_text):
        return None
    if len(value_text) < 8:
        return None
    return {
        "severity": "info",
        "classification": "NEEDS_REVIEW",
        "confidence": "medium",
        "reason": "Client ID literal found.",
        "key": str(key or ""),
        "sample": sample,
    }


def is_documentation_or_rule_file(rel):
    rel_text = str(rel or "").replace("\\", "/")
    name = Path(rel_text).name.lower()
    return bool(
        DOCUMENTATION_OR_RULE_PATH_RE.search(rel_text)
        or name.endswith((".md", ".txt", ".rst"))
        or "ruleset" in rel_text.lower()
    )


def analyze_sensitive_assignment(key, value, sample, quote="", source_file=""):
    key_text = str(key or "")
    key_lower = key_text.lower()
    value_text = str(value or "").strip().strip("\"'`;")
    value_lower = value_text.lower()
    if not value_text:
        return None
    if not quote and not is_literal_value_file(source_file) and not re.fullmatch(r"[+-]?\d+(?:\.\d+)?|true|false|null|none|nil|undefined", value_text, re.I):
        # Unquoted right-hand side in a real source file (not .env/.yaml/
        # .properties/etc). String literals must be quoted in every language
        # this scanner supports, so an unquoted RHS here can only be a
        # variable reference, function/method call, computed expression, or
        # a bare number/boolean/null -- never a hardcoded secret string.
        # This replaces trying to enumerate every possible "this is code"
        # shape (dotted calls, multi-arg calls, ternaries, f-strings, etc.)
        # with one general rule based on what the value even *can* be.
        return classified_false_positive(key_text, sample, "Unquoted value in a source file is a code expression (variable, function call, or similar), not a hardcoded string literal.")
    if CONFIG_REFERENCE_FRAGMENT_RE.search(sample):
        return classified_false_positive(key_text, sample, "Configuration/property reference, not a hardcoded literal secret.")
    if is_documentation_or_rule_file(source_file) and re.search(r"(?<![A-Za-z0-9])secret123(?![A-Za-z0-9])", value_text, re.I):
        return classified_false_positive(key_text, sample, "Common documentation/example secret value, not a real credential.")
    if any(marker in sample for marker in ["(?!", "[^", "\\$\\{", "\\$\\["]):
        return classified_false_positive(key_text, sample, "Secret-detection regex or rule definition, not a credential value.")
    if re.fullmatch(r"(?:Optional|Union|List|Dict|Set|Tuple|Sequence|Mapping)\[[^\]]+\]", value_text):
        return classified_false_positive(key_text, sample, "Type annotation, not a credential value.")
    if is_same_identifier_reference(key_text, value_text):
        return classified_false_positive(key_text, sample, "Object shorthand or variable forwarding, not a hardcoded literal secret.")
    if RUNTIME_VALUE_REFERENCE_RE.search(sample):
        return classified_false_positive(key_text, sample, "Runtime request/session/config lookup, not a hardcoded literal secret.")
    if TOKEN_METRIC_ASSIGNMENT_RE.search(sample):
        return classified_false_positive(key_text, sample, "Token accounting or usage metadata, not a secret value.")
    if NON_SECRET_STORAGE_KEY_RE.search(key_lower):
        return classified_false_positive(key_text, sample, "Storage/cache/cookie key name, not a credential value.")
    if "token" in key_lower and NON_SECRET_TOKEN_KEY_RE.search(key_lower):
        return classified_false_positive(key_text, sample, "Variable name is token metadata/counter state.")
    if NON_SECRET_COMPOUND_KEY_RE.search(key_lower):
        return classified_false_positive(key_text, sample, "Sensitive substring is part of an unrelated identifier (e.g. tokenizer, secretary), not a credential variable.")
    if key_lower in {"max_tokens", "max-token", "maxtokens", "resolved_tokens", "resolvedtokens"}:
        return classified_false_positive(key_text, sample, "Token limit/accounting parameter, not a credential.")
    if key_lower.endswith(".access_token") and not re.search(r"[\"'][A-Za-z0-9._~+/=-]{16,}[\"']", sample):
        return classified_false_positive(key_text, sample, "Access token attribute reference without a hardcoded token literal.")
    if "authorization" in key_lower and NON_SECRET_URI_KEY_RE.search(key_lower):
        return classified_false_positive(key_text, sample, "Authorization URI/URL/endpoint configuration, not a credential.")
    if "authorization" in key_lower and NON_SECRET_AUTH_CONFIG_KEY_RE.search(key_lower):
        return classified_false_positive(key_text, sample, "OAuth authorization flow/grant configuration, not a credential.")
    if "authorization" in key_lower and value_lower == "bearer":
        return None
    if PLACEHOLDER_SECRET_RE.fullmatch(value_text):
        return classified_false_positive(key_text, sample, "Placeholder, example, environment reference, or intentionally empty value.")
    if is_code_reference_value(value_text):
        return classified_false_positive(key_text, sample, "Runtime reference or frontend value read, not a hardcoded literal secret.")
    if OAUTH_GRANT_VALUE_RE.fullmatch(value_text) and "authorization" in key_lower:
        return classified_false_positive(key_text, sample, "OAuth grant value, not a credential.")
    if value_lower.startswith(("http://", "https://")) and not re.search(r"://[^/\s:@]+:[^@\s]+@", value_lower):
        return classified_false_positive(key_text, sample, "URL without embedded credentials.")
    if re.fullmatch(r"[a-z0-9.-]+\.[a-z]{2,}(?::\d+)?(?:/[^\s]*)?", value_lower):
        return classified_false_positive(key_text, sample, "Domain/host value without embedded credentials.")
    if re.fullmatch(r"\d+(?:\.\d+)?", value_text):
        return classified_false_positive(key_text, sample, "Numeric value, counter, or limit.")
    entropy = shannon_entropy(value_text)
    has_secret_key = any(term in key_lower for term in ["apikey", "api_key", "x-api-key", "clientsecret", "client_secret", "password", "secret"])
    has_token_key = "token" in key_lower or "authorization" in key_lower
    if has_secret_key and len(value_text) >= 8:
        confidence = "high" if entropy >= 3.0 or len(value_text) >= 16 else "medium"
        severity = "high" if confidence == "high" else "medium"
        reason = "Sensitive key name with a literal value."
        classification = "TRUE_POSITIVE" if confidence == "high" else "NEEDS_REVIEW"
    elif has_token_key and len(value_text) >= 16 and entropy >= 3.0:
        severity = "high"
        confidence = "high"
        reason = "Token-like key with a long high-entropy literal value."
        classification = "TRUE_POSITIVE"
    elif has_token_key and len(value_text) >= 8:
        severity = "medium"
        confidence = "medium"
        reason = "Token-like key with a literal value that needs review."
        classification = "NEEDS_REVIEW"
    else:
        return classified_false_positive(key_text, sample, "Sensitive-looking variable name without evidence of a real literal secret.")
    return {
        "severity": severity,
        "classification": classification,
        "confidence": confidence,
        "reason": reason,
        "key": key_text,
        "sample": sample,
    }


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


def dependency_risk_review(components, findings):
    unpinned = []
    snapshots = []
    for component in components:
        version = str(component.get("version") or "")
        if not version or version == "unspecified":
            unpinned.append(component)
        elif UNPINNED_VERSION_RE.search(version):
            unpinned.append(component)
        if "snapshot" in version.lower():
            snapshots.append(component)
    if unpinned:
        add_finding(findings, "medium", "Dependency risk", "Unpinned or floating dependency versions were found.", {
            "count": len(unpinned),
            "examples": unpinned[:10],
        })
    if snapshots:
        add_finding(findings, "medium", "Dependency risk", "Snapshot dependencies were found in the deployable artifact.", {
            "count": len(snapshots),
            "examples": snapshots[:10],
        })
    return {
        "unpinnedCount": len(unpinned),
        "snapshotCount": len(snapshots),
    }


def extract_license_values_from_text(file_path, text):
    lower = file_path.name.lower()
    values = []
    try:
        if lower == "package.json":
            pkg = json.loads(text)
            license_value = pkg.get("license")
            if isinstance(license_value, str):
                values.append(license_value)
            elif isinstance(license_value, dict):
                values.append(str(license_value.get("type") or license_value.get("name") or ""))
            for item in pkg.get("licenses") or []:
                if isinstance(item, str):
                    values.append(item)
                elif isinstance(item, dict):
                    values.append(str(item.get("type") or item.get("name") or ""))
        elif lower == "pyproject.toml":
            match = re.search(r"(?m)^\s*license\s*=\s*([\"']?)(.+?)\1\s*$", text)
            if match:
                values.append(match.group(2).strip("{} "))
        elif lower == "pom.xml":
            values.extend(re.findall(r"<license>[\s\S]*?<name>(.*?)</name>[\s\S]*?</license>", text, re.I))
        elif lower in {"license", "license.md", "license.txt", "copying"}:
            values.append(text[:2000])
    except Exception:
        return values
    return [value.strip() for value in values if value and value.strip()]


def scan_license_risk(files, extract_dir, findings):
    license_entries = []
    manifest_count = 0
    for file_path in files:
        lower = file_path.name.lower()
        if lower not in {"package.json", "pyproject.toml", "pom.xml", "license", "license.md", "license.txt", "copying"}:
            continue
        if not should_read_as_text(file_path):
            continue
        rel = str(file_path.relative_to(extract_dir))
        text = file_path.read_text(errors="ignore")
        values = extract_license_values_from_text(file_path, text)
        if lower in {"package.json", "pyproject.toml", "pom.xml"}:
            manifest_count += 1
        for value in values:
            entry = {"file": rel, "license": value[:160]}
            license_entries.append(entry)
            if COPYLEFT_LICENSE_RE.search(value):
                add_finding(findings, "medium", "License risk", "Copyleft or restricted license evidence was found. Confirm license compatibility before deployment.", entry)
            elif not PERMISSIVE_LICENSE_RE.search(value) and lower not in {"license", "license.md", "license.txt", "copying"}:
                add_finding(findings, "low", "License risk", "Dependency or project license is present but not recognized by the simple allowlist.", entry)
    if manifest_count and not license_entries:
        add_finding(findings, "low", "License risk", "No project license metadata was found in recognized manifests.", {})
    return {
        "licenseEntries": license_entries[:100],
        "licenseCount": len(license_entries),
    }


def scan_configuration_security(files, extract_dir, findings):
    config_files = []
    hardcoded_urls = []
    unsafe_defaults = []
    dev_references = []
    for file_path in files:
        if not should_read_as_text(file_path):
            continue
        rel = str(file_path.relative_to(extract_dir))
        lower_name = file_path.name.lower()
        is_config = lower_name in CONFIG_FILE_NAMES or file_path.suffix.lower() in {".properties", ".yml", ".yaml", ".json", ".toml", ".ini", ".conf", ".cfg"}
        if not is_config:
            continue
        config_files.append(rel)
        text = file_path.read_text(errors="ignore")
        urls = [url for url in URL_RE.findall(text) if DEV_ENV_RE.search(url) and not is_loopback_url(url)]
        if urls:
            hardcoded_urls.append({"file": rel, "urls": urls[:5]})
        for idx, line in enumerate(text.splitlines(), start=1):
            lowered = line.lower()
            if re.search(r"\b(debug|trace)\s*[:=]\s*(true|1|yes|on)\b", lowered):
                unsafe_defaults.append({"file": rel, "line": idx, "setting": line.strip()[:160]})
            if re.search(r"\b(tls|ssl|verify|certificate|rejectunauthorized)\b.*\b(false|0|off|disabled)\b", lowered):
                unsafe_defaults.append({"file": rel, "line": idx, "setting": line.strip()[:160]})
            line_without_loopback_urls = remove_loopback_urls(line)
            if DEV_ENV_RE.search(line_without_loopback_urls) and not line.lstrip().startswith("#"):
                dev_references.append({"file": rel, "line": idx, "text": line.strip()[:160]})
    if hardcoded_urls:
        add_finding(findings, "medium", "Configuration security", "Environment-specific or non-production URLs were found in packaged config.", {
            "count": len(hardcoded_urls),
            "examples": hardcoded_urls[:10],
        })
    if unsafe_defaults:
        add_finding(findings, "high", "Configuration security", "Unsafe runtime defaults were found in packaged config.", {
            "count": len(unsafe_defaults),
            "examples": unsafe_defaults[:10],
        })
    if dev_references:
        add_finding(findings, "low", "Configuration security", "Development/test environment references were found in packaged config.", {
            "count": len(dev_references),
            "examples": dev_references[:10],
        })
    return {
        "configFiles": config_files[:100],
        "configFileCount": len(config_files),
        "hardcodedUrlCount": len(hardcoded_urls),
        "unsafeDefaultCount": len(unsafe_defaults),
        "devReferenceCount": len(dev_references),
    }


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


def find_pip_audit_targets(extract_dir):
    targets = []
    for current, dirs, names in os.walk(extract_dir):
        dirs[:] = [
            name for name in dirs
            if name not in {"node_modules", ".git", "dist", "build", "coverage", ".venv", "venv", "__pycache__"}
        ]
        current_path = Path(current)
        if "requirements.txt" in names:
            targets.append({"project": current_path, "file": current_path / "requirements.txt", "kind": "requirements"})
        if "pyproject.toml" in names:
            targets.append({"project": current_path, "file": current_path / "pyproject.toml", "kind": "pyproject"})
    return targets


def pip_audit_severity(vulnerability):
    aliases = {
        "critical": "critical",
        "high": "high",
        "moderate": "medium",
        "medium": "medium",
        "low": "low",
    }
    candidates = []

    def collect(value):
        if isinstance(value, str):
            candidates.append(value)
        elif isinstance(value, list):
            for item in value:
                collect(item)
        elif isinstance(value, dict):
            for key, item in value.items():
                if str(key).lower() in {"severity", "cvssv3_severity"}:
                    collect(item)
                elif str(key).lower() in {"database_specific", "severity"}:
                    collect(item)

    collect(vulnerability)
    for candidate in candidates:
        normalized = candidate.strip().lower()
        if normalized in aliases:
            return aliases[normalized]
    return "medium"


def run_pip_audit_if_possible(extract_dir, findings):
    targets = find_pip_audit_targets(extract_dir)
    if not targets:
        return {"attempted": False, "targets": [], "reason": "No requirements.txt or pyproject.toml files found"}
    if not shutil.which("pip-audit"):
        return {"attempted": False, "targets": [], "reason": "pip-audit command is not installed"}

    results = []
    total_vulnerabilities = 0
    attempted = False

    # pip-audit against a requirements.txt is pure static analysis of pinned
    # versions -- it never installs anything. Pointing pip-audit at a
    # pyproject.toml *project directory* instead of a lockfile is different:
    # to resolve dependencies, pip-audit can invoke the project's build
    # backend (setup.py / PEP 517 build hooks), which means an untrusted
    # uploaded build could execute arbitrary code on this server during a
    # "security scan". So by default we do NOT resolve pyproject.toml
    # projects; we just flag them and recommend exporting a requirements.txt
    # for audit. Set SECURITY_ASSESSOR_ALLOW_PYPROJECT_RESOLVE=true to opt
    # back into the old (unsafe) behavior in a fully trusted/sandboxed host.
    allow_pyproject_resolve = (os.getenv("SECURITY_ASSESSOR_ALLOW_PYPROJECT_RESOLVE") or "").strip().lower() in {"1", "true", "yes"}

    for target in targets:
        rel_target = "." if target["project"] == extract_dir else str(target["project"].relative_to(extract_dir))
        rel_file = str(target["file"].relative_to(extract_dir))
        target_vulnerabilities = 0
        target_ok = False
        error_message = None

        if target["kind"] == "pyproject" and not allow_pyproject_resolve:
            add_finding(findings, "info", "Known vulnerability scan",
                "Skipped pip-audit for a pyproject.toml project because resolving "
                "its dependencies can execute the project's own build backend "
                "code. Export a requirements.txt (e.g. `pip freeze` or "
                "`poetry export`) for a safe, static vulnerability audit, or set "
                "SECURITY_ASSESSOR_ALLOW_PYPROJECT_RESOLVE=true in a trusted, "
                "sandboxed environment to allow resolving it.",
                {"project": rel_target, "file": rel_file})
            results.append({
                "project": rel_target,
                "ok": False,
                "vulnerabilityCount": 0,
                "error": "skipped: pyproject.toml resolution disabled by default (build-backend execution risk)",
            })
            continue

        attempted = True
        try:
            command = [
                "pip-audit",
                "--format",
                "json",
                "--progress-spinner",
                "off",
                "--timeout",
                "60",
            ]
            service = (os.getenv("PIP_AUDIT_SERVICE") or "").strip()
            if service:
                command.extend(["--vulnerability-service", service])
            if target["kind"] == "requirements":
                command.extend(["--requirement", str(target["file"])])
            else:
                command.append(str(target["project"]))
            result = subprocess.run(
                command,
                cwd=target["project"],
                text=True,
                capture_output=True,
                timeout=90,
            )
            data = json.loads(result.stdout or "{}")
            dependencies = data.get("dependencies") or []
            for dependency in dependencies:
                package_name = dependency.get("name") or "unknown"
                installed_version = dependency.get("version") or "unknown"
                vulnerabilities = dependency.get("vulns") or dependency.get("vulnerabilities") or []
                target_vulnerabilities += len(vulnerabilities)
                for vulnerability in vulnerabilities:
                    aliases = vulnerability.get("aliases") or []
                    vuln_id = vulnerability.get("id") or (aliases[0] if aliases else "unknown")
                    severity = pip_audit_severity(vulnerability)
                    fix_versions = vulnerability.get("fix_versions") or vulnerability.get("fixed_versions") or []
                    add_finding(findings, severity, "Known vulnerability scan", f"pip-audit reported a vulnerability for {package_name}.", {
                        "package": package_name,
                        "version": installed_version,
                        "vulnerability": vuln_id,
                        "project": rel_target,
                        "sourceFile": rel_file,
                        "fixVersions": fix_versions,
                    })
            total_vulnerabilities += target_vulnerabilities
            target_ok = result.returncode in {0, 1}
            if not target_ok and not dependencies:
                error_message = (result.stderr or result.stdout or "pip-audit failed").strip()[:1000]
                add_finding(findings, "medium", "Known vulnerability scan", "pip-audit did not return parseable dependency output.", {
                    "project": rel_target,
                    "sourceFile": rel_file,
                    "error": error_message,
                })
        except Exception as exc:
            error_message = str(exc)
            add_finding(findings, "medium", "Known vulnerability scan", "pip-audit did not return parseable output.", {
                "project": rel_target,
                "sourceFile": rel_file,
                "error": error_message,
            })

        results.append({
            "project": rel_target,
            "sourceFile": rel_file,
            "kind": target["kind"],
            "ok": target_ok,
            "vulnerabilityCount": target_vulnerabilities,
            "error": error_message,
        })

    return {
        "attempted": attempted,
        "targets": results,
        "vulnerabilityCount": total_vulnerabilities,
    }


def add_external_vulnerability_findings(vulnerabilities, findings):
    for vuln in vulnerabilities or []:
        scanner = vuln.get("scanner") or "external-scanner"
        vuln_id = vuln.get("cve_id") or "unknown vulnerability"
        component = vuln.get("component") or "unknown component"
        severity = vuln.get("severity") if vuln.get("severity") in SEVERITY_RANK else "medium"
        add_finding(
            findings,
            severity,
            "Known vulnerability scan",
            f"{scanner} reported {vuln_id} for {component}.",
            {
                "scanner": scanner,
                "vulnerability": vuln_id,
                "component": component,
                "version": vuln.get("version"),
                "fixedVersion": vuln.get("fixed_version"),
                "file": vuln.get("file_location"),
                "description": vuln.get("description"),
            },
        )


def add_java_analysis_findings(java_analysis, findings):
    if not java_analysis:
        return
    class_count = java_analysis.get("classFileCount", 0)
    decompile = java_analysis.get("decompile") or {}
    if class_count and not decompile.get("attempted"):
        add_finding(
            findings,
            "info",
            "Java bytecode analysis",
            "Java class files were found, but source decompilation was not run.",
            {
                "classFileCount": class_count,
                "reason": decompile.get("error") or "CFR decompiler not configured",
                "examples": (java_analysis.get("classFiles") or [])[:10],
            },
        )
    elif decompile.get("attempted") and not decompile.get("ok"):
        add_finding(
            findings,
            "medium",
            "Java bytecode analysis",
            "Java class decompilation was attempted but did not complete successfully.",
            {
                "classFileCount": class_count,
                "tool": decompile.get("tool"),
                "error": decompile.get("error"),
            },
        )

def decision_for(findings):
    worst = max([SEVERITY_RANK.get(item["severity"], 0) for item in findings] or [0])
    if worst >= SEVERITY_RANK["critical"]:
        return "Blocked"
    if worst >= SEVERITY_RANK["high"]:
        return "Blocked pending security review"
    if worst >= SEVERITY_RANK["medium"]:
        return "Conditional approval"
    return "Approved for dev deployment"


def score_status(score):
    if score >= 90:
        return "Good"
    if score >= 75:
        return "Review"
    if score >= 60:
        return "Needs attention"
    return "Weak"


def score_from_findings(findings, tasks, base=100):
    weights = {"critical": 40, "high": 25, "medium": 10, "low": 3, "info": 0}
    penalty = 0
    for item in findings:
        if item.get("task") in tasks:
            penalty += weights.get(item.get("severity", "info"), 0)
    return max(0, min(100, base - penalty))


def security_report_card(assessment):
    findings = assessment.get("findings") or []
    npm_vulns = (assessment.get("npmAudit") or {}).get("vulnerabilityCount", 0) or 0
    pip_vulns = (assessment.get("pipAudit") or {}).get("vulnerabilityCount", 0) or 0
    external_vulns = len(assessment.get("externalVulnerabilities") or [])
    cert_files = len((assessment.get("certificateScan") or {}).get("certificateFiles") or [])
    dependency_risk = assessment.get("dependencyRisk") or {}
    license_review = assessment.get("licenseReview") or {}
    configuration_security = assessment.get("configurationSecurity") or {}
    cards = [
        {
            "area": "Secrets safety",
            "score": score_from_findings(findings, {"Secret scanning", "Archive path safety"}),
            "status": "",
            "detail": "Hardcoded secrets, private keys, credentialed URLs, and unsafe archive paths.",
        },
        {
            "area": "Dependency risk",
            "score": max(0, score_from_findings(findings, {"Known vulnerability scan", "Dependency risk", "Dependency inventory"}) - min(30, (npm_vulns + pip_vulns + external_vulns) * 5)),
            "status": "",
            "detail": f"{len(assessment.get('components') or [])} component(s), {npm_vulns + pip_vulns + external_vulns} known vulnerability item(s).",
        },
        {
            "area": "Certificate/TLS",
            "score": score_from_findings(findings, {"Certificate and TLS security", "Certificate inventory"}),
            "status": "",
            "detail": f"{cert_files} certificate/key/keystore file(s) reviewed.",
        },
        {
            "area": "Config security",
            "score": score_from_findings(findings, {"Configuration security"}),
            "status": "",
            "detail": f"{configuration_security.get('configFileCount', 0)} config file(s), {configuration_security.get('unsafeDefaultCount', 0)} unsafe default(s).",
        },
        {
            "area": "License readiness",
            "score": score_from_findings(findings, {"License risk"}),
            "status": "",
            "detail": f"{license_review.get('licenseCount', 0)} license evidence item(s) reviewed.",
        },
        {
            "area": "SBOM readiness",
            "score": 100 if assessment.get("sbom") else 0,
            "status": "",
            "detail": "CycloneDX-lite dependency inventory generated.",
        },
    ]
    for card in cards:
        card["status"] = score_status(card["score"])
    return cards


def create_sbom(artifact, components, vulnerabilities=None):
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
        "vulnerabilities": [
            {
                "id": item.get("cve_id") or item.get("component") or "unknown",
                "source": {"name": item.get("scanner", "external-scanner")},
                "ratings": [{"severity": item.get("severity", "info")}],
                "affects": [{"ref": item.get("component", "unknown")}],
                "description": item.get("description", ""),
                "properties": [
                    {"name": "component", "value": item.get("component", "")},
                    {"name": "version", "value": item.get("version", "")},
                    {"name": "fixedVersion", "value": item.get("fixed_version", "")},
                    {"name": "fileLocation", "value": item.get("file_location", "")},
                ],
            }
            for item in (vulnerabilities or [])
        ],
    }


def run_llm_review(assessment):
    safe_assessment = redact_value({
        "artifact": assessment["artifact"],
        "decision": assessment["decision"],
        "findingCounts": assessment["findingCounts"],
        "findings": assessment["findings"],
        "externalVulnerabilities": assessment.get("externalVulnerabilities", [])[:80],
        "javaAnalysis": assessment.get("javaAnalysis"),
        "dependencySample": assessment["components"][:60],
        "certificateScan": assessment.get("certificateScan"),
        "dependencyRisk": assessment.get("dependencyRisk"),
        "licenseReview": assessment.get("licenseReview"),
        "configurationSecurity": assessment.get("configurationSecurity"),
        "npmAudit": assessment.get("npmAudit"),
        "pipAudit": assessment.get("pipAudit"),
        "trivyScan": {key: value for key, value in (assessment.get("trivyScan") or {}).items() if key != "vulnerabilities"},
        "dependencyCheck": {key: value for key, value in (assessment.get("dependencyCheck") or {}).items() if key != "vulnerabilities"},
        "llmStructuredReview": assessment.get("llmStructuredReview"),
    })
    try:
        return redact_text(call_llm([
            {"role": "system", "content": "You are a secure software release reviewer. Review only the sanitized scan summary. Do not ask for secrets or source code. Return concise risk assessment, missing checks, and deployment recommendation."},
            {"role": "user", "content": "Review this sanitized package security assessment and respond in Markdown:\n\n" + json.dumps(safe_assessment, indent=2)},
        ]))
    except Exception as exc:
        return "LLM review unavailable: " + redact_text(str(exc))


def run_quality_llm_review(payload):
    safe_payload = redact_value(payload)
    try:
        return redact_text(call_llm([
            {
                "role": "system",
                "content": (
                    "You are a senior code quality reviewer. Review the provided static quality findings and bounded redacted code samples. "
                    "Your primary output is an actionable table, not a narrative essay. "
                    "Return exactly these sections in Markdown, in this order:\n"
                    "## Executive Summary\n"
                    "2 to 3 sentences maximum. What this result means overall.\n\n"
                    "## Action Table\n"
                    "A Markdown table with these exact columns: "
                    "Finding | File/Line | Severity | Why It Matters | Suggested Fix Direction | Priority (1-5). "
                    "Include one row for every distinct finding provided in the payload. If omittedFindingCount is greater than 0, "
                    "add one final row summarizing that additional lower-priority findings were omitted from the LLM context. "
                    "Priority 1 means fix before release, 5 means safe to defer. "
                    "Every Suggested Fix Direction cell must name a concrete action "
                    "(for example: 'move key to environment variable', 'add null check before accessing X', "
                    "'wrap in try/except and log the error'). "
                    "Do not use vague language like 'review this area' or 'consider improving this'. "
                    "Do not provide full code patches, diffs, or exact line-by-line rewrites — one sentence of "
                    "direction per row is enough.\n\n"
                    "## Release Impact\n"
                    "1 to 2 sentences: does this block release, and why or why not.\n\n"
                    "Do not request secrets or full source code."
                ),
            },
            {
                "role": "user",
                "content": (
                    "Review this code quality assessment context and produce the required Action Table covering "
                    "every finding listed below, plus the Executive Summary and Release Impact sections.\n\n"
                    + json.dumps(safe_payload, indent=2)
                ),
            },
        ], config_label="Quality LLM", max_tokens=600))
    except Exception as exc:
        status = llm_status()
        providers = status.get("providers") or []
        fallback_hint = ""
        if providers == ["anthropic_gateway"]:
            fallback_hint = (
                "\n\nFallback was not attempted because no fallback LLM provider is configured. "
                "Set ANTHROPIC_API_KEY, ANTHROPIC_STANDARD_API_KEY, or ANTHROPIC_FALLBACK_API_KEY "
                "to enable automatic fallback to standard Anthropic."
            )
        return "LLM quality review unavailable: " + redact_text(str(exc)) + fallback_hint


def combined_deployment_verdict(security_payload, quality_payload, guardrail_payload=None):
    security_decision = str(security_payload.get("decision") or "").lower()
    quality_decision = str(quality_payload.get("decision") or "").lower()
    guardrail_payload = guardrail_payload or {}
    guardrail_decision = str(guardrail_payload.get("decision") or "").lower()
    if not security_decision or not quality_decision:
        raise ValueError("Both security and quality decisions are required.")

    blocking_issues = []
    review_items = []
    required_approvals = []
    prompt_guardrail_status = guardrail_payload.get("decision") if guardrail_payload else "Not run / not applicable"

    if "failed" in guardrail_decision:
        blocking_issues.append("Prompt guardrail failed")
        status = "Do not deploy"
        reason = "Prompt guardrail testing found unsafe or unexpected prompt behavior."
        required_action = "Fix prompt guardrail failures and rerun the prompt guardrail test before deployment."
    elif "blocked" in security_decision:
        if "pending security review" in security_decision:
            required_approvals.append("Security owner")
            review_items.append("Security assessment is blocked pending security review")
            status = "Do not deploy without security approval"
            reason = "Security assessment is blocked pending security review."
            required_action = "Get security owner approval or remediate the security findings, then rerun the assessment."
        else:
            blocking_issues.append("Package security assessment found blocking risk")
            status = "Do not deploy"
            reason = "Security assessment found blocking risk."
            required_action = "Fix the blocking security findings and rerun security and quality assessment."
    elif "failed" in quality_decision:
        blocking_issues.append("Quality assessment failed the quality gate")
        status = "Do not deploy"
        reason = "Quality assessment failed the quality gate."
        required_action = "Fix quality gate failures and rerun the quality assessment."
    elif "conditional" in security_decision and "passed" in quality_decision:
        required_approvals.append("Security owner")
        review_items.append("Security conditional findings require exception approval")
        status = "Conditional deploy"
        reason = "Quality passed, but security requires conditional approval."
        required_action = "Record the security exception/approval before deployment."
    elif "conditional" in security_decision:
        required_approvals.extend(["Security owner", "Quality reviewer"])
        review_items.extend([
            "Security conditional findings require exception approval",
            "Quality findings require review before release",
        ])
        status = "Conditional deploy"
        reason = "Security is conditional and quality still requires review."
        required_action = "Resolve or formally accept security and quality review items."
    elif "review recommended" in quality_decision:
        required_approvals.append("Quality reviewer")
        review_items.append("Quality findings require review before release")
        status = "Conditional deploy"
        reason = "Security is acceptable, but quality review is recommended."
        required_action = "Complete quality review approval or remediate the review findings."
    elif "warning" in guardrail_decision:
        required_approvals.append("Prompt guardrail reviewer")
        review_items.append("Prompt guardrail produced warnings")
        status = "Conditional deploy"
        reason = "Security and quality may be acceptable, but prompt guardrail testing produced warnings."
        required_action = "Review prompt guardrail warnings and document approval or rerun after fixing endpoint/configuration issues."
    elif "passed" in quality_decision and "approved" in security_decision:
        status = "Deployable"
        reason = "Security and quality checks are in acceptable states."
        if guardrail_decision:
            reason = "Security, quality, and prompt guardrail checks are in acceptable states."
        required_action = "Proceed with normal environment-specific release validation."
    else:
        status = "Review required before deployment"
        reason = "The combined assessment state is not clearly deployable."
        required_action = "Review security and quality reports before deployment."
        review_items.append("Assessment state needs manual release review")
    css_class = "pass" if status == "Deployable" else "fail" if blocking_issues or status.startswith("Do not deploy") else "medium"
    next_action = required_action
    return {
        "status": status,
        "className": css_class,
        "reason": reason,
        "requiredAction": required_action,
        "nextAction": next_action,
        "requiredApprovals": required_approvals or ["None"],
        "blockingIssues": blocking_issues or ["None"],
        "reviewItems": review_items or ["None"],
        "promptGuardrailStatus": prompt_guardrail_status,
        "securityDecision": security_payload.get("decision"),
        "guardrailDecision": guardrail_payload.get("decision") if guardrail_payload else "Not run / not applicable",
        "qualityDecision": quality_payload.get("decision"),
    }


def run_deployment_llm_advisory(verdict, security_payload, quality_payload, guardrail_payload=None):
    guardrail_payload = guardrail_payload or {}
    safe_payload = redact_value({
        "finalVerdict": verdict,
        "security": {
            "decision": security_payload.get("decision"),
            "findingCounts": security_payload.get("findingCounts"),
            "reportCard": security_payload.get("reportCard"),
            "topFindings": (security_payload.get("findings") or [])[:20],
        },
        "promptGuardrail": {
            "decision": guardrail_payload.get("decision") if guardrail_payload else "Not run / not applicable",
            "summary": guardrail_payload.get("summary") if guardrail_payload else {},
            "topTests": (guardrail_payload.get("tests") or [])[:20] if guardrail_payload else [],
        },
        "quality": {
            "decision": quality_payload.get("decision"),
            "score": quality_payload.get("score"),
            "findingCounts": quality_payload.get("findingCounts"),
            "reportCard": quality_payload.get("reportCard"),
            "topFindings": (quality_payload.get("findings") or [])[:20],
        },
    })
    try:
        return redact_text(call_llm([
            {
                "role": "system",
                "content": (
                    "You are a release readiness advisor. The deterministic final deployment verdict is already decided by policy. "
                    "Do not override or weaken it. Explain the verdict in concise Markdown with exactly these sections: "
                    "## Deployment Advisory, ## Top Reasons, ## Required Actions. Use short bullets."
                ),
            },
            {
                "role": "user",
                "content": "Explain this final deployment verdict using the security, prompt guardrail, and quality summaries:\n\n" + json.dumps(safe_payload, indent=2),
            },
        ], config_label="Deployment verdict LLM"))
    except Exception as exc:
        return "LLM deployment advisory unavailable: " + redact_text(str(exc))


def build_deployment_verdict(payload):
    security_payload = payload.get("security") or {}
    guardrail_payload = payload.get("guardrail") or {}
    quality_payload = payload.get("quality") or {}
    if not security_payload.get("findingCounts"):
        raise ValueError("Run package Security Assessment before requesting final deployment verdict.")
    if "score" not in quality_payload:
        raise ValueError("Run Quality Assessment before requesting final deployment verdict.")
    verdict = combined_deployment_verdict(security_payload, quality_payload, guardrail_payload)
    verdict["advisory"] = run_deployment_llm_advisory(verdict, security_payload, quality_payload, guardrail_payload)
    verdict["generatedAt"] = datetime.now(timezone.utc).isoformat()
    return verdict



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
    expected_key = re.sub(r"[^a-z0-9]+", "-", expected).strip("-")
    if expected in {"pass", "passed", "accept", "accepted", "allow", "allowed", "good", "safe", "normal"}:
        expected = "allowed"
    if expected_key in {
        "block",
        "blocked",
        "blocked-or-sanitized",
        "blocked-or-redacted",
        "deny",
        "denied",
        "reject",
        "rejected",
        "refuse",
        "refused",
        "sanitize",
        "sanitized",
        "redact",
        "redacted",
        "bad",
        "unsafe",
        "restricted",
        "malicious",
    }:
        expected = "blocked"
    if not expected:
        expected = "allowed" if prompt_type in {"allowed", "good", "safe", "normal"} else "blocked"
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


def multipart_fields_from_template(template, prompt, prompt_field):
    text = str(template or "").strip()
    fields = {}
    if text:
        try:
            parsed = replace_prompt_value(json.loads(text), prompt)
            if isinstance(parsed, dict):
                for key, value in parsed.items():
                    if value is None:
                        continue
                    fields[str(key)] = value if isinstance(value, str) else json.dumps(value)
        except json.JSONDecodeError:
            pass
    if prompt_field:
        fields[prompt_field] = prompt
    return fields


def multipart_body(fields, file_field, file_name, file_bytes):
    boundary = "----security-assessor-" + uuid.uuid4().hex
    chunks = []
    for key, value in fields.items():
        chunks.extend([
            f"--{boundary}\r\n".encode("utf-8"),
            f'Content-Disposition: form-data; name="{key}"\r\n\r\n'.encode("utf-8"),
            str(value).encode("utf-8"),
            b"\r\n",
        ])
    safe_file_name = safe_name(file_name or "upload.bin")
    chunks.extend([
        f"--{boundary}\r\n".encode("utf-8"),
        f'Content-Disposition: form-data; name="{file_field}"; filename="{safe_file_name}"\r\n'.encode("utf-8"),
        b"Content-Type: application/octet-stream\r\n\r\n",
        file_bytes,
        b"\r\n",
        f"--{boundary}--\r\n".encode("utf-8"),
    ])
    return b"".join(chunks), f"multipart/form-data; boundary={boundary}"


def evaluate_guardrail_block(response, expected_signals):
    status = response.get("status")
    body = str(response.get("body") or "").lower()
    if status in BLOCKING_HTTP_STATUSES:
        return True, f"Blocked by HTTP status {status}"
    for signal in expected_signals:
        if signal and signal in body:
            return True, f"Matched block signal: {signal}"
    return False, "No blocking status or expected warning text was observed"


def retry_after_seconds(headers, fallback_seconds):
    value = ""
    if headers:
        value = headers.get("Retry-After") or headers.get("retry-after") or ""
    try:
        seconds = float(value)
        return max(0.0, min(120.0, seconds))
    except (TypeError, ValueError):
        return fallback_seconds


def send_guardrail_prompt(config, prompt):
    data = None
    method = config["method"]
    headers = {"Content-Type": "application/json", **config["headers"]}
    url = config["targetUrl"].rstrip("/") + config["endpoint"]
    if method != "GET":
        if config.get("targetFileBytes"):
            fields = multipart_fields_from_template(config["bodyTemplate"], prompt, config.get("multipartPromptField") or "userInstruction")
            data, content_type = multipart_body(
                fields,
                config.get("multipartFileField") or "file",
                config.get("targetFileName") or "upload.bin",
                config["targetFileBytes"],
            )
            headers = {key: value for key, value in config["headers"].items() if key.lower() != "content-type"}
            headers["Content-Type"] = content_type
        else:
            data = request_body_from_template(config["bodyTemplate"], prompt)
    attempts = config["rateLimitRetries"] + 1
    for attempt in range(attempts):
        request = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=config["timeoutSeconds"]) as response:
                body = response.read(12000).decode("utf-8", errors="ignore")
                return {"ok": True, "status": response.status, "body": redact_text(body), "error": "", "attempts": attempt + 1}
        except urllib.error.HTTPError as exc:
            body = exc.read(12000).decode("utf-8", errors="ignore")
            if exc.code == 429 and attempt < attempts - 1:
                wait_seconds = retry_after_seconds(exc.headers, config["rateLimitDelaySeconds"])
                time.sleep(wait_seconds)
                continue
            return {"ok": False, "status": exc.code, "body": redact_text(body), "error": redact_text(str(exc)), "attempts": attempt + 1}
        except Exception as exc:
            return {"ok": False, "status": None, "body": "", "error": target_request_error_message(exc), "attempts": attempt + 1}
    return {"ok": False, "status": None, "body": "", "error": "Request failed after retry loop.", "attempts": attempts}


def target_request_error_message(exc):
    text = str(exc)
    lower = text.lower()
    if "connection refused" in lower or "errno 61" in lower or "errno 111" in lower:
        return "Target endpoint was unreachable: connection refused. Confirm the target app is running, the host/port is correct, and the endpoint is listening."
    if "timed out" in lower or "timeout" in lower:
        return "Target endpoint timed out. Confirm the target app is responsive or increase the timeout."
    if "name or service not known" in lower or "nodename nor servname" in lower or "temporary failure in name resolution" in lower:
        return "Target host could not be resolved. Check the target URL hostname."
    if "network is unreachable" in lower or "no route to host" in lower:
        return "Target host is not reachable from the Security Assessor machine. Check network, firewall, VPN, or cloud security group rules."
    return redact_text(text)


def target_endpoint_config_error(response, config):
    status = response.get("status")
    body = str(response.get("body") or "")
    body_lower = body.lower()
    target = config["targetUrl"].rstrip("/") + config["endpoint"]
    if status is None:
        return response.get("error") or f"Target endpoint could not be reached: {target}"
    if status == 404:
        return f"Prompt endpoint was not found: {target}. Check the running app URL and prompt endpoint path."
    if status == 405:
        return f"Prompt endpoint exists but does not allow {config['method']}. Check the HTTP method for {target}."
    if status == 415:
        return f"Prompt endpoint rejected the content type. Check headers and request body template for {target}."
    if status == 413:
        return "Prompt request is too large for the target endpoint. Reduce prompt size or target request payload."
    if status == 401:
        return "Target endpoint requires authentication. Add the required Authorization or API key header."
    if status == 403 and not any(signal in body_lower for signal in config["expectedSignals"]):
        return "Target endpoint returned 403 without an expected guardrail block signal. Check auth, permissions, CORS/API gateway rules, or endpoint access policy."
    if status == 400:
        request_shape_terms = [
            "bad request",
            "invalid json",
            "invalid request",
            "malformed",
            "missing",
            "required",
            "expected",
            "body",
            "payload",
            "field",
            "parameter",
            "schema",
            "content-type",
        ]
        guardrail_terms = ["blocked", "guardrail", "policy", "restricted", "not allowed", "cannot comply", "forbidden"]
        looks_like_request_shape_error = any(term in body_lower for term in request_shape_terms)
        looks_like_guardrail_block = any(term in body_lower for term in guardrail_terms)
        if looks_like_request_shape_error and not looks_like_guardrail_block:
            sample = redact_text(body)[:300] or response.get("error") or "HTTP 400"
            return (
                "Target endpoint returned HTTP 400 before guardrail evaluation. "
                "Check the request body template and required field names for this app. "
                f"Response sample: {sample}"
            )
    return ""


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
        f"- Allowed skipped: {result['summary'].get('allowedSkipped', 0)}",
        f"- Warnings: {result['summary']['warnings']}",
        "",
        "## Prompt Results",
        "",
        "| Prompt | Type | Severity | Result | HTTP | Attempts | Reason |",
        "| --- | --- | --- | --- | ---: | ---: | --- |",
    ]
    for item in result["tests"]:
        lines.append(f"| {item['name']} | {item['type']} | {item['severity']} | {item['result']} | {item.get('status') or ''} | {item.get('attempts') or ''} | {item['reason']} |")
    lines.extend([
        "",
        "## Evidence Notes",
        "",
        "Response samples are redacted and truncated in the JSON report.",
    ])
    return "\n".join(lines)


def guardrail_rows(result):
    headers = [
        "Prompt",
        "Type",
        "Severity",
        "Expected",
        "Result",
        "HTTP Status",
        "Attempts",
        "Reason",
        "Response Sample",
        "Error",
    ]
    rows = [style_header(headers)]
    for item in result.get("tests", []):
        rows.append([
            item.get("name", ""),
            item.get("type", ""),
            item.get("severity", ""),
            item.get("expected", ""),
            item.get("result", ""),
            item.get("status") or "",
            item.get("attempts") or "",
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
        ["Allowed skipped", result["summary"].get("allowedSkipped", 0)],
        ["Warnings", result["summary"]["warnings"]],
    ]
    sheets = [
        ("Summary", rows, [28, 90]),
        ("Prompt Results", guardrail_rows(result), [34, 14, 14, 18, 18, 14, 12, 52, 80, 60]),
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
        "executeAllowedPrompts": bool(payload.get("executeAllowedPrompts")),
        "rateLimitDelaySeconds": max(0.0, min(60.0, int(payload.get("rateLimitDelayMs") or 1000) / 1000.0)),
        "rateLimitRetries": max(0, min(10, int(payload.get("rateLimitRetries") or 2))),
    }
    if payload.get("targetFileContentBase64"):
        target_file_bytes = base64.b64decode(payload.get("targetFileContentBase64"))
        if len(target_file_bytes) > MAX_UPLOAD_BYTES:
            raise ValueError(f"Target endpoint file exceeds {MAX_UPLOAD_BYTES} bytes.")
        config["targetFileBytes"] = target_file_bytes
        config["targetFileName"] = payload.get("targetFileName") or "upload.bin"
        config["multipartFileField"] = str(payload.get("multipartFileField") or "file").strip() or "file"
        config["multipartPromptField"] = str(payload.get("multipartPromptField") or "userInstruction").strip() or "userInstruction"
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
    allowed_skipped = 0
    warnings = 0
    sent_prompt_count = 0
    for prompt_item in prompts:
        if prompt_item["expected"] == "allowed" and not config["executeAllowedPrompts"]:
            allowed_skipped += 1
            tests.append({
                "id": prompt_item["id"],
                "name": prompt_item["name"],
                "type": prompt_item["type"],
                "expected": prompt_item["expected"],
                "severity": prompt_item.get("severity", "info"),
                "result": "skipped",
                "passed": True,
                "status": "",
                "reason": "Allowed prompt was not sent to the target endpoint. Enable allowed-prompt execution only for guardrail-only or no-op endpoints.",
                "responseSample": "",
                "error": "",
                "attempts": "",
            })
            continue
        if sent_prompt_count and config["rateLimitDelaySeconds"]:
            time.sleep(config["rateLimitDelaySeconds"])
        response = send_guardrail_prompt(config, prompt_item["prompt"])
        sent_prompt_count += 1
        endpoint_error = target_endpoint_config_error(response, config)
        if endpoint_error:
            raise ValueError(endpoint_error)
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
            "attempts": response.get("attempts") or 1,
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
            "allowedSkipped": allowed_skipped,
            "failed": restricted_failed + allowed_failed,
            "warnings": warnings,
        },
        "decision": guardrail_decision(restricted_failed + allowed_failed, warnings),
        "tests": tests,
    }
    result["reportMarkdown"] = build_guardrail_markdown(result)
    report_excel = build_guardrail_xlsx(result)
    (run_dir / "guardrail-report.md").write_text(result["reportMarkdown"], encoding="utf-8")
    (run_dir / "guardrail-report.json").write_text(json.dumps(redact_value(result), indent=2), encoding="utf-8")
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
        "| Dependency risk | Flags unpinned, floating, and snapshot dependency versions. | Completed |",
        "| License risk | Reviews project and manifest license evidence for compatibility review. | Completed |",
        "| Configuration security | Checks packaged config for unsafe defaults and environment-specific endpoints. | Completed |",
        f"| npm vulnerability scan | Runs npm audit for every package.json + package-lock.json pair found, including nested client apps. | {'Completed' if assessment['npmAudit']['attempted'] else 'Not applicable'} |",
        f"| Python vulnerability scan | Runs pip-audit for requirements.txt and pyproject.toml targets. | {'Completed' if assessment['pipAudit']['attempted'] else 'Not applicable'} |",
        f"| Trivy filesystem scan | Runs Trivy against the extracted artifact when the trivy CLI is installed. | {'Completed' if assessment.get('trivyScan', {}).get('attempted') else 'Not installed'} |",
        f"| OWASP Dependency-Check | Runs Dependency-Check against extracted Java/package evidence when installed. | {'Completed' if assessment.get('dependencyCheck', {}).get('attempted') else 'Not installed'} |",
        f"| Java bytecode analysis | Inventories .class files and optionally decompiles JAR/WAR bytecode with CFR. | {'Completed' if assessment.get('javaAnalysis') else 'Not applicable'} |",
        "| SBOM generation | Generates a CycloneDX-lite JSON dependency inventory. | Completed |",
        "| Structured LLM security review | Sends redacted findings plus selected critical file snippets to the configured backend LLM. | Completed |",
        "",
        "## Finding Summary",
        "",
        "| Severity | Count |",
        "| --- | ---: |",
    ]
    for severity in ["critical", "high", "medium", "low", "info"]:
        lines.append(f"| {severity} | {assessment['findingCounts'].get(severity, 0)} |")
    secret_scan = assessment.get("secretScan") or {}
    lines.extend([
        "",
        "## Secret Scan Classification",
        "",
        "| Metric | Count |",
        "| --- | ---: |",
        f"| Text files scanned | {secret_scan.get('scannedFiles', 0)} |",
        f"| False positives ignored | {secret_scan.get('falsePositiveCount', 0)} |",
        f"| Needs review | {secret_scan.get('needsReviewCount', 0)} |",
    ])
    # Security Report Card export disabled for current development.
    # lines.extend([
    #     "",
    #     "## Security Report Card",
    #     "",
    #     "| Area | Score | Status | Evidence Basis |",
    #     "| --- | ---: | --- | --- |",
    # ])
    # for card in assessment.get("reportCard") or []:
    #     lines.append(f"| {card.get('area', '')} | {card.get('score', 0)} | {card.get('status', '')} | {card.get('detail', '')} |")
    for severity in ["critical", "high", "medium", "low", "info"]:
        items = [item for item in assessment["findings"] if item["severity"] == severity]
        if not items:
            continue
        lines.extend(["", f"## {severity.title()} Findings", ""])
        for item in items:
            count = item.get("count") or 1
            prefix = f"{item['task']}"
            if count > 1:
                prefix = f"{prefix} ({count} occurrences)"
            lines.append(f"- {prefix}: {item['details']}")
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

    lines.extend([
        "",
        "## Python Audit Targets",
        "",
        "| Project | Source | Status | Vulnerabilities |",
        "| --- | --- | --- | ---: |",
    ])
    pip_audit_targets = assessment["pipAudit"].get("targets") or []
    if pip_audit_targets:
        for target in pip_audit_targets:
            status = "Completed" if target.get("ok") else "Failed"
            lines.append(f"| {target.get('project', '.')} | {target.get('sourceFile', '')} | {status} | {target.get('vulnerabilityCount', 0)} |")
    else:
        lines.append(f"| Not applicable |  | {assessment['pipAudit'].get('reason', 'No Python audit targets found')} | 0 |")

    java_analysis = assessment.get("javaAnalysis") or {}
    decompile = java_analysis.get("decompile") or {}
    lines.extend([
        "",
        "## Java Bytecode Analysis",
        "",
        f"- Class files found: {java_analysis.get('classFileCount', 0)}",
        f"- Nested JAR/WAR files found: {java_analysis.get('nestedJarCount', 0)}",
        f"- Decompile attempted: {decompile.get('attempted', False)}",
        f"- Decompiled Java files: {decompile.get('javaFileCount', 0)}",
    ])
    if decompile.get("error"):
        lines.append(f"- Decompile note: {decompile.get('error')}")
    class_examples = java_analysis.get("classFiles") or []
    if class_examples:
        lines.extend(["", "| Class file examples |", "| --- |"])
        for item in class_examples[:25]:
            lines.append(f"| {item} |")

    lines.extend([
        "",
        "## External Scanner Results",
        "",
        "| Scanner | Attempted | Status | Vulnerabilities | Note |",
        "| --- | --- | --- | ---: | --- |",
    ])
    for scanner_name, scanner_payload in [
        ("Trivy", assessment.get("trivyScan") or {}),
        ("OWASP Dependency-Check", assessment.get("dependencyCheck") or {}),
    ]:
        attempted = scanner_payload.get("attempted", False)
        status = "Completed" if scanner_payload.get("ok") else "Skipped" if not attempted else "Failed"
        note = scanner_payload.get("reason") or scanner_payload.get("error") or ""
        lines.append(f"| {scanner_name} | {attempted} | {status} | {scanner_payload.get('vulnerabilityCount', 0) or 0} | {str(note)[:180]} |")

    external_vulnerabilities = assessment.get("externalVulnerabilities") or []
    lines.extend([
        "",
        "## Normalized External Vulnerabilities",
        "",
        "| Scanner | CVE/ID | Severity | Component | Version | Fixed Version | Location |",
        "| --- | --- | --- | --- | --- | --- | --- |",
    ])
    if external_vulnerabilities:
        for item in external_vulnerabilities[:150]:
            lines.append(
                f"| {item.get('scanner', '')} | {item.get('cve_id', '')} | {item.get('severity', '')} | "
                f"{item.get('component', '')} | {item.get('version', '')} | {item.get('fixed_version', '')} | {item.get('file_location', '')} |"
            )
    else:
        lines.append("| None |  |  |  |  |  |  |")

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
    dependency_risk = assessment.get("dependencyRisk") or {}
    license_review = assessment.get("licenseReview") or {}
    configuration_security = assessment.get("configurationSecurity") or {}
    lines.extend([
        "",
        "## Dependency, License, and Configuration Risk",
        "",
        f"- Unpinned/floating dependencies: {dependency_risk.get('unpinnedCount', 0)}",
        f"- Snapshot dependencies: {dependency_risk.get('snapshotCount', 0)}",
        f"- License entries reviewed: {license_review.get('licenseCount', 0)}",
        f"- Config files reviewed: {configuration_security.get('configFileCount', 0)}",
        f"- Environment-specific URL references: {configuration_security.get('hardcodedUrlCount', 0)}",
        f"- Unsafe runtime defaults: {configuration_security.get('unsafeDefaultCount', 0)}",
    ])
    lines.extend([
        "",
        "## Structured LLM Security Review",
        "",
    ])
    structured = assessment.get("llmStructuredReview") or {}
    if structured.get("score"):
        lines.append(f"LLM security score: {structured.get('score')}/100")
        lines.append("")
    if structured.get("summary"):
        lines.append(str(structured.get("summary")))
    llm_items = structured.get("findings") or structured.get("vulnerabilities") or []
    if llm_items:
        lines.extend([
            "",
            "| Finding | Severity | Confidence | File | Risk | Fix |",
            "| --- | --- | --- | --- | --- | --- |",
        ])
        for item in llm_items[:60]:
            title = item.get("title") or item.get("vulnerability_name") or ""
            file_location = item.get("file") or item.get("file_location") or ""
            risk = item.get("description") or item.get("risk_explanation") or ""
            fix = item.get("fix") or item.get("remediation_code") or ""
            lines.append(
                f"| {str(title)[:120]} | {item.get('severity', '')} | {item.get('confidence', '')} | "
                f"{file_location} | {str(risk)[:260]} | {str(fix)[:260]} |"
            )
    elif structured.get("error"):
        lines.append("Structured LLM review unavailable: " + str(structured.get("error")))
    else:
        lines.append("No structured LLM vulnerabilities were returned.")
    selected_files = structured.get("selectedFiles") or []
    if selected_files:
        lines.extend(["", "### Critical Files Selected For LLM", "", "| File | Reasons |", "| --- | --- |"])
        for item in selected_files[:30]:
            lines.append(f"| {item.get('file', '')} | {', '.join(item.get('reasons') or [])} |")
    lines.extend([
        "",
        "## Narrative LLM Review",
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
    rows = [style_header(["Severity", "Count", "Task", "Details", "Evidence"])]
    for item in findings:
        rows.append([
            item.get("severity", ""),
            item.get("count") or 1,
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


def pip_audit_rows(pip_audit):
    rows = [style_header(["Project", "Source File", "Kind", "Status", "Vulnerabilities", "Error"])]
    targets = pip_audit.get("targets") or []
    if not targets:
        rows.append(["Not applicable", "", "", pip_audit.get("reason", "No Python audit targets found"), 0, ""])
        return rows
    for target in targets:
        rows.append([
            target.get("project", "."),
            target.get("sourceFile", ""),
            target.get("kind", ""),
            "Completed" if target.get("ok") else "Failed",
            target.get("vulnerabilityCount", 0),
            target.get("error") or "",
        ])
    return rows


def external_scanner_rows(assessment):
    rows = [style_header(["Scanner", "Attempted", "Status", "Vulnerabilities", "Note"])]
    for scanner_name, scanner_payload in [
        ("Trivy", assessment.get("trivyScan") or {}),
        ("OWASP Dependency-Check", assessment.get("dependencyCheck") or {}),
    ]:
        attempted = scanner_payload.get("attempted", False)
        status = "Completed" if scanner_payload.get("ok") else "Skipped" if not attempted else "Failed"
        rows.append([
            scanner_name,
            attempted,
            status,
            scanner_payload.get("vulnerabilityCount", 0) or 0,
            scanner_payload.get("reason") or scanner_payload.get("error") or "",
        ])
    return rows


def external_vulnerability_rows(vulnerabilities):
    rows = [style_header(["Scanner", "CVE/ID", "Severity", "Component", "Version", "Fixed Version", "Location", "Description"])]
    for item in vulnerabilities or []:
        rows.append([
            item.get("scanner", ""),
            item.get("cve_id", ""),
            item.get("severity", ""),
            item.get("component", ""),
            item.get("version", ""),
            item.get("fixed_version", ""),
            item.get("file_location", ""),
            item.get("description", ""),
        ])
    if len(rows) == 1:
        rows.append(["None", "", "", "", "", "", "", "No external scanner vulnerabilities were found or scanners were unavailable."])
    return rows


def java_analysis_rows(java_analysis):
    java_analysis = java_analysis or {}
    decompile = java_analysis.get("decompile") or {}
    rows = [
        style_header(["Metric", "Value"]),
        ["Class files found", java_analysis.get("classFileCount", 0)],
        ["Nested JAR/WAR files found", java_analysis.get("nestedJarCount", 0)],
        ["Decompile attempted", decompile.get("attempted", False)],
        ["Decompile status", "Completed" if decompile.get("ok") else "Skipped/failed"],
        ["Decompiled Java files", decompile.get("javaFileCount", 0)],
        ["Decompiler note", decompile.get("error", "")],
    ]
    for item in (java_analysis.get("classFiles") or [])[:100]:
        rows.append(["Class file", item])
    return rows


def structured_llm_rows(structured):
    structured = structured or {}
    rows = [
        style_header(["Field", "Value"]),
        ["Score", structured.get("score", "")],
        ["Summary", structured.get("summary", "")],
        ["Error", structured.get("error", "")],
        [],
        style_header(["Finding", "Severity", "Confidence", "File", "Risk", "Fix"]),
    ]
    for item in (structured.get("findings") or structured.get("vulnerabilities") or []):
        rows.append([
            item.get("title") or item.get("vulnerability_name", ""),
            item.get("severity", ""),
            item.get("confidence", ""),
            item.get("file") or item.get("file_location", ""),
            item.get("description") or item.get("risk_explanation", ""),
            item.get("fix") or item.get("remediation_code", ""),
        ])
    rows.extend([[], style_header(["Selected File", "Reasons"])])
    for item in structured.get("selectedFiles") or []:
        rows.append([item.get("file", ""), ", ".join(item.get("reasons") or [])])
    return rows


def security_readiness_rows(assessment):
    dependency_risk = assessment.get("dependencyRisk") or {}
    license_review = assessment.get("licenseReview") or {}
    configuration_security = assessment.get("configurationSecurity") or {}
    rows = [
        style_header(["Area", "Metric", "Value"]),
        ["Dependency risk", "Unpinned/floating dependencies", dependency_risk.get("unpinnedCount", 0)],
        ["Dependency risk", "Snapshot dependencies", dependency_risk.get("snapshotCount", 0)],
        ["License risk", "License entries reviewed", license_review.get("licenseCount", 0)],
        ["Configuration security", "Config files reviewed", configuration_security.get("configFileCount", 0)],
        ["Configuration security", "Environment-specific URL references", configuration_security.get("hardcodedUrlCount", 0)],
        ["Configuration security", "Unsafe runtime defaults", configuration_security.get("unsafeDefaultCount", 0)],
        ["Configuration security", "Development/test references", configuration_security.get("devReferenceCount", 0)],
    ]
    for item in (license_review.get("licenseEntries") or [])[:50]:
        rows.append(["License evidence", item.get("file", ""), item.get("license", "")])
    for item in (configuration_security.get("configFiles") or [])[:50]:
        rows.append(["Config evidence", "File", item])
    return rows


def report_card_rows(report_card):
    rows = [style_header(["Area", "Score", "Status", "Evidence Basis"])]
    for item in report_card or []:
        rows.append([
            item.get("area", ""),
            item.get("score", 0),
            item.get("status", ""),
            item.get("detail", ""),
        ])
    if len(rows) == 1:
        rows.append(["Security", 0, "No data", "No report card data was generated."])
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
    secret_scan = assessment.get("secretScan") or {}
    summary_rows.extend([
        [],
        style_header(["Secret Scan Metric", "Count"]),
        ["Text files scanned", secret_scan.get("scannedFiles", 0)],
        ["False positives ignored", secret_scan.get("falsePositiveCount", 0)],
        ["Needs review", secret_scan.get("needsReviewCount", 0)],
    ])
    summary_rows.extend([
        [],
        style_header(["Check", "Status"]),
        ["Archive path safety", "Completed" if assessment["archive"].get("extracted") else "Completed with limitation"],
        ["Secret scanning", "Completed"],
        ["Certificate and TLS security", "Completed"],
        ["Dependency inventory", "Completed"],
        ["Dependency risk", "Completed"],
        ["License risk", "Completed"],
        ["Configuration security", "Completed"],
        ["npm audit", "Completed" if assessment["npmAudit"].get("attempted") else "Not applicable"],
        ["pip-audit", "Completed" if assessment["pipAudit"].get("attempted") else "Not applicable"],
        ["Trivy", "Completed" if assessment.get("trivyScan", {}).get("attempted") else "Not installed"],
        ["OWASP Dependency-Check", "Completed" if assessment.get("dependencyCheck", {}).get("attempted") else "Not installed"],
        ["Java bytecode analysis", "Completed"],
        ["Structured LLM security review", "Completed"],
        ["SBOM generation", "Completed"],
    ])
    sheets = [
        ("Summary", summary_rows, [32, 90]),
        # Security Report Card export disabled for current development.
        # ("Report Card", report_card_rows(assessment.get("reportCard") or []), [30, 12, 20, 90]),
        ("Findings", finding_rows(assessment["findings"]), [16, 10, 28, 80, 80]),
        ("Certificates", certificate_rows(assessment.get("certificateScan") or {}), [16, 42, 18, 12, 50, 50, 24, 60]),
        ("Components", component_rows(assessment["components"]), [24, 42, 22, 48]),
        ("Security Readiness", security_readiness_rows(assessment), [28, 42, 90]),
        ("npm Audit", npm_audit_rows(assessment["npmAudit"]), [36, 18, 18, 60]),
        ("Python Audit", pip_audit_rows(assessment["pipAudit"]), [36, 48, 18, 18, 18, 60]),
        ("External Scanners", external_scanner_rows(assessment), [28, 18, 18, 18, 90]),
        ("External Vulnerabilities", external_vulnerability_rows(assessment.get("externalVulnerabilities") or []), [18, 24, 14, 42, 20, 24, 50, 90]),
        ("Java Analysis", java_analysis_rows(assessment.get("javaAnalysis") or {}), [28, 90]),
        ("Structured LLM", structured_llm_rows(assessment.get("llmStructuredReview") or {}), [32, 90, 18, 80, 80]),
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


def cleanup_raw_run_files(upload_dir, extract_dir):
    cleanup = {
        "enabled": DELETE_RAW_FILES_AFTER_RUN,
        "removed": [],
        "errors": [],
    }
    if not DELETE_RAW_FILES_AFTER_RUN:
        return cleanup
    for path in [upload_dir, extract_dir]:
        try:
            if path.exists():
                shutil.rmtree(path)
                cleanup["removed"].append(path.name)
        except Exception as exc:
            cleanup["errors"].append({"path": str(path), "error": str(exc)})
    return cleanup


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
    files = walk_files(extract_dir, findings)
    java_analysis = analyze_java_bytecode(artifact_path, extract_dir, files, artifact["type"])
    add_java_analysis_findings(java_analysis, findings)
    decompiled_dir = extract_dir / "_decompiled_java"
    if decompiled_dir.exists():
        files = walk_files(extract_dir, findings)
    secret_scan = scan_secrets(files, extract_dir, findings)
    certificate_scan = scan_certificates(files, extract_dir, findings)
    components = collect_dependency_inventory(files, extract_dir, findings)
    dependency_risk = dependency_risk_review(components, findings)
    license_review = scan_license_risk(files, extract_dir, findings)
    configuration_security = scan_configuration_security(files, extract_dir, findings)
    npm_audit = run_npm_audit_if_possible(extract_dir, findings)
    pip_audit = run_pip_audit_if_possible(extract_dir, findings)
    trivy_scan = run_trivy_scan(extract_dir, artifact["type"])
    dependency_check = run_dependency_check_scan(extract_dir, run_dir, artifact["type"])
    external_vulnerabilities = dedupe_vulnerabilities(
        (trivy_scan.get("vulnerabilities") or [])
        + (dependency_check.get("vulnerabilities") or [])
    )
    add_external_vulnerability_findings(external_vulnerabilities, findings)
    raw_finding_total = len(findings)
    findings = sorted_security_findings(group_security_findings(findings))
    finding_counts = {}
    for item in findings:
        finding_counts[item["severity"]] = finding_counts.get(item["severity"], 0) + (item.get("count") or 1)
    assessment = {
        "runId": run_id,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "artifact": artifact,
        "archive": archive,
        "secretScan": secret_scan,
        "certificateScan": certificate_scan,
        "dependencyRisk": dependency_risk,
        "licenseReview": license_review,
        "configurationSecurity": configuration_security,
        "npmAudit": npm_audit,
        "pipAudit": pip_audit,
        "trivyScan": trivy_scan,
        "dependencyCheck": dependency_check,
        "javaAnalysis": java_analysis,
        "externalVulnerabilities": external_vulnerabilities,
        "components": components,
        "findings": findings,
        "findingCounts": finding_counts,
        "findingTotal": raw_finding_total,
        "displayFindingTotal": len(findings),
        "decision": decision_for(findings),
    }
    assessment["sbom"] = create_sbom(artifact, components, external_vulnerabilities)
    assessment["reportCard"] = security_report_card(assessment)
    assessment["llmStructuredReview"] = run_structured_security_llm(call_llm, redact_value, redact_text, assessment, files, extract_dir)
    assessment["llmReview"] = run_llm_review(assessment)
    assessment["reportMarkdown"] = build_markdown_report(assessment)
    report_excel = build_xlsx_report(assessment)
    (run_dir / "report.md").write_text(assessment["reportMarkdown"], encoding="utf-8")
    (run_dir / "report.json").write_text(json.dumps(redact_value(assessment), indent=2), encoding="utf-8")
    (run_dir / "sbom.json").write_text(json.dumps(assessment["sbom"], indent=2), encoding="utf-8")
    (run_dir / "report.xlsx").write_bytes(report_excel)
    assessment["rawFileCleanup"] = cleanup_raw_run_files(upload_dir, extract_dir)
    (run_dir / "report.json").write_text(json.dumps(redact_value(assessment), indent=2), encoding="utf-8")
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
        if self.path not in {"/api/assess", "/api/guardrail-test", "/api/quality-assess", "/api/deployment-verdict"}:
            self.send_json(HTTPStatus.NOT_FOUND, {"error": "Route not found."})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            if self.path == "/api/deployment-verdict":
                self.send_json(HTTPStatus.OK, build_deployment_verdict(payload))
                return
            if self.path == "/api/quality-assess":
                llm_reviewer = run_quality_llm_review if payload.get("useLlmReview") else None
                result = assess_quality(payload.get("fileName"), payload.get("contentBase64"), RUNS_DIR, llm_reviewer=llm_reviewer)
                self.send_json(HTTPStatus.OK, {
                    "runId": result["runId"],
                    "decision": result["decision"],
                    "score": result["score"],
                    "scoreDetails": result["scoreDetails"],
                    "findingCounts": result["findingCounts"],
                    "findingTotal": result["findingTotal"],
                    "displayFindingTotal": result["displayFindingTotal"],
                    "findingDensity": result["findingDensity"],
                    "reportCard": result["reportCard"],
                    "findings": result["findings"],
                    "metrics": result["metrics"],
                    "llmReview": result["llmReview"],
                    "llmStatus": llm_status(),
                    "reportMarkdown": result["reportMarkdown"],
                    "markdownPath": result["markdownPath"],
                    "jsonPath": result["jsonPath"],
                    "excelPath": result["excelPath"],
                })
                return
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
                "findingTotal": result["findingTotal"],
                "displayFindingTotal": result["displayFindingTotal"],
                "findings": result["findings"],
                "components": result["components"][:150],
                "componentCount": len(result["components"]),
                "certificateScan": result["certificateScan"],
                "dependencyRisk": result["dependencyRisk"],
                "licenseReview": result["licenseReview"],
                "configurationSecurity": result["configurationSecurity"],
                "reportCard": result["reportCard"],
                "npmAudit": result["npmAudit"],
                "pipAudit": result["pipAudit"],
                "trivyScan": result["trivyScan"],
                "dependencyCheck": result["dependencyCheck"],
                "javaAnalysis": result["javaAnalysis"],
                "externalVulnerabilities": result["externalVulnerabilities"][:150],
                "llmStructuredReview": result["llmStructuredReview"],
                "rawFileCleanup": result["rawFileCleanup"],
                "llmReview": result["llmReview"],
                "reportMarkdown": result["reportMarkdown"],
                "reportPath": result["reportPath"],
                "jsonPath": result["jsonPath"],
                "sbomPath": result["sbomPath"],
                "excelPath": result["excelPath"],
            })
        except Exception as exc:
            traceback.print_exc()
            if self.path == "/api/quality-assess":
                label = "Quality Assessor"
            elif self.path == "/api/deployment-verdict":
                label = "Deployment Verdict"
            else:
                label = "Security Assessor"
            self.send_json(HTTPStatus.BAD_REQUEST, {
                "error": f"{label} request failed: " + redact_text(str(exc)),
                "route": self.path,
            })

    def do_GET(self):
        if self.path == "/.well-known/appspecific/com.chrome.devtools.json":
            self.send_response(HTTPStatus.NO_CONTENT)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        match = re.match(r"^/api/reports/([^/]+)/(report\.md|report\.json|report\.xlsx|sbom\.json|guardrail-report\.md|guardrail-report\.json|guardrail-report\.xlsx|quality-report\.md|quality-report\.json|quality-report\.xlsx)$", self.path)
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
