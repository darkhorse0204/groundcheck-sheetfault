#!/bin/sh
# Held-out confirmation: fresh workbooks (seed base 700), final system (column letters in chunks), 8B model.
# The chunk-format fix was motivated by the main task set, so this set tests it on tasks it never saw.
cd "$(dirname "$0")"
ENGINE="${ENGINE_FILE:-baselines/SpreadsheetEngine.letters.js}"
until grep -q "all done" /tmp/e5_final.log 2>/dev/null; do sleep 30; done
node e5_endtoend.js --backend ollama:llama3.1:8b --out results/e5_llama3.1-8b_heldout.jsonl --tasks 180 --seed-base 700 --resume --engine-file "$ENGINE" 2> results/e5_llama3.1-8b_heldout.log
echo "heldout done"
