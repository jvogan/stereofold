#!/usr/bin/env python3
"""Validate and atomically update Stereofold's host JSON configuration."""

from __future__ import annotations

import argparse
from dataclasses import dataclass
import fcntl
import json
import os
import secrets
import stat
import sys
import time
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class TargetSnapshot:
    raw: bytes
    mode: int
    device: int
    inode: int


def lexical_absolute(value: str) -> Path:
    return Path(os.path.abspath(os.path.expanduser(value)))


def validate_target(target_value: str, expected_value: str, *, allow_parent_create: bool) -> Path:
    target = lexical_absolute(target_value)
    expected = lexical_absolute(expected_value)
    if target != expected:
        raise ValueError(f"Refusing unexpected config target: {target}; expected {expected}")

    parent = target.parent
    missing: list[Path] = []
    cursor = parent
    while not cursor.exists() and not cursor.is_symlink():
        missing.append(cursor)
        if cursor == cursor.parent:
            break
        cursor = cursor.parent

    if cursor.is_symlink():
        raise ValueError(f"Refusing symlinked config parent: {cursor}")
    if not cursor.is_dir():
        raise ValueError(f"Refusing non-directory config parent: {cursor}")
    if Path(os.path.realpath(cursor)) != cursor:
        raise ValueError(f"Refusing non-canonical config parent: {cursor}")
    if missing and not allow_parent_create:
        raise ValueError(f"Config parent does not exist: {parent}")

    # Check every existing component, not only realpath(parent), so a symlink
    # cannot disappear into an otherwise canonical suffix.
    current = Path(parent.anchor)
    for part in parent.parts[1:]:
        current /= part
        try:
            details = os.lstat(current)
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(details.st_mode):
            raise ValueError(f"Refusing symlinked config parent: {current}")
        if not stat.S_ISDIR(details.st_mode):
            raise ValueError(f"Refusing non-directory config parent: {current}")

    try:
        details = os.lstat(target)
    except FileNotFoundError:
        return target
    if stat.S_ISLNK(details.st_mode):
        raise ValueError(f"Refusing symlink config target: {target}")
    if not stat.S_ISREG(details.st_mode):
        raise ValueError(f"Refusing non-regular config target: {target}")
    return target


def ensure_parent(parent: Path) -> None:
    """Create missing parents one component at a time without following links."""
    flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
    current_fd = os.open(parent.anchor, flags)
    try:
        for part in parent.parts[1:]:
            try:
                next_fd = os.open(part, flags, dir_fd=current_fd)
            except FileNotFoundError:
                os.mkdir(part, 0o700, dir_fd=current_fd)
                next_fd = os.open(part, flags, dir_fd=current_fd)
            os.close(current_fd)
            current_fd = next_fd
    finally:
        os.close(current_fd)


def assert_held_parent(parent: Path, parent_fd: int) -> None:
    current = os.lstat(parent)
    held = os.fstat(parent_fd)
    if stat.S_ISLNK(current.st_mode) or not stat.S_ISDIR(current.st_mode):
        raise ValueError(f"Refusing changed config parent: {parent}")
    if (current.st_dev, current.st_ino) != (held.st_dev, held.st_ino):
        raise ValueError(f"Refusing replaced config parent: {parent}")


def open_parent_no_follow(parent: Path) -> int:
    flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
    parent_fd = os.open(parent.anchor, flags)
    try:
        for part in parent.parts[1:]:
            next_fd = os.open(part, flags, dir_fd=parent_fd)
            os.close(parent_fd)
            parent_fd = next_fd
        assert_held_parent(parent, parent_fd)
    except Exception:
        os.close(parent_fd)
        raise
    return parent_fd


