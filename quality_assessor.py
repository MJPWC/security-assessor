import base64
import hashlib
import io
import json
import os
import re
import shutil
import tarfile
import uuid
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from xml.sax.saxutils import escape

from llm_client import redact_text as redact_sensitive_text


MAX_UPLOAD_BYTES = 50 * 1024 * 1024
# Cap on total bytes written to disk while extracting an archive (uncompressed
# size), independent of MAX_UPLOAD_BYTES which only bounds the compressed
# upload received over the wire.
MAX_EXTRACTED_BYTES = int(os.getenv("SECURITY_ASSESSOR_MAX_EXTRACTED_BYTES", str(500 * 1024 * 1024)))
MAX_WALK_FILES = 3000
MAX_LLM_QUALITY_FINDINGS = int(os.getenv("SECURITY_ASSESSOR_MAX_LLM_QUALITY_FINDINGS", "50"))
MAX_LLM_QUALITY_SAMPLE_FILES = int(os.getenv("SECURITY_ASSESSOR_MAX_LLM_QUALITY_SAMPLE_FILES", "6"))
MAX_LLM_QUALITY_SAMPLE_LINES = int(os.getenv("SECURITY_ASSESSOR_MAX_LLM_QUALITY_SAMPLE_LINES", "40"))
MAX_LLM_QUALITY_SAMPLE_CHARS = int(os.getenv("SECURITY_ASSESSOR_MAX_LLM_QUALITY_SAMPLE_CHARS", "2500"))
DELETE_RAW_FILES_AFTER_RUN = (os.getenv("SECURITY_ASSESSOR_DELETE_RAW_FILES_AFTER_RUN", "true") or "").strip().lower() not in {"0", "false", "no", "off"}
# A build package should never legitimately contain the assessor's own prior
# run output. If it does, the upload was likely packaged from this app's own
# working directory without excluding output/ -- skip those entries instead
# of extracting them, to avoid recursive, ever-growing nested output.
SELF_REFERENTIAL_PATH_MARKER = "security-assessor/output/security-assessor/runs"
TEXT_FILE_LIMIT_BYTES = 512 * 1024
QUALITY_EXTENSIONS = {
    ".js", ".jsx", ".ts", ".tsx", ".py", ".java", ".xml", ".json", ".yaml",
    ".yml", ".toml", ".properties", ".md", ".html", ".css", ".scss",
}
SKIP_DIRS = {"node_modules", "dist", "build", "target", ".git", ".venv", "venv", "__pycache__"}
BUILD_MANIFEST_NAMES = {"package.json", "pom.xml", "build.gradle", "gradlew", "pyproject.toml", "requirements.txt", "setup.py"}
CI_FILE_NAMES = {".github/workflows", ".gitlab-ci.yml", "jenkinsfile", "azure-pipelines.yml", "bitbucket-pipelines.yml"}
OPERATIONAL_FILE_NAMES = {"dockerfile", "procfile", "docker-compose.yml", "docker-compose.yaml"}
RELEASE_NOTE_NAMES = {"readme.md", "changelog.md", "release-notes.md", "releasenotes.md", "release.md"}
HEALTH_RE = re.compile(r"\b(health|healthcheck|readiness|liveness|actuator/health)\b", re.I)
VERSION_RE = re.compile(r"\b(version|implementation-version|revision|commit|build[-_]?time)\b", re.I)
SEVERITY_RANK = {"critical": 4, "high": 3, "medium": 2, "low": 1, "info": 0}
SEVERITY_SORT = {"critical": 0, "high": 1, "medium": 2, "low": 3, "info": 4}
QUALITY_SCORE_WEIGHTS = {"critical": 30, "high": 15, "medium": 1, "low": 0.10, "info": 0}
QUALITY_SCORE_CAPS = {"critical": 90, "high": 60, "medium": 20, "low": 5, "info": 0}
SENSITIVE_TEXT_RE = re.compile(
    r"(sk-[A-Za-z0-9_-]{12,}|AKIA[0-9A-Z]{16}|Bearer\s+[A-Za-z0-9._~+/=-]{12,}|"
    r"(api[_-]?key|token|secret|password)\s*[:=]\s*['\"]?[^'\"\s,}]{6,})",
    re.I,
)


def make_run_id():
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
    return f"quality_{stamp}_{uuid.uuid4().hex[:8]}"


def safe_name(file_name):
    return re.sub(r"[^A-Za-z0-9._-]", "_", Path(file_name).name or "uploaded-artifact")


