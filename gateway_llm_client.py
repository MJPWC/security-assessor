#!/usr/bin/env python3
"""
gateway_llm_client.py

Standalone client for calling an employer-provided / gateway-fronted Anthropic
endpoint that authenticates via a Bearer token (ANTHROPIC_AUTH_TOKEN) instead
of the standard Anthropic Console x-api-key (ANTHROPIC_API_KEY).

This module is intentionally kept separate from llm_client.py so the existing
call_llm() / provider_configs() flow used by app.py is untouched. Wire this in
only where you specifically want to call the gateway.

Required env vars (set in .env.local / .envlocal / .env.private, same as
llm_client.py already loads):

    ANTHROPIC_AUTH_TOKEN        the token value shown in VS Code settings.json
    ANTHROPIC_GATEWAY_BASE_URL  the gateway base URL from VS Code settings.json
    ANTHROPIC_GATEWAY_MODEL     the exact model name string from VS Code settings.json

Usage:
    from gateway_llm_client import call_gateway_llm
    text = call_gateway_llm([
        {"role": "system", "content": "You are a helpful reviewer."},
        {"role": "user", "content": "Summarize this."},
    ])
"""
import json
import os
import urllib.error
import urllib.request

# Reuse the same redaction helpers as llm_client.py so error messages never
# leak secrets, without importing/modifying llm_client.py's call flow.
from llm_client import redact_text, env_value, join_url


def gateway_configured():
    return bool(env_value("ANTHROPIC_AUTH_TOKEN") and env_value("ANTHROPIC_GATEWAY_BASE_URL"))


def gateway_status():
    return {
        "configured": gateway_configured(),
        "baseUrl": env_value("ANTHROPIC_GATEWAY_BASE_URL"),
        "model": os.getenv("ANTHROPIC_GATEWAY_MODEL") or os.getenv("ANTHROPIC_MODEL", ""),
    }


def _http_json(url, headers, body):
    request = urllib.request.Request(url, data=json.dumps(body).encode("utf-8"), headers=headers, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        error_body = exc.read(4000).decode("utf-8", errors="ignore")
        raise RuntimeError(f"HTTP {exc.code}: {redact_text(error_body or exc.reason)}") from exc


def call_gateway_llm(messages, model=None, base_url=None, auth_token=None, max_tokens=900, temperature=0.2):
    """
    Calls an Anthropic-API-shaped endpoint (POST {base_url}/v1/messages) using
    Authorization: Bearer <token> instead of x-api-key.

    messages: list of {"role": ..., "content": ...} dicts, same shape as
              llm_client.call_llm expects. messages[0] must be the system
              message; the rest are passed through as the conversation.

    Raises RuntimeError with a redacted message on failure. Never raises with
    the raw token/secret in the exception text.
    """
    token = auth_token or env_value("ANTHROPIC_AUTH_TOKEN")
    resolved_base_url = base_url or env_value("ANTHROPIC_GATEWAY_BASE_URL")
    resolved_model = model or os.getenv("ANTHROPIC_GATEWAY_MODEL") or os.getenv("ANTHROPIC_MODEL", "")

    if not token:
        raise RuntimeError(
            "ANTHROPIC_AUTH_TOKEN is not set. Add it to .env.local / .envlocal / "
            ".env.private using the token value from your VS Code settings.json."
        )
    if not resolved_base_url:
        raise RuntimeError(
            "ANTHROPIC_GATEWAY_BASE_URL is not set. Add the gateway base URL to "
            ".env.local / .envlocal / .env.private."
        )
    if not resolved_model:
        raise RuntimeError(
            "ANTHROPIC_MODEL is not set. Copy the exact model name string from "
            "your VS Code settings.json into .env.local / .envlocal / .env.private."
        )
    if not messages:
        raise RuntimeError("messages must be a non-empty list, with messages[0] as the system message.")

    endpoint = join_url(resolved_base_url, "/v1/messages")
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {token}",
        "anthropic-version": os.getenv("ANTHROPIC_API_VERSION", "2023-06-01"),
    }
    body = {
        "model": resolved_model,
        "system": messages[0]["content"],
        "messages": messages[1:],
        "temperature": temperature,
        "max_tokens": max_tokens,
    }

    try:
        data = _http_json(endpoint, headers, body)
    except Exception as exc:
        raise RuntimeError(f"Gateway LLM request failed: {redact_text(str(exc))}") from exc

    return "\n".join(part.get("text", "") for part in data.get("content", []))


if __name__ == "__main__":
    # Quick manual smoke test:
    #   python3 gateway_llm_client.py
    # Requires ANTHROPIC_AUTH_TOKEN / ANTHROPIC_GATEWAY_BASE_URL /
    # ANTHROPIC_GATEWAY_MODEL to
    # already be set in the environment (llm_client.py's load_env_file runs
    # on import, so .env.local etc. are picked up automatically).
    print("Gateway status:", gateway_status())
    if gateway_configured():
        try:
            reply = call_gateway_llm([
                {"role": "system", "content": "You are a terse assistant."},
                {"role": "user", "content": "Reply with the single word: OK"},
            ])
            print("Gateway reply:", reply)
        except Exception as exc:
            print("Gateway call failed:", exc)
    else:
        print("Set ANTHROPIC_AUTH_TOKEN and ANTHROPIC_GATEWAY_BASE_URL to test connectivity.")
