#!/usr/bin/env bash
# Iterate every entry in src/local-models.json, swap llama-server to it,
# run the woid-skills test, and collect results into results-woid-skills.tsv.
#
# Usage:
#   ./scripts/sweep-local-woid-skills.sh            # all models
#   ./scripts/sweep-local-woid-skills.sh <id> <id>  # subset

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CATALOG="$HERE/src/local-models.json"
OUT="$HERE/results-woid-skills.tsv"

if [ $# -eq 0 ]; then
  IDS=$(jq -r '.[].id' "$CATALOG")
else
  IDS="$*"
fi

# Seed the header only if the file doesn't already exist — keep prior rows
# so reruns on subsets (single model) don't wipe out the full-sweep results.
if [ ! -f "$OUT" ]; then
  echo -e "model\tresult\tprogress\tduration_s\ttotal_s\tbridge_calls\ttimestamp" > "$OUT"
fi

for ID in $IDS; do
  echo ""
  echo "====================================================="
  echo "  [$ID] swapping llama-server..."
  echo "====================================================="

  START=$(date +%s)

  # Cap context + batch for large models; KV cache grows linearly, and the
  # task only needs ~2K tokens of real context.
  "$HERE/scripts/swap-local-model.sh" "$ID" --extra="--ctx-size 16384" || {
    echo "  [$ID] swap FAILED" | tee -a "$OUT"
    echo -e "$ID\terror\t-\t-\t$(($(date +%s) - START))\t0\t$(date -Iseconds)" >> "$OUT"
    continue
  }

  # Wait for llama-server health.
  echo "  [$ID] waiting for /health..."
  WAIT_START=$(date +%s)
  while ! curl -sf http://localhost:18080/health >/dev/null 2>&1; do
    sleep 5
    if [ $(($(date +%s) - WAIT_START)) -gt 600 ]; then
      echo "  [$ID] server failed to start within 10min"
      echo -e "$ID\tload-timeout\t-\t-\t$(($(date +%s) - START))\t0\t$(date -Iseconds)" >> "$OUT"
      continue 2
    fi
  done
  echo "  [$ID] server up after $(($(date +%s) - WAIT_START))s"

  # Run the test.
  RUN_OUT=$(mktemp)
  LOCAL_LLM_BASE_URL=http://localhost:18080/v1 \
    LOCAL_LLM_MODEL="$ID" \
    PI_DASHBOARD_PORT=3459 \
    "$HERE/node_modules/.bin/tsx" "$HERE/src/run.ts" --provider=local --test=woid-skills --all \
    > "$RUN_OUT" 2>&1 || true

  # Parse summary lines.
  RESULT=$(grep -oP '(?<=model_result: )\w+' "$RUN_OUT" | head -1)
  PROGRESS=$(grep -oP '(?<=progress=)\w+' "$RUN_OUT" | head -1)
  DURATION=$(grep -oP '(?<=duration=)\w+' "$RUN_OUT" | head -1)
  BRIDGE=$(grep -oP '(?<=woid_bridge_records: )\d+' "$RUN_OUT" | head -1)
  TOTAL=$(($(date +%s) - START))

  RESULT=${RESULT:-unknown}
  PROGRESS=${PROGRESS:-none}
  DURATION=${DURATION:-?}
  BRIDGE=${BRIDGE:-0}

  echo "  [$ID] result=$RESULT progress=$PROGRESS run=$DURATION total=${TOTAL}s bridge=$BRIDGE"
  echo -e "$ID\t$RESULT\t$PROGRESS\t$DURATION\t${TOTAL}\t$BRIDGE\t$(date -Iseconds)" >> "$OUT"

  # Stash full log per model for later inspection.
  mkdir -p "$HERE/logs/woid-skills"
  cp "$RUN_OUT" "$HERE/logs/woid-skills/$ID.log"
  rm "$RUN_OUT"
done

echo ""
echo "Results -> $OUT"
column -t -s $'\t' "$OUT"
