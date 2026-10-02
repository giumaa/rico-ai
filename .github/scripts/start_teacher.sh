#!/usr/bin/env bash
# Start (or verify) the llama.cpp teacher server used by ml/distill.py generate. Safe to call repeatedly.
# env: LLAMA_BIN, TEACHER_GGUF, PARALLEL (2), CTX_PER_SLOT (3072), PORT (8080), CACHE_RAM_MIB (512), WAIT_SECS (900)
set -uo pipefail
: "${LLAMA_BIN:?LLAMA_BIN not set}"
: "${TEACHER_GGUF:?TEACHER_GGUF not set}"
PARALLEL="${PARALLEL:-2}"
CTX_PER_SLOT="${CTX_PER_SLOT:-3072}"
PORT="${PORT:-8080}"
CACHE_RAM_MIB="${CACHE_RAM_MIB:-512}"
WAIT_SECS="${WAIT_SECS:-900}"
TMP="${RUNNER_TEMP:-/tmp}"
LOG="$TMP/llama-server.log"
PIDF="$TMP/llama-server.pid"
MEMPID="$TMP/mem_watch.pid"

healthy() { curl -sf -m 5 "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; }

# memory logger + guard (kills llama-server before the whole runner dies of OOM; distill.py restarts it)
if [ ! -f "$MEMPID" ] || ! kill -0 "$(cat "$MEMPID")" 2>/dev/null; then
  nohup setsid bash "$(dirname "$0")/mem_watch.sh" >/dev/null 2>&1 &
  echo $! > "$MEMPID"
fi

if healthy; then echo "teacher server already healthy"; exit 0; fi
if [ -f "$PIDF" ]; then kill -9 "$(cat "$PIDF")" 2>/dev/null || true; sleep 3; fi

echo "--- memory before start:"; free -m | sed -n 1,3p
export LD_LIBRARY_PATH="${LLAMA_BIN}:${LD_LIBRARY_PATH:-}"
# -np/-c: total context = slots x per-slot; q8 KV + flash-attn + load-mode none (b11312 has no --no-mmap) = predictable memory (no page-cache thrash);
# --cache-ram / -ctxcp: llama-server's defaults (8 GiB host prompt cache, 32 SWA checkpoints/slot) can eat all RAM.
nohup setsid "${LLAMA_BIN}/llama-server" -m "${TEACHER_GGUF}" \
  -c $((PARALLEL * CTX_PER_SLOT)) -np "${PARALLEL}" -t 4 -tb 4 \
  -fa on --cache-type-k q8_0 --cache-type-v q8_0 --load-mode none \
  --cache-ram "${CACHE_RAM_MIB}" -ctxcp 2 --metrics \
  --host 127.0.0.1 --port "${PORT}" --no-webui --jinja \
  --chat-template-kwargs '{"enable_thinking": false}' \
  > "$LOG" 2>&1 &
pid=$!
echo "$pid" > "$PIDF"
echo "llama-server pid $pid ; waiting for /health (max ${WAIT_SECS}s) ..."
for i in $(seq 1 $((WAIT_SECS / 3))); do
  if healthy; then echo "healthy after ~$((i * 3))s"; free -m | sed -n 2p; exit 0; fi
  if ! kill -0 "$pid" 2>/dev/null; then echo "llama-server DIED:"; tail -n 80 "$LOG"; exit 1; fi
  sleep 3
done
echo "timeout waiting for llama-server"; tail -n 80 "$LOG"; exit 1
