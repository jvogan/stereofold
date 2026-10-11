#!/usr/bin/env python3
"""Descriptor-relative staging and removal for Stereofold plugin directories."""

from __future__ import annotations

import argparse
import ctypes
from dataclasses import dataclass
import errno
import hashlib
import json
import os
import secrets
import shutil
import stat
import sys
from datetime import datetime, timezone
from pathlib import Path


DIRECTORY_FLAGS = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
UNSET = object()


@dataclass(frozen=True)
class SnapshotEntry:
    path: str
    kind: str
    mode: int
    size: int
    modified_ns: int
    changed_ns: int
    device: int
    inode: int
    digest: str | None


def lexical_absolute(value: str) -> Path:
    return Path(os.path.abspath(os.path.expanduser(value)))


def open_directory_no_follow(path: Path) -> int:
    descriptor = os.open(path.anchor, DIRECTORY_FLAGS)
    try:
        for part in path.parts[1:]:
            next_descriptor = os.open(part, DIRECTORY_FLAGS, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = next_descriptor
        current = os.lstat(path)
        held = os.fstat(descriptor)
        if stat.S_ISLNK(current.st_mode) or not stat.S_ISDIR(current.st_mode):
            raise ValueError(f"Refusing non-directory or symlinked parent: {path}")
        if (current.st_dev, current.st_ino) != (held.st_dev, held.st_ino):
            raise ValueError(f"Refusing replaced parent: {path}")
        if Path(os.path.realpath(path)) != path:
            raise ValueError(f"Refusing non-canonical parent: {path}")
        return descriptor
    except Exception:
        os.close(descriptor)
        raise


def validate_paths(stage_value: str | None, target_value: str, expected_value: str) -> tuple[Path | None, Path]:
    target = lexical_absolute(target_value)
    expected = lexical_absolute(expected_value)
    if target != expected:
        raise ValueError(f"Refusing unexpected plugin target: {target}; expected {expected}")
    stage = lexical_absolute(stage_value) if stage_value is not None else None
    if stage is not None:
        if stage.parent != target.parent or not stage.name.startswith(".stereofold-stage-"):
            raise ValueError(f"Refusing unexpected staging directory: {stage}")
        if stage == target:
            raise ValueError("Staging directory and plugin target must differ")
    return stage, target


def entry_details(parent_fd: int, name: str) -> os.stat_result | None:
    try:
        return os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
    except FileNotFoundError:
        return None


def require_directory(parent_fd: int, name: str, label: str) -> os.stat_result:
    details = entry_details(parent_fd, name)
    if details is None or stat.S_ISLNK(details.st_mode) or not stat.S_ISDIR(details.st_mode):
        raise ValueError(f"Refusing missing, non-directory, or symlinked {label}: {name}")
    return details


def same_identity(left: os.stat_result | None, right: os.stat_result | None) -> bool:
    if left is None or right is None:
        return left is None and right is None
    return (left.st_dev, left.st_ino) == (right.st_dev, right.st_ino)


def same_metadata(left: os.stat_result, right: os.stat_result) -> bool:
    return (
        left.st_dev,
        left.st_ino,
        stat.S_IFMT(left.st_mode),
        stat.S_IMODE(left.st_mode),
        left.st_size,
        left.st_mtime_ns,
        left.st_ctime_ns,
    ) == (
        right.st_dev,
        right.st_ino,
        stat.S_IFMT(right.st_mode),
        stat.S_IMODE(right.st_mode),
        right.st_size,
        right.st_mtime_ns,
        right.st_ctime_ns,
    )


def snapshot_file(parent_fd: int, name: str, path: str, expected: os.stat_result) -> SnapshotEntry:
    descriptor = os.open(name, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0), dir_fd=parent_fd)
    try:
        opened = os.fstat(descriptor)
        if not stat.S_ISREG(opened.st_mode) or not same_identity(opened, expected):
            raise ValueError(f"Release source changed while snapshotting: {path}")
        digest = hashlib.sha256()
        while True:
            chunk = os.read(descriptor, 1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
        finished = os.fstat(descriptor)
        if not same_metadata(opened, finished):
            raise ValueError(f"Release source changed while snapshotting: {path}")
        return SnapshotEntry(
            path=path,
            kind="file",
            mode=stat.S_IMODE(opened.st_mode),
            size=opened.st_size,
            modified_ns=opened.st_mtime_ns,
            changed_ns=opened.st_ctime_ns,
            device=opened.st_dev,
            inode=opened.st_ino,
            digest=digest.hexdigest(),
        )
    finally:
        os.close(descriptor)


def snapshot_entry(
    parent_fd: int,
    name: str,
    path: str,
    snapshot: dict[str, SnapshotEntry],
) -> None:
    expected = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
    if stat.S_ISLNK(expected.st_mode):
        raise ValueError(f"Refusing symlinked release input: {path}")
    if stat.S_ISREG(expected.st_mode):
        snapshot[path] = snapshot_file(parent_fd, name, path, expected)
        return
    if not stat.S_ISDIR(expected.st_mode):
        raise ValueError(f"Refusing non-regular release input: {path}")

    descriptor = os.open(name, DIRECTORY_FLAGS, dir_fd=parent_fd)
    try:
        opened = os.fstat(descriptor)
        if not same_identity(opened, expected):
            raise ValueError(f"Release source changed while snapshotting: {path}")
        snapshot[path] = SnapshotEntry(
            path=path,
            kind="directory",
            mode=stat.S_IMODE(opened.st_mode),
            size=opened.st_size,
            modified_ns=opened.st_mtime_ns,
            changed_ns=opened.st_ctime_ns,
            device=opened.st_dev,
            inode=opened.st_ino,
            digest=None,
        )
        for child in sorted(os.listdir(descriptor)):
            snapshot_entry(descriptor, child, f"{path}/{child}", snapshot)
        if not same_metadata(opened, os.fstat(descriptor)):
            raise ValueError(f"Release source changed while snapshotting: {path}")
    finally:
        os.close(descriptor)


def snapshot_entries(root_fd: int, entries: list[str]) -> dict[str, SnapshotEntry]:
    snapshot: dict[str, SnapshotEntry] = {}
    for entry in entries:
        if entry in ("", ".", "..") or "/" in entry or "\\" in entry:
            raise ValueError(f"Refusing unexpected release entry: {entry}")
        snapshot_entry(root_fd, entry, entry, snapshot)
    return snapshot


def snapshot_complete_root(root_fd: int) -> tuple[list[str], dict[str, SnapshotEntry]]:
    opened = os.fstat(root_fd)
    names = sorted(os.listdir(root_fd))
    snapshot = snapshot_entries(root_fd, names)
    if not same_metadata(opened, os.fstat(root_fd)):
        raise ValueError("Staged release changed while snapshotting")
    return names, snapshot


def portable_snapshot(snapshot: dict[str, SnapshotEntry]) -> dict[str, tuple[str, int, int, str | None]]:
    return {
        path: (entry.kind, entry.mode, entry.size if entry.kind == "file" else 0, entry.digest)
        for path, entry in snapshot.items()
    }


def rename_exclusive_at(parent_fd: int, source: str, target: str) -> None:
    """Rename within one held directory without replacing the destination."""
    libc = ctypes.CDLL(None, use_errno=True)
    source_bytes = os.fsencode(source)
    target_bytes = os.fsencode(target)
    if sys.platform == "darwin" and hasattr(libc, "renameatx_np"):
        operation = libc.renameatx_np
        operation.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
        result = operation(parent_fd, source_bytes, parent_fd, target_bytes, 0x00000004)  # RENAME_EXCL
    elif sys.platform.startswith("linux") and hasattr(libc, "renameat2"):
        operation = libc.renameat2
        operation.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
        result = operation(parent_fd, source_bytes, parent_fd, target_bytes, 0x1)  # RENAME_NOREPLACE
    else:
        raise ValueError("This platform has no supported exclusive descriptor-relative rename")
    if result != 0:
        error_number = ctypes.get_errno()
        if error_number in (errno.EEXIST, errno.ENOTEMPTY):
            raise FileExistsError(error_number, os.strerror(error_number), target)
        raise OSError(error_number, os.strerror(error_number), target)


def assert_parent_held(parent: Path, parent_fd: int) -> None:
    current = os.lstat(parent)
    held = os.fstat(parent_fd)
    if stat.S_ISLNK(current.st_mode) or not stat.S_ISDIR(current.st_mode):
        raise ValueError(f"Refusing changed plugin parent: {parent}")
    if (current.st_dev, current.st_ino) != (held.st_dev, held.st_ino):
        raise ValueError(f"Refusing replaced plugin parent: {parent}")


def preflight(target: Path, parent_fd: int) -> os.stat_result | None:
    details = entry_details(parent_fd, target.name)
    if details is not None and (stat.S_ISLNK(details.st_mode) or not stat.S_ISDIR(details.st_mode)):
        raise ValueError(f"Refusing non-directory or symlinked plugin target: {target}")
    assert_parent_held(target.parent, parent_fd)
    return details


def swap(
    stage: Path,
    target: Path,
    parent_fd: int,
    *,
    expected_target: os.stat_result | None | object = UNSET,
) -> Path | None:
    expected_stage = require_directory(parent_fd, stage.name, "staging directory")
    current_target = preflight(target, parent_fd)
    if expected_target is not UNSET and not same_identity(current_target, expected_target):
        raise ValueError(f"Refusing plugin target changed during staging: {target}")
    expected_target = current_target
    backup_name: str | None = None
    if expected_target is not None:
        while True:
            candidate = f".stereofold-backup-{secrets.token_hex(12)}"
            try:
                rename_exclusive_at(parent_fd, target.name, candidate)
                backup_name = candidate
                break
            except FileExistsError:
                continue
        moved_target = entry_details(parent_fd, backup_name)
        if not same_identity(moved_target, expected_target):
            if entry_details(parent_fd, target.name) is None:
                rename_exclusive_at(parent_fd, backup_name, target.name)
            raise ValueError(f"Refusing concurrently replaced plugin target: {target}")

    try:
        assert_parent_held(target.parent, parent_fd)
        if not same_identity(require_directory(parent_fd, stage.name, "staging directory"), expected_stage):
            raise ValueError(f"Refusing staging directory changed before rename: {stage}")
        rename_exclusive_at(parent_fd, stage.name, target.name)
        installed = entry_details(parent_fd, target.name)
        if not same_identity(installed, expected_stage) or installed is None \
                or stat.S_ISLNK(installed.st_mode) or not stat.S_ISDIR(installed.st_mode):
            rejected: str | None = None
            if installed is not None:
                rejected = f".stereofold-rejected-{secrets.token_hex(12)}"
                rename_exclusive_at(parent_fd, target.name, rejected)
            if backup_name is not None and entry_details(parent_fd, target.name) is None:
                rename_exclusive_at(parent_fd, backup_name, target.name)
                backup_name = None
            os.fsync(parent_fd)
            suffix = "" if rejected is None else f"; unexpected entry retained as {target.parent / rejected}"
            raise ValueError(f"Refusing staging entry changed during rename: {stage}{suffix}")
        os.fsync(parent_fd)
    except Exception:
        if backup_name is not None and entry_details(parent_fd, target.name) is None:
            rename_exclusive_at(parent_fd, backup_name, target.name)
            os.fsync(parent_fd)
        raise

    if backup_name is None:
        return None
    return target.parent / backup_name


def remove(target: Path, parent_fd: int) -> Path | None:
    expected_target = preflight(target, parent_fd)
    if expected_target is None:
        return None
    quarantine = f".stereofold-remove-{secrets.token_hex(12)}"
    rename_exclusive_at(parent_fd, target.name, quarantine)
    if not same_identity(entry_details(parent_fd, quarantine), expected_target):
        if entry_details(parent_fd, target.name) is None:
            rename_exclusive_at(parent_fd, quarantine, target.name)
        raise ValueError(f"Refusing to remove concurrently replaced plugin target: {target}")
    assert_parent_held(target.parent, parent_fd)
    os.fsync(parent_fd)
    return target.parent / quarantine


def copy_file(source_fd: int, target_fd: int, name: str, expected: os.stat_result) -> None:
    source = os.open(name, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0), dir_fd=source_fd)
    destination = -1
    try:
        opened = os.fstat(source)
        if not stat.S_ISREG(opened.st_mode) or not same_identity(opened, expected):
            raise ValueError(f"Refusing changed or non-regular release input: {name}")
        destination = os.open(
            name,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0),
            stat.S_IMODE(opened.st_mode),
            dir_fd=target_fd,
        )
        os.fchmod(destination, stat.S_IMODE(opened.st_mode))
        with os.fdopen(source, "rb", closefd=False) as input_file, os.fdopen(destination, "wb", closefd=False) as output_file:
            shutil.copyfileobj(input_file, output_file)
            output_file.flush()
            os.fsync(output_file.fileno())
        finished = os.fstat(source)
        if (finished.st_size, finished.st_mtime_ns) != (opened.st_size, opened.st_mtime_ns):
            raise ValueError(f"Refusing concurrently changed release input: {name}")
    finally:
        os.close(source)
        if destination >= 0:
            os.close(destination)


