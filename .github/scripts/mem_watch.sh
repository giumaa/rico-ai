#!/usr/bin/env bash
# Background memory logger + OOM guard for the teacher server.
# Logs "<time> avail=<MB> swapfree=<MB> rss_server=<MB>" every 20 s to $RUNNER_TEMP/mem.log and SIGKILLs llama-server
# when available memory stays below MIN_AVAIL_MB for 2 samples (a dying runner loses the whole job; a killed server
# is restarted by distill.py --restart-cmd and its unfinished requests are retried).
TMP="${RUNNER_TEMP:-/tmp}"
LOG="$TMP/mem.log"
PIDF="$TMP/llama-server.pid"
MIN_AVAIL_MB="${MIN_AVAIL_MB:-400}"
low=0
while true; do
  avail=$(awk '/^MemAvailable/ {print int($2/1024)}' /proc/meminfo)
  swapfree=$(awk '/^SwapFree/ {print int($2/1024)}' /proc/meminfo)
  pid=""; rss=0
  if [ -f "$PIDF" ]; then pid=$(cat "$PIDF"); rss=$(awk '/^VmRSS/ {print int($2/1024)}' "/proc/$pid/status" 2>/dev/null || echo 0); fi
  echo "$(date +%T) avail=${avail}MB swapfree=${swapfree}MB rss_server=${rss:-0}MB" >> "$LOG"
  if [ "${avail:-99999}" -lt "$MIN_AVAIL_MB" ]; then low=$((low + 1)); else low=0; fi
  if [ "$low" -ge 2 ] && [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    echo "$(date +%T) GUARD: avail ${avail}MB < ${MIN_AVAIL_MB}MB -> SIGKILL llama-server $pid" | tee -a "$LOG"
    kill -9 "$pid" 2>/dev/null
    low=0
  fi
  sleep 20
done
