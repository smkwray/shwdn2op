"""Assemble a runnable `metamon/` package from this fork plus Metamon's large upstream data files.

The fork keeps code and small assets. The 24 data files listed in data.sha256 (showdown_dex move/pokedex/learnset JSON,
baseline and team-preview .pt weights) stay out of the synced tree and are copied, hash-checked, from a directory that
already holds them: an upstream checkout at 0a00a759 or an existing run source.

  python assemble.py tree DIR                              print DIR/metamon's tree hash and file count
  python assemble.py build DEST --data-from DIR --expect H  write DEST/metamon (DEST/metamon must not exist)
  python assemble.py swap DEST --expect H                   replace DEST/metamon between blocks: the new tree takes its
                                                           data from the old one, which moves to DEST/../source-retired/<tree12>/

Tree hash: SHA256 over "<sha256>  <posix path>\\n" lines for every file under metamon/ (paths start "metamon/"), sorted by
path string, without __pycache__ or .pyc. A build or swap that does not reproduce --expect is removed and fails.
"""

import argparse
import hashlib
from pathlib import Path
import shutil
import sys

FORK = Path(__file__).resolve().parent


def sha(path):
    with open(path, "rb") as f:
        return hashlib.file_digest(f, "sha256").hexdigest()


def files(root):
    """root/metamon's files keyed by posix path relative to root."""
    found = {}
    for p in (root / "metamon").rglob("*"):
        rel = p.relative_to(root).as_posix()
        if p.is_file() and "__pycache__" not in p.parts and p.suffix != ".pyc":
            found[rel] = p
    return found


def tree(root):
    listing = "".join(f"{sha(p)}  {rel}\n" for rel, p in sorted(files(root).items()))
    return hashlib.sha256(listing.encode()).hexdigest(), listing.count("\n")


def data():
    rows = [line.split("  ", 1) for line in (FORK / "data.sha256").read_text().splitlines() if line]
    return {rel: digest for digest, rel in rows}


def build(dest, data_from, expect):
    """Write the assembled package to dest/metamon via a staging dir; return its tree hash."""
    stage = dest / "metamon-assemble.tmp"
    if (dest / "metamon").exists() or stage.exists():
        raise SystemExit(f"refusing to overwrite {dest / 'metamon'} or {stage}")
    wanted = data()
    code = files(FORK)
    overlap = set(code) & set(wanted)
    if overlap:
        raise SystemExit(f"data files also present in the fork: {sorted(overlap)}")
    try:
        for rel, src in code.items():
            out = stage / rel.split("/", 1)[1]
            out.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(src, out)
        for rel, digest in wanted.items():
            src = data_from / rel
            if not src.is_file() or sha(src) != digest:
                raise SystemExit(f"data file missing or wrong hash: {src}")
            out = stage / rel.split("/", 1)[1]
            out.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(src, out)
        stage.rename(dest / "metamon")
    except BaseException:
        shutil.rmtree(stage, ignore_errors=True)
        raise
    got, count = tree(dest)
    if got != expect:
        shutil.rmtree(dest / "metamon")
        raise SystemExit(f"tree {got} ({count} files) != expected {expect}; build removed")
    return got, count


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    t = sub.add_parser("tree")
    t.add_argument("dir", type=Path)
    b = sub.add_parser("build")
    b.add_argument("dest", type=Path)
    b.add_argument("--data-from", type=Path, required=True)
    b.add_argument("--expect", required=True)
    s = sub.add_parser("swap")
    s.add_argument("dest", type=Path)
    s.add_argument("--expect", required=True)
    a = ap.parse_args()
    if a.cmd == "tree":
        print(*tree(a.dir.resolve()))
        return
    dest = a.dest.resolve()
    if a.cmd == "build":
        print("built", *build(dest, a.data_from.resolve(), a.expect), dest / "metamon")
        return
    old, _ = tree(dest)
    if old == a.expect:
        print("already", old, dest / "metamon")
        return
    retired = dest.parent / "source-retired" / old[:12]
    if retired.exists():
        raise SystemExit(f"refusing to overwrite {retired}")
    retired.mkdir(parents=True)
    (dest / "metamon").rename(retired / "metamon")
    try:
        got = build(dest, retired, a.expect)
    except BaseException:
        if not (dest / "metamon").exists():
            (retired / "metamon").rename(dest / "metamon")  # restore the old tree
        raise
    print("swapped", old, "->", *got, "retired", retired / "metamon")


if __name__ == "__main__":
    sys.exit(main())
