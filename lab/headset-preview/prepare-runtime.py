#!/usr/bin/env python3
"""Fetch the pinned IWER browser runtime without installing dependencies."""
import argparse
import base64
import hashlib
import io
import json
from pathlib import Path
import tarfile
import urllib.request

VERSION = "2.3.0"
URL = "https://registry.npmjs.org/iwer/-/iwer-2.3.0.tgz"
INTEGRITY = "sha512-+aY/BXVIjztCtS4F1hAO2rQy0P1/0JbJ6Jq5QHVscUBBlv8xJlTkkyeg+uSiD9RQ7i5B6k1Blpcx84FQaI7Myw=="
FILES = {
    "package/build/iwer.min.js": "iwer.min.js",
    "package/LICENSE": "LICENSE",
    "package/package.json": "package.json",
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()
    if not args.out.is_absolute():
        parser.error("--out must be an absolute, new directory outside the repository")
    parent = args.out.parent.resolve(strict=True)
    out = parent / args.out.name
    repo = Path(__file__).resolve().parents[4]
    if out.is_relative_to(repo):
        parser.error("Keep downloaded runtime files outside the repository")
    if out.exists() or out.is_symlink():
        parser.error("--out already exists")

    with urllib.request.urlopen(URL, timeout=30) as response:
        archive = response.read(1024 * 1024 + 1)
    if len(archive) > 1024 * 1024:
        raise ValueError("Pinned runtime archive exceeds 1 MiB")
    actual = "sha512-" + base64.b64encode(hashlib.sha512(archive).digest()).decode()
    if actual != INTEGRITY:
        raise ValueError("Runtime archive differs from the pinned npm integrity")
    contents = {}
    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as source:
        for member, name in FILES.items():
            entry = source.getmember(member)
            if not entry.isfile() or entry.size > 512 * 1024:
                raise ValueError("Unexpected runtime archive entry")
            contents[name] = source.extractfile(entry).read()
    package = json.loads(contents["package.json"])
    if package["name"] != "iwer" or package["version"] != VERSION:
        raise ValueError("Unexpected runtime package")

    out.mkdir()
    files = []
    for name, value in contents.items():
        with (out / name).open("xb") as target:
            target.write(value)
        files.append({"path": name, "bytes": len(value), "sha256": hashlib.sha256(value).hexdigest()})
    record = {
        "kind": "pinned_webxr_emulation_runtime",
        "name": "iwer", "version": VERSION, "source": URL,
        "integrity": INTEGRITY, "archiveBytes": len(archive),
        "archiveSha256": hashlib.sha256(archive).hexdigest(),
        "files": files,
        "installedDependencies": False,
        "physicalHeadsetTest": "not_run",
    }
    (out / "runtime.json").write_text(json.dumps(record, indent=2) + "\n")
    print(json.dumps({"out": str(out), "runtimeBytes": len(contents["iwer.min.js"]), "retainedBytes": sum(len(b) for b in contents.values())}))


if __name__ == "__main__":
    main()
