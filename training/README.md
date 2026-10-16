# Lumo 1: Lumo's own on-device model

Lumo 1 is Qwen3 (Apache-2.0) fine-tuned to be Lumo: the warm owl voice, the honesty rules (says it's an
AI, never claims an order was placed, never invents prices) and the safety habits (crisis lines, no
diagnosis or medication advice). It runs on people's own computers through Ollama like Orbit and Nebula,
so it costs nothing per use and conversations stay on the device.

It is a fine-tune, not a model built from scratch: it sounds and behaves like Lumo much more reliably than
the stock models, but it is not smarter than the base it starts from.

## What it costs

| Step                     | Where                                  | Cost                                 |
| ------------------------ | -------------------------------------- | ------------------------------------ |
| Write more example chats | `generate.py` on your computer, Ollama | free                                 |
| Train                    | Google Colab or Kaggle free T4 GPU     | free (or about $2–5 on a rented GPU) |
| Host the download        | ollama.com library (or Hugging Face)   | free                                 |
| Each use                 | the user's computer                    | free                                 |

## Steps

1. **Grow the examples.** `data/seed.jsonl` holds hand-written chats. To draft many more, install Ollama,
   run `ollama pull gpt-oss:20b`, then `python3 generate.py --per-prompt 3`. It answers every line of
   `prompts.txt` as Lumo and saves the drafts to `data/generated.jsonl`. Add lines to `prompts.txt` for
   anything Lumo should handle well. Aim for 1,000–3,000 chats in total.
   Only use open models whose license allows training on their outputs; Claude, ChatGPT and Gemini terms
   forbid it.
2. **Review the drafts.** Read `data/generated.jsonl`, fix or delete weak answers. Quality matters far
   more than quantity: every answer here is how Lumo will talk. Put your own extra chats in
   `data/extra.jsonl` (same format as `seed.jsonl`).
3. **Build the training files.** `python3 build_dataset.py` adds Lumo's real system prompt (read from
   `apps/desktop/src-tauri/src/agent/prompt.rs`) to every chat and writes `data/train.jsonl` and
   `data/eval.jsonl`.
4. **Train.** In a Colab or Kaggle notebook with a T4 GPU, upload `train_lumo.py` and the `data` folder,
   then run:
   ```sh
   pip install unsloth
   python3 train_lumo.py                                     # Lumo 1, 8B (from Qwen3 8B)
   python3 train_lumo.py --base unsloth/Qwen3-4B --name lumo-1-4b   # a smaller one for 8 GB laptops
   ```
   Download the `.gguf` file it leaves in `out/lumo-1-8b/` (about 5 GB).
5. **Package and test it.** On your computer, with Ollama running:
   ```sh
   ./make_modelfile.sh path/to/the.gguf qwen3:8b > Modelfile
   ollama create keplarone/lumo-1:8b -f Modelfile
   python3 eval.py keplarone/lumo-1:8b
   ```
   `eval.py` prints its answers to the held-out chats and safety prompts, and fails if the model stopped
   calling tools. Read the answers; if something is off, fix the examples and train again.
6. **Publish.** Make a free account at ollama.com, add your Ollama key (Settings → Ollama keys), then
   `ollama push keplarone/lumo-1:8b`. Anyone can now download it with that name.
7. **Add it to Lumo.** Add a `CatalogEntry` for `keplarone/lumo-1:8b` in
   `apps/desktop/src-tauri/src/local_models.rs` (base model "Qwen3 8B", license Apache-2.0), set which plans
   get it in `plans.rs`, and ship an update. Users then see it in the model list and download it with
   one click.

## License

Qwen3 is Apache-2.0, which allows fine-tuning, renaming and selling a product built on it. Keep the
license text (`make_modelfile.sh` copies it into the model) and keep showing "based on Qwen3" in Lumo's
model list, as the app already does for the other on-device models.
