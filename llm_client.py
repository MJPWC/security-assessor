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
CONFIG_REFERENCE_RE = re.compile(
    r"^(?:"
    r"\$\{[^}]+\}|"
    r"#\{[^}]+\}|"
    r"\{\{[^}]+\}\}|"
    r"%[A-Z_][A-Z0-9_]*%|"
    r"\$[A-Z_][A-Z0-9_]*|"
    r"process\.env\.[\w.]+|"
    r"import\.meta\.env\.[\w.]+|"
    r"env\.[\w.]+|"
    r"os\.environ(?:\.get)?\(?[\"']?[\w.]+"
    r")$",
    re.I,
)
PLACEHOLDER_SECRET_RE = re.compile(
    r"^(?:<[^>]+>|your[_-]?[a-z0-9_-]*|my[_-]?[a-z0-9_-]*|change_?me|changeme|todo|tbd|redacted|"
    r"example|sample|dummy|placeholder|abc(?:123)?|xyz(?:789)?|foo|bar|baz|null|none|undefined|true|false)$",
    re.I,
)
SENSITIVE_ASSIGNMENT_VALUE_RE = re.compile(
    r"\b(?P<prefix>[\w.-]*(?:api[_-]?key|apikey|token|secret|password|client[_-]?secret|clientSecret|authorization|x-api-key)[\w.-]*\b\s*[:=]\s*)"
    r"(?:(?P<quote>[\"'`])(?P<quoted_value>[^\r\n]*?)(?P=quote)|(?P<config_value>\$\{[^}\r\n]+\}|#\{[^}\r\n]+\}|\{\{[^}\r\n]+\}\}|%[A-Z_][A-Z0-9_]*%|\$[A-Z_][A-Z0-9_]*)|(?P<value>[^\"'`,\s}\\)]+))",
    re.I,
)


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
    return SENSITIVE_ASSIGNMENT_VALUE_RE.sub(redact_assignment_match, text)


def is_placeholder_or_reference(value):
    text = str(value or "").strip().strip("\"'`")
    if not text:
        return True
    return bool(CONFIG_REFERENCE_RE.fullmatch(text) or PLACEHOLDER_SECRET_RE.fullmatch(text))


def redact_assignment_match(match):
    value = match.group("quoted_value") if match.group("quote") else (match.group("config_value") or match.group("value"))
    if is_placeholder_or_reference(value):
        return match.group(0)
    quote = match.group("quote") or ""
    if quote:
        return f"{match.group('prefix')}{quote}[REDACTED_SECRET]{quote}"
    return f"{match.group('prefix')}[REDACTED_SECRET]"


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
    configs = {
        "anthropic_gateway": (
            gateway_token if gateway_base_url else "",
            os.getenv("ANTHROPIC_GATEWAY_MODEL") or os.getenv("ANTHROPIC_MODEL", "claude-3-7-sonnet-20250219"),
        ),
        "anthropic": (
            first_env_value("ANTHROPIC_API_KEY", "ANTHROPIC_STANDARD_API_KEY", "ANTHROPIC_FALLBACK_API_KEY"),
            os.getenv("ANTHROPIC_MODEL", "claude-3-7-sonnet-20250219"),
        ),
        "groq": (first_env_value("GROQ_API_KEY"), os.getenv("GROQ_MODEL", "openai/gpt-oss-120b")),
        "openai": (first_env_value("OPENAI_API_KEY"), os.getenv("OPENAI_MODEL", "gpt-4o-mini")),
        "gemini": (
            first_env_value("GEMINI_API_KEY", "GEMINI_API_KEY_1", "GEMINI_API_KEY_2", "GEMINI_API_KEY_3", "GEMINI_API_KEY_4"),
            os.getenv("GEMINI_MODEL", "gemini-2.0-flash"),
        ),
        "openrouter": (first_env_value("OPENROUTER_API_KEY"), os.getenv("OPENROUTER_MODEL", "meta-llama/llama-3.1-8b-instruct")),
    }
    providers = []
    for provider in LLM_PROVIDER_SEQUENCE:
        api_key, model = configs.get(provider, ("", ""))
        if api_key:
            providers.append((provider, api_key, model))
    return providers


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


def raise_for_provider_error(provider, data):
    if not isinstance(data, dict):
        raise RuntimeError(f"{provider} returned a non-object JSON response.")
    error = data.get("error")
    if error:
        if isinstance(error, dict):
            message = error.get("message") or error.get("detail") or json.dumps(redact_value(error))
        else:
            message = str(error)
        raise RuntimeError(f"{provider} returned an error: {redact_text(message)}")


def anthropic_response_text(provider, data):
    raise_for_provider_error(provider, data)
    parts = data.get("content") or []
    text = "\n".join(part.get("text", "") for part in parts if isinstance(part, dict)).strip()
    if not text:
        raise RuntimeError(f"{provider} returned no text content.")
    return text


def gemini_response_text(provider, data):
    raise_for_provider_error(provider, data)
    parts = data.get("candidates", [{}])[0].get("content", {}).get("parts", [])
    text = "\n".join(part.get("text", "") for part in parts if isinstance(part, dict)).strip()
    if not text:
        raise RuntimeError(f"{provider} returned no text content.")
    return text


def chat_response_text(provider, data):
    raise_for_provider_error(provider, data)
    text = data.get("choices", [{}])[0].get("message", {}).get("content", "")
    if not str(text).strip():
        raise RuntimeError(f"{provider} returned no text content.")
    return text


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
                return anthropic_response_text(provider, data)
            if provider == "anthropic":
                endpoint = join_url(first_env_value("ANTHROPIC_API_BASE_URL", "ANTHROPIC_STANDARD_BASE_URL") or "https://api.anthropic.com", "/v1/messages")
                data = http_json(
                    endpoint,
                    {"Content-Type": "application/json", "x-api-key": api_key, "anthropic-version": os.getenv("ANTHROPIC_API_VERSION", "2023-06-01")},
                    {"model": model, "system": messages[0]["content"], "messages": messages[1:], "temperature": 0.2, "max_tokens": 900},
                )
                return anthropic_response_text(provider, data)
            if provider == "gemini":
                base_url = os.getenv("GEMINI_BASE_URL", "https://generativelanguage.googleapis.com")
                data = http_json(
                    f"{join_url(base_url, f'/v1beta/models/{model}:generateContent')}?key={api_key}",
                    {"Content-Type": "application/json"},
                    {"contents": [{"role": "user", "parts": [{"text": "\n\n".join(message["content"] for message in messages)}]}], "generationConfig": {"temperature": 0.2, "maxOutputTokens": 900}},
                )
                return gemini_response_text(provider, data)
            endpoint = join_url(os.getenv("OPENAI_BASE_URL", "https://api.openai.com"), "/v1/chat/completions")
            headers = {"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"}
            if provider == "groq":
                endpoint = join_url(os.getenv("GROQ_BASE_URL", "https://api.groq.com"), "/openai/v1/chat/completions")
            if provider == "openrouter":
                endpoint = join_url(os.getenv("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1"), "/chat/completions")
            data = http_json(endpoint, headers, {"model": model, "messages": messages, "temperature": 0.2, "max_tokens": 900})
            return chat_response_text(provider, data)
        except Exception as exc:
            errors.append(f"{provider}: {redact_text(str(exc))}")
    raise RuntimeError("LLM request failed for all configured providers. " + " | ".join(errors))


def llm_status(providers=None):
    providers = provider_configs() if providers is None else providers
    return {
        "configured": bool(providers),
        "providers": [provider for provider, _, _ in providers],
    }