def acquire_update_lock(path: Path, parent_fd: int) -> int:
    lock_name = f".{path.name}.stereofold.lock"
    descriptor = os.open(
        lock_name,
        os.O_WRONLY | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0),
        0o600,
        dir_fd=parent_fd,
    )
    try:
        details = os.fstat(descriptor)
        if not stat.S_ISREG(details.st_mode):
            raise ValueError(f"Refusing non-regular config lock: {path.parent / lock_name}")
        current = os.stat(lock_name, dir_fd=parent_fd, follow_symlinks=False)
        if stat.S_ISLNK(current.st_mode) or (current.st_dev, current.st_ino) != (details.st_dev, details.st_ino):
            raise ValueError(f"Refusing replaced config lock: {path.parent / lock_name}")
        fcntl.flock(descriptor, fcntl.LOCK_EX)
        current = os.stat(lock_name, dir_fd=parent_fd, follow_symlinks=False)
        if (current.st_dev, current.st_ino) != (details.st_dev, details.st_ino):
            raise ValueError(f"Refusing replaced config lock: {path.parent / lock_name}")
        assert_held_parent(path.parent, parent_fd)
        return descriptor
    except Exception:
        os.close(descriptor)
        raise


def read_json_no_follow(
    path: Path,
    parent_fd: int,
    *,
    default: dict[str, Any] | None = None,
) -> tuple[dict[str, Any], TargetSnapshot | None]:
    assert_held_parent(path.parent, parent_fd)
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(path.name, flags, dir_fd=parent_fd)
    except FileNotFoundError:
        if default is None:
            raise ValueError(f"Config file does not exist: {path}") from None
        return default, None
    try:
        opened = os.fstat(descriptor)
        if not stat.S_ISREG(opened.st_mode):
            raise ValueError(f"Refusing non-regular open config target: {path}")
        with os.fdopen(descriptor, "rb", closefd=False) as source:
            raw = source.read()
    finally:
        os.close(descriptor)
    payload = json.loads(raw)
    if not isinstance(payload, dict):
        raise ValueError(f"Refusing unexpected JSON root in {path}")
    return payload, TargetSnapshot(
        raw=raw,
        mode=stat.S_IMODE(opened.st_mode),
        device=opened.st_dev,
        inode=opened.st_ino,
    )


def assert_snapshot_unchanged(path: Path, parent_fd: int, original: TargetSnapshot | None) -> None:
    """Fail rather than overwrite a config changed since it was parsed."""
    assert_held_parent(path.parent, parent_fd)
    if original is None:
        try:
            os.stat(path.name, dir_fd=parent_fd, follow_symlinks=False)
        except FileNotFoundError:
            return
        raise ValueError(f"Refusing to overwrite newly created config target: {path}")

    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(path.name, flags, dir_fd=parent_fd)
    except FileNotFoundError:
        raise ValueError(f"Refusing to replace removed config target: {path}") from None
    try:
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode):
            raise ValueError(f"Refusing changed non-regular config target: {path}")
        with os.fdopen(descriptor, "rb", closefd=False) as source:
            current_raw = source.read()
        after = os.fstat(descriptor)
    finally:
        os.close(descriptor)
    identity = (after.st_dev, after.st_ino)
    if identity != (before.st_dev, before.st_ino) or identity != (original.device, original.inode):
        raise ValueError(f"Refusing to overwrite replaced config target: {path}")
    if stat.S_IMODE(after.st_mode) != original.mode:
        raise ValueError(f"Refusing to overwrite config target with changed permissions: {path}")
    if current_raw != original.raw:
        raise ValueError(f"Refusing to overwrite concurrently changed config target: {path}")


