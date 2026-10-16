"""Draft more training chats: send each line of prompts.txt to a larger open model together with Lumo's
system prompt, and save its answers to data/generated.jsonl for review.

Use an open-weight model whose license allows training on its outputs (the default, gpt-oss 20B, and the
Qwen3 models are Apache-2.0). Do not use Claude, ChatGPT or Gemini outputs: their terms forbid using them
to train another model.

    python3 generate.py                                 # local Ollama, gpt-oss:20b, free
    python3 generate.py --model qwen3:30b --per-prompt 3
    python3 generate.py --base-url https://host/v1 --model some-model   # key in LUMO_GEN_API_KEY
"""

import argparse
import json
import os
import pathlib
import re
import urllib.request

from lumo_prompt import system_prompt

HERE = pathlib.Path(__file__).resolve().parent


def ask(base_url: str, model: str, messages: list, temperature: float) -> str:
    req = urllib.request.Request(
        base_url.rstrip("/") + "/chat/completions",
        data=json.dumps({"model": model, "messages": messages, "temperature": temperature}).encode(),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {os.environ.get('LUMO_GEN_API_KEY', 'none')}"},
    )
    with urllib.request.urlopen(req, timeout=600) as r:
        text = json.load(r)["choices"][0]["message"]["content"] or ""
    return re.sub(r"<think>.*?</think>", "", text, flags=re.S).strip()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base-url", default="http://localhost:11434/v1")
    ap.add_argument("--model", default="gpt-oss:20b")
    ap.add_argument("--per-prompt", type=int, default=2, help="answers per prompt (more variety)")
    ap.add_argument("--temperature", type=float, default=0.8)
    ap.add_argument("--out", default=str(HERE / "data/generated.jsonl"))
    args = ap.parse_args()

    prompts = [l.strip() for l in (HERE / "prompts.txt").read_text(encoding="utf-8").splitlines() if l.strip() and not l.startswith("#")]
    sys_msg = {"role": "system", "content": system_prompt()}
    with open(args.out, "a", encoding="utf-8") as out:
        for i, p in enumerate(prompts, 1):
            for _ in range(args.per_prompt):
                answer = ask(args.base_url, args.model, [sys_msg, {"role": "user", "content": p}], args.temperature)
                if answer:
                    out.write(json.dumps({"messages": [{"role": "user", "content": p}, {"role": "assistant", "content": answer}]}) + "\n")
            print(f"[{i}/{len(prompts)}] {p}")
    print(f"Saved to {args.out}. Read through it, fix or delete weak answers, then run build_dataset.py.")


if __name__ == "__main__":
    main()
