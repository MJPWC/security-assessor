#!/usr/bin/env python3
import json
import os
import re
import urllib.error
import urllib.request
from pathlib import Path

APP_DIR = Path(__file__).resolve().parent
LLM_PROVIDER_SEQUENCE = ["anthropic_gateway", "anthropic", "groq", "openai", "gemini", "openrouter"]
SENSITIVE_KEY_RE = re.compile(r"(api[_-]?key|apikey|token|secret|password|client[_-]?secret|clientSecret|authorization|x-api-key)", re.I)
PLACEHOLDER_MARKERS = ["__replace", "replace_me", "your_", "placeholder", "change_me", "changeme", "dummy", "example"]


def load_env_file(path, override=False):
    if not path.exists():
        return
    for line in path.read_text(errors="ignore").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        key = key.strip()
        parsed_value = value.strip().strip('"').strip("'")
        if not parsed_value:
            continue
        if override or key not in os.environ:
            os.environ[key] = parsed_value


load_env_file(APP_DIR / ".env")
load_env_file(APP_DIR / ".env.local", override=True)
load_env_file(APP_DIR / ".envlocal", override=True)
load_env_file(APP_DIR / ".env.private", override=True)


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


def env_value(name):
    value = (os.getenv(name) or "").strip()
    if not value:
        return ""
    lower = value.lower()
    if any(marker in lower for marker in PLACEHOLDER_MARKERS):
        return ""
    return value


def first_env_value(*names):
    for name in names:
        value = env_value(name)
        if value:
            return value
    return ""


def provider_configs():
    gateway_token = first_env_value("ANTHROPIC_GATEWAY_AUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN")
    gateway_base_url = first_env_value("ANTHROPIC_GATEWAY_BASE_URL", "ANTHROPIC_BASE_URL")
    configs = [
        (
            "anthropic_gateway",
            gateway_token if gateway_base_url else "",
            os.getenv("ANTHROPIC_GATEWAY_MODEL") or os.getenv("ANTHROPIC_MODEL", "claude-3-7-sonnet-20250219"),
        ),
        ("anthropic", first_env_value("ANTHROPIC_API_KEY"), os.getenv("ANTHROPIC_MODEL", "claude-3-7-sonnet-20250219")),
        ("groq", first_env_value("GROQ_API_KEY"), os.getenv("GROQ_MODEL", "openai/gpt-oss-120b")),
        ("openai", first_env_value("OPENAI_API_KEY"), os.getenv("OPENAI_MODEL", "gpt-4o-mini")),
        ("gemini", first_env_value("GEMINI_API_KEY", "GEMINI_API_KEY_1", "GEMINI_API_KEY_2", "GEMINI_API_KEY_3", "GEMINI_API_KEY_4"), os.getenv("GEMINI_MODEL", "gemini-2.0-flash")),
        ("openrouter", first_env_value("OPENROUTER_API_KEY"), os.getenv("OPENROUTER_MODEL", "meta-llama/llama-3.1-8b-instruct")),
    ]
    available = [item for item in configs if item[1]]
    preferred = os.getenv("LLM_PROVIDER", "").lower()
    if preferred:
        available.sort(key=lambda item: 0 if item[0] == preferred else LLM_PROVIDER_SEQUENCE.index(item[0]) + 1)
    else:
        available.sort(key=lambda item: LLM_PROVIDER_SEQUENCE.index(item[0]))
    return available


def join_url(base_url, path):
    return str(base_url or "").rstrip("/") + "/" + str(path or "").lstrip("/")


def http_json(url, headers, body):
    request = urllib.request.Request(url, data=json.dumps(body).encode("utf-8"), headers=headers, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        error_body = exc.read(4000).decode("utf-8", errors="ignore")
        raise RuntimeError(f"HTTP {exc.code}: {redact_text(error_body or exc.reason)}") from exc


def call_llm(messages, providers=None, config_label="LLM"):
    errors = []
    providers = provider_configs() if providers is None else providers
    if not providers:
        raise RuntimeError(f"No {config_label} provider is configured. Set ANTHROPIC_AUTH_TOKEN with ANTHROPIC_GATEWAY_BASE_URL, or set one of ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, GROQ_API_KEY, or OPENROUTER_API_KEY in Security Assessor's .env.local, .envlocal, or .env.private, then restart the app.")
    for provider, api_key, model in providers:
        try:
            if provider == "anthropic_gateway":
                endpoint = join_url(
                    first_env_value("ANTHROPIC_GATEWAY_BASE_URL", "ANTHROPIC_BASE_URL"),
                    "/v1/messages",
                )
                data = http_json(
                    endpoint,
                    {"Content-Type": "application/json", "Authorization": f"Bearer {api_key}", "anthropic-version": os.getenv("ANTHROPIC_API_VERSION", "2023-06-01")},
                    {"model": model, "system": messages[0]["content"], "messages": messages[1:], "temperature": 0.2, "max_tokens": 900},
                )
                return "\n".join(part.get("text", "") for part in data.get("content", []))
            if provider == "anthropic":
                endpoint = join_url(first_env_value("ANTHROPIC_API_BASE_URL", "ANTHROPIC_STANDARD_BASE_URL") or "https://api.anthropic.com", "/v1/messages")
                data = http_json(
                    endpoint,
                    {"Content-Type": "application/json", "x-api-key": api_key, "anthropic-version": os.getenv("ANTHROPIC_API_VERSION", "2023-06-01")},
                    {"model": model, "system": messages[0]["content"], "messages": messages[1:], "temperature": 0.2, "max_tokens": 900},
                )
                return "\n".join(part.get("text", "") for part in data.get("content", []))
            if provider == "gemini":
                base_url = os.getenv("GEMINI_BASE_URL", "https://generativelanguage.googleapis.com")
                data = http_json(
                    f"{join_url(base_url, f'/v1beta/models/{model}:generateContent')}?key={api_key}",
                    {"Content-Type": "application/json"},
                    {"contents": [{"role": "user", "parts": [{"text": "\n\n".join(message["content"] for message in messages)}]}], "generationConfig": {"temperature": 0.2, "maxOutputTokens": 900}},
                )
                return "\n".join(part.get("text", "") for part in data.get("candidates", [{}])[0].get("content", {}).get("parts", []))
            endpoint = join_url(os.getenv("OPENAI_BASE_URL", "https://api.openai.com"), "/v1/chat/completions")
            headers = {"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"}
            if provider == "groq":
                endpoint = join_url(os.getenv("GROQ_BASE_URL", "https://api.groq.com"), "/openai/v1/chat/completions")
            if provider == "openrouter":
                endpoint = join_url(os.getenv("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1"), "/chat/completions")
            data = http_json(endpoint, headers, {"model": model, "messages": messages, "temperature": 0.2, "max_tokens": 900})
            return data.get("choices", [{}])[0].get("message", {}).get("content", "")
        except Exception as exc:
            errors.append(f"{provider}: {redact_text(str(exc))}")
    raise RuntimeError("LLM request failed for all configured providers. " + " | ".join(errors))


def llm_status(providers=None):
    providers = provider_configs() if providers is None else providers
    return {
        "configured": bool(providers),
        "providers": [provider for provider, _, _ in providers],
    }
