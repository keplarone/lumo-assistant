"""Check the on-device speech model pinned in stt/mod.rs against Hugging Face: each file must exist at
the pinned revision with the same size and SHA-256. Small files aren't in Git LFS, so they are
downloaded, checked against Git's blob id from the Hub, and hashed. With a folder argument, downloads
every file into it (verified) for the smoke test."""

import hashlib
import json
import pathlib
import re
import sys
import urllib.request

SRC = pathlib.Path(__file__).resolve().parents[2] / "apps/desktop/src-tauri/src/stt/mod.rs"
HUB = "https://huggingface.co"


def pins():
    text = SRC.read_text(encoding="utf-8")
    repo = re.search(r'pub const REPO: &str = "([^"]+)"', text).group(1)
    rev = re.search(r'pub const REVISION: &str = "([0-9a-f]{40})"', text).group(1)
    files = [
        {"name": n, "size": int(s.replace("_", "")), "sha256": h}
        for n, s, h in re.findall(
            r'ModelFile \{\s*name: "([^"]+)",\s*size_bytes: ([0-9_]+),\s*sha256: "([0-9a-f]{64})",?\s*\}', text, re.S
        )
    ]
    if not files:
        sys.exit(f"no speech model files found in {SRC}")
    return repo, rev, files


def fetch(url: str) -> bytes:
    with urllib.request.urlopen(url, timeout=600) as r:
        return r.read()


def main() -> None:
    repo, rev, files = pins()
    if len(sys.argv) > 1:
        out = pathlib.Path(sys.argv[1])
        out.mkdir(parents=True, exist_ok=True)
        for f in files:
            body = fetch(f"{HUB}/{repo}/resolve/{rev}/{f['name']}")
            if len(body) != f["size"] or hashlib.sha256(body).hexdigest() != f["sha256"]:
                sys.exit(f"{f['name']} does not match its pin")
            (out / f["name"]).write_bytes(body)
            print(f"downloaded {f['name']}")
        return
    tree = {t["path"]: t for t in json.loads(fetch(f"{HUB}/api/models/{repo}/tree/{rev}"))}
    bad = 0
    for f in files:
        t = tree.get(f["name"])
        if t is None:
            ok, detail = False, "missing on the Hub"
        elif t.get("lfs"):
            got = t["lfs"]
            ok = got.get("oid") == f["sha256"] and got.get("size") == f["size"]
            detail = f"hub size={got.get('size')} sha256={got.get('oid')}"
        else:
            body = fetch(f"{HUB}/{repo}/resolve/{rev}/{f['name']}")
            blob = hashlib.sha1(b"blob %d\0" % len(body) + body).hexdigest()
            sha = hashlib.sha256(body).hexdigest()
            ok = blob == t.get("oid") and len(body) == f["size"] and sha == f["sha256"]
            detail = f"hub size={len(body)} sha256={sha} (git blob {'matches' if blob == t.get('oid') else 'DIFFERS'})"
        print(f"{'ok  ' if ok else 'FAIL'} {repo}@{rev[:8]}/{f['name']}")
        if not ok:
            print(f"     pinned size={f['size']} sha256={f['sha256']}\n     {detail}")
            bad += 1
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
