#!/usr/bin/env python3
"""Refresh AgentSphere traffic/envd tokens; output both as JSON by default."""

from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Optional
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlparse
from urllib.request import HTTPRedirectHandler, Request, build_opener


DEFAULT_API_URL = "https://agentsphere.cn-south-1.myhuaweicloud.com"


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # A control-plane redirect must not forward the API key elsewhere.
        return None


def environment_value(*names: str, default: Optional[str] = None) -> Optional[str]:
    for name in names:
        value = os.environ.get(name, "").strip()
        if value:
            return value
    return default


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Refresh trafficAccessToken and envdAccessToken for an existing Sandbox",
    )
    parser.add_argument(
        "sandbox_id", nargs="?", default=environment_value("E2B_SANDBOX_ID"),
        metavar="SANDBOX_ID", help="existing Sandbox ID; defaults to E2B_SANDBOX_ID",
    )
    parser.add_argument(
        "--api-url", default=environment_value("E2B_API_URL", default=DEFAULT_API_URL),
        help="AgentSphere control-plane URL; defaults to E2B_API_URL or cn-south-1",
    )
    parser.add_argument(
        "--format", choices=("json", "traffic", "envd"), default="json",
        help="json: both tokens (default); traffic/envd: one token only",
    )
    parser.add_argument(
        "--request-timeout", type=float, default=30,
        help="control-plane request timeout in seconds (default: 30)",
    )
    parser.set_defaults(
        api_key=environment_value("E2B_API_KEY", "HUAWEICLOUD_AGENTSPHERE_E2B_API_KEY"),
    )
    return parser


def connect_sandbox(api_url: str, sandbox_id: str, api_key: str, timeout: float) -> dict:
    request = Request(
        api_url + "/sandboxes/" + quote(sandbox_id, safe="") + "/connect",
        # Keep the previous SDK connect default; the control plane requires > 0.
        data=b'{"timeout":300}', method="POST",
        headers={"X-API-Key": api_key, "Content-Type": "application/json"},
    )
    try:
        with build_opener(NoRedirect()).open(request, timeout=timeout) as response:
            result = json.load(response)
    except HTTPError as error:
        # Preserve nonstandard Huawei Cloud errors without SDK model parsing.
        detail = error.read(4096).decode("utf-8", errors="replace").replace(api_key, "[redacted]")
        raise ValueError(f"connect failed: HTTP {error.code}: {detail}") from None
    except (URLError, OSError) as error:
        raise ValueError(f"connect request failed: {str(error).replace(api_key, '[redacted]')}") from None
    except (ValueError, UnicodeError):
        raise ValueError("connect returned invalid JSON") from None
    if not isinstance(result, dict):
        raise ValueError("connect returned an invalid response object")
    return result


def response_token(response: dict, camel_name: str, snake_name: str) -> str:
    for name in (camel_name, snake_name):
        value = response.get(name)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def main(argv: Optional[list[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if not args.sandbox_id:
        parser.error("provide SANDBOX_ID or set E2B_SANDBOX_ID")
    if not args.api_key:
        parser.error("set E2B_API_KEY before running this script")
    if not 0 < args.request_timeout < float("inf"):
        parser.error("--request-timeout must be a positive finite number")

    try:
        parsed = urlparse(args.api_url)
        valid = (
            parsed.scheme in ("http", "https") and parsed.hostname
            and parsed.username is None and parsed.password is None
            and not parsed.query and not parsed.fragment
        )
    except ValueError:
        valid = False
    if not valid:
        parser.error("E2B_API_URL must be an HTTP(S) base URL without credentials, query or fragment")

    try:
        response = connect_sandbox(
            args.api_url.rstrip("/"), args.sandbox_id, args.api_key, args.request_timeout,
        )
        traffic_token = response_token(response, "trafficAccessToken", "traffic_access_token")
        envd_token = response_token(response, "envdAccessToken", "envd_access_token")
        if args.format != "envd" and not traffic_token:
            raise ValueError("connect returned no trafficAccessToken")
        if args.format != "traffic" and not envd_token:
            raise ValueError("connect returned no envdAccessToken; check runtime token initialization")
    except ValueError as error:
        print(f"failed to refresh Sandbox access tokens: {error}", file=sys.stderr)
        return 1

    if args.format == "traffic":
        print(traffic_token)
    elif args.format == "envd":
        print(envd_token)
    else:
        print(json.dumps({
            "sandboxID": args.sandbox_id,
            "trafficAccessToken": traffic_token,
            "envdAccessToken": envd_token,
        }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