def detect_type(file_name):
    lower = str(file_name or "").lower()
    if lower.endswith(".jar"):
        return "java-jar"
    if lower.endswith(".war"):
        return "java-war"
    if lower.endswith(".zip"):
        return "zip"
    if lower.endswith(".tgz") or lower.endswith(".tar.gz"):
        return "tarball"
    if lower.endswith(".tar"):
        return "tar"
    if lower.endswith(".whl"):
        return "python-wheel"
    return "source-file"


def cleanup_raw_run_files(*paths):
    cleanup = {
        "enabled": DELETE_RAW_FILES_AFTER_RUN,
        "removed": [],
        "errors": [],
    }
    if not DELETE_RAW_FILES_AFTER_RUN:
        return cleanup
    for path in paths:
        path = Path(path)
        if not path.exists():
            continue
        try:
            shutil.rmtree(path)
            cleanup["removed"].append(path.name)
        except OSError as exc:
            cleanup["errors"].append({"path": str(path), "error": str(exc)})
    return cleanup


def is_safe_archive_entry(name):
    normalized = str(name).replace("\\", "/").strip()
    return normalized and not normalized.startswith("/") and "\x00" not in normalized and ".." not in Path(normalized).parts


def is_self_referential_entry(name):
    return SELF_REFERENTIAL_PATH_MARKER in str(name).replace("\\", "/").lower()


def extract_artifact(artifact_path, extract_dir, artifact_type, findings=None):
    if artifact_type in {"zip", "java-jar", "java-war", "python-wheel"}:
        with zipfile.ZipFile(artifact_path) as package:
            infos = package.infolist()
            self_referential = [m.filename for m in infos if is_self_referential_entry(m.filename)]
            if self_referential and findings is not None:
                add_finding(findings, "medium", "Self-referential upload",
                    "Archive contains the security assessor's own prior run output "
                    "(output/security-assessor/runs/...); those entries were skipped.",
                    {"entries": self_referential[:10], "skippedCount": len(self_referential)})
            declared_total = sum(m.file_size for m in infos if not m.is_dir() and is_safe_archive_entry(m.filename) and not is_self_referential_entry(m.filename))
            if declared_total > MAX_EXTRACTED_BYTES:
                if findings is not None:
                    add_finding(findings, "critical", "Archive extraction",
                        "Archive's uncompressed size exceeds the extraction limit; extraction was aborted.",
                        {"declaredUncompressedBytes": declared_total, "limitBytes": MAX_EXTRACTED_BYTES})
                return {"extracted": False, "type": "zip"}
            written = 0
            for member in infos:
                if not is_safe_archive_entry(member.filename) or is_self_referential_entry(member.filename):
                    continue
                written += member.file_size
                if written > MAX_EXTRACTED_BYTES:
                    if findings is not None:
                        add_finding(findings, "critical", "Archive extraction",
                            "Extraction aborted after exceeding the maximum allowed extracted size.",
                            {"limitBytes": MAX_EXTRACTED_BYTES})
                    return {"extracted": False, "type": "zip"}
                package.extract(member, extract_dir)
        return {"extracted": True, "type": "zip"}
    if artifact_type in {"tarball", "tar"}:
        with tarfile.open(artifact_path) as package:
            members = package.getmembers()
            self_referential = [m.name for m in members if is_self_referential_entry(m.name)]
            if self_referential and findings is not None:
                add_finding(findings, "medium", "Self-referential upload",
                    "Archive contains the security assessor's own prior run output "
                    "(output/security-assessor/runs/...); those entries were skipped.",
                    {"entries": self_referential[:10], "skippedCount": len(self_referential)})
            safe_members = [
                m for m in members
                if is_safe_archive_entry(m.name)
                and (m.isfile() or m.isdir())
                and not is_self_referential_entry(m.name)
            ]
            declared_total = sum(m.size for m in safe_members if m.isfile())
            if declared_total > MAX_EXTRACTED_BYTES:
                if findings is not None:
                    add_finding(findings, "critical", "Archive extraction",
                        "Archive's uncompressed size exceeds the extraction limit; extraction was aborted.",
                        {"declaredUncompressedBytes": declared_total, "limitBytes": MAX_EXTRACTED_BYTES})
                return {"extracted": False, "type": "tar"}
            written = 0
            for member in safe_members:
                if member.isfile():
                    written += member.size
                    if written > MAX_EXTRACTED_BYTES:
                        if findings is not None:
                            add_finding(findings, "critical", "Archive extraction",
                                "Extraction aborted after exceeding the maximum allowed extracted size.",
                                {"limitBytes": MAX_EXTRACTED_BYTES})
                        return {"extracted": False, "type": "tar"}
                package.extract(member, extract_dir)
        return {"extracted": True, "type": "tar"}
    target = extract_dir / artifact_path.name
    target.write_bytes(artifact_path.read_bytes())
    return {"extracted": False, "type": "single-file"}


