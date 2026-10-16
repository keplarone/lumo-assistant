"""Check every on-device model pinned in local_models.rs against Hugging Face: the file must exist at the
pinned revision with the same size and SHA-256. Prints the pinned URL of the entry named on the command
line (for the smoke test to download), else checks them all."""

import json
import pathlib
import re
import sys
import urllib.request

SRC = pathlib.Path(__file__).resolve().parents[2] / "apps/desktop/src-tauri/src/local_models.rs"
FIELDS = ("id", "source_repo", "revision", "file_name", "size_bytes", "sha256")


def catalog() -> list:
    text = SRC.read_text(encoding="utf-8")
    entries = []
    for block in re.findall(r"CatalogEntry \{(.*?)\n    \}", text, re.S):
        e = {}
        for f in FIELDS:
            m = re.search(rf"\b{f}: (\"([^\"]*)\"|([0-9_]+))", block)
            if m:
                e[f] = m.group(2) if m.group(2) is not None else int(m.group(3).replace("_", ""))
        if len(e) == len(FIELDS):
            entries.append(e)
    if not entries:
        sys.exit(f"no catalog entries found in {SRC}")
    return entries


def main() -> None:
    entries = catalog()
    if len(sys.argv) > 1:
        e = next(x for x in entries if x["id"] == sys.argv[1])
        print(f"https://huggingface.co/{e['source_repo']}/resolve/{e['revision']}/{e['file_name']} {e['sha256']}")
        return
    bad = 0
    for e in entries:
        url = f"https://huggingface.co/api/models/{e['source_repo']}/tree/{e['revision']}"
        with urllib.request.urlopen(url, timeout=60) as r:
            files = {f["path"]: f for f in json.load(r)}
        f = files.get(e["file_name"])
        got = (f or {}).get("lfs") or {}
        ok = f is not None and got.get("oid") == e["sha256"] and got.get("size", f and f.get("size")) == e["size_bytes"]
        print(f"{'ok  ' if ok else 'FAIL'} {e['id']}: {e['source_repo']}@{e['revision'][:8]}/{e['file_name']}")
        if not ok:
            print(f"     pinned size={e['size_bytes']} sha256={e['sha256']}\n     hub    {got or f}")
            bad += 1
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
