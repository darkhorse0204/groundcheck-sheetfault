#!/bin/sh
# Verify -> repair -> execute arm for the local models (see e5_exec.js). Waits for the seed runs to finish so the GPU is free.
cd "$(dirname "$0")"
until [ -f results/e5_seeds.status ]; do sleep 30; done
node e5_exec.js --backend ollama:llama3.1:8b --main results/e5_llama3.1-8b_letters.jsonl --out results/e5_exec_llama3.1-8b.jsonl --resume 2>> results/e5_exec_llama3.1-8b.log
node e5_exec.js --backend ollama:llama3.2:3b --main results/e5_llama3.2-3b_letters.jsonl --out results/e5_exec_llama3.2-3b.jsonl --resume 2>> results/e5_exec_llama3.2-3b.log
echo "exec arm finished" > results/e5_exec.status
