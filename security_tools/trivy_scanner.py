from .common import normalized_vulnerability, parse_json_output, relative_path, run_command, scanner_timeout, tool_path


def _fixed_version(vuln):
    fixed = vuln.get("FixedVersion") or vuln.get("FixedVersions") or ""
    if isinstance(fixed, list):
        return ", ".join(str(item) for item in fixed if item)
    return str(fixed or "")


def parse_trivy_vulnerabilities(data):
    vulnerabilities = []
    for target in data.get("Results") or []:
        target_name = target.get("Target") or ""
        for vuln in target.get("Vulnerabilities") or []:
            vulnerabilities.append(normalized_vulnerability(
                scanner="trivy",
                vulnerability_id=vuln.get("VulnerabilityID") or vuln.get("ID"),
                severity=vuln.get("Severity"),
                component=vuln.get("PkgName") or vuln.get("PkgIdentifier", {}).get("PURL"),
                version=vuln.get("InstalledVersion"),
                fixed_version=_fixed_version(vuln),
                description=vuln.get("Description") or vuln.get("Title"),
                file_location=target_name,
                evidence={
                    "target": target_name,
                    "packageType": target.get("Type"),
                    "primaryURL": vuln.get("PrimaryURL"),
                    "title": vuln.get("Title"),
                },
            ))
    return vulnerabilities


def run_trivy_scan(extract_dir, artifact_type):
    binary = tool_path("trivy")
    if not binary:
        return {
            "attempted": False,
            "ok": False,
            "tool": "trivy",
            "reason": "trivy command is not installed",
            "vulnerabilities": [],
        }

    command = [
        binary,
        "fs",
        "--format",
        "json",
        "--scanners",
        "vuln,secret,misconfig",
        "--quiet",
        str(extract_dir),
    ]
    completed = run_command(command, cwd=extract_dir, timeout=scanner_timeout("SECURITY_ASSESSOR_TRIVY_TIMEOUT_SECONDS", 240))
    data = parse_json_output(completed["stdout"])
    vulnerabilities = parse_trivy_vulnerabilities(data or {}) if data else []
    return {
        "attempted": True,
        "ok": data is not None and completed["returnCode"] in {0, 1},
        "tool": "trivy",
        "artifactType": artifact_type,
        "command": "trivy fs --format json --scanners vuln,secret,misconfig",
        "vulnerabilityCount": len(vulnerabilities),
        "vulnerabilities": vulnerabilities,
        "error": "" if data is not None else (completed["error"] or completed["stderr"][:1200] or "trivy did not return JSON output"),
    }

