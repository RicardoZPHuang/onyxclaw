#!/usr/bin/env python3
"""Composable E2B-compatible management-plane and data-plane client.

The key rule is to retain the object returned by ``Sandbox.create`` for all
later data-plane operations.  A fresh ``Sandbox.connect`` is still used to
resume a paused sandbox, but the original create-time object retains the
gateway routing metadata required by compatible Agent Gateway deployments.
"""

from __future__ import annotations

import json
import os
import re
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Iterable, Mapping, Optional, TypeVar, Union
from urllib.parse import urlparse

from e2b import Sandbox
from e2b.connection_config import ConnectionConfig


T = TypeVar("T")
Operation = Callable[["WorkflowContext"], Any]


def _url(value: str, name: str) -> str:
    value = value.strip().rstrip("/")
    if not value:
        raise ValueError(f"{name} must not be empty")
    if "://" not in value:
        value = f"https://{value}"
    parsed = urlparse(value)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError(f"{name} must be an HTTP(S) URL")
    return value


def _safe_error(error: BaseException, secrets: Iterable[Optional[str]]) -> str:
    message = str(error) or type(error).__name__
    for secret in secrets:
        if secret:
            message = message.replace(secret, "[REDACTED]")
    return re.sub(
        r"(?i)((?:api[_-]?key|access[_-]?token|auth[_-]?token|secret|password)\s*[=:]\s*)[^\s,;]+",
        r"\1[REDACTED]",
        message,
    )


@dataclass(frozen=True)
class E2BConfig:
    """Transport configuration shared by management and data-plane clients."""

    api_key: str
    api_url: str
    sandbox_url: str
    domain: Optional[str] = None
    proxy: Optional[str] = None
    request_timeout: Optional[float] = None
    data_headers: Mapping[str, str] = field(default_factory=dict)

    def __post_init__(self) -> None:
        object.__setattr__(self, "api_url", _url(self.api_url, "api_url"))
        object.__setattr__(self, "sandbox_url", _url(self.sandbox_url, "sandbox_url"))
        if not self.api_key:
            raise ValueError("api_key must not be empty")
        if self.proxy:
            object.__setattr__(self, "proxy", _url(self.proxy, "proxy"))
        if self.domain is None:
            object.__setattr__(self, "domain", urlparse(self.api_url).hostname)

    @classmethod
    def from_env(cls, prefix: str = "E2B") -> "E2BConfig":
        """Build config from E2B_API_KEY, E2B_API_URL, E2B_SANDBOX_URL, etc.

        Optional settings: E2B_DOMAIN, E2B_PROXY, E2B_REQUEST_TIMEOUT_SECONDS,
        and E2B_DATA_HEADERS_JSON (a JSON object of additional data headers).
        """
        def required(name: str) -> str:
            value = os.getenv(f"{prefix}_{name}")
            if not value:
                raise RuntimeError(f"missing environment variable: {prefix}_{name}")
            return value

        raw_headers = os.getenv(f"{prefix}_DATA_HEADERS_JSON", "{}")
        try:
            data_headers = json.loads(raw_headers)
        except json.JSONDecodeError as error:
            raise RuntimeError(f"{prefix}_DATA_HEADERS_JSON must be a JSON object") from error
        if not isinstance(data_headers, dict) or not all(
            isinstance(key, str) and isinstance(value, str) for key, value in data_headers.items()
        ):
            raise RuntimeError(f"{prefix}_DATA_HEADERS_JSON must be a string-to-string JSON object")

        raw_timeout = os.getenv(f"{prefix}_REQUEST_TIMEOUT_SECONDS")
        return cls(
            api_key=required("API_KEY"),
            api_url=required("API_URL"),
            sandbox_url=required("SANDBOX_URL"),
            domain=os.getenv(f"{prefix}_DOMAIN"),
            proxy=os.getenv(f"{prefix}_PROXY"),
            request_timeout=float(raw_timeout) if raw_timeout else None,
            data_headers=data_headers,
        )

    def management_options(self) -> dict[str, Any]:
        options: dict[str, Any] = {
            "api_key": self.api_key,
            "api_url": self.api_url,
            "domain": self.domain,
        }
        if self.proxy:
            options["proxy"] = self.proxy
        return options

    def safe_summary(self) -> dict[str, Any]:
        """Use this in diagnostics; it deliberately does not expose secrets."""
        return {
            "api_url": self.api_url,
            "sandbox_url": self.sandbox_url,
            "domain": self.domain,
            "proxy_configured": bool(self.proxy),
            "data_header_names": sorted(self.data_headers),
        }


