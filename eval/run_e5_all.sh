#!/bin/sh
# Runs the end-to-end study for each local model sequentially (resumable).
cd "$(dirname "$0")"
node e5_endtoend.js --backend ollama:llama3.1:8b --out results/e5_llama3.1-8b.jsonl --tasks 360 --resume 2> results/e5_llama3.1-8b.log
node e5_endtoend.js --backend ollama:llama3.2:3b --out results/e5_llama3.2-3b.jsonl --tasks 360 --resume 2> results/e5_llama3.2-3b.log
