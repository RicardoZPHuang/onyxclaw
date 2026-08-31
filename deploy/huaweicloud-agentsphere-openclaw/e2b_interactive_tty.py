#!/usr/bin/env python3
"""Create or connect to an interactive shell in an AgentSphere E2B Sandbox.

Template ID and API key can be supplied by command-line option, environment
variable, or an interactive prompt. The API key prompt does not echo input.
Press Ctrl-] to close the remote terminal while leaving the Sandbox running.
"""

from __future__ import annotations

import argparse
import getpass
import os
import select
import shutil
import signal
import sys
import termios
import threading
import time
import tty
from dataclasses import dataclass
from typing import Any, Callable, Optional
from urllib.parse import urlparse

from e2b import PtySize, Sandbox
from e2b.connection_config import ConnectionConfig


DEFAULT_API_URL = "https://agentsphere.cn-south-1.myhuaweicloud.com"
DEFAULT_SANDBOX_URL = (
    "https://agent-gateway-sandbox3-geywmobqmy.agentgateway."
    "cn-south-1.huaweicloud-agentnetwork.com"
)
DETACH_BYTE = b"\x1d"  # Ctrl-]


def environment_value(*names: str, default: Optional[str] = None) -> Optional[str]:
    for name in names:
        value = os.environ.get(name, "").strip()
        if value:
            return value
    return default


def require_inputs(args: argparse.Namespace, parser: argparse.ArgumentParser) -> None:
    """Prompt only for values that were not supplied non-interactively."""
    if not args.sandbox_id and not args.template:
        if not sys.stdin.isatty():
            parser.error(
                "set E2B_SANDBOX_ID/--sandbox-id to connect, or "
                "E2B_TEMPLATE_ID/--template to create"
            )
        args.sandbox_id = input(
            "Existing Sandbox ID (leave empty to create a new Sandbox): "
        ).strip()
        if not args.sandbox_id:
            args.template = input("Template ID: ").strip()
            if not args.template:
                parser.error("Template ID cannot be empty")

    if not args.api_key:
        if not sys.stdin.isatty():
            parser.error("set E2B_API_KEY or pass --api-key")
        args.api_key = getpass.getpass("E2B API key (input hidden): ").strip()
        if not args.api_key:
            parser.error("E2B API key cannot be empty")


def terminal_size() -> PtySize:
    size = shutil.get_terminal_size(fallback=(120, 36))
    return PtySize(rows=size.lines, cols=size.columns)


def write_terminal_output(event: Any) -> None:
    data = getattr(event, "data", event)
    if isinstance(data, str):
        payload = data.encode(errors="replace")
    elif isinstance(data, (bytes, bytearray, memoryview)):
        payload = bytes(data)
    else:
        payload = str(data).encode(errors="replace")
    os.write(sys.stdout.fileno(), payload)


def routed_sandbox(claimed: Sandbox, sandbox_url: str) -> Sandbox:
    """Route envd calls through the fixed Agent Gateway data-plane URL."""
    original = claimed.connection_config
    headers = original.sandbox_headers.copy()
    if claimed.traffic_access_token:
        headers["E2B-Traffic-Access-Token"] = claimed.traffic_access_token
    headers["E2b-Sandbox-Id"] = claimed.sandbox_id
    headers["E2b-Sandbox-Port"] = str(original.envd_port)

    config = ConnectionConfig(
        domain=original.domain,
        debug=original.debug,
        api_key=original.api_key,
        api_url=original.api_url,
        sandbox_url=sandbox_url,
        access_token=original.access_token,
        request_timeout=original.request_timeout,
        headers=original.headers.copy(),
        extra_sandbox_headers=headers,
        proxy=original.proxy,
    )
    return Sandbox(
        sandbox_id=claimed.sandbox_id,
        sandbox_domain=claimed.sandbox_domain,
        connection_config=config,
        envd_version=claimed._envd_version,
        envd_access_token=claimed._envd_access_token,
        traffic_access_token=claimed.traffic_access_token,
    )


