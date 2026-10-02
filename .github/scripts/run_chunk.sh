#!/usr/bin/env bash
# One time-boxed chunk of ml/distill.py generate (prompts + article-grounded Q&A) against the local teacher server.
# env: SHARD NUM_SHARDS SAMPLES QA_SAMPLES MAX_TOKENS TEMPERATURE PARALLEL CHUNK_MINUTES TEACHER_NAME (+ start_teacher.sh vars)
set -uo pipefail
bash .github/scripts/start_teacher.sh || exit 1
articles=""
if [ -s ml/data/recent/articles.jsonl ]; then articles="ml/data/recent/articles.jsonl"; fi
python3 ml/distill.py generate \
  --shard "$SHARD" --num-shards "$NUM_SHARDS" --samples "$SAMPLES" \
  --max-tokens "$MAX_TOKENS" --temperature "$TEMPERATURE" --parallel "$PARALLEL" \
  --budget-minutes "$CHUNK_MINUTES" --grace-minutes 10 --teacher-name "$TEACHER_NAME" \
  --articles "$articles" --qa-samples "${QA_SAMPLES:-2}" \
  --server-log "${RUNNER_TEMP:-/tmp}/llama-server.log" --restart-cmd "bash .github/scripts/start_teacher.sh" \
  --out "work/shard-${SHARD}.jsonl"
rc=$?
echo "--- memory log (last 6):"; tail -n 6 "${RUNNER_TEMP:-/tmp}/mem.log" 2>/dev/null || true
exit $rc