def walk_files(root_dir, findings=None):
    files = []
    truncated = False
    for current, dirs, names in os.walk(root_dir):
        current = Path(current)
        dirs[:] = [name for name in dirs if name not in SKIP_DIRS and not name.startswith(".")]
        for name in names:
            path = current / name
            if not path.is_symlink() and path.is_file():
                files.append(path)
                if len(files) >= MAX_WALK_FILES:
                    truncated = True
                    break
        if truncated:
            break
    if truncated and findings is not None:
        add_finding(findings, "medium", "Scan coverage",
            f"File scan limit reached ({MAX_WALK_FILES} files). Some files in this "
            "build were not scanned; results below may be incomplete.",
            {"maxWalkFiles": MAX_WALK_FILES})
    return files


def is_text_file(path):
    try:
        if path.stat().st_size > TEXT_FILE_LIMIT_BYTES:
            return False
    except OSError:
        return False
    lower = path.name.lower()
    return path.suffix.lower() in QUALITY_EXTENSIONS or lower in {"requirements.txt", "pipfile", "dockerfile", "makefile"}


def add_finding(findings, severity, category, title, details, file="", line=""):
    findings.append({
        "severity": severity,
        "category": category,
        "title": title,
        "details": details,
        "file": file,
        "line": line,
        "count": 1,
    })


def redact_text(text):
    return redact_sensitive_text(text)


def relative(path, root_dir):
    return str(path.relative_to(root_dir)).replace("\\", "/")


def scan_text_quality(files, root_dir):
    findings = []
    text_files = []
    source_files = []
    test_files = []
    for path in files:
        if not is_text_file(path):
            continue
        rel = relative(path, root_dir)
        text_files.append(rel)
        if path.suffix.lower() in {".js", ".jsx", ".ts", ".tsx", ".py", ".java"}:
            source_files.append(rel)
        if re.search(r"(^|/)(test|tests|spec|__tests__)(/|$)", rel, re.I) or re.search(r"(\.test|\.spec)\.", rel, re.I):
            test_files.append(rel)
        try:
            text = path.read_text(errors="ignore")
        except OSError:
            continue
        lines = text.splitlines()
        if len(lines) > 700:
            add_finding(findings, "medium", "Maintainability", "Large file", f"File has {len(lines)} lines. Consider splitting it into smaller modules.", rel)
        long_lines = [idx for idx, line in enumerate(lines, 1) if len(line) > 140]
        if long_lines:
            add_finding(findings, "low", "Readability", "Long lines", f"{len(long_lines)} lines exceed 140 characters.", rel, long_lines[0])
        for idx, line in enumerate(lines, 1):
            if re.search(r"\b(TODO|FIXME|HACK)\b", line):
                add_finding(findings, "low", "Maintainability", "Open code marker", "TODO/FIXME/HACK marker should be resolved or tracked.", rel, idx)
            if re.search(r"\b(console\.log|print\s*\()", line) and path.suffix.lower() in {".js", ".jsx", ".ts", ".tsx", ".py"}:
                add_finding(findings, "low", "Code hygiene", "Debug output", "Debug logging statement found in source code.", rel, idx)
        if re.search(r"catch\s*\([^)]*\)\s*\{\s*\}", text, re.S):
            add_finding(findings, "medium", "Reliability", "Empty catch block", "Exception is swallowed without handling or logging.", rel)
        if path.suffix.lower() in {".js", ".jsx", ".ts", ".tsx"}:
            function_matches = re.finditer(r"\b(function\s+\w+|const\s+\w+\s*=\s*(?:async\s*)?\([^)]*\)\s*=>)", text)
            if sum(1 for _ in function_matches) > 80:
                add_finding(findings, "medium", "Maintainability", "Many functions in one file", "File contains more than 80 function-like declarations.", rel)
    root_names = {p.name.lower() for p in files if p.parent == root_dir}
    if "readme.md" not in root_names:
        add_finding(findings, "low", "Documentation", "Missing README", "No README.md was found at the package root.")
    if source_files and not test_files:
        add_finding(findings, "medium", "Testability", "No tests found", "Source files were found, but no test/spec directory or file was detected.")
    if "package.json" in root_names and "package-lock.json" not in root_names and "yarn.lock" not in root_names and "pnpm-lock.yaml" not in root_names:
        add_finding(findings, "medium", "Dependency hygiene", "Missing JavaScript lock file", "package.json exists without a recognized lock file.")
    return findings, {"textFiles": len(text_files), "sourceFiles": len(source_files), "testFiles": len(test_files)}