@dataclass
class SandboxHandle:
    """The retained create-time session plus a correctly routed data session."""

    claimed: Sandbox
    data: Sandbox

    @property
    def sandbox_id(self) -> str:
        return self.claimed.sandbox_id


class E2BClient:
    """Management APIs plus EnvD process/filesystem APIs for one configuration."""

    def __init__(self, config: E2BConfig, data_session_wait_seconds: float = 60.0):
        self.config = config
        self.data_session_wait_seconds = max(0.0, data_session_wait_seconds)

    # -- Management plane -------------------------------------------------
    def create(
        self,
        template: str,
        *,
        timeout: int = 300,
        metadata: Optional[Mapping[str, str]] = None,
        envs: Optional[Mapping[str, str]] = None,
        secure: bool = True,
        lifecycle: Optional[Mapping[str, Any]] = None,
    ) -> SandboxHandle:
        create_options: dict[str, Any] = {
            "template": template,
            "timeout": timeout,
            "secure": secure,
            **self.config.management_options(),
        }
        if metadata is not None:
            create_options["metadata"] = dict(metadata)
        if envs is not None:
            create_options["envs"] = dict(envs)
        # ``lifecycle`` is unavailable in some deployed E2B SDK versions.
        # Only opt into it when the caller actually requests lifecycle policy.
        if lifecycle is not None:
            create_options["lifecycle"] = dict(lifecycle)
        claimed = Sandbox.create(**create_options)
        return SandboxHandle(claimed=claimed, data=self._routed(claimed))

    def get(self, sandbox_id: str) -> Any:
        return Sandbox.get_info(sandbox_id, **self.config.management_options())

    def list(self, *, limit: int = 100, query: Any = None) -> list[Any]:
        """Return at most ``limit`` management-plane sandbox records."""
        if limit < 1:
            raise ValueError("limit must be at least 1")
        paginator = Sandbox.list(query=query, limit=limit, **self.config.management_options())
        items: list[Any] = []
        while True:
            remaining = limit - len(items)
            items.extend(paginator.next_items()[:remaining])
            if len(items) >= limit:
                return items
            has_next = paginator.has_next() if callable(paginator.has_next) else paginator.has_next
            if not has_next:
                return items

    def pause(self, handle_or_id: Union[SandboxHandle, str]) -> None:
        """Pause a known create-time session using the SDK's current beta API."""
        if isinstance(handle_or_id, SandboxHandle):
            handle_or_id.claimed.beta_pause(**self.config.management_options())
            return
        self.connect(handle_or_id).beta_pause(**self.config.management_options())

    def connect(self, sandbox_id: str, *, timeout: Optional[int] = None) -> Sandbox:
        """Control-plane connect/resume; do not replace an existing handle with it."""
        return Sandbox.connect(sandbox_id, timeout=timeout, **self.config.management_options())

    def resume(self, handle: SandboxHandle, *, timeout: Optional[int] = None) -> Sandbox:
        """Resume a paused Sandbox, while preserving the original data session."""
        return self.connect(handle.sandbox_id, timeout=timeout)

    def delete(self, handle_or_id: Union[SandboxHandle, str]) -> bool:
        if isinstance(handle_or_id, SandboxHandle):
            return bool(handle_or_id.claimed.kill())
        return bool(self.connect(handle_or_id).kill())

    # -- EnvD data plane ---------------------------------------------------
    def run_process(self, handle: SandboxHandle, command: str, *, user: Optional[str] = "node") -> Any:
        return self._retry_data_plane(lambda: handle.data.commands.run(command, user=user))

    def write_file(
        self,
        handle: SandboxHandle,
        path: str,
        content: Union[str, bytes],
        *,
        user: Optional[str] = "node",
    ) -> Any:
        return self._retry_data_plane(lambda: handle.data.files.write(path, content, user=user))

    def read_file(self, handle: SandboxHandle, path: str, *, user: Optional[str] = "node") -> Union[str, bytes]:
        return self._retry_data_plane(lambda: handle.data.files.read(path, user=user))

    def envd(self, handle: SandboxHandle) -> Sandbox:
        """Return the raw, routed SDK object for any version-specific EnvD API.

        The raw routed SDK object is intentionally exposed on ``handle.data``
        so callers can use version-specific APIs beyond process and files.
        """
        return handle.data

    def _routed(self, claimed: Sandbox) -> Sandbox:
        original = claimed.connection_config
        # Preserve SDK-generated sandbox ID, EnvD port, and X-Access-Token.
        sandbox_headers = dict(original.sandbox_headers)
        # User headers are additive only. System routing headers always win.
        sandbox_headers = {**dict(self.config.data_headers), **sandbox_headers}
        if claimed.traffic_access_token:
            sandbox_headers["E2B-Traffic-Access-Token"] = claimed.traffic_access_token
        connection_config = ConnectionConfig(
            domain=original.domain,
            debug=original.debug,
            api_key=original.api_key,
            api_url=original.api_url,
            sandbox_url=self.config.sandbox_url,
            access_token=original.access_token,
            request_timeout=(
                self.config.request_timeout
                if self.config.request_timeout is not None
                else original.request_timeout
            ),
            headers=original.headers.copy(),
            extra_sandbox_headers=sandbox_headers,
            proxy=self.config.proxy or original.proxy,
        )
        return Sandbox(
            sandbox_id=claimed.sandbox_id,
            sandbox_domain=claimed.sandbox_domain,
            connection_config=connection_config,
            envd_version=claimed._envd_version,
            envd_access_token=claimed._envd_access_token,
            traffic_access_token=claimed.traffic_access_token,
        )

    def _retry_data_plane(self, operation: Callable[[], T]) -> T:
        deadline = time.monotonic() + self.data_session_wait_seconds
        delay = 1.0
        while True:
            try:
                return operation()
            except Exception as error:
                transient = "session not found" in str(error).lower()
                remaining = deadline - time.monotonic()
                if not transient or remaining <= 0:
                    raise RuntimeError(_safe_error(error, (self.config.api_key,))) from error
                time.sleep(min(delay, remaining))
                delay = min(delay * 2, 5.0)


