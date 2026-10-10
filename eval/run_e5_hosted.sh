#!/bin/sh
# Hosted-model arm of the end-to-end study, with the model version the API reports stored per task.
# Needs GEMINI_API_KEY in the environment. Each run stops with exit code 3 when the free tier's daily quota
# for that model is used up; rerun this script after the quota resets and every run resumes where it stopped.
cd "$(dirname "$0")"
for m in gemini-3.1-flash-lite gemini-3.5-flash-lite gemma-4-26b-a4b-it; do
  node e5_endtoend.js --backend "gemini:$m" --out "results/e5_$m.jsonl" --tasks 360 --resume 2>> "results/e5_$m.log"
  echo "$m exit $?" >> results/e5_hosted.status
done
echo "hosted pass finished" >> results/e5_hosted.status