def copy_tree(source_fd: int, target_fd: int) -> None:
    for name in sorted(os.listdir(source_fd)):
        expected = os.stat(name, dir_fd=source_fd, follow_symlinks=False)
        if stat.S_ISLNK(expected.st_mode):
            raise ValueError(f"Refusing symlinked release input: {name}")
        if stat.S_ISREG(expected.st_mode):
            copy_file(source_fd, target_fd, name, expected)
            continue
        if not stat.S_ISDIR(expected.st_mode):
            raise ValueError(f"Refusing non-regular release input: {name}")
        os.mkdir(name, 0o700, dir_fd=target_fd)
        source_child = os.open(name, DIRECTORY_FLAGS, dir_fd=source_fd)
        target_child = os.open(name, DIRECTORY_FLAGS, dir_fd=target_fd)
        try:
            if not same_identity(os.fstat(source_child), expected):
                raise ValueError(f"Refusing changed release directory: {name}")
            copy_tree(source_child, target_child)
            os.fchmod(target_child, stat.S_IMODE(expected.st_mode))
            os.fsync(target_child)
        finally:
            os.close(source_child)
            os.close(target_child)


def copy_entry(source_fd: int, target_fd: int, name: str) -> None:
    if name in ("", ".", "..") or "/" in name or "\\" in name:
        raise ValueError(f"Refusing unexpected release entry: {name}")
    expected = os.stat(name, dir_fd=source_fd, follow_symlinks=False)
    if stat.S_ISLNK(expected.st_mode):
        raise ValueError(f"Refusing symlinked release input: {name}")
    if stat.S_ISREG(expected.st_mode):
        copy_file(source_fd, target_fd, name, expected)
        return
    if not stat.S_ISDIR(expected.st_mode):
        raise ValueError(f"Refusing non-regular release input: {name}")
    os.mkdir(name, 0o700, dir_fd=target_fd)
    source_child = os.open(name, DIRECTORY_FLAGS, dir_fd=source_fd)
    target_child = os.open(name, DIRECTORY_FLAGS, dir_fd=target_fd)
    try:
        if not same_identity(os.fstat(source_child), expected):
            raise ValueError(f"Refusing changed release directory: {name}")
        copy_tree(source_child, target_child)
        os.fchmod(target_child, stat.S_IMODE(expected.st_mode))
        os.fsync(target_child)
    finally:
        os.close(source_child)
        os.close(target_child)


