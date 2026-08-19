import json
import os
import re
import shutil
import subprocess
from pathlib import Path


SEVERITY_ORDER = {"critical": 4, "high": 3, "medium": 2, "low": 1, "info": 0, "unknown": 0}


def normalize_severity(value, default="medium"):
    text = str(value or "").strip().lower()
    if text in {"critical", "high", "medium", "low", "info"}:
        return text
    if text in {"moderate", "warning"}:
        return "medium"
    if text in {"negligible", "none", "unknown", ""}:
        return "info"
    return default


def tool_path(*names):
    for name in names:
        found = shutil.which(name)
        if found:
            return found
    return ""


def relative_path(path, root):
    try:
        return str(Path(path).relative_to(root)).replace("\\", "/")
    except Exception:
        return str(path).replace("\\", "/")


def safe_text(value, limit=1000):
    text = str(value or "")
    text = re.sub(r"\s+", " ", text).strip()
    return text[:limit]


def run_command(command, cwd=None, timeout=120):
    try:
        result = subprocess.run(
            command,
            cwd=cwd,
            text=True,
            capture_output=True,
            timeout=timeout,
        )
        return {
            "ok": result.returncode == 0,
            "returnCode": result.returncode,
            "stdout": result.stdout,
            "stderr": result.stderr,
            "error": "",
        }
    except subprocess.TimeoutExpired as exc:
        return {
            "ok": False,
            "returnCode": None,
            "stdout": exc.stdout or "",
            "stderr": exc.stderr or "",
            "error": f"command timed out after {timeout} seconds",
        }
    except Exception as exc:
        return {
            "ok": False,
            "returnCode": None,
            "stdout": "",
            "stderr": "",
            "error": str(exc),
        }


def parse_json_output(output):
    text = str(output or "").strip()
    if not text:
        return None
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        start = text.find("{")
        end = text.rfind("}")
        if start >= 0 and end > start:
            try:
                return json.loads(text[start:end + 1])
            except json.JSONDecodeError:
                return None
    return None


def scanner_timeout(env_name, default):
    try:
        value = int(os.getenv(env_name, str(default)))
        return max(10, value)
    except ValueError:
        return default


def normalized_vulnerability(scanner, vulnerability_id="", severity="medium", component="", version="", fixed_version="", description="", file_location="", evidence=None):
    return {
        "scanner": scanner,
        "cve_id": str(vulnerability_id or ""),
        "severity": normalize_severity(severity),
        "component": str(component or "unknown"),
        "version": str(version or ""),
        "fixed_version": str(fixed_version or ""),
        "description": safe_text(description, 1200),
        "file_location": str(file_location or ""),
        "evidence": evidence or {},
    }


def dedupe_vulnerabilities(items):
    seen = set()
    results = []
    for item in items or []:
        key = (
            str(item.get("scanner", "")),
            str(item.get("cve_id", "")),
            str(item.get("component", "")),
            str(item.get("version", "")),
            str(item.get("file_location", "")),
        )
        if key in seen:
            continue
        seen.add(key)
        results.append(item)
    return sorted(results, key=lambda item: (-SEVERITY_ORDER.get(item.get("severity", "info"), 0), item.get("scanner", ""), item.get("component", "")))

