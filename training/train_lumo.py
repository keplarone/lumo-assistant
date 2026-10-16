"""Fine-tune Lumo 1 from Qwen3 (Apache-2.0) with a small LoRA, then export a GGUF file Ollama can run.

Sizes (bigger is smarter, but needs a stronger computer to run):
    --size 4b    8 GB laptops        trains on a free Colab/Kaggle T4
    --size 8b    16 GB computers     trains on a free Colab/Kaggle T4   (default)
    --size 14b   24 GB computers     trains on a free T4 (slow) or a rented 24 GB GPU
    --size 30b   32 GB computers     Qwen3 30B-A3B: smartest and still fast; needs a rented 40-80 GB GPU (~$2-4)

    pip install unsloth
    python3 train_lumo.py --size 8b          # -> out/lumo-1-8b

A small LoRA (rank 16, two epochs) teaches Lumo's voice and safety habits without wearing away the base
model's tool use. Run eval.py on the result before publishing it.
"""

import argparse

from datasets import load_dataset
from trl import SFTConfig, SFTTrainer
from unsloth import FastLanguageModel
from unsloth.chat_templates import train_on_responses_only


BASES = {"4b": "unsloth/Qwen3-4B", "8b": "unsloth/Qwen3-8B", "14b": "unsloth/Qwen3-14B", "30b": "unsloth/Qwen3-30B-A3B"}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--size", choices=sorted(BASES), default="8b")
    ap.add_argument("--train", default="data/train.jsonl")
    ap.add_argument("--eval", default="data/eval.jsonl")
    ap.add_argument("--epochs", type=float, default=2)
    ap.add_argument("--max-len", type=int, default=4096)
    ap.add_argument("--quant", default="q4_k_m", help="GGUF quantization (q4_k_m matches the other on-device models)")
    args = ap.parse_args()
    args.base, args.name = BASES[args.size], f"lumo-1-{args.size}"

    model, tokenizer = FastLanguageModel.from_pretrained(args.base, max_seq_length=args.max_len, load_in_4bit=True)
    model = FastLanguageModel.get_peft_model(
        model,
        r=16,
        lora_alpha=16,
        lora_dropout=0,
        target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
        use_gradient_checkpointing="unsloth",
        random_state=7,
    )

    # Lumo uses Qwen3 in non-thinking mode, so train on the same template the app's requests produce.
    def render(batch):
        return {"text": [tokenizer.apply_chat_template(m, tokenize=False, enable_thinking=False) for m in batch["messages"]]}

    data = load_dataset("json", data_files={"train": args.train, "eval": args.eval}).map(render, batched=True)
    trainer = SFTTrainer(
        model=model,
        tokenizer=tokenizer,
        train_dataset=data["train"],
        eval_dataset=data["eval"],
        args=SFTConfig(
            dataset_text_field="text",
            max_seq_length=args.max_len,
            per_device_train_batch_size=2,
            gradient_accumulation_steps=4,
            num_train_epochs=args.epochs,
            learning_rate=2e-4,
            lr_scheduler_type="linear",
            warmup_steps=5,
            logging_steps=5,
            eval_strategy="epoch",
            optim="adamw_8bit",
            seed=7,
            output_dir=f"out/{args.name}-checkpoints",
            report_to="none",
        ),
    )
    # Learn only Lumo's replies, not the system prompt or the user's messages.
    trainer = train_on_responses_only(trainer, instruction_part="<|im_start|>user\n", response_part="<|im_start|>assistant\n")
    trainer.train()

    model.save_pretrained(f"out/{args.name}-lora")
    tokenizer.save_pretrained(f"out/{args.name}-lora")
    model.save_pretrained_gguf(f"out/{args.name}", tokenizer, quantization_method=args.quant)
    print(f"Done. The .gguf file is in out/{args.name}/; next, test it with eval.py (see README).")


if __name__ == "__main__":
    main()
