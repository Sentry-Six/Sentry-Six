#!/usr/bin/env python3
"""Writes an update manifest (latest.yml, latest-mac.yml, latest-linux.yml)
the way electron-builder writes it, so installed copies of Electron Studio
(electron-updater, and its own .deb updater) and the native app's updater
read the same file from a GitHub release:

    version: 2026.45.40
    files:
      - url: SentryStudioSetup2026.45.40.exe
        sha512: <base64 of the file's SHA-512>
        size: <bytes>
    path: SentryStudioSetup2026.45.40.exe
    sha512: <same as the first file's>
    releaseDate: '2026-11-07T12:00:00.000Z'

The first file is the one electron-updater installs (`path`), so list the
.zip before the .dmg on macOS, as electron-builder does.

    tools/update-manifest.py OUT.yml VERSION FILE [FILE...]
        [--minimum-system-version KERNEL_VERSION]

--minimum-system-version is compared with os.release() by electron-updater:
the kernel version (Darwin 22.0.0 is macOS 13), not the OS's marketing one.
"""
import argparse
import base64
import datetime
import hashlib
import os
import re
import sys


def sha512_base64(path):
    h = hashlib.sha512()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return base64.b64encode(h.digest()).decode("ascii")


def main():
    p = argparse.ArgumentParser(description="Write an electron-builder style update manifest.")
    p.add_argument("out")
    p.add_argument("version")
    p.add_argument("files", nargs="+")
    p.add_argument("--minimum-system-version")
    args = p.parse_args()

    # A plain x.y.z: electron-updater would read a "-beta" suffix as a
    # channel and look for beta.yml, and Electron Studio's .deb updater
    # accepts only dotted numbers.
    if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", args.version):
        sys.exit(f"update-manifest: version {args.version!r} is not x.y.z")
    if args.minimum_system_version and not re.fullmatch(r"[0-9]+(\.[0-9]+)*", args.minimum_system_version):
        sys.exit(f"update-manifest: bad --minimum-system-version {args.minimum_system_version!r}")

    entries = []
    for path in args.files:
        name = os.path.basename(path)
        # GitHub keeps these names as they are; a space or a quote would not
        # survive as a release asset name or as a plain YAML scalar.
        if not re.fullmatch(r"[A-Za-z0-9._-]+", name):
            sys.exit(f"update-manifest: file name {name!r} needs only letters, digits, '.', '_' and '-'")
        entries.append((name, sha512_base64(path), os.path.getsize(path)))

    now = datetime.datetime.now(datetime.timezone.utc)
    release_date = now.strftime("%Y-%m-%dT%H:%M:%S.") + f"{now.microsecond // 1000:03d}Z"

    lines = [f"version: {args.version}", "files:"]
    for name, sha512, size in entries:
        lines += [f"  - url: {name}", f"    sha512: {sha512}", f"    size: {size}"]
    lines += [f"path: {entries[0][0]}", f"sha512: {entries[0][1]}"]
    if args.minimum_system_version:
        lines.append(f"minimumSystemVersion: {args.minimum_system_version}")
    lines.append(f"releaseDate: '{release_date}'")

    tmp = args.out + ".tmp"
    with open(tmp, "w", newline="\n") as f:
        f.write("\n".join(lines) + "\n")
    os.replace(tmp, args.out)
    print(f"{args.out}: {', '.join(e[0] for e in entries)}")


if __name__ == "__main__":
    main()