def scan_deployment_readiness(files, root_dir, metrics):
    findings = []
    rel_files = [relative(path, root_dir) for path in files]
    lower_names = {path.name.lower() for path in files}
    lower_paths = {relative(path, root_dir).lower() for path in files}
    source_files = metrics.get("sourceFiles", 0) or 0

    build_manifests = [
        rel for rel in rel_files
        if Path(rel).name.lower() in BUILD_MANIFEST_NAMES or rel.lower().endswith((".jar", ".war", ".whl"))
    ]
    if source_files and not build_manifests:
        add_finding(findings, "medium", "Build readiness", "Build manifest missing", "No recognized build manifest or deployable artifact was found.", "")

    packaged_artifacts = [rel for rel in rel_files if rel.lower().endswith((".jar", ".war", ".whl"))]
    if build_manifests and not packaged_artifacts and not any(name in lower_names for name in {"package.json", "pyproject.toml"}):
        add_finding(findings, "low", "Build readiness", "Deployable artifact evidence missing", "Build metadata exists, but no packaged JAR/WAR/wheel artifact was found in the upload.", "")

    ci_files = [
        rel for rel in lower_paths
        if rel in CI_FILE_NAMES or rel.startswith(".github/workflows/")
    ]
    if source_files and not ci_files:
        add_finding(findings, "low", "Test evidence", "CI evidence missing", "No recognized CI workflow file was found in the uploaded package.", "")

    coverage_files = [
        rel for rel in lower_paths
        if "coverage" in rel or rel.endswith(("jacoco.xml", "coverage.xml", "lcov.info"))
    ]
    if metrics.get("testFiles", 0) and not coverage_files:
        add_finding(findings, "low", "Test evidence", "Coverage evidence missing", "Tests were detected, but no coverage report or coverage metadata was found.", "")

    operational_files = [
        rel for rel in rel_files
        if Path(rel).name.lower() in OPERATIONAL_FILE_NAMES or any(part in rel.lower() for part in ["k8s/", "kubernetes/", "helm/", "deployment.yaml", "deployment.yml"])
    ]
    if source_files and not operational_files:
        add_finding(findings, "low", "Operational readiness", "Runtime packaging metadata missing", "No Dockerfile, Procfile, Kubernetes, Helm, or compose metadata was found.", "")

    health_evidence = []
    version_evidence = []
    for path in files:
        if not is_text_file(path):
            continue
        rel = relative(path, root_dir)
        try:
            text = path.read_text(errors="ignore")
        except OSError:
            continue
        if HEALTH_RE.search(text):
            health_evidence.append(rel)
        if VERSION_RE.search(text) and Path(rel).name.lower() in {"package.json", "pom.xml", "pyproject.toml", "manifest.mf"}:
            version_evidence.append(rel)
    if source_files and not health_evidence:
        add_finding(findings, "low", "Operational readiness", "Health check evidence missing", "No health/readiness/liveness endpoint or metadata was found in scanned text files.", "")

    if not version_evidence and not packaged_artifacts:
        add_finding(findings, "low", "Deployment metadata", "Version metadata missing", "No obvious version, commit, or build metadata was found in recognized manifests.", "")

    release_notes = [rel for rel in lower_paths if Path(rel).name.lower() in RELEASE_NOTE_NAMES]
    if "readme.md" not in lower_names and not release_notes:
        add_finding(findings, "low", "Deployment metadata", "Release documentation missing", "No README, changelog, or release notes file was found.", "")

    return findings, {
        "buildManifestCount": len(build_manifests),
        "packagedArtifactCount": len(packaged_artifacts),
        "ciFileCount": len(ci_files),
        "coverageFileCount": len(coverage_files),
        "operationalFileCount": len(operational_files),
        "healthEvidenceCount": len(set(health_evidence)),
        "versionEvidenceCount": len(set(version_evidence)),
        "releaseNoteCount": len(release_notes),
    }


def sorted_findings(findings):
    return sorted(
        findings,
        key=lambda item: (
            SEVERITY_SORT.get(item.get("severity", "info"), 9),
            item.get("category", ""),
            item.get("title", ""),
            item.get("file", ""),
            int(item.get("line") or 0),
        ),
    )


