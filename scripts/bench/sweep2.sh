#!/usr/bin/env bash
# Strategy sweep against a PERSISTENT proxy (no restarts). Switches strategy by
# writing the control file /tmp/m365-framing, then runs the bench for one task.
# Interleaved by task with rotated strategy order to spread thread-rate order
# effects (docs F13) evenly across strategies. n=1 per (strategy,task) cell.
set -u
cd "$(dirname "$0")/../.." || exit 1

CTRL=/tmp/m365-framing
BASE=http://localhost:4141/v1
SUMMARY=/tmp/m365-sweep2-summary.txt
# Spacing between threads. Thread-rate is the throttle axis (docs F13), so space
# generously to keep each request landing on a rested account — otherwise late
# threads disengage from rate, confounding the framing signal.
COOLDOWN="${COOLDOWN:-45}"
BLOCK_COOLDOWN="${BLOCK_COOLDOWN:-60}"
: > "$SUMMARY"

STRATS=(baseline minimal recency fewshot proof_demand persona react negative terse reply_tool)
TASKS=(fix-bug find-needle edit-config)

ti=0
for task in "${TASKS[@]}"; do
  n=${#STRATS[@]}
  echo "########## TASK: $task ##########"
  for k in $(seq 0 $((n-1))); do
    # rotate starting strategy per task so none is systematically first
    idx=$(( (k + ti) % n ))
    s=${STRATS[$idx]}
    printf '%s\n' "$s" > "$CTRL"
    sleep 1
    line=$(node scripts/bench/run.mjs --base-url "$BASE" --model m365-copilot \
            --label "s2-$task-$s" --tasks "$task" --max-turns 12 2>&1 \
          | grep -E "^\s+$task ")
    printf '%-12s %-12s | %s\n' "$task" "$s" "$line" | tee -a "$SUMMARY"
    sleep "$COOLDOWN"   # cooldown between threads
  done
  ti=$((ti+1))
  echo "--- task block done; cooldown ${BLOCK_COOLDOWN}s ---"
  sleep "$BLOCK_COOLDOWN"
done

echo "==================== SWEEP2 COMPLETE ===================="
cat "$SUMMARY"
