#!/usr/bin/env python3
"""Read-only profile resolution and bundle checks for the Codex installer."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import sys


DIRECTORY_FLAGS = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
VIEWER_PLACEHOLDER = "stereofold-viewer-build-unstamped-000000000000000000000000000000"
BUNDLE_PATHS = ("dist/viewer.html", "dist/server.mjs", "dist/inspector.html", "dist/inspector.css", "dist/inspector-host.js")
PLUGIN_TOKEN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
VERSION_TOKEN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9.+-]{0,127}$")


def absolute_path(value: str) -> Path:
    path = Path(os.path.expanduser(value))
    if not path.is_absolute() or any(character in str(path) for character in "\n\r\0"):
        raise ValueError("Use an absolute path without control characters")
    return Path(os.path.abspath(path))


def open_directory(path: Path) -> int:
    descriptor = os.open(path.anchor, DIRECTORY_FLAGS)
    try:
        for part in path.parts[1:]:
            next_descriptor = os.open(part, DIRECTORY_FLAGS, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = next_descriptor
        current = os.lstat(path)
        held = os.fstat(descriptor)
        if not stat.S_ISDIR(current.st_mode) or (current.st_dev, current.st_ino) != (held.st_dev, held.st_ino):
            raise ValueError(f"Directory changed while checking it: {path}")
        if Path(os.path.realpath(path)) != path:
            raise ValueError(f"Refusing a symlinked directory: {path}")
        return descriptor
    except Exception:
        os.close(descriptor)
        raise


def resolve_profile(value: str) -> Path:
    profile = absolute_path(value)
    if profile == Path(profile.anchor):
        raise ValueError("The filesystem root cannot be a Codex profile")
    descriptor = open_directory(profile)
    os.close(descriptor)
    cache_path = profile
    for part in ("plugins", "cache", "personal", "stereofold"):
        cache_path /= part
        if cache_path.is_symlink():
            raise ValueError(f"Refusing a symlinked profile/cache path: {cache_path}")
        if not cache_path.exists():
            break
        descriptor = open_directory(cache_path)
        os.close(descriptor)
    return profile


def resolve_cli(value: str) -> Path:
    executable = shutil.which(value)
    if executable is None:
        raise ValueError(f"Codex executable is unavailable: {value}")
    path = absolute_path(os.path.abspath(executable))
    if not path.is_file() or not os.access(path, os.X_OK):
        raise ValueError(f"Codex executable is not an executable file: {path}")
    return path


def read_regular(root: Path, relative: str) -> bytes:
    path = root / relative
    parent = open_directory(path.parent)
    try:
        descriptor = os.open(path.name, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0), dir_fd=parent)
        with os.fdopen(descriptor, "rb") as source:
            before = os.fstat(source.fileno())
            if not stat.S_ISREG(before.st_mode):
                raise ValueError(f"Expected a regular artifact file: {path}")
            payload = source.read()
            after = os.fstat(source.fileno())
        current = os.stat(path.name, dir_fd=parent, follow_symlinks=False)
        fields = ("st_dev", "st_ino", "st_size", "st_mtime_ns", "st_ctime_ns")
        if any(getattr(before, field) != getattr(after, field) or getattr(after, field) != getattr(current, field) for field in fields):
            raise ValueError(f"Artifact changed while reading it: {path}")
        return payload
    finally:
        os.close(parent)


def viewer_stamp(payload: bytes) -> str | None:
    html = payload.decode("utf-8")
    if VIEWER_PLACEHOLDER in html:
        return None
    candidates = set(re.findall(r"(?<![0-9A-Za-z])[0-9a-f]{64}(?![0-9A-Za-z])", html))
    stamps = [candidate for candidate in candidates if hashlib.sha256(html.replace(candidate, VIEWER_PLACEHOLDER).encode()).hexdigest() == candidate]
    return stamps[0] if len(stamps) == 1 else None


def fingerprint(value: str, *, require_stamp: bool = True) -> dict:
    root = absolute_path(value)
    manifest = json.loads(read_regular(root, ".codex-plugin/plugin.json"))
    if not isinstance(manifest, dict) or manifest.get("name") != "stereofold":
        raise ValueError("Artifact manifest must name stereofold")
    version = manifest.get("version")
    if not isinstance(version, str) or not version or not re.fullmatch(r"[0-9A-Za-z.+-]+", version):
        raise ValueError("Artifact manifest has an invalid cache version")
    bundles = {relative: read_regular(root, relative) for relative in BUNDLE_PATHS}
    stamp = viewer_stamp(bundles["dist/viewer.html"])
    if require_stamp and stamp is None:
        raise ValueError("Artifact viewer has no verified build stamp")
    inspector_html = bundles["dist/inspector.html"]
    css_marker = b"/* STEREOFOLD_INSPECTOR_CSS */"
    if css_marker in inspector_html:
        if inspector_html.count(css_marker) != 1:
            raise ValueError("Inspector must contain exactly one stylesheet marker")
        inspector_html = inspector_html.replace(css_marker, bundles["dist/inspector.css"])
    inspector_stamp = viewer_stamp(inspector_html)
    if require_stamp and inspector_stamp is None:
        raise ValueError("Artifact inspector has no verified build stamp")
    return {
        "inspectorBuild": inspector_stamp,
        "pluginName": "stereofold",
        "version": version,
        "viewerBuild": stamp,
        "files": {relative: {"bytes": len(payload), "sha256": hashlib.sha256(payload).hexdigest()} for relative, payload in bundles.items()},
    }


def installed_plugins() -> list[dict]:
    listing = json.load(sys.stdin)
    if not isinstance(listing, dict) or not isinstance(listing.get("installed"), list):
        raise ValueError("Codex discovery must return an installed-plugin list")
    plugins = listing["installed"]
    if any(not isinstance(plugin, dict) for plugin in plugins):
        raise ValueError("Codex discovery contains an invalid installed-plugin entry")
    return plugins


def plugin_identity(plugin: dict, *, required_name: str | None = None) -> tuple[str, str, str]:
    name = plugin.get("name")
    identifier = plugin.get("pluginId")
    version = plugin.get("version")
    if not isinstance(name, str) or not PLUGIN_TOKEN.fullmatch(name) or not isinstance(version, str) or not VERSION_TOKEN.fullmatch(version):
        raise ValueError("Codex discovery contains an installed plugin with an invalid name or version")
    if not isinstance(identifier, str) or identifier.count("@") != 1:
        raise ValueError("Codex discovery contains an installed plugin with an invalid plugin identifier")
    identifier_name, source = identifier.split("@")
    if not PLUGIN_TOKEN.fullmatch(identifier_name) or not PLUGIN_TOKEN.fullmatch(source) or identifier_name != name:
        raise ValueError("Codex discovery plugin identity does not match its name")
    if required_name is not None and name != required_name:
        raise ValueError(f"Expected plugin {required_name}, found {name}")
    return name, source, version


def installed_artifact(profile: Path, plugin: dict, *, required_name: str | None = None) -> tuple[Path, set[str]]:
    name, source, version = plugin_identity(plugin, required_name=required_name)
    root = profile / "plugins" / "cache" / source / name / version
    manifest = json.loads(read_regular(root, ".codex-plugin/plugin.json"))
    if (not isinstance(manifest, dict) or manifest.get("name") != name or manifest.get("version") != version
            or manifest.get("mcpServers") != "./.mcp.json"):
        raise ValueError(f"Installed cache identity does not match Codex discovery for {plugin['pluginId']}")
    descriptor = json.loads(read_regular(root, ".mcp.json"))
    servers = descriptor.get("mcpServers") if isinstance(descriptor, dict) else None
    if not isinstance(servers, dict) or not servers:
        raise ValueError(f"Installed plugin {plugin['pluginId']} has no readable MCP server registration")
    server_ids = set(servers)
    if any(not isinstance(server, str) or not PLUGIN_TOKEN.fullmatch(server) for server in server_ids):
        raise ValueError(f"Installed plugin {plugin['pluginId']} has an invalid MCP server registration")
    return root, server_ids


def verify_ownership(profile: Path, expected_server: str) -> None:
    if not PLUGIN_TOKEN.fullmatch(expected_server):
        raise ValueError("Expected Stereofold server identity is invalid")
    matches = [plugin for plugin in installed_plugins() if plugin.get("installed") is True and (
        plugin.get("name") == "structure-viewer"
        or (isinstance(plugin.get("pluginId"), str) and plugin["pluginId"].startswith("structure-viewer@"))
    )]
    identifiers = set()
    for plugin in matches:
        identifier = plugin.get("pluginId")
        if not isinstance(identifier, str) or identifier in identifiers:
            raise ValueError("Codex discovery contains an ambiguous structure-viewer registration")
        identifiers.add(identifier)
        _root, server_ids = installed_artifact(profile, plugin, required_name="structure-viewer")
        if expected_server in server_ids:
            raise ValueError(f"Stereofold server {expected_server} conflicts with installed {identifier}")
    print(f"CODEX COEXISTENCE CHECK PASS {len(matches)} non-conflicting structure-viewer plugin(s)")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="operation", required=True)
    profile = commands.add_parser("profile")
    profile.add_argument("--codex-home", required=True)
    cli = commands.add_parser("cli")
    cli.add_argument("--codex-bin", required=True)
    preview = commands.add_parser("preview")
    preview.add_argument("--codex-home", required=True)
    preview.add_argument("--codex-bin", required=True)
    preview.add_argument("--artifact", required=True)
    preview.add_argument("--staging", required=True)
    preview.add_argument("--marketplace", required=True)
    manifest = commands.add_parser("fingerprint")
    manifest.add_argument("--artifact", required=True)
    manifest.add_argument("--viewer-stamp")
    verify = commands.add_parser("verify")
    verify.add_argument("--artifact", required=True)
    verify.add_argument("--expected", required=True)
    verify.add_argument("--version", required=True)
    verify.add_argument("--viewer-stamp", required=True)
    discovery = commands.add_parser("discovery")
    selection = discovery.add_mutually_exclusive_group(required=True)
    selection.add_argument("--name")
    selection.add_argument("--plugin-id")
    registration = commands.add_parser("registration")
    registration.add_argument("--version", required=True)
    registration.add_argument("--codex-home", required=True)
    ownership = commands.add_parser("ownership")
    ownership.add_argument("--codex-home", required=True)
    ownership.add_argument("--server-id", required=True)
    args = parser.parse_args()

    if args.operation == "profile":
        print(resolve_profile(args.codex_home))
    elif args.operation == "cli":
        print(resolve_cli(args.codex_bin))
    elif args.operation == "preview":
        target_profile = resolve_profile(args.codex_home)
        print(json.dumps({
            "mode": "preview",
            "codexExecutable": str(resolve_cli(args.codex_bin)),
            "codexProfile": str(target_profile),
            "cacheRoot": str(target_profile / "plugins/cache/personal/stereofold"),
            "sharedStaging": str(absolute_path(args.staging)),
            "sharedMarketplace": str(absolute_path(args.marketplace)),
            "artifactRoot": str(absolute_path(args.artifact)),
            "artifact": fingerprint(args.artifact, require_stamp=False),
            "cliInvoked": False,
            "buildRun": False,
            "installedPluginDiscovery": "not_run",
        }, indent=2))
    elif args.operation == "fingerprint":
        observed = fingerprint(args.artifact)
        if args.viewer_stamp is not None and observed["viewerBuild"] != args.viewer_stamp:
            raise ValueError("Release viewer stamp does not match the smoke result")
        print(json.dumps(observed, separators=(",", ":")))
    elif args.operation == "verify":
        expected = json.loads(args.expected)
        observed = fingerprint(args.artifact)
        if observed["version"] != args.version:
            raise ValueError(f"Artifact version {observed['version']} does not match {args.version}")
        for relative in BUNDLE_PATHS:
            if observed["files"][relative] != expected["files"][relative]:
                raise ValueError(f"Artifact does not match the prepared release: {relative}")
        if observed["viewerBuild"] != expected["viewerBuild"] or observed["viewerBuild"] != args.viewer_stamp:
            raise ValueError("Artifact viewer stamp does not match the verified release")
        print(f"CODEX BUNDLE CHECK PASS {absolute_path(args.artifact)}")
    elif args.operation == "discovery":
        for plugin in installed_plugins():
            if plugin.get("installed") is not True:
                continue
            if (args.name is not None and plugin.get("name") == args.name) or (args.plugin_id is not None and plugin.get("pluginId") == args.plugin_id):
                identifier = plugin.get("pluginId")
                if not isinstance(identifier, str) or not identifier or any(character in identifier for character in "\n\r\0"):
                    raise ValueError("Codex discovery contains an invalid plugin identifier")
                print(identifier)
    elif args.operation == "registration":
        matches = [plugin for plugin in installed_plugins() if plugin.get("pluginId") == "stereofold@personal" and plugin.get("installed") is True]
        if len(matches) != 1 or matches[0].get("version") != args.version or matches[0].get("enabled") is not True:
            raise ValueError("Codex does not report the expected Stereofold version installed and enabled in the selected profile")
        _root, server_ids = installed_artifact(resolve_profile(args.codex_home), matches[0], required_name="stereofold")
        if server_ids != {"stereo_structure"}:
            raise ValueError("Installed Stereofold cache does not exclusively register stereo_structure")
        print(f"CODEX REGISTRATION CHECK PASS {args.version}")
    elif args.operation == "ownership":
        verify_ownership(resolve_profile(args.codex_home), args.server_id)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1) from error
