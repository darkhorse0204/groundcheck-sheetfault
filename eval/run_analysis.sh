#!/bin/sh
# Recompute every derived result and regenerate the paper's tables, numbers and figures, in dependency order.
# Optional inputs (a hosted model, extra seeds, the second confirmation set, Google Sheets / annotation results)
# are used when their files exist.
cd "$(dirname "$0")"
R=results

# ---- end-to-end study: one spec per model (final system), main task set first
SPECS="llama3.1-8b=$R/e5_llama3.1-8b_letters.jsonl+$R/e5_llama3.1-8b.jsonl llama3.2-3b=$R/e5_llama3.2-3b_letters.jsonl llama3.1-8b-heldout=$R/e5_llama3.1-8b_heldout.jsonl"
FINAL="llama3.1-8b=$R/e5_llama3.1-8b_letters.jsonl llama3.2-3b=$R/e5_llama3.2-3b_letters.jsonl llama3.1-8b-heldout=$R/e5_llama3.1-8b_heldout.jsonl"
for m in gemini-3.1-flash-lite gemini-3.5-flash-lite gemma-4-26b-a4b-it; do
  if [ -s "$R/e5_$m.jsonl" ]; then SPECS="$SPECS $m=$R/e5_$m.jsonl"; FINAL="$FINAL $m=$R/e5_$m.jsonl"; fi
done
node analyze_e5.js $SPECS || exit 1
node analyze_robust.js $FINAL || exit 1

# ---- run-to-run variation of the local models
if [ -s "$R/e5_llama3.1-8b_s2.jsonl" ] && [ -s "$R/e5_llama3.2-3b_s2.jsonl" ]; then
  node analyze_seeds.js \
    "llama3.1-8b=$R/e5_llama3.1-8b_letters.jsonl+$R/e5_llama3.1-8b.jsonl,$R/e5_llama3.1-8b_s1.jsonl,$R/e5_llama3.1-8b_s2.jsonl" \
    "llama3.2-3b=$R/e5_llama3.2-3b_letters.jsonl,$R/e5_llama3.2-3b_s1.jsonl,$R/e5_llama3.2-3b_s2.jsonl" || exit 1
fi

# verify -> repair -> execute arm, when its runs exist
if [ -s "$R/e5_exec_llama3.1-8b.jsonl" ]; then
  node analyze_exec.js "llama3.1-8b=$R/e5_llama3.1-8b_letters.jsonl,$R/e5_exec_llama3.1-8b.jsonl" "llama3.2-3b=$R/e5_llama3.2-3b_letters.jsonl,$R/e5_exec_llama3.2-3b.jsonl" || exit 1
fi

node analyze_extra.js || exit 1
node make_paper_assets.js || exit 1
python make_figures.py || exit 1