def control_options(api_key: str, api_url: str) -> dict[str, Any]:
    parsed = urlparse(api_url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise ValueError("E2B_API_URL must be an HTTP(S) URL")
    normalized = parsed.geturl().rstrip("/")
    os.environ["E2B_API_URL"] = normalized
    os.environ["E2B_DOMAIN"] = parsed.hostname
    return {
        "api_key": api_key,
        "api_url": normalized,
        "domain": parsed.hostname,
    }


def open_sandbox(args: argparse.Namespace) -> tuple[Sandbox, Sandbox, bool]:
    options = control_options(args.api_key, args.api_url)
    if args.sandbox_id:
        claimed = Sandbox.connect(args.sandbox_id, **options)
        created = False
    else:
        claimed = Sandbox.create(
            template=args.template,
            timeout=args.sandbox_timeout,
            secure=True,
            **options,
        )
        created = True
    return claimed, routed_sandbox(claimed, args.sandbox_url), created


def with_session_retry(
    operation: Callable[[], Any],
    retries: int,
    interval_seconds: float,
) -> Any:
    attempt = 0
    while True:
        try:
            return operation()
        except Exception as error:
            if "session not found" not in str(error).lower():
                raise
            if attempt >= retries:
                raise
            attempt += 1
            sys.stderr.write(
                "Session not found; "
                f"retry {attempt}/{retries} in {interval_seconds:g}s...\n"
            )
            time.sleep(interval_seconds)


@dataclass
class InteractiveHandle:
    pid: int
    wait: Callable[[Callable[[Any], None]], Any]
    send: Callable[[bytes], None]
    resize: Callable[[PtySize], None]
    disconnect: Callable[[], None]
    kill: Callable[[], Any]


def open_remote_terminal(sandbox: Sandbox, args: argparse.Namespace) -> InteractiveHandle:
    if args.command_mode:
        handle = with_session_retry(
            lambda: sandbox.commands.run(
                f"exec {args.shell}",
                background=True,
                stdin=True,
                user=args.user,
                cwd=args.cwd,
                envs={"TERM": os.environ.get("TERM", "xterm-256color")},
                timeout=0,
            ),
            args.session_retries,
            args.session_retry_interval,
        )
        return InteractiveHandle(
            pid=handle.pid,
            wait=lambda output: handle.wait(on_stdout=output, on_stderr=output),
            send=lambda data: handle.send_stdin(data.decode(errors="replace")),
            resize=lambda _size: None,
            disconnect=handle.disconnect,
            kill=handle.kill,
        )

    handle = with_session_retry(
        lambda: sandbox.pty.create(
            size=terminal_size(),
            user=args.user,
            cwd=args.cwd,
            envs={"TERM": os.environ.get("TERM", "xterm-256color")},
            timeout=0,
        ),
        args.session_retries,
        args.session_retry_interval,
    )
    return InteractiveHandle(
        pid=handle.pid,
        wait=lambda output: handle.wait(on_pty=output),
        send=lambda data: sandbox.pty.send_stdin(handle.pid, data),
        resize=lambda size: sandbox.pty.resize(handle.pid, size),
        disconnect=handle.disconnect,
        kill=handle.kill,
    )


def interactive_loop(session: InteractiveHandle) -> None:
    if not sys.stdin.isatty() or not sys.stdout.isatty():
        raise RuntimeError("run this script from an interactive terminal")

    finished = threading.Event()
    wait_error: list[BaseException] = []

    def receive_output() -> None:
        try:
            session.wait(write_terminal_output)
        except BaseException as error:
            wait_error.append(error)
        finally:
            finished.set()

    receiver = threading.Thread(target=receive_output, daemon=True)
    receiver.start()

    old_attributes = termios.tcgetattr(sys.stdin.fileno())
    detached = False

    def resize_remote(_signum: Optional[int] = None, _frame: Any = None) -> None:
        try:
            session.resize(terminal_size())
        except Exception:
            pass

    old_winch = signal.getsignal(signal.SIGWINCH)
    signal.signal(signal.SIGWINCH, resize_remote)
    resize_remote()

    try:
        tty.setraw(sys.stdin.fileno())
        while not finished.is_set():
            readable, _, _ = select.select([sys.stdin.fileno()], [], [], 0.1)
            if not readable:
                continue
            data = os.read(sys.stdin.fileno(), 4096)
            if not data:
                break
            if DETACH_BYTE in data:
                before, _, _after = data.partition(DETACH_BYTE)
                if before:
                    session.send(before)
                detached = True
                break
            session.send(data)
    finally:
        termios.tcsetattr(sys.stdin.fileno(), termios.TCSADRAIN, old_attributes)
        signal.signal(signal.SIGWINCH, old_winch)

    if detached:
        try:
            session.kill()
        except Exception:
            session.disconnect()
            raise
        sys.stderr.write("\nRemote terminal closed; the Sandbox is still running.\n")
    else:
        receiver.join(timeout=2)
        if wait_error:
            raise wait_error[0]


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Interactive AgentSphere E2B Sandbox terminal (Ctrl-] closes the shell)",
    )
    parser.add_argument(
        "--template",
        default=environment_value("E2B_TEMPLATE_ID"),
        help="Template ID; defaults to E2B_TEMPLATE_ID, otherwise prompts",
    )
    parser.add_argument(
        "--sandbox-id",
        default=environment_value("E2B_SANDBOX_ID"),
        help="connect an existing Sandbox and open a new PTY; defaults to E2B_SANDBOX_ID",
    )
    parser.add_argument("--user", default="root")
    parser.add_argument("--cwd", default="/home/node")
    parser.add_argument("--shell", default="/bin/bash -li")
    parser.add_argument("--sandbox-timeout", type=int, default=3600)
    parser.add_argument("--session-retries", type=int, default=5)
    parser.add_argument("--session-retry-interval", type=float, default=2.0)
    parser.add_argument("--command-mode", action="store_true", help="use Commands.run instead of PTY")
    parser.add_argument("--kill-on-exit", action="store_true")
    parser.add_argument(
        "--api-url",
        default=environment_value("E2B_API_URL", default=DEFAULT_API_URL),
    )
    parser.add_argument(
        "--sandbox-url",
        default=environment_value("E2B_SANDBOX_URL", default=DEFAULT_SANDBOX_URL),
    )
    parser.add_argument(
        "--api-key",
        default=environment_value("E2B_API_KEY", "HUAWEICLOUD_AGENTSPHERE_E2B_API_KEY"),
        help="API key; prefer hidden prompt or E2B_API_KEY over this option",
    )
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    require_inputs(args, parser)
    if args.session_retries < 0:
        parser.error("--session-retries must be zero or greater")
    if args.session_retry_interval < 0:
        parser.error("--session-retry-interval must be zero or greater")

    claimed: Optional[Sandbox] = None
    session: Optional[InteractiveHandle] = None
    try:
        claimed, sandbox, created = open_sandbox(args)
        action = "created" if created else "connected"
        sys.stderr.write(f"Sandbox {action}: {claimed.sandbox_id}\n")
        session = open_remote_terminal(sandbox, args)
        mode = "command" if args.command_mode else "pty"
        sys.stderr.write(f"New {mode.upper()} opened; press Ctrl-] to close the shell\n")
        interactive_loop(session)
        return 0
    finally:
        if args.kill_on_exit and claimed is not None:
            try:
                claimed.kill()
                sys.stderr.write(f"Sandbox killed: {claimed.sandbox_id}\n")
            except Exception as error:
                sys.stderr.write(f"Sandbox cleanup failed: {error}\n")


if __name__ == "__main__":
    raise SystemExit(main())