def summarize_quality_findings(findings):
    grouped_keys = {
        ("low", "Code hygiene", "Debug output"): "Remove temporary debug logging or replace it with controlled application logging.",
        ("low", "Readability", "Long lines"): "Wrap long lines so the code is easier to review and maintain.",
        ("low", "Maintainability", "Open code marker"): "Resolve TODO/FIXME/HACK markers or track them in backlog items.",
        ("medium", "Maintainability", "Large file"): "Review these files for natural module boundaries and split only where it improves maintainability.",
    }
    grouped = {}
    summarized = []
    for item in findings:
        key = (item.get("severity"), item.get("category"), item.get("title"))
        if key not in grouped_keys:
            summarized.append(dict(item))
            continue
        bucket = grouped.setdefault(key, {**item, "count": 0, "files": set(), "examples": [], "occurrences": []})
        bucket["count"] += 1
        if item.get("file"):
            bucket["files"].add(item["file"])
        bucket["occurrences"].append({
            "file": item.get("file", ""),
            "line": item.get("line", ""),
            "details": item.get("details", ""),
        })
        if item.get("file") and len(bucket["examples"]) < 3:
            example = item["file"]
            if item.get("line"):
                example = f"{example}:{item['line']}"
            bucket["examples"].append(example)

    for key, item in grouped.items():
        files = sorted(item.pop("files"))
        examples = item.pop("examples")
        file_count = len(files)
        example_text = ", ".join(examples)
        more_text = f" +{file_count - len(examples)} more files" if file_count > len(examples) else ""
        item["file"] = example_text + more_text if example_text else ""
        item["line"] = ""
        item["details"] = f"{item['count']} occurrence(s) across {file_count or 1} file(s). {grouped_keys[key]}"
        summarized.append(item)

    return sorted_findings(summarized)


def quality_score_details(findings):
    counts = {}
    for item in findings:
        severity = item.get("severity", "info")
        counts[severity] = counts.get(severity, 0) + 1
    penalties = {}
    for severity, count in counts.items():
        weighted_penalty = count * QUALITY_SCORE_WEIGHTS.get(severity, 0)
        penalties[severity] = min(weighted_penalty, QUALITY_SCORE_CAPS.get(severity, 0))
    total_penalty = sum(penalties.values())
    return {
        "score": max(0, round(100 - total_penalty)),
        "penalty": round(total_penalty, 2),
        "penalties": penalties,
    }


def quality_score(findings):
    return quality_score_details(findings)["score"]


def decision_for(score):
    if score < 60:
        return "Quality gate failed"
    if score < 80:
        return "Review recommended"
    return "Quality gate passed"


def report_card_status(score):
    if score >= 90:
        return "Good"
    if score >= 75:
        return "Review"
    if score >= 60:
        return "Needs attention"
    return "Weak"


def score_for_categories(findings, categories, base=100):
    weights = {"critical": 35, "high": 20, "medium": 10, "low": 3, "info": 0}
    penalty = 0
    for item in findings:
        if item.get("category") in categories:
            penalty += weights.get(item.get("severity", "info"), 0) * int(item.get("count", 1) or 1)
    return max(0, min(100, base - penalty))


def build_report_card(findings, metrics):
    readiness = metrics.get("readiness") or {}
    source_files = metrics.get("sourceFiles", 0) or 0
    test_files = metrics.get("testFiles", 0) or 0
    build_score = 100
    if source_files and not readiness.get("buildManifestCount"):
        build_score -= 35
    if not readiness.get("packagedArtifactCount") and not readiness.get("buildManifestCount"):
        build_score -= 15
    test_score = score_for_categories(findings, {"Testability", "Test evidence"})
    if source_files and not test_files:
        test_score = min(test_score, 60)
    if test_files and not readiness.get("coverageFileCount"):
        test_score = min(test_score, 80)
    operational_score = score_for_categories(findings, {"Operational readiness"})
    if source_files and not readiness.get("operationalFileCount"):
        operational_score = min(operational_score, 75)
    if source_files and not readiness.get("healthEvidenceCount"):
        operational_score = min(operational_score, 70)
    documentation_score = score_for_categories(findings, {"Documentation", "Deployment metadata"})
    cards = [
        {
            "area": "Maintainability",
            "score": score_for_categories(findings, {"Maintainability", "Readability", "Code hygiene", "Dependency hygiene"}),
            "status": "",
            "detail": "Large files, long lines, debug output, open markers, and dependency hygiene.",
        },
        {
            "area": "Reliability",
            "score": score_for_categories(findings, {"Reliability"}),
            "status": "",
            "detail": "Exception handling and reliability-related static signals.",
        },
        {
            "area": "Testability",
            "score": test_score,
            "status": "",
            "detail": f"{test_files} test file(s), {readiness.get('ciFileCount', 0)} CI file(s), {readiness.get('coverageFileCount', 0)} coverage file(s).",
        },
        {
            "area": "Build readiness",
            "score": max(0, min(100, build_score)),
            "status": "",
            "detail": f"{readiness.get('buildManifestCount', 0)} build manifest(s), {readiness.get('packagedArtifactCount', 0)} packaged artifact(s).",
        },
        {
            "area": "Operational readiness",
            "score": operational_score,
            "status": "",
            "detail": f"{readiness.get('operationalFileCount', 0)} runtime metadata file(s), {readiness.get('healthEvidenceCount', 0)} health evidence file(s).",
        },
        {
            "area": "Documentation",
            "score": documentation_score,
            "status": "",
            "detail": f"{readiness.get('releaseNoteCount', 0)} release note/readme evidence file(s), {readiness.get('versionEvidenceCount', 0)} version metadata file(s).",
        },
    ]
    for card in cards:
        card["status"] = report_card_status(card["score"])
    return cards


