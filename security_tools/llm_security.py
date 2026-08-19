import json
import re
from pathlib import Path


SECURITY_RELEVANT_NAMES = {
    "package.json", "package-lock.json", "pom.xml", "build.gradle", "settings.gradle",
    "requirements.txt", "pyproject.toml", "dockerfile", "docker-compose.yml",
    "application.properties", "application.yml", "application.yaml", ".env", ".env.local",
    "config.json", "settings.py", "web.xml",
}
SECURITY_RELEVANT_EXTENSIONS = {".java", ".js", ".ts", ".py", ".xml", ".yaml", ".yml", ".json", ".properties", ".conf", ".cfg", ".ini"}
SECURITY_PATH_RE = re.compile(r"(auth|security|login|session|token|secret|config|controller|route|api|filter|middleware|permission|policy)", re.I)


def _safe_read(path, max_chars):
    try:
        text = path.read_text(errors="ignore")
    except Exception:
        return ""
    return text[:max_chars]


def _line_excerpt(path, line_number, radius=8, max_chars=6000):
    try:
        lines = path.read_text(errors="ignore").splitlines()
    except Exception:
        return ""
    if not line_number:
        return "\n".join(lines[:80])[:max_chars]
    start = max(0, int(line_number) - radius - 1)
    end = min(len(lines), int(line_number) + radius)
    return "\n".join(f"{idx + 1}: {lines[idx]}" for idx in range(start, end))[:max_chars]


def select_critical_files(files, extract_dir, findings=None, external_vulnerabilities=None, max_files=18, max_chars_per_file=6000):
    scored = {}

    def add_score(path, points, reason, line=None):
        if not path or not path.exists() or not path.is_file():
            return
        current = scored.setdefault(path, {"score": 0, "reasons": set(), "lines": set()})
        current["score"] += points
        current["reasons"].add(reason)
        if line:
            current["lines"].add(line)

    for path in files:
        name = path.name.lower()
        rel = str(path.relative_to(extract_dir)).replace("\\", "/")
        if name in SECURITY_RELEVANT_NAMES or name.startswith(".env"):
            add_score(path, 8, "security/config manifest")
        if path.suffix.lower() in SECURITY_RELEVANT_EXTENSIONS and SECURITY_PATH_RE.search(rel):
            add_score(path, 6, "security-relevant path/name")
        if name in {"pom.xml", "package.json", "requirements.txt", "pyproject.toml"}:
            add_score(path, 6, "dependency manifest")

    by_rel = {str(path.relative_to(extract_dir)).replace("\\", "/"): path for path in files}
    for finding in findings or []:
        evidence = finding.get("evidence") or {}
        candidates = []
        if isinstance(evidence, dict):
            candidates.append(evidence.get("file"))
            for occurrence in evidence.get("occurrences") or []:
                if isinstance(occurrence, dict):
                    candidates.append(occurrence.get("file"))
        for rel in candidates:
            if rel in by_rel:
                add_score(by_rel[rel], 10, f"referenced by {finding.get('task', 'finding')}", evidence.get("line"))

    for vuln in external_vulnerabilities or []:
        rel = str(vuln.get("file_location") or "")
        if rel in by_rel:
            add_score(by_rel[rel], 10, f"referenced by {vuln.get('scanner', 'scanner')}")

    selected = sorted(scored.items(), key=lambda item: (-item[1]["score"], str(item[0])))[:max_files]
    snippets = []
    for path, meta in selected:
        rel = str(path.relative_to(extract_dir)).replace("\\", "/")
        lines = sorted(meta["lines"])
        snippet = _line_excerpt(path, lines[0], max_chars=max_chars_per_file) if lines else _safe_read(path, max_chars_per_file)
        snippets.append({
            "file": rel,
            "score": meta["score"],
            "reasons": sorted(meta["reasons"]),
            "snippet": snippet,
        })
    return snippets