def atomic_write(
    path: Path,
    parent_fd: int,
    payload: dict[str, Any],
    original: TargetSnapshot | None,
    *,
    backup: bool,
) -> Path | None:
    encoded = (json.dumps(payload, indent=2) + "\n").encode()
    mode = original.mode if original is not None else 0o600
    temporary_name = f".{path.name}.{secrets.token_hex(12)}.tmp"
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(temporary_name, flags, mode, dir_fd=parent_fd)
    try:
        os.fchmod(descriptor, mode)
        with os.fdopen(descriptor, "wb", closefd=False) as output:
            output.write(encoded)
            output.flush()
            os.fsync(output.fileno())
        temporary_details = os.fstat(descriptor)
        os.close(descriptor)
        descriptor = -1
        backup_path = None
        if backup and original is not None:
            # Preserve the exact bytes parsed above. Revalidate afterwards so
            # the backup work cannot hide a concurrent edit before replace.
            backup_path = write_backup(path, parent_fd, original.raw, original.mode)
        assert_snapshot_unchanged(path, parent_fd, original)
        os.replace(temporary_name, path.name, src_dir_fd=parent_fd, dst_dir_fd=parent_fd)
        replaced = os.stat(path.name, dir_fd=parent_fd, follow_symlinks=False)
        if stat.S_ISLNK(replaced.st_mode) or not stat.S_ISREG(replaced.st_mode) \
                or (replaced.st_dev, replaced.st_ino) != (temporary_details.st_dev, temporary_details.st_ino):
            raise ValueError(f"Config target changed during atomic replacement: {path}")
        os.fsync(parent_fd)
        return backup_path
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        try:
            os.unlink(temporary_name, dir_fd=parent_fd)
        except FileNotFoundError:
            pass


def write_backup(path: Path, parent_fd: int, raw: bytes, mode: int) -> Path:
    base_name = f"{path.name}.bak-{time.strftime('%Y%m%d%H%M%S')}"
    backup_name = base_name
    suffix = 0
    while True:
        try:
            descriptor = os.open(
                backup_name,
                os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0),
                mode,
                dir_fd=parent_fd,
            )
            break
        except FileExistsError:
            suffix += 1
            backup_name = f"{base_name}.{suffix}"
    with os.fdopen(descriptor, "wb") as output:
        output.write(raw)
        output.flush()
        os.fsync(output.fileno())
    return path.parent / backup_name


def codex_payload(path: Path, parent_fd: int, *, remove: bool, initialize: bool = False) -> tuple[dict[str, Any], TargetSnapshot | None]:
    data, original = read_json_no_follow(path, parent_fd, default={"name": "personal", "plugins": []} if initialize else None)
    if data.get("name") != "personal" or not isinstance(data.get("plugins"), list):
        raise ValueError(f"Refusing unexpected personal marketplace shape: {path}")
    data["plugins"] = [item for item in data["plugins"] if not isinstance(item, dict) or item.get("name") != "stereofold"]
    if not remove:
        data["plugins"].append({
            "name": "stereofold",
            "source": {"source": "local", "path": "./plugins/stereofold"},
            "policy": {"installation": "AVAILABLE", "authentication": "ON_INSTALL"},
            "category": "Education & Research",
        })
    return data, original


def verify_codex_reuse_source(path: Path, parent_fd: int) -> None:
    data, original = read_json_no_follow(path, parent_fd)
    assert original is not None
    if data.get("name") != "personal" or not isinstance(data.get("plugins"), list):
        raise ValueError(f"Refusing unexpected personal marketplace shape: {path}")
    matches = [item for item in data["plugins"] if isinstance(item, dict) and item.get("name") == "stereofold"]
    if len(matches) != 1 or matches[0].get("source") != {"source": "local", "path": "./plugins/stereofold"}:
        raise ValueError(f"Personal marketplace does not contain exactly one Stereofold entry for local shared staging: {path}")


def claude_payload(
    path: Path,
    parent_fd: int,
    server: str | None,
    *,
    update: bool,
    env: dict[str, str] | None = None,
    node: str = "/opt/homebrew/bin/node",
) -> tuple[dict[str, Any], TargetSnapshot | None]:
    data, original = read_json_no_follow(path, parent_fd, default={"servers": []})
    if not isinstance(data.get("servers"), list):
        raise ValueError(f"Refusing unexpected shape (no servers array): {path}")
    if not update:
        return data, original
    if server is None:
        raise ValueError("claude-install requires --server")
    server_path = lexical_absolute(server)
    server_details = os.lstat(server_path)
    if stat.S_ISLNK(server_details.st_mode) or not stat.S_ISREG(server_details.st_mode):
        raise ValueError(f"Refusing non-regular release server: {server_path}")
    data["servers"] = [item for item in data["servers"] if not isinstance(item, dict) or item.get("name") != "stereofold"]
    data["servers"].append({
        "name": "stereofold",
        "command": node,
        "args": [str(server_path)],
        "env": dict(env) if env else {},
    })
    return data, original