def build_markdown_report(result):
    score_details = result.get("scoreDetails") or {}
    penalties = score_details.get("penalties") or {}
    text_files = result["metrics"].get("textFiles", 0) or 0
    source_files = result["metrics"].get("sourceFiles", 0) or 0
    finding_total = result.get("findingTotal", len(result.get("findings") or []))
    readiness = result["metrics"].get("readiness") or {}
    findings_per_text_file = round(finding_total / text_files, 2) if text_files else 0
    findings_per_source_file = round(finding_total / source_files, 2) if source_files else 0
    lines = [
        "# Code Quality Assessment Report",
        "",
        f"Run ID: {result['runId']}",
        f"Generated: {result['generatedAt']}",
        f"Decision: {result['decision']}",
        f"Quality score: {result['score']}/100",
        "",
        "## Summary",
        "",
        f"- File: {result['artifact']['fileName']}",
        f"- Type: {result['artifact']['type']}",
        f"- Raw findings: {finding_total}",
        f"- Displayed finding rows: {result.get('displayFindingTotal', len(result.get('findings') or []))}",
        f"- Findings per text file: {findings_per_text_file}",
        f"- Findings per source file: {findings_per_source_file}",
        "",
        "## Score Breakdown",
        "",
        "Decision is based on the final score band: below 60 fails, 60-79 requires review, and 80 or higher passes.",
        "",
        "| Severity | Raw Count | Penalty Applied |",
        "| --- | ---: | ---: |",
    ]
    for severity in ["critical", "high", "medium", "low", "info"]:
        lines.append(f"| {severity} | {result['findingCounts'].get(severity, 0)} | {penalties.get(severity, 0)} |")
    lines.extend([
        f"| total | {finding_total} | {score_details.get('penalty', 0)} |",
    ])
    # Quality Report Card export disabled for current development.
    # lines.extend([
    #     "",
    #     "## Quality Report Card",
    #     "",
    #     "| Area | Score | Status | Evidence Basis |",
    #     "| --- | ---: | --- | --- |",
    # ])
    # for card in result.get("reportCard") or []:
    #     lines.append(f"| {card.get('area', '')} | {card.get('score', 0)} | {card.get('status', '')} | {card.get('detail', '')} |")
    lines.extend([
        "",
        "## LLM Quality Review",
        "",
        result.get("llmReview") or "LLM review was not requested or no provider was configured.",
        "",
        "## Findings",
        "",
        "| Severity | Count | Category | Title | File | Line | Recommended Action |",
        "| --- | ---: | --- | --- | --- | ---: | --- |",
    ])
    if not result["findings"]:
        lines.append("| info | 0 | Quality | No findings |  |  | No quality findings were detected by the static checks. |")
    for item in result["findings"]:
        lines.append(f"| {item['severity']} | {item.get('count', 1)} | {item['category']} | {item['title']} | {item.get('file', '')} | {item.get('line', '')} | {item['details']} |")
    lines.extend([
        "",
        "## Finding Occurrences",
        "",
        "Grouped rows above are expanded here so each affected file and line can be located.",
        "",
        "| Severity | Category | Title | File | Line | Details |",
        "| --- | --- | --- | --- | ---: | --- |",
    ])
    occurrence_count = 0
    for item in result["findings"]:
        occurrences = item.get("occurrences") or []
        if not occurrences:
            lines.append(f"| {item['severity']} | {item['category']} | {item['title']} | {item.get('file', '')} | {item.get('line', '')} | {item['details']} |")
            occurrence_count += 1
            continue
        for occurrence in occurrences:
            lines.append(f"| {item['severity']} | {item['category']} | {item['title']} | {occurrence.get('file', '')} | {occurrence.get('line', '')} | {occurrence.get('details', '')} |")
            occurrence_count += 1
    if occurrence_count == 0:
        lines.append("| info | Quality | No findings |  |  | No quality findings were detected by the static checks. |")
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


