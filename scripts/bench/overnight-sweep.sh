#!/usr/bin/env bash
# Overnight framing A/B orchestrator — unattended, throttle-aware, resumable.
#
# Drives a PERSISTENT proxy (started separately with M365_FRAMING_FILE=$CTRL) and
# switches framing strategy per cell by writing the control file. Runs many ROUNDS
# of the full (task × strategy) grid, interleaved by task with a rotating strategy
# start index each round so no strategy is systematically first/last (controls the
# thread-rate order effect, docs F13 / §M caveat 4).
#
# Why this exists: the framing variants (fenced.ts) are "BUILT, awaiting live A/B
# on a rested account" (docs §8.12 H4 / §9). n=1 is noise; this accumulates n≈ROUNDS
# per cell across the night with thread spacing well under the throttle onset rate
# (F13: ~75 threads / 35 min ≈ 2.1/min triggered degradation; we run ~0.3/min).
#
# Output (incremental, append-only — survives a crash so no round is lost):
#   $CSV : round,iso_ts,task,strategy,outcome,tools,msgs,elapsed_s
#   plus per-cell JSON in scripts/bench/out/ov-<round>-<task>-<strategy>-<ts>.json
#
# Throttle backoff: a streak of ERROR outcomes (502/empty = thread-rate throttle or
# Disengage) triggers an escalating sleep instead of hammering a degraded account.
set -u
cd "$(dirname "$0")/../.." || exit 1

CTRL="${CTRL:-/tmp/m365-framing}"
BASE="${BASE:-http://localhost:4141/v1}"
CSV="${CSV:-/tmp/m365-overnight.csv}"
HEARTBEAT="${HEARTBEAT:-/tmp/m365-overnight.heartbeat}"
ROUNDS="${ROUNDS:-30}"            # upper bound; the night usually ends it first
CELL_COOLDOWN="${CELL_COOLDOWN:-120}"   # seconds between threads (keeps rate ~0.3/min)
MAX_TURNS="${MAX_TURNS:-12}"
BACKOFF_BASE="${BACKOFF_BASE:-1800}"    # 30 min first long backoff on throttle streak
ERR_STREAK_TRIP="${ERR_STREAK_TRIP:-3}" # consecutive ERRORs before a long backoff

IFS=' ' read -r -a STRATS <<< "${STRATS:-baseline softened demo_only session_facts minimal recency fewshot proof_demand persona react negative terse reply_tool}"
IFS=' ' read -r -a TASKS  <<< "${TASKS:-fix-bug find-needle edit-config}"

# CSV header only if new file
[ -f "$CSV" ] || echo "round,iso_ts,task,strategy,outcome,tools,msgs,elapsed_s" > "$CSV"

proxy_up() { curl -s -m 4 "${BASE%/v1}/health" >/dev/null 2>&1; }

err_streak=0
backoff_mult=1

echo "[overnight] start: rounds=$ROUNDS strats=${#STRATS[@]} tasks=${#TASKS[@]} cooldown=${CELL_COOLDOWN}s base=$BASE"
echo "[overnight] grid = $(( ${#STRATS[@]} * ${#TASKS[@]} )) cells/round; CSV=$CSV"

