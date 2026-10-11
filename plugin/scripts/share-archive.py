"""Write a private share without filesystem ownership or extended attributes."""

import sys
import tarfile
from pathlib import Path


def portable_member(member):
    if not (member.isfile() or member.isdir()):
        raise ValueError("Share archives accept only regular files and directories")
    member.uid = member.gid = 0
    member.uname = member.gname = ""
    member.mtime = int(member.mtime)
    member.pax_headers = {}
    return member


if __name__ == "__main__":
    destination, source, *entries = sys.argv[1:]
    root = Path(source)
    with tarfile.open(destination, "w:gz") as archive:
        for entry in entries:
            archive.add(root / entry, arcname=entry, filter=portable_member)