def quality_finding_rows(findings):
    rows = [style_header(["Severity", "Count", "Category", "Title", "File", "Line", "Recommended Action"])]
    for item in findings:
        rows.append([
            item.get("severity", ""),
            item.get("count", 1),
            item.get("category", ""),
            item.get("title", ""),
            item.get("file", ""),
            item.get("line", ""),
            item.get("details", ""),
        ])
    if len(rows) == 1:
        rows.append(["info", 0, "Quality", "No findings", "", "", "No quality findings were detected."])
    return rows


def quality_occurrence_rows(findings):
    rows = [style_header(["Severity", "Category", "Title", "File", "Line", "Details"])]
    for item in findings:
        occurrences = item.get("occurrences") or []
        if not occurrences:
            rows.append([
                item.get("severity", ""),
                item.get("category", ""),
                item.get("title", ""),
                item.get("file", ""),
                item.get("line", ""),
                item.get("details", ""),
            ])
            continue
        for occurrence in occurrences:
            rows.append([
                item.get("severity", ""),
                item.get("category", ""),
                item.get("title", ""),
                occurrence.get("file", ""),
                occurrence.get("line", ""),
                occurrence.get("details", ""),
            ])
    if len(rows) == 1:
        rows.append(["info", "Quality", "No findings", "", "", "No quality findings were detected."])
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
        rows.append(["Quality", 0, "No data", "No report card data was generated."])
    return rows


