"""Check every on-device model pinned in local_models.rs against Hugging Face: each file (the model, and a
vision model's image projector) must exist at the pinned revision with the same size and SHA-256. With
an entry id on the command line, prints "URL SHA256" for each of its files instead, the model first (for
the smoke tests to download)."""

import json
import pathlib
import re
import sys
import urllib.request

SRC = pathlib.Path(__file__).resolve().parents[2] / "apps/desktop/src-tauri/src/local_models.rs"
FIELDS = ("id", "source_repo", "revision", "file_name", "size_bytes", "sha256")
FILE_FIELDS = ("file_name", "size_bytes", "sha256")


def fields(block: str, names: tuple) -> dict:
    e = {}
    for f in names:
        m = re.search(rf"\b{f}: (\"([^\"]*)\"|([0-9_]+))", block)
        if m:
            e[f] = m.group(2) if m.group(2) is not None else int(m.group(3).replace("_", ""))
    return e


def catalog() -> list:
    text = SRC.read_text(encoding="utf-8")
    entries = []
    for block in re.findall(r"CatalogEntry \{(.*?)\n    \}", text, re.S):
        # The projector's fields have the same names; read the model's without them.
        proj = re.search(r"projector: Some\(Projector \{(.*?)\}\)", block, re.S)
        main = block[: proj.start()] + block[proj.end() :] if proj else block
        e = fields(main, FIELDS)
        if len(e) == len(FIELDS):
            e["files"] = [{f: e[f] for f in FILE_FIELDS}]
            if proj:
                p = fields(proj.group(1), FILE_FIELDS)
                if len(p) != len(FILE_FIELDS):
                    sys.exit(f"{e['id']}: incomplete projector in {SRC}")
                e["files"].append(p)
            entries.append(e)
    if not entries:
        sys.exit(f"no catalog entries found in {SRC}")
    return entries


def main() -> None:
    entries = catalog()
    if len(sys.argv) > 1:
        e = next(x for x in entries if x["id"] == sys.argv[1])
        for f in e["files"]:
            print(f"https://huggingface.co/{e['source_repo']}/resolve/{e['revision']}/{f['file_name']} {f['sha256']}")
        return
    bad = 0
    for e in entries:
        url = f"https://huggingface.co/api/models/{e['source_repo']}/tree/{e['revision']}"
        with urllib.request.urlopen(url, timeout=60) as r:
            listing = {f["path"]: f for f in json.load(r)}
        for pin in e["files"]:
            f = listing.get(pin["file_name"])
            got = (f or {}).get("lfs") or {}
            ok = f is not None and got.get("oid") == pin["sha256"] and got.get("size", f and f.get("size")) == pin["size_bytes"]
            print(f"{'ok  ' if ok else 'FAIL'} {e['id']}: {e['source_repo']}@{e['revision'][:8]}/{pin['file_name']}")
            if not ok:
                print(f"     pinned size={pin['size_bytes']} sha256={pin['sha256']}\n     hub    {got or f}")
                bad += 1
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
