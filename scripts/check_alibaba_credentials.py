#!/usr/bin/env python3
"""Check whether the configured Alibaba DashScope/Qwen credentials work.

The script reads ALIBABA_API_KEY and ALIBABA_API_HOST from the environment,
falling back to the workspace .env file when present. It sends a very small
OpenAI-compatible chat completion request and redacts secret values in output.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path


DEFAULT_ALIBABA_API_HOST = "https://dashscope-intl.aliyuncs.com/compatible-mode/v1"
DEFAULT_ALIBABA_TEXT_MODEL = "qwen-plus"


def main() -> int:
    parser = argparse.ArgumentParser(description="Check Alibaba/Qwen API credentials.")
    parser.add_argument(
        "--model",
        default=None,
        help=f"Text model to call. Defaults to ALIBABA_TEXT_MODEL or {DEFAULT_ALIBABA_TEXT_MODEL}.",
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=30.0,
        help="HTTP timeout in seconds.",
    )
    args = parser.parse_args()

    workspace_root = find_workspace_root(Path.cwd())
    load_dotenv(workspace_root / ".env")

    api_key = os.environ.get("ALIBABA_API_KEY", "").strip()
    api_host = os.environ.get("ALIBABA_API_HOST", DEFAULT_ALIBABA_API_HOST).strip()
    model = (args.model or os.environ.get("ALIBABA_TEXT_MODEL") or DEFAULT_ALIBABA_TEXT_MODEL).strip()

    if not api_key:
        print("ALIBABA_API_KEY is missing or empty.", file=sys.stderr)
        return 2
    if not api_host:
        print("ALIBABA_API_HOST is missing or empty.", file=sys.stderr)
        return 2

    base_url = alibaba_compatible_base_url(api_host)
    url = f"{base_url}/chat/completions"
    payload = {
        "model": normalize_model(model),
        "messages": [{"role": "user", "content": "Reply exactly with OK."}],
        "temperature": 0,
        "max_tokens": 8,
    }

    print(f"ALIBABA_API_KEY: set ({redacted_key_label(api_key)})")
    print(f"ALIBABA_API_HOST: {base_url}")
    print(f"Model: {payload['model']}")
    print("Calling Alibaba Qwen chat completions...")

    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(request, timeout=args.timeout) as response:
            body = response.read().decode("utf-8", errors="replace")
            data = json.loads(body) if body else {}
    except urllib.error.HTTPError as error:
        body = error.read().decode("utf-8", errors="replace")
        message = extract_error_message(body) or error.reason
        print(f"Request failed with HTTP {error.code}: {message}", file=sys.stderr)
        return 1
    except urllib.error.URLError as error:
        print(f"Request failed before receiving an HTTP response: {error.reason}", file=sys.stderr)
        return 1
    except TimeoutError:
        print("Request timed out.", file=sys.stderr)
        return 1
    except json.JSONDecodeError as error:
        print(f"Request returned non-JSON response: {error}", file=sys.stderr)
        return 1

    content = response_text(data)
    usage = data.get("usage") if isinstance(data, dict) else None

    print("Credentials look valid.")
    if content:
        print(f"Response text: {content!r}")
    if isinstance(usage, dict):
        prompt_tokens = usage.get("prompt_tokens")
        completion_tokens = usage.get("completion_tokens")
        print(f"Usage: prompt_tokens={prompt_tokens}, completion_tokens={completion_tokens}")
    return 0


def find_workspace_root(start: Path) -> Path:
    current = start.resolve()
    while True:
        package_json = current / "package.json"
        if package_json.exists():
            try:
                data = json.loads(package_json.read_text(encoding="utf-8"))
                if data.get("name") == "ai-book-maker":
                    return current
            except (OSError, json.JSONDecodeError):
                return current
        if current.parent == current:
            return start.resolve()
        current = current.parent


def load_dotenv(path: Path) -> None:
    if not path.exists():
        return
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = unquote_env_value(value.strip())
        os.environ.setdefault(key, value)


def unquote_env_value(value: str) -> str:
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
        return value[1:-1]
    return value


def alibaba_compatible_base_url(api_host: str) -> str:
    return normalize_alibaba_url(api_host, "compatible-mode/v1")


def normalize_alibaba_url(api_host: str, target_path: str) -> str:
    trimmed = (api_host or DEFAULT_ALIBABA_API_HOST).strip().rstrip("/")
    current_path = "api/v1" if target_path == "compatible-mode/v1" else "compatible-mode/v1"
    if trimmed.endswith(f"/{target_path}"):
        return trimmed
    if f"/{current_path}" in trimmed:
        return trimmed.split(f"/{current_path}", 1)[0] + f"/{target_path}"
    if f"/{target_path}/" in trimmed:
        return trimmed.split(f"/{target_path}/", 1)[0] + f"/{target_path}"
    return f"{trimmed}/{target_path}"


def normalize_model(model: str) -> str:
    model = model.strip()
    return model.removeprefix("models/") or DEFAULT_ALIBABA_TEXT_MODEL


def redacted_key_label(api_key: str) -> str:
    return f"length={len(api_key)}"


def extract_error_message(body: str) -> str | None:
    try:
        data = json.loads(body)
    except json.JSONDecodeError:
        return body[:500] if body else None
    if not isinstance(data, dict):
        return body[:500]
    for path in (("message",), ("error", "message"), ("output", "message")):
        value = data
        for key in path:
            if not isinstance(value, dict):
                value = None
                break
            value = value.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return body[:500]


def response_text(data: object) -> str | None:
    if not isinstance(data, dict):
        return None
    choices = data.get("choices")
    if not isinstance(choices, list) or not choices:
        return None
    first = choices[0]
    if not isinstance(first, dict):
        return None
    message = first.get("message")
    if not isinstance(message, dict):
        return None
    content = message.get("content")
    if isinstance(content, str) and content.strip():
        return content.strip()
    return None


if __name__ == "__main__":
    raise SystemExit(main())