def read_staged_manifest(stage_fd: int) -> tuple[dict[str, object], int]:
    manifest_directory = os.open(".codex-plugin", DIRECTORY_FLAGS, dir_fd=stage_fd)
    try:
        manifest_fd = os.open("plugin.json", os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0), dir_fd=manifest_directory)
        manifest_details = os.fstat(manifest_fd)
        with os.fdopen(manifest_fd, "r", encoding="utf-8") as manifest_file:
            manifest = json.load(manifest_file)
        if not isinstance(manifest, dict) or manifest.get("name") != "stereofold":
            raise ValueError("Staged manifest must name the stereofold plugin")
        version = manifest.get("version")
        if not isinstance(version, str) or not version.strip():
            raise ValueError("Staged manifest must have a non-empty version")
        return manifest, stat.S_IMODE(manifest_details.st_mode)
    finally:
        os.close(manifest_directory)


def cachebust_manifest(stage_fd: int) -> tuple[str, bytes]:
    manifest, manifest_mode = read_staged_manifest(stage_fd)
    version = manifest["version"]
    assert isinstance(version, str)
    manifest_directory = os.open(".codex-plugin", DIRECTORY_FLAGS, dir_fd=stage_fd)
    try:
        cachebuster = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S") + f"-{secrets.token_hex(4)}"
        next_version = f"{version.split('+', 1)[0]}+codex.{cachebuster}"
        manifest["version"] = next_version
        payload = (json.dumps(manifest, indent=2) + "\n").encode("utf-8")
        temporary = f".plugin.json.{secrets.token_hex(12)}.tmp"
        descriptor = os.open(
            temporary,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0),
            manifest_mode,
            dir_fd=manifest_directory,
        )
        try:
            with os.fdopen(descriptor, "wb", closefd=False) as output:
                output.write(payload)
                output.flush()
                os.fsync(output.fileno())
        finally:
            os.close(descriptor)
        os.replace(temporary, "plugin.json", src_dir_fd=manifest_directory, dst_dir_fd=manifest_directory)
        os.fsync(manifest_directory)
        return next_version, payload
    finally:
        os.close(manifest_directory)


