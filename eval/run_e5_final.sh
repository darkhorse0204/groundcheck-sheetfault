#!/bin/sh
# Second pass of the end-to-end study, then the critic baseline. Run after the first 8B pass finishes.
#   pass 1 (done earlier): llama3.1:8b, flat + retrieved context with the chunk format shipped at HEAD,
#                          repairs forked from the shipped-format retrieved attempt
#   pass 2 (this script) : final chunk format (column letters + data-row span)
#                          8B: retrieved arm only (flat is already in pass 1); 3B: flat + retrieved
cd "$(dirname "$0")"
ENGINE="${ENGINE_FILE:-baselines/SpreadsheetEngine.letters.js}"

until [ "$(wc -l < results/e5_llama3.1-8b.jsonl)" -ge 360 ]; do sleep 20; done
sleep 5

node e5_endtoend.js --backend ollama:llama3.1:8b --out results/e5_llama3.1-8b_letters.jsonl --tasks 360 --resume --skip-flat --engine-file "$ENGINE" 2> results/e5_llama3.1-8b_letters.log
node e5_endtoend.js --backend ollama:llama3.2:3b --out results/e5_llama3.2-3b_letters.jsonl --tasks 360 --resume --engine-file "$ENGINE" 2> results/e5_llama3.2-3b_letters.log
node e6_llm_critic.js --backend ollama:llama3.1:8b --per-class 15 --clean 300 --out results/e6_critic.jsonl 2> results/e6_critic.log
echo "all done"
