#!/bin/sh
# Two further sampling seeds (--traj-seed 1 and 2) for the local models on the main task set, final system
# (retrieved context with column letters, and the active-sheet arm), to measure run-to-run variation.
cd "$(dirname "$0")"
for s in 1 2; do
  node e5_endtoend.js --backend ollama:llama3.1:8b --out "results/e5_llama3.1-8b_s$s.jsonl" --tasks 360 --resume --traj-seed $s 2>> "results/e5_llama3.1-8b_s$s.log"
  node e5_endtoend.js --backend ollama:llama3.2:3b --out "results/e5_llama3.2-3b_s$s.jsonl" --tasks 360 --resume --traj-seed $s 2>> "results/e5_llama3.2-3b_s$s.log"
done
echo "seeds finished" >> results/e5_seeds.status