def install(source: Path, target: Path, parent_fd: int) -> tuple[str, Path | None]:
    source_fd = open_directory_no_follow(source)
    stage_name = f".stereofold-stage-{secrets.token_hex(12)}"
    stage_fd = -1
    staged = False
    try:
        expected_target = preflight(target, parent_fd)
        source_names, source_snapshot = snapshot_complete_root(source_fd)
        os.mkdir(stage_name, 0o700, dir_fd=parent_fd)
        stage_fd = os.open(stage_name, DIRECTORY_FLAGS, dir_fd=parent_fd)
        copy_tree(source_fd, stage_fd)
        staged_names, staged_snapshot = snapshot_complete_root(stage_fd)
        staged_matches = staged_names == source_names \
            and portable_snapshot(staged_snapshot) == portable_snapshot(source_snapshot)
        if not staged_matches:
            assert_parent_held(source, source_fd)
            source_after_names, source_after = snapshot_complete_root(source_fd)
            if source_after_names != source_names or source_after != source_snapshot:
                raise ValueError("Plugin source changed while staging; current plugin left intact")
            raise ValueError("Staged plugin does not match its source snapshot; current plugin left intact")
        version, manifest_payload = cachebust_manifest(stage_fd)
        cachebusted_names, cachebusted_snapshot = snapshot_complete_root(stage_fd)
        expected_cachebusted = portable_snapshot(source_snapshot)
        manifest_path = ".codex-plugin/plugin.json"
        manifest_entry = cachebusted_snapshot.get(manifest_path)
        if manifest_entry is None:
            raise ValueError("Cache-busted stage lost its plugin manifest; current plugin left intact")
        expected_cachebusted[manifest_path] = (
            "file",
            source_snapshot[manifest_path].mode,
            len(manifest_payload),
            hashlib.sha256(manifest_payload).hexdigest(),
        )
        if cachebusted_names != source_names \
                or portable_snapshot(cachebusted_snapshot) != expected_cachebusted:
            raise ValueError("Cache-busted stage changed unexpectedly; current plugin left intact")
        staged_manifest, _ = read_staged_manifest(stage_fd)
        assert_parent_held(source, source_fd)
        source_after_names, source_after = snapshot_complete_root(source_fd)
        if source_after_names != source_names or source_after != source_snapshot:
            raise ValueError("Plugin source changed while staging; current plugin left intact")
        if staged_manifest.get("version") != version:
            raise ValueError("Cache-busted stage has an unexpected version; current plugin left intact")
        os.fsync(stage_fd)
        os.close(stage_fd)
        stage_fd = -1
        backup = swap(
            target.parent / stage_name,
            target,
            parent_fd,
            expected_target=expected_target,
        )
        staged = True
        return version, backup
    finally:
        os.close(source_fd)
        if stage_fd >= 0:
            os.close(stage_fd)
        if not staged and entry_details(parent_fd, stage_name) is not None:
            print(f"INCOMPLETE STAGE RETAINED {target.parent / stage_name}", file=sys.stderr)


