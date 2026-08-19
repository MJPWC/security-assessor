import os
from pathlib import Path

from .common import relative_path, run_command, scanner_timeout, tool_path


def analyze_java_bytecode(artifact_path, extract_dir, files, artifact_type):
    class_files = [path for path in files if path.suffix.lower() == ".class"]
    jar_files = [path for path in files if path.suffix.lower() in {".jar", ".war"}]
    result = {
        "classFileCount": len(class_files),
        "classFiles": [relative_path(path, extract_dir) for path in class_files[:200]],
        "nestedJarCount": len(jar_files),
        "decompile": {
            "attempted": False,
            "ok": False,
            "tool": "",
            "outputDir": "",
            "javaFileCount": 0,
            "error": "",
        },
    }
    if not class_files or artifact_type not in {"java-jar", "java-war"}:
        return result

    cfr_jar = os.getenv("SECURITY_ASSESSOR_CFR_JAR", "").strip()
    java_bin = tool_path("java")
    if not cfr_jar:
        result["decompile"]["error"] = "CFR decompiler not configured. Set SECURITY_ASSESSOR_CFR_JAR to enable Java source reconstruction."
        return result
    if not Path(cfr_jar).exists():
        result["decompile"]["error"] = f"CFR jar not found at configured path: {cfr_jar}"
        return result
    if not java_bin:
        result["decompile"]["error"] = "java command is not installed or not on PATH."
        return result

    output_dir = extract_dir / "_decompiled_java"
    output_dir.mkdir(parents=True, exist_ok=True)
    command = [
        java_bin,
        "-jar",
        cfr_jar,
        str(artifact_path),
        "--outputdir",
        str(output_dir),
    ]
    result["decompile"].update({
        "attempted": True,
        "tool": "cfr",
        "outputDir": str(output_dir),
    })
    completed = run_command(command, cwd=extract_dir.parent, timeout=scanner_timeout("SECURITY_ASSESSOR_DECOMPILE_TIMEOUT_SECONDS", 180))
    java_files = list(output_dir.rglob("*.java")) if output_dir.exists() else []
    result["decompile"].update({
        "ok": completed["returnCode"] == 0 and bool(java_files),
        "javaFileCount": len(java_files),
        "error": completed["error"] or completed["stderr"][:1200],
    })
    return result