def parse_env_arguments(entries: list[str]) -> dict[str, str]:
    """Parse repeated --env KEY=VALUE options into an ordered dict.

    A later repeat of the same key overwrites the earlier one, matching how
    environment variable lists are usually read.
    """
    env: dict[str, str] = {}
    for entry in entries:
        if "=" not in entry:
            raise ValueError(f"Refusing malformed --env value (expected KEY=VALUE): {entry}")
        key, _, value = entry.partition("=")
        if not key:
            raise ValueError(f"Refusing --env value with an empty key: {entry}")
        env[key] = value
    return env


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("operation", choices=["codex-install", "codex-remove", "codex-reuse-check", "claude-install"])
    parser.add_argument("--target", required=True)
    parser.add_argument("--expected-target", required=True)
    parser.add_argument("--server")
    parser.add_argument("--node", help="claude-install only: absolute Node executable path")
    parser.add_argument("--initialize", action="store_true", help="codex-install only: create a personal marketplace when missing")
    parser.add_argument("--env", action="append", default=[], metavar="KEY=VALUE",
                         help="claude-install only: repeatable env var to set on the stereofold server entry.")
    parser.add_argument("--check-only", action="store_true")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    is_claude = args.operation == "claude-install"
    if args.env and not is_claude:
        raise ValueError("--env is only valid with claude-install")
    if args.initialize and args.operation != "codex-install":
        raise ValueError("--initialize is only valid with codex-install")
    if args.node and not is_claude:
        raise ValueError("--node is only valid with claude-install")
    if args.node and (not Path(args.node).is_absolute() or not os.access(args.node, os.X_OK)):
        raise ValueError("--node must name an absolute executable path")
    env = parse_env_arguments(args.env)
    create_parent = is_claude or args.initialize
    target = validate_target(args.target, args.expected_target, allow_parent_create=create_parent)
    if create_parent and args.check_only and not target.parent.exists():
        print(f"CONFIG PREFLIGHT PASS {target}")
        return
    if create_parent and not target.parent.exists():
        ensure_parent(target.parent)
        target = validate_target(args.target, args.expected_target, allow_parent_create=True)

    parent_fd = open_parent_no_follow(target.parent)
    try:
        if args.operation == "codex-reuse-check":
            verify_codex_reuse_source(target, parent_fd)
            print(f"CONFIG REUSE CHECK PASS {target}")
            return
        if args.check_only:
            if is_claude:
                claude_payload(target, parent_fd, args.server, update=False)
            else:
                codex_payload(target, parent_fd, remove=args.operation == "codex-remove", initialize=args.initialize)
            print(f"CONFIG PREFLIGHT PASS {target}")
            return

        lock_fd = acquire_update_lock(target, parent_fd)
        try:
            if is_claude:
                payload, original = claude_payload(target, parent_fd, args.server, update=True, env=env, node=args.node or "/opt/homebrew/bin/node")
            else:
                payload, original = codex_payload(
                    target,
                    parent_fd,
                    remove=args.operation == "codex-remove",
                    initialize=args.initialize,
                )
            backup = atomic_write(
                target,
                parent_fd,
                payload,
                original,
                backup=is_claude,
            )
            if backup is not None:
                print(f"backed up {target} to {backup}")
            print(f"CONFIG UPDATE PASS {target}")
        finally:
            fcntl.flock(lock_fd, fcntl.LOCK_UN)
            os.close(lock_fd)
    finally:
        os.close(parent_fd)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:  # noqa: BLE001 - CLI must fail closed with one diagnostic.
        print(str(error), file=sys.stderr)
        raise SystemExit(1) from error