def build_xlsx_report(result):
    score_details = result.get("scoreDetails") or {}
    penalties = score_details.get("penalties") or {}
    density = result.get("findingDensity") or {}
    readiness = result["metrics"].get("readiness") or {}
    summary_rows = [
        [{"value": "Code Quality Assessment Report", "style": 2}],
        [],
        style_header(["Field", "Value"]),
        ["Run ID", result["runId"]],
        ["Generated", result["generatedAt"]],
        ["Decision", result["decision"]],
        ["Quality score", result["score"]],
        ["File", result["artifact"]["fileName"]],
        ["Type", result["artifact"]["type"]],
        ["Size bytes", result["artifact"]["sizeBytes"]],
        ["SHA-256", result["artifact"]["sha256"]],
        ["Raw findings", result.get("findingTotal", len(result.get("findings") or []))],
        ["Displayed finding rows", result.get("displayFindingTotal", len(result.get("findings") or []))],
        ["Findings per text file", density.get("perTextFile", 0)],
        ["Findings per source file", density.get("perSourceFile", 0)],
        ["Score penalty", score_details.get("penalty", 0)],
        ["Decision rule", "Score bands: <60 failed, 60-79 review, >=80 passed"],
        [],
        style_header(["Severity", "Count", "Penalty Applied"]),
    ]
    for severity in ["critical", "high", "medium", "low", "info"]:
        summary_rows.append([severity, result["findingCounts"].get(severity, 0), penalties.get(severity, 0)])
    llm_rows = [
        [{"value": "LLM Quality Review", "style": 2}],
        [],
        ["Review", result.get("llmReview") or "LLM review was not requested or no provider was configured."],
    ]
    sheets = [
        ("Summary", summary_rows, [28, 90]),
        # Quality Report Card export disabled for current development.
        # ("Report Card", report_card_rows(result.get("reportCard") or []), [30, 12, 20, 90]),
        ("Findings", quality_finding_rows(result["findings"]), [14, 10, 22, 34, 48, 10, 80]),
        ("Occurrences", quality_occurrence_rows(result["findings"]), [14, 22, 34, 60, 10, 80]),
        ("LLM Review", llm_rows, [22, 120]),
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
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as package:
        package.writestr("[Content_Types].xml", "".join(content_types))
        package.writestr("_rels/.rels", rels_xml)
        package.writestr("xl/workbook.xml", workbook_xml)
        package.writestr("xl/_rels/workbook.xml.rels", "".join(workbook_rels))
        package.writestr("xl/styles.xml", styles_xml)
        for index, (_, rows, widths) in enumerate(sheets, start=1):
            package.writestr(f"xl/worksheets/sheet{index}.xml", xlsx_sheet_xml(rows, widths))
    return output.getvalue()


def source_file_priority(path):
    suffix = path.suffix.lower()
    if suffix in {".py", ".js", ".ts", ".tsx", ".jsx", ".java"}:
        return 0
    if path.name.lower() in {"package.json", "pom.xml", "pyproject.toml", "requirements.txt"}:
        return 1
    return 2


def build_llm_quality_payload(result, files, root_dir):
    finding_files = {item.get("file") for item in result["findings"] if item.get("file")}
    candidates = []
    for path in files:
        if not is_text_file(path):
            continue
        rel = relative(path, root_dir)
        if rel in finding_files or path.suffix.lower() in {".py", ".js", ".ts", ".tsx", ".jsx", ".java"}:
            candidates.append(path)
    candidates.sort(key=lambda path: (source_file_priority(path), path.stat().st_size if path.exists() else 0, relative(path, root_dir)))
    samples = []
    for path in candidates[:MAX_LLM_QUALITY_SAMPLE_FILES]:
        try:
            lines = path.read_text(errors="ignore").splitlines()
        except OSError:
            continue
        samples.append({
            "file": relative(path, root_dir),
            "lineCount": len(lines),
            "sample": redact_text("\n".join(lines[:MAX_LLM_QUALITY_SAMPLE_LINES]))[:MAX_LLM_QUALITY_SAMPLE_CHARS],
        })
    return {
        "artifact": result["artifact"],
        "decision": result["decision"],
        "score": result["score"],
        "metrics": result["metrics"],
        "findingCounts": result["findingCounts"],
        "findings": result["findings"][:MAX_LLM_QUALITY_FINDINGS],
        "omittedFindingCount": max(0, len(result["findings"]) - MAX_LLM_QUALITY_FINDINGS),
        "codeSamples": samples,
    }


def assess_quality(file_name, content_base64, runs_dir, llm_reviewer=None):
    data = base64.b64decode(content_base64 or "")
    if not data:
        raise ValueError("Uploaded artifact is empty.")
    if len(data) > MAX_UPLOAD_BYTES:
        raise ValueError(f"Uploaded artifact exceeds {MAX_UPLOAD_BYTES} bytes.")
    run_id = make_run_id()
    run_dir = Path(runs_dir) / run_id
    upload_dir = run_dir / "upload"
    extract_dir = run_dir / "quality-extract"
    upload_dir.mkdir(parents=True, exist_ok=True)
    extract_dir.mkdir(parents=True, exist_ok=True)
    cleaned_name = safe_name(file_name)
    artifact_path = upload_dir / cleaned_name
    artifact_path.write_bytes(data)
    artifact = {
        "fileName": cleaned_name,
        "originalFileName": Path(file_name or "").name,
        "type": detect_type(file_name),
        "sizeBytes": len(data),
        "sha256": hashlib.sha256(data).hexdigest(),
    }
    extraction_findings = []
    archive = extract_artifact(artifact_path, extract_dir, artifact["type"], extraction_findings)
    files = walk_files(extract_dir, extraction_findings)
    raw_findings, metrics = scan_text_quality(files, extract_dir)
    readiness_findings, readiness_metrics = scan_deployment_readiness(files, extract_dir, metrics)
    raw_findings = extraction_findings + raw_findings
    raw_findings.extend(readiness_findings)
    metrics["readiness"] = readiness_metrics
    counts = {}
    for item in raw_findings:
        counts[item["severity"]] = counts.get(item["severity"], 0) + 1
    score_details = quality_score_details(raw_findings)
    score = score_details["score"]
    findings = summarize_quality_findings(raw_findings)
    report_card = build_report_card(raw_findings, metrics)
    text_file_count = metrics.get("textFiles", 0) or 0
    source_file_count = metrics.get("sourceFiles", 0) or 0
    finding_density = {
        "perTextFile": round(len(raw_findings) / text_file_count, 2) if text_file_count else 0,
        "perSourceFile": round(len(raw_findings) / source_file_count, 2) if source_file_count else 0,
    }
    result = {
        "runId": run_id,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "artifact": artifact,
        "archive": archive,
        "metrics": metrics,
        "score": score,
        "scoreDetails": score_details,
        "decision": decision_for(score),
        "findingCounts": counts,
        "findingTotal": len(raw_findings),
        "displayFindingTotal": len(findings),
        "findingDensity": finding_density,
        "reportCard": report_card,
        "findings": findings,
        "llmReview": "",
    }
    if llm_reviewer:
        try:
            result["llmReview"] = llm_reviewer(build_llm_quality_payload(result, files, extract_dir))
        except Exception as exc:
            result["llmReview"] = "LLM quality review unavailable: " + redact_text(str(exc))
    result["reportMarkdown"] = build_markdown_report(result)
    report_excel = build_xlsx_report(result)
    (run_dir / "quality-report.md").write_text(result["reportMarkdown"], encoding="utf-8")
    (run_dir / "quality-report.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
    (run_dir / "quality-report.xlsx").write_bytes(report_excel)
    result["rawFileCleanup"] = cleanup_raw_run_files(upload_dir, extract_dir)
    (run_dir / "quality-report.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
    result["markdownPath"] = str(run_dir / "quality-report.md")
    result["jsonPath"] = str(run_dir / "quality-report.json")
    result["excelPath"] = str(run_dir / "quality-report.xlsx")
    return result