for round in $(seq 1 "$ROUNDS"); do
  echo "########## ROUND $round / $ROUNDS ($(date -Iseconds)) ##########"
  nt=${#TASKS[@]}
  # rotate TASK order per round too, so each task visits early/mid/late positions
  # across rounds. Without this, task-content and position-in-round are perfectly
  # confounded (a late task that Disengages could be content OR cumulative-window
  # effect). With rotation, that's separable in analysis. (wake-4 fix)
  for tj in $(seq 0 $((nt-1))); do
    tidx=$(( (tj + round) % nt ))
    task=${TASKS[$tidx]}
    n=${#STRATS[@]}
    for k in $(seq 0 $((n-1))); do
      # rotate strategy start by (round + task position) so order varies every round
      idx=$(( (k + tj + round) % n ))
      s=${STRATS[$idx]}

      # wait for the proxy if it's down (it lives outside this script; if it stays
      # down we just back off — the operator's wakeup check will restart it)
      if ! proxy_up; then
        echo "[overnight] proxy DOWN — waiting 300s (round $round, $task/$s)"
        echo "$round,$(date -Iseconds),$task,$s,PROXY_DOWN,0,0,0" >> "$CSV"
        sleep 300
        continue
      fi

      printf '%s\n' "$s" > "$CTRL"   # switch framing for this cell
      sleep 1

      ts=$(date +%Y%m%dT%H%M%S)
      label="ov-${round}-${task}-${s}"
      out=$(node scripts/bench/run.mjs --base-url "$BASE" --model m365-copilot \
              --label "$label" --tasks "$task" --max-turns "$MAX_TURNS" 2>&1)
      line=$(echo "$out" | grep -E "^[[:space:]]+$task[[:space:]]")
      outcome=$(echo "$line" | awk '{print $2}'); outcome="${outcome:-NOLINE}"
      tools=$(echo "$line" | grep -oP 'tools=\K[0-9]+' | head -1); tools="${tools:-0}"
      msgs=$(echo "$line"  | grep -oP 'msgs=\K[0-9]+'  | head -1); msgs="${msgs:-0}"
      elapsed=$(echo "$line" | grep -oP '\b\K[0-9]+(?=s\b)' | head -1); elapsed="${elapsed:-0}"

      # Classify an ERROR by reading the just-written per-cell JSON. Disengaged is a
      # per-request CONTENT refusal (fail-fast, account is fine) — it must NOT trigger
      # the throttle backoff, or aggressive framings (which reliably Disengage) waste
      # the night. Only empty-response/rate-limit (F13 thread-rate throttle) backs off.
      if [ "$outcome" = "ERROR" ]; then
        jf=$(ls -t scripts/bench/out/${label}-*.json 2>/dev/null | head -1)
        if [ -n "$jf" ] && grep -qi 'disengaged' "$jf"; then
          outcome="DISENGAGED"
        elif [ -n "$jf" ] && grep -qiE 'empty response|rate limit|429|throttle' "$jf"; then
          outcome="THROTTLE"
        fi
      fi

      echo "$round,$(date -Iseconds),$task,$s,$outcome,$tools,$msgs,$elapsed" >> "$CSV"
      printf '  [r%s] %-12s %-12s -> %-14s tools=%s msgs=%s %ss\n' "$round" "$task" "$s" "$outcome" "$tools" "$msgs" "$elapsed"
      date -Iseconds > "$HEARTBEAT"

      # throttle accounting — ONLY real throttle/unknown-errors count toward the
      # backoff streak. DISENGAGED is content-filter (not degradation); SOLVED /
      # GAVE_UP_PROSE / MAX_TURNS are normal task outcomes. All reset the streak.
      case "$outcome" in
        THROTTLE|ERROR|NOLINE|PROXY_DOWN) err_streak=$((err_streak+1));;
        *) err_streak=0; backoff_mult=1;;
      esac

      if [ "$err_streak" -ge "$ERR_STREAK_TRIP" ]; then
        backoff=$(( BACKOFF_BASE * backoff_mult ))
        echo "[overnight] ERROR streak=$err_streak — long backoff ${backoff}s (likely thread-rate throttle, docs F13)"
        sleep "$backoff"
        err_streak=0
        backoff_mult=$(( backoff_mult * 2 )); [ "$backoff_mult" -gt 4 ] && backoff_mult=4
      else
        sleep "$CELL_COOLDOWN"
      fi
    done
  done
  echo "[overnight] round $round complete; tallies so far:"
  tail -n +2 "$CSV" | awk -F, '{c[$5]++} END{for(o in c) printf "    %s=%s\n", o, c[o]}'
done
echo "==================== OVERNIGHT SWEEP COMPLETE ===================="
