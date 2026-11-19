#!/usr/bin/env bash
# Puts the judge's model on asus: llama.cpp's CPU build and Qwen3 4B Instruct 2507 (Q4_K_M, about 2.5 GB) in
# ~/.local/share/weft-when. Run on asus; running it again changes nothing that is already there.
set -euo pipefail
D=~/.local/share/weft-when
LLAMA=b12532
MODEL=Qwen3-4B-Instruct-2507-Q4_K_M.gguf
SUM=3605803b982cb64aead44f6c1b2ae36e3acdb41d8e46c8a94c6533bc4c67e597
mkdir -p "$D/models" "$D/llama"
if [ ! -x "$D/llama/llama-server" ]; then
  curl -fsSL "https://github.com/ggml-org/llama.cpp/releases/download/$LLAMA/llama-$LLAMA-bin-ubuntu-x64.tar.gz" | tar -xz -C "$D/llama" --strip-components=1
fi
if [ ! -f "$D/models/$MODEL" ]; then
  curl -fsSL -o "$D/models/$MODEL.part" "https://huggingface.co/unsloth/Qwen3-4B-Instruct-2507-GGUF/resolve/main/$MODEL"
  echo "$SUM  $D/models/$MODEL.part" | sha256sum -c --quiet
  mv "$D/models/$MODEL.part" "$D/models/$MODEL"
fi
echo "ok: $D"