@dataclass
class WorkflowContext:
    """Mutable state supplied to freely composed workflow operations."""

    client: E2BClient
    values: dict[str, Any] = field(default_factory=dict)

    def require(self, name: str) -> Any:
        try:
            return self.values[name]
        except KeyError as error:
            raise KeyError(f"workflow value not found: {name}") from error


class Workflow:
    """Optional composition helper; operations may be any callable."""

    def __init__(self, client: E2BClient):
        self._context = WorkflowContext(client)
        self._steps: list[tuple[str, Operation]] = []

    def add(self, name: str, operation: Operation) -> "Workflow":
        self._steps.append((name, operation))
        return self

    def run(self) -> WorkflowContext:
        for name, operation in self._steps:
            self._context.values[name] = operation(self._context)
        return self._context


def create_operation(template: str, **kwargs: Any) -> Operation:
    return lambda context: context.client.create(template, **kwargs)


if __name__ == "__main__":
    # Keep CLI behavior deliberately small. Prefer importing this module for
    # application code and composing the management/data-plane calls you need.
    import argparse

    parser = argparse.ArgumentParser(description="Create a Sandbox and run a data-plane command.")
    parser.add_argument("--template", required=True)
    parser.add_argument("--command", default="id")
    parser.add_argument("--user", default="node")
    parser.add_argument("--keep", action="store_true")
    args = parser.parse_args()

    client = E2BClient(E2BConfig.from_env())
    sandbox = client.create(args.template)
    print(f"sandbox_id={sandbox.sandbox_id}")
    try:
        result = client.run_process(sandbox, args.command, user=args.user)
        print(f"exit_code={result.exit_code}")
        print(result.stdout, end="")
        print(result.stderr, end="")
    finally:
        if not args.keep:
            client.delete(sandbox)
