#!/usr/bin/env bash
# Start (or verify) the llama.cpp teacher server used by ml/distill.py generate.
# env: LLAMA_BIN (dir with llama-server), TEACHER_GGUF, PARALLEL (default 6), CTX_PER_SLOT (default 3072), PORT (8080)
set -euo pipefail
: "${LLAMA_BIN:?LLAMA_BIN not set}"
: "${TEACHER_GGUF:?TEACHER_GGUF not set}"
PARALLEL="${PARALLEL:-6}"
CTX_PER_SLOT="${CTX_PER_SLOT:-3072}"
PORT="${PORT:-8080}"

if curl -sf "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
  echo "teacher server already healthy"; exit 0
fi
pkill -f llama-server 2>/dev/null || true
export LD_LIBRARY_PATH="${LLAMA_BIN}:${LD_LIBRARY_PATH:-}"
nohup "${LLAMA_BIN}/llama-server" -m "${TEACHER_GGUF}" \
  -c $((PARALLEL * CTX_PER_SLOT)) -np "${PARALLEL}" -t 4 -tb 4 \
  --host 127.0.0.1 --port "${PORT}" --no-webui --jinja \
  --chat-template-kwargs '{"enable_thinking": false}' \
  > "${RUNNER_TEMP:-/tmp}/llama-server.log" 2>&1 &
echo "llama-server pid $! ; waiting for /health ..."
for i in $(seq 1 300); do
  if curl -sf "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then echo "healthy after ~$((i*3))s"; exit 0; fi
  if ! pgrep -f llama-server >/dev/null; then echo "llama-server died:"; tail -n 60 "${RUNNER_TEMP:-/tmp}/llama-server.log"; exit 1; fi
  sleep 3
done
echo "timeout waiting for llama-server"; tail -n 60 "${RUNNER_TEMP:-/tmp}/llama-server.log"; exit 1
