# Lumo 1: Lumo's own on-device model

Lumo 1 is Qwen3 (Apache-2.0) fine-tuned to be Lumo: the warm, natural owl voice, the honesty rules (says
it's an AI, never claims an order was placed, never invents prices) and the safety habits (crisis lines,
no diagnosis or medication advice). It runs on people's own computers inside Lumo's built-in engine
(llama.cpp), so it costs nothing per use and conversations stay on the device.

## Smarter and more human

Three things decide how good Lumo 1 is, in this order:

1. **The base size.** A fine-tune teaches voice and habits; raw intelligence comes from the base model.
   Train more than one size and Lumo offers the biggest one each computer can run:
   `4b` (8 GB laptops), `8b` (16 GB), `14b` (24 GB) and `30b` (Qwen3 30B-A3B, 32 GB: the smartest, and
   still fast because only 3B of its parameters work on each word).
2. **The teacher.** `generate.py` has a strong open model write Lumo's side of every training chat, so
   Lumo 1 learns from answers better than it would give by itself. Use the strongest teacher you can:
   gpt-oss 120B or Qwen3 235B through any OpenAI-compatible host costs a few dollars for thousands of
   chats; gpt-oss 20B on your own computer is free but weaker.
3. **Real conversations.** A second model plays a real person texting casually, so chats run several
   turns: Lumo learns to follow up, remember what was said, ask one question at a time, and match the
   mood. Reviewing them by hand (step 2) is what makes it sound like a person rather than a template.

It stays honest that it is an AI. That is part of Lumo's safety rules and makes it more trustworthy,
not less human.

## What it costs

| Step               | Where                                        | Cost                           |
| ------------------ | -------------------------------------------- | ------------------------------ |
| Write the chats    | `generate.py` with a hosted teacher          | a few dollars (or free, local) |
| Train 4B, 8B, 14B  | Google Colab or Kaggle free T4 GPU           | free                           |
| Train 30B          | a rented 40–80 GB GPU (RunPod, Lambda, etc.) | about $2–4                     |
| Host the downloads | Hugging Face                                 | free                           |
| Each use           | the user's computer                          | free                           |

## Steps

1. **Write the chats.** `data/seed.jsonl` holds hand-written chats. To draft many more:
   ```sh
   # strong hosted teacher (recommended); put the host's key in LUMO_GEN_API_KEY
   python3 generate.py --base-url https://host/v1 --model openai/gpt-oss-120b --per-prompt 4 --turns 4
   # or free on your own computer with Ollama: ollama pull gpt-oss:20b
   python3 generate.py
   ```
   It starts a chat from every line of `prompts.txt` and saves them to `data/generated.jsonl`. Add lines
   to `prompts.txt` for anything Lumo should handle well. Aim for 2,000–5,000 chats.
   Only use open models whose license allows training on their outputs (gpt-oss and Qwen3 are
   Apache-2.0). Claude, ChatGPT and Gemini terms forbid it.
2. **Review the chats.** Read `data/generated.jsonl` and fix or delete anything that sounds robotic,
   preachy, wrong or too long. Every answer here is how Lumo will talk. Put your own chats in
   `data/extra.jsonl` (same format as `seed.jsonl`).
3. **Build the training files.** `python3 build_dataset.py` adds Lumo's real system prompt (read from
   `apps/desktop/src-tauri/src/agent/prompt.rs`) to every chat and writes `data/train.jsonl` and
   `data/eval.jsonl`.
4. **Train.** In a Colab or Kaggle notebook with a GPU, upload `train_lumo.py` and the `data` folder:
   ```sh
   pip install unsloth
   python3 train_lumo.py --size 8b      # also 4b, 14b, 30b
   ```
   It leaves a `.gguf` file in `out/lumo-1-8b/`.
5. **Test it.** Serve it with llama.cpp (the engine inside Lumo) and run the checks:
   ```sh
   llama-server -m out/lumo-1-8b/<file>.gguf --jinja --port 8080
   python3 eval.py
   ```
   `eval.py` prints its answers to the held-out chats plus safety, reasoning and small-talk prompts, and
   fails if the model stopped calling tools. If something is off, fix the chats and train again.
6. **Publish.** Make a free Hugging Face account and upload the file:
   ```sh
   huggingface-cli upload keplarone/lumo-1-8b-GGUF out/lumo-1-8b/<file>.gguf lumo-1-8b-Q4_K_M.gguf
   ```
7. **Add it to Lumo.** Add a catalog entry in `apps/desktop/src-tauri/src/local_models.rs` with the file's
   download URL, SHA-256 and size (base model "Qwen3 8B", license Apache-2.0), set which plans get it in
   `plans.rs`, and ship an update. Users then download it in Lumo with one click.

## License

Qwen3 is Apache-2.0, which allows fine-tuning, renaming and selling a product built on it. Include the
Apache-2.0 license text with the uploaded model and keep showing "based on Qwen3" in Lumo's model list,
as the app already does for the other on-device models.
