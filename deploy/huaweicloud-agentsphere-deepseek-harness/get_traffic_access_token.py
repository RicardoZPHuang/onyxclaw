#!/usr/bin/env python3
"""Print a fresh AgentSphere traffic access token for an existing Sandbox."""

from __future__ import annotations

import argparse
import os
from typing import Optional
from urllib.parse import urlparse

from e2b import Sandbox


DEFAULT_API_URL = "https://agentsphere.cn-south-1.myhuaweicloud.com"


def environment_value(*names: str, default: Optional[str] = None) -> Optional[str]:
    for name in names:
        value = os.environ.get(name, "").strip()
        if value:
            return value
    return default


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Print the refreshed traffic access token for a Sandbox",
    )
    parser.add_argument(
        "sandbox_id",
        nargs="?",
        default=environment_value("E2B_SANDBOX_ID"),
        metavar="SANDBOX_ID",
        help="existing Sandbox ID; defaults to E2B_SANDBOX_ID",
    )
    parser.add_argument(
        "--api-url",
        default=environment_value("E2B_API_URL", default=DEFAULT_API_URL),
        help="AgentSphere control-plane URL; defaults to E2B_API_URL",
    )
    parser.set_defaults(
        api_key=environment_value("E2B_API_KEY", "HUAWEICLOUD_AGENTSPHERE_E2B_API_KEY"),
    )
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    if not args.sandbox_id:
        parser.error("provide SANDBOX_ID or set E2B_SANDBOX_ID")
    if not args.api_key:
        parser.error("set E2B_API_KEY before running this script")

    parsed = urlparse(args.api_url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        parser.error("E2B_API_URL must be an HTTP(S) URL")
    api_url = parsed.geturl().rstrip("/")
    os.environ["E2B_API_URL"] = api_url
    os.environ["E2B_DOMAIN"] = parsed.hostname

    try:
        sandbox = Sandbox.connect(
            args.sandbox_id,
            api_key=args.api_key,
            api_url=api_url,
            domain=parsed.hostname,
        )
    except Exception as error:
        raise SystemExit(f"failed to refresh traffic access token: {error}") from None
    token = (sandbox.traffic_access_token or "").strip()
    if not token:
        raise SystemExit("Sandbox.connect returned no traffic access token")
    print(token)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
