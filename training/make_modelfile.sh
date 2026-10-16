#!/bin/sh
# Write an Ollama Modelfile for a trained Lumo GGUF, reusing the base model's chat template (which carries
# Qwen3's tool calling), recommended settings and Apache-2.0 license text.
#   ./make_modelfile.sh out/lumo-1-8b/unsloth.Q4_K_M.gguf qwen3:8b > Modelfile
set -eu
gguf="$1"
base="${2:-qwen3:8b}"
ollama pull "$base" >/dev/null
echo "FROM $gguf"
ollama show "$base" --modelfile | grep -v '^#' | grep -v '^FROM '
