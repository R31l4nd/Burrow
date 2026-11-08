#!/usr/bin/env python3
"""Delete old backups: by age, capped by a count, with a floor.

Usage: retention.py DIRECTORY COUNT DAYS PREFIX [MAX]

A backup stays when it is younger than DAYS and one of the newest MAX (the
cap, decision 17), or one of the newest COUNT whatever its age (the floor:
a backup service that stopped working does not end with none). The floor
never goes past the cap. COUNT 0 keeps everything; DAYS 0 looks at the
count only; MAX 0 (or none given) caps nothing. The newest COUNT alone was
not enough: every deploy, self-update and "Back up now" adds a round, and 30
archives spanned 4.4 days (A3-OPS-08); the age alone kept as many as there
were rounds (about 100 in 30 days on a machine deployed to often). The age
comes from the UTC time in the name, not the file's mtime, so a copied
archive keeps its date. Only files named PREFIX-YYYYMMDDTHHMMSSZ[-N].tar.gz.enc
are considered; their .sha256 companions go with them.
"""

import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path


def number(value, name):
    if not value.isdigit():
        raise SystemExit(f"{name} must be 0 or a positive integer.")
    return int(value)


def main():
    if len(sys.argv) not in (5, 6):
        raise SystemExit("Usage: retention.py DIRECTORY COUNT DAYS PREFIX [MAX]")
    directory, prefix = Path(sys.argv[1]), sys.argv[4]
    keep = number(sys.argv[2], "COUNT")
    days = number(sys.argv[3], "DAYS")
    cap = number(sys.argv[5], "MAX") if len(sys.argv) == 6 else 0
    if cap:
        keep = min(keep, cap)
    if not directory.is_dir():
        raise SystemExit(f"Backup directory does not exist: {directory}")
    if keep == 0:
        return
    pattern = re.compile(rf"^{re.escape(prefix)}-(\d{{8}}T\d{{6}}Z)(?:-\d+)?\.tar\.gz\.enc$")
    backups = sorted(
        (p for p in directory.iterdir() if p.is_file() and pattern.fullmatch(p.name)),
        reverse=True,
    )
    cutoff = datetime.now(timezone.utc) - timedelta(days=days) if days else None
    for index, old in enumerate(backups):
        if index < keep:
            continue
        made = datetime.strptime(pattern.fullmatch(old.name).group(1), "%Y%m%dT%H%M%SZ").replace(tzinfo=timezone.utc)
        if cutoff is not None and made >= cutoff and (not cap or index < cap):
            continue
        old.unlink()
        Path(f"{old}.sha256").unlink(missing_ok=True)
        print(f"Removed old backup: {old}")


if __name__ == "__main__":
    main()
