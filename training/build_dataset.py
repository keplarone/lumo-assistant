"""Merge the hand-written and reviewed chats into the training files, adding Lumo's real system prompt to
each one (with a random OS name, as the app does). Writes data/train.jsonl and data/eval.jsonl.

    python3 build_dataset.py
"""

import json
import pathlib
import random

from lumo_prompt import system_prompt

HERE = pathlib.Path(__file__).resolve().parent
SOURCES = ["seed.jsonl", "generated.jsonl", "extra.jsonl"]


def load(path: pathlib.Path) -> list:
    rows = []
    for n, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        row = json.loads(line)
        roles = [m["role"] for m in row["messages"]]
        if not roles or roles[0] != "user" or roles[-1] != "assistant" or "system" in roles:
            raise SystemExit(f"{path.name}:{n}: a chat must start with the user, end with Lumo, and have no system message")
        rows.append(row)
    return rows


def main() -> None:
    random.seed(7)
    prompts = {os_name: system_prompt(os_name) for os_name in ("macOS", "Windows", "Linux")}
    rows = []
    for name in SOURCES:
        p = HERE / "data" / name
        if p.exists():
            got = load(p)
            print(f"{name}: {len(got)} chats")
            rows += got
    random.shuffle(rows)
    for r in rows:
        r["messages"].insert(0, {"role": "system", "content": prompts[random.choice(list(prompts))]})
    n_eval = max(1, len(rows) // 20)
    for name, part in (("eval.jsonl", rows[:n_eval]), ("train.jsonl", rows[n_eval:])):
        with open(HERE / "data" / name, "w", encoding="utf-8") as f:
            f.writelines(json.dumps(r, ensure_ascii=False) + "\n" for r in part)
        print(f"wrote data/{name}: {len(part)} chats")


if __name__ == "__main__":
    main()
