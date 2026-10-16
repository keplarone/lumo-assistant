"""Lumo's system prompt, read straight from the app (apps/desktop/src-tauri/src/agent/prompt.rs) so the
model is trained on exactly the prompt it will see in Lumo."""

import pathlib
import re

PROMPT_RS = pathlib.Path(__file__).resolve().parent.parent / "apps/desktop/src-tauri/src/agent/prompt.rs"


def system_prompt(os_name: str = "macOS") -> str:
    src = PROMPT_RS.read_text(encoding="utf-8")
    m = re.search(r'format!\(\s*r#"(.*?)"#', src, re.S)
    if not m:
        raise SystemExit(f"Could not find the system prompt in {PROMPT_RS}")
    return m.group(1).replace("{os}", os_name)
