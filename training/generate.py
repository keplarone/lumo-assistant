"""Draft training chats: a strong open "teacher" model answers as Lumo (with Lumo's real system prompt),
while a second model plays a real person, so the chats run several turns and read like real
conversations. Saves to data/generated.jsonl for review.

The teacher decides how smart and natural Lumo 1 becomes, so use the strongest open model you can:
gpt-oss 120B or Qwen3 235B through any OpenAI-compatible host (a few dollars for thousands of chats),
or gpt-oss 20B on your own computer for free. Only use models whose license allows training on their
outputs (gpt-oss and Qwen3 are Apache-2.0). Claude, ChatGPT and Gemini terms forbid it.

    python3 generate.py                                         # local Ollama, gpt-oss:20b, free
    python3 generate.py --base-url https://host/v1 --model openai/gpt-oss-120b --turns 4
                                                                # key in LUMO_GEN_API_KEY
"""

import argparse
import json
import os
import pathlib
import random
import re
import urllib.request

from lumo_prompt import system_prompt

HERE = pathlib.Path(__file__).resolve().parent

PERSON = """You are role-playing a real person texting with Lumo, an AI assistant app on their computer. Your \
first message was: "{opening}". Continue as that same person: write only their next message, the way \
people really text (casual, sometimes short, sometimes with typos or no capitals, reacting to what Lumo \
just said, adding a detail, pushing back, or changing the subject a little). Never write as Lumo and \
never say you are role-playing. If the conversation has naturally ended, reply with exactly: END"""


def ask(base_url: str, model: str, messages: list, temperature: float) -> str:
    req = urllib.request.Request(
        base_url.rstrip("/") + "/chat/completions",
        data=json.dumps({"model": model, "messages": messages, "temperature": temperature}).encode(),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {os.environ.get('LUMO_GEN_API_KEY', 'none')}"},
    )
    with urllib.request.urlopen(req, timeout=600) as r:
        text = json.load(r)["choices"][0]["message"]["content"] or ""
    return re.sub(r"<think>.*?</think>", "", text, flags=re.S).strip()


def conversation(args, opening: str) -> list:
    chat = [{"role": "user", "content": opening}]
    lumo_sys = {"role": "system", "content": system_prompt(random.choice(["macOS", "Windows", "Linux"]))}
    person_sys = {"role": "system", "content": PERSON.format(opening=opening)}
    turns = random.randint(1, args.turns)
    for t in range(turns):
        answer = ask(args.base_url, args.model, [lumo_sys, *chat], args.temperature)
        if not answer:
            break
        chat.append({"role": "assistant", "content": answer})
        if t == turns - 1:
            break
        # The person model sees the chat from its own side: Lumo's lines are the "user" it replies to.
        flipped = [{"role": "assistant" if m["role"] == "user" else "user", "content": m["content"]} for m in chat]
        reply = ask(args.base_url, args.person_model or args.model, [person_sys, *flipped], 1.0)
        if not reply or reply.strip() == "END":
            break
        chat.append({"role": "user", "content": reply})
    return chat if chat[-1]["role"] == "assistant" else chat[:-1]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base-url", default="http://localhost:11434/v1")
    ap.add_argument("--model", default="gpt-oss:20b", help="the teacher that answers as Lumo")
    ap.add_argument("--person-model", help="model that plays the person (default: same as --model)")
    ap.add_argument("--per-prompt", type=int, default=2, help="chats per opening line (more variety)")
    ap.add_argument("--turns", type=int, default=3, help="up to this many Lumo replies per chat")
    ap.add_argument("--temperature", type=float, default=0.8)
    ap.add_argument("--out", default=str(HERE / "data/generated.jsonl"))
    args = ap.parse_args()

    prompts = [l.strip() for l in (HERE / "prompts.txt").read_text(encoding="utf-8").splitlines() if l.strip() and not l.startswith("#")]
    with open(args.out, "a", encoding="utf-8") as out:
        for i, p in enumerate(prompts, 1):
            for _ in range(args.per_prompt):
                chat = conversation(args, p)
                if len(chat) >= 2:
                    out.write(json.dumps({"messages": chat}, ensure_ascii=False) + "\n")
                    out.flush()
            print(f"[{i}/{len(prompts)}] {p}")
    print(f"Saved to {args.out}. Read through it, fix or delete weak answers, then run build_dataset.py.")


if __name__ == "__main__":
    main()