def stage_release(source: Path, target: Path, entries: list[str]) -> Path | None:
    if target.parent != source / "release" or target.name != "stereofold":
        raise ValueError(f"Refusing release target outside {source / 'release'}: {target}")
    if len(entries) == 0 or len(entries) != len(set(entries)):
        raise ValueError("Release entries must be a non-empty unique list")

    source_fd = open_directory_no_follow(source)
    release_fd = -1
    stage_fd = -1
    stage_name = f".stereofold-stage-{secrets.token_hex(12)}"
    staged = False
    try:
        release_details = entry_details(source_fd, "release")
        if release_details is None:
            os.mkdir("release", 0o700, dir_fd=source_fd)
        elif stat.S_ISLNK(release_details.st_mode) or not stat.S_ISDIR(release_details.st_mode):
            raise ValueError(f"Refusing non-directory or symlinked release parent: {target.parent}")
        release_fd = os.open("release", DIRECTORY_FLAGS, dir_fd=source_fd)
        assert_parent_held(target.parent, release_fd)
        expected_target = preflight(target, release_fd)
        source_snapshot = snapshot_entries(source_fd, entries)
        os.mkdir(stage_name, 0o700, dir_fd=release_fd)
        stage_fd = os.open(stage_name, DIRECTORY_FLAGS, dir_fd=release_fd)
        for entry in entries:
            copy_entry(source_fd, stage_fd, entry)
        staged_names, staged_snapshot = snapshot_complete_root(stage_fd)
        staged_matches = staged_names == sorted(entries) \
            and portable_snapshot(staged_snapshot) == portable_snapshot(source_snapshot)
        assert_parent_held(source, source_fd)
        source_after = snapshot_entries(source_fd, entries)
        if source_after != source_snapshot:
            raise ValueError("Release source changed while staging; current release left intact")
        if not staged_matches:
            raise ValueError("Staged release does not match its source snapshot; current release left intact")
        read_staged_manifest(stage_fd)
        os.fsync(stage_fd)
        os.close(stage_fd)
        stage_fd = -1
        backup = swap(
            target.parent / stage_name,
            target,
            release_fd,
            expected_target=expected_target,
        )
        staged = True
        return backup
    finally:
        if stage_fd >= 0:
            os.close(stage_fd)
        if release_fd >= 0:
            if not staged and entry_details(release_fd, stage_name) is not None:
                print(f"INCOMPLETE STAGE RETAINED {target.parent / stage_name}", file=sys.stderr)
            os.close(release_fd)
        os.close(source_fd)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("operation", choices=["preflight", "swap", "remove", "install", "release"])
    parser.add_argument("--target", required=True)
    parser.add_argument("--expected-target", required=True)
    parser.add_argument("--stage")
    parser.add_argument("--source")
    parser.add_argument("--expected-source")
    parser.add_argument("--entry", action="append", default=[])
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    stage, target = validate_paths(args.stage, args.target, args.expected_target)
    if args.operation == "release":
        if args.source is None or args.expected_source is None:
            raise ValueError("release requires --source and --expected-source")
        source = lexical_absolute(args.source)
        expected_source = lexical_absolute(args.expected_source)
        if source != expected_source:
            raise ValueError(f"Refusing unexpected release source: {source}; expected {expected_source}")
        backup = stage_release(source, target, args.entry)
        print(f"RELEASE SWAP PASS {target}")
        if backup is not None:
            print(f"PREVIOUS RELEASE RETAINED {backup}")
        return
    parent_fd = open_directory_no_follow(target.parent)
    try:
        if args.operation == "preflight":
            preflight(target, parent_fd)
            print(f"PLUGIN PREFLIGHT PASS {target}")
            return
        if args.operation == "remove":
            removed = remove(target, parent_fd)
            print(f"PLUGIN REMOVE PASS {target}")
            if removed is not None:
                print(f"REMOVED PLUGIN RETAINED {removed}")
            return
        if args.operation == "install":
            if args.source is None or args.expected_source is None:
                raise ValueError("install requires --source and --expected-source")
            source = lexical_absolute(args.source)
            expected_source = lexical_absolute(args.expected_source)
            if source != expected_source:
                raise ValueError(f"Refusing unexpected release source: {source}; expected {expected_source}")
            version, backup = install(source, target, parent_fd)
            print(f"PLUGIN SWAP PASS {target}")
            print(f"STAGED VERSION {version}")
            if backup is not None:
                print(f"PREVIOUS PLUGIN RETAINED {backup}")
            return
        if stage is None:
            raise ValueError("swap requires --stage")
        backup = swap(stage, target, parent_fd)
        print(f"PLUGIN SWAP PASS {target}")
        if backup is not None:
            print(f"PREVIOUS PLUGIN RETAINED {backup}")
    finally:
        os.close(parent_fd)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:  # noqa: BLE001 - CLI must fail closed.
        print(str(error), file=sys.stderr)
        raise SystemExit(1) from error