def parse_llm_json(text):
    if not text:
        return {"score": 0, "summary": "", "findings": [], "raw": ""}
    cleaned = str(text).strip()
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned)
        cleaned = re.sub(r"\s*```$", "", cleaned)
    try:
        parsed = json.loads(cleaned)
    except json.JSONDecodeError:
        start = cleaned.find("{")
        end = cleaned.rfind("}")
        if start >= 0 and end > start:
            try:
                parsed = json.loads(cleaned[start:end + 1])
            except json.JSONDecodeError:
                return {"score": 0, "summary": "", "findings": [], "raw": text}
        else:
            return {"score": 0, "summary": "", "findings": [], "raw": text}
    if isinstance(parsed, list):
        parsed = {"score": 0, "summary": "", "findings": parsed}
    if "findings" not in parsed and "vulnerabilities" in parsed:
        parsed["findings"] = parsed.get("vulnerabilities") or []
    parsed.setdefault("score", 0)
    parsed.setdefault("summary", "")
    parsed.setdefault("findings", [])
    parsed["vulnerabilities"] = parsed["findings"]
    return parsed


def run_structured_security_llm(call_llm, redact_value, redact_text, assessment, files, extract_dir):
    external_vulnerabilities = assessment.get("externalVulnerabilities") or []
    snippets = select_critical_files(
        files,
        extract_dir,
        findings=assessment.get("findings"),
        external_vulnerabilities=external_vulnerabilities,
    )
    payload = redact_value({
        "artifact": assessment.get("artifact"),
        "decision": assessment.get("decision"),
        "findingCounts": assessment.get("findingCounts"),
        "findings": assessment.get("findings"),
        "externalVulnerabilities": external_vulnerabilities[:80],
        "javaAnalysis": assessment.get("javaAnalysis"),
        "trivyScan": {key: value for key, value in (assessment.get("trivyScan") or {}).items() if key != "vulnerabilities"},
        "dependencyCheck": {key: value for key, value in (assessment.get("dependencyCheck") or {}).items() if key != "vulnerabilities"},
        "criticalFileSnippets": snippets,
    })
    system = (
        "You are an expert DevSecOps Automated Auditor. You will receive redacted scanner results, "
        "normalized vulnerability records, artifact metadata, Java bytecode analysis, and selected "
        "source/configuration snippets from an uploaded application build.\n\n"
        "Your task:\n"
        "1. Prioritize exploitable security risks from scanner findings and source snippets.\n"
        "2. Review the provided code/configuration for logic flaws, hardcoded secrets, auth/session "
        "weaknesses, injection risks, unsafe deserialization/parsing, insecure transport, and dangerous defaults.\n"
        "3. Filter out likely false positives when evidence shows the value is a placeholder, local-only "
        "setting, identifier name, storage key, generated metadata, or scanner noise.\n"
        "4. Do not invent findings. If evidence is insufficient, either omit the issue or mark confidence as \"low\".\n"
        "5. Do not request secrets or additional source code.\n\n"
        "Return valid JSON only with this exact shape:\n"
        "{"
        "\"score\": 1-100,"
        "\"summary\": \"Exactly 3 sentences describing the build's security posture.\","
        "\"findings\": ["
        "{"
        "\"title\": \"Issue name\","
        "\"severity\": \"critical|high|medium|low|info\","
        "\"confidence\": \"high|medium|low\","
        "\"file\": \"path:line if known\","
        "\"description\": \"Plain-language exploitation impact.\","
        "\"fix\": \"Exact code/config change when enough context is present; otherwise precise remediation guidance.\""
        "}"
        "]"
        "}"
    )
    try:
        raw = call_llm([
            {"role": "system", "content": system},
            {"role": "user", "content": json.dumps(payload, indent=2)},
        ], config_label="Structured Security LLM")
        parsed = parse_llm_json(redact_text(raw))
        parsed["selectedFiles"] = [{"file": item["file"], "reasons": item["reasons"], "score": item["score"]} for item in snippets]
        return parsed
    except Exception as exc:
        return {
            "score": 0,
            "summary": "Structured LLM security review unavailable.",
            "findings": [],
            "vulnerabilities": [],
            "selectedFiles": [{"file": item["file"], "reasons": item["reasons"], "score": item["score"]} for item in snippets],
            "error": redact_text(str(exc)),
        }
