import json
from pathlib import Path

from .common import normalized_vulnerability, run_command, scanner_timeout, tool_path


def _dependency_check_binary():
    return tool_path("dependency-check", "dependency-check.sh")


def _first_cve(vuln):
    name = vuln.get("name") or vuln.get("source") or ""
    if str(name).upper().startswith("CVE-"):
        return name
    for item in vuln.get("references") or []:
        value = item.get("name") or item.get("url") or ""
        if "CVE-" in str(value).upper():
            parts = str(value).replace("/", " ").split()
            for part in parts:
                if part.upper().startswith("CVE-"):
                    return part.strip(".,;")
    return name


def _fixed_version(vuln):
    versions = []
    for item in vuln.get("vulnerableSoftware") or []:
        if isinstance(item, dict) and item.get("versionEndExcluding"):
            versions.append(f"< {item.get('versionEndExcluding')}")
        elif isinstance(item, dict) and item.get("versionEndIncluding"):
            versions.append(f"<= {item.get('versionEndIncluding')}")
    return ", ".join(versions[:5])


def parse_dependency_check_vulnerabilities(data):
    vulnerabilities = []
    for dependency in data.get("dependencies") or []:
        file_name = dependency.get("fileName") or Path(dependency.get("filePath") or "").name
        file_path = dependency.get("filePath") or file_name
        component = file_name
        if dependency.get("packages"):
            component = dependency["packages"][0].get("id") or component
        for vuln in dependency.get("vulnerabilities") or []:
            vulnerabilities.append(normalized_vulnerability(
                scanner="dependency-check",
                vulnerability_id=_first_cve(vuln),
                severity=vuln.get("severity"),
                component=component,
                version=dependency.get("version") or "",
                fixed_version=_fixed_version(vuln),
                description=vuln.get("description") or vuln.get("name"),
                file_location=file_path,
                evidence={
                    "dependencyFileName": file_name,
                    "source": vuln.get("source"),
                    "cvssv3": vuln.get("cvssv3"),
                    "cvssv2": vuln.get("cvssv2"),
                },
            ))
    return vulnerabilities


def run_dependency_check_scan(extract_dir, run_dir, artifact_type):
    binary = _dependency_check_binary()
    if not binary:
        return {
            "attempted": False,
            "ok": False,
            "tool": "dependency-check",
            "reason": "dependency-check command is not installed",
            "vulnerabilities": [],
        }

    out_dir = run_dir / "dependency-check"
    out_dir.mkdir(parents=True, exist_ok=True)
    command = [
        binary,
        "--project",
        "security-assessor-upload",
        "--scan",
        str(extract_dir),
        "--format",
        "JSON",
        "--out",
        str(out_dir),
        "--prettyPrint",
    ]
    completed = run_command(command, cwd=run_dir, timeout=scanner_timeout("SECURITY_ASSESSOR_DEPENDENCY_CHECK_TIMEOUT_SECONDS", 420))
    report_path = out_dir / "dependency-check-report.json"
    data = None
    if report_path.exists():
        try:
            data = json.loads(report_path.read_text(errors="ignore"))
        except Exception:
            data = None
    vulnerabilities = parse_dependency_check_vulnerabilities(data or {}) if data else []
    return {
        "attempted": True,
        "ok": data is not None and completed["returnCode"] in {0, 1, 14},
        "tool": "dependency-check",
        "artifactType": artifact_type,
        "reportPath": str(report_path) if report_path.exists() else "",
        "vulnerabilityCount": len(vulnerabilities),
        "vulnerabilities": vulnerabilities,
        "error": "" if data is not None else (completed["error"] or completed["stderr"][:1200] or "Dependency-Check did not produce a JSON report"),
    }

