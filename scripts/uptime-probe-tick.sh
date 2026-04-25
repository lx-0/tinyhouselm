#!/usr/bin/env bash
# TinyHouse uptime probe (TINA-31).
#
# Runs once per Paperclip routine fire. Probes the public /ready endpoint
# three times, updates persistent state, and creates or closes a CTO-assigned
# incident issue based on the rolling failure pattern.
#
# Designed to run end-to-end inside a single agent heartbeat so per-fire LLM
# cost stays low: the agent just invokes this script and exits. The script
# itself owns probe + decision + Paperclip API writes.
#
# Required env (auto-injected by Paperclip in heartbeats):
#   PAPERCLIP_API_KEY      short-lived run JWT
#   PAPERCLIP_API_URL      Paperclip control plane URL
#   PAPERCLIP_COMPANY_ID   company id
#   PAPERCLIP_AGENT_ID     CTO agent id (incident assignee)
#   PAPERCLIP_RUN_ID       run audit trail id
#   PAPERCLIP_TASK_ID      the routine run issue id (this script will mark it done)
#
# Optional env:
#   UPTIME_PROBE_URL       default: https://tinyhouse.up.railway.app/ready
#   UPTIME_PROBE_STATE_FILE  default: ${HOME}/.tinyhouse/uptime-probe-state.json
#   UPTIME_PROBE_PROJECT_ID  project id used when filing incidents
#   UPTIME_PROBE_GOAL_ID     goal id used when filing incidents
#   UPTIME_PROBE_PARENT_ID   parent issue (default: TINA-31 itself)

set -euo pipefail

PROBE_URL="${UPTIME_PROBE_URL:-https://tinyhouse.up.railway.app/ready}"
# Default state path is scoped per-agent so multiple agents sharing $HOME do
# not collide on probe state.
DEFAULT_STATE_FILE="${HOME:-/tmp}/.tinyhouse/uptime-probe-state-${PAPERCLIP_AGENT_ID:-shared}.json"
STATE_FILE="${UPTIME_PROBE_STATE_FILE:-$DEFAULT_STATE_FILE}"
N_PROBES_PER_RUN=3
PROBE_GAP_SEC=3
N_FAIL_RUNS_TO_OPEN=1
N_OK_RUNS_TO_CLOSE=2

require() {
  local name="$1"
  if [ -z "${!name:-}" ]; then
    echo "uptime-probe: missing required env $name" >&2
    exit 2
  fi
}

require PAPERCLIP_API_KEY
require PAPERCLIP_API_URL
require PAPERCLIP_COMPANY_ID
require PAPERCLIP_AGENT_ID
require PAPERCLIP_RUN_ID

mkdir -p "$(dirname "$STATE_FILE")"
if [ ! -f "$STATE_FILE" ]; then
  echo '{"consecutiveFailRuns":0,"consecutiveOkRuns":0,"currentIncidentIssueId":null,"lastRunAt":null,"lastRunOutcome":null}' >"$STATE_FILE"
fi

# Probe N times, count failures.
fails=0
codes=()
for i in $(seq 1 "$N_PROBES_PER_RUN"); do
  code=$(curl -s -o /dev/null -m 8 -w "%{http_code}" "$PROBE_URL" || echo "000")
  codes+=("$code")
  if [ "$code" != "200" ]; then
    fails=$((fails + 1))
  fi
  if [ "$i" -lt "$N_PROBES_PER_RUN" ]; then
    sleep "$PROBE_GAP_SEC"
  fi
done

if [ "$fails" -ge "$N_PROBES_PER_RUN" ]; then
  outcome="fail"
elif [ "$fails" -eq 0 ]; then
  outcome="ok"
else
  outcome="flaky"
fi

now_iso=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
codes_csv=$(IFS=,; echo "${codes[*]}")

state=$(cat "$STATE_FILE")
prev_fail_runs=$(echo "$state" | jq -r '.consecutiveFailRuns // 0')
prev_ok_runs=$(echo "$state" | jq -r '.consecutiveOkRuns // 0')
incident_id=$(echo "$state" | jq -r '.currentIncidentIssueId // empty')

case "$outcome" in
  fail)
    new_fail_runs=$((prev_fail_runs + 1))
    new_ok_runs=0
    ;;
  ok)
    new_fail_runs=0
    new_ok_runs=$((prev_ok_runs + 1))
    ;;
  flaky)
    new_fail_runs="$prev_fail_runs"
    new_ok_runs=0
    ;;
esac

api() {
  local method="$1"; shift
  local path="$1"; shift
  # Never let a transport error abort the script — callers inspect the
  # response body instead. We still emit stderr noise so failures are visible
  # in the run log.
  curl -s -m 15 -X "$method" \
    -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
    -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" \
    -H "Content-Type: application/json" \
    "$@" \
    "${PAPERCLIP_API_URL%/}${path}" 2>/dev/null || true
}

action="none"

# Open incident if we have crossed the failure threshold and there is no
# existing open incident on file.
if [ "$outcome" = "fail" ] && [ "$new_fail_runs" -ge "$N_FAIL_RUNS_TO_OPEN" ] && [ -z "$incident_id" ]; then
  body=$(jq -n \
    --arg title "Prod outage: tinyhouse.up.railway.app /ready failing" \
    --arg desc "## Uptime probe alarm

The TinyHouse uptime probe (TINA-31) saw all $N_PROBES_PER_RUN /ready checks fail in a single run.

- Probe URL: \`$PROBE_URL\`
- Codes this run: \`$codes_csv\`
- Run issue: this incident was filed automatically; ack here when you're handling it.

## Triage

1. \`curl -I $PROBE_URL\` from any shell.
2. \`railway status --json --service tina\`
3. \`railway logs --service tina | tail -80\`

Auto-closes after $N_OK_RUNS_TO_CLOSE consecutive healthy probe runs." \
    --arg assigneeAgentId "$PAPERCLIP_AGENT_ID" \
    --arg projectId "${UPTIME_PROBE_PROJECT_ID:-}" \
    --arg goalId "${UPTIME_PROBE_GOAL_ID:-}" \
    --arg parentId "${UPTIME_PROBE_PARENT_ID:-}" \
    '{
      title: $title,
      description: $desc,
      priority: "critical",
      status: "todo",
      assigneeAgentId: $assigneeAgentId
    }
    + (if $projectId != "" then {projectId: $projectId} else {} end)
    + (if $goalId != "" then {goalId: $goalId} else {} end)
    + (if $parentId != "" then {parentId: $parentId} else {} end)')
  resp=$(api POST "/api/companies/$PAPERCLIP_COMPANY_ID/issues" -d "$body")
  new_incident_id=$(echo "$resp" | jq -r '.id // empty')
  if [ -n "$new_incident_id" ]; then
    incident_id="$new_incident_id"
    action="opened-incident:$incident_id"
  else
    action="open-incident-failed"
    echo "uptime-probe: failed to open incident: $resp" >&2
  fi
fi

# Close incident if we have crossed the recovery threshold and one is open.
if [ "$outcome" = "ok" ] && [ "$new_ok_runs" -ge "$N_OK_RUNS_TO_CLOSE" ] && [ -n "$incident_id" ]; then
  close_body=$(jq -n \
    --arg comment "Auto-closed by uptime probe: $N_OK_RUNS_TO_CLOSE consecutive healthy /ready runs at $now_iso." \
    '{status: "done", comment: $comment}')
  resp=$(api PATCH "/api/issues/$incident_id" -d "$close_body")
  closed_status=$(echo "$resp" | jq -r '.status // empty')
  if [ "$closed_status" = "done" ]; then
    action="closed-incident:$incident_id"
    incident_id=""
  else
    action="close-incident-failed"
    echo "uptime-probe: failed to close incident $incident_id: $resp" >&2
  fi
fi

# Persist state.
new_state=$(jq -n \
  --argjson fr "$new_fail_runs" \
  --argjson okr "$new_ok_runs" \
  --arg incident "$incident_id" \
  --arg ts "$now_iso" \
  --arg outcome "$outcome" \
  '{
    consecutiveFailRuns: $fr,
    consecutiveOkRuns: $okr,
    currentIncidentIssueId: (if $incident == "" then null else $incident end),
    lastRunAt: $ts,
    lastRunOutcome: $outcome
  }')
echo "$new_state" >"$STATE_FILE"

# Mark the routine's run issue done with a one-line summary, if we know it.
# Capture this routine's id from the current run issue so the sweeper below
# can scope itself to siblings only.
routine_id=""
if [ -n "${PAPERCLIP_TASK_ID:-}" ]; then
  task_resp=$(api GET "/api/issues/$PAPERCLIP_TASK_ID")
  routine_id=$(echo "$task_resp" | jq -r '.originId // empty' 2>/dev/null || echo "")

  summary="probe outcome=$outcome codes=$codes_csv failRuns=$new_fail_runs okRuns=$new_ok_runs action=$action"
  done_body=$(jq -n --arg comment "$summary" '{status: "done", comment: $comment}')
  api PATCH "/api/issues/$PAPERCLIP_TASK_ID" -d "$done_body" >/dev/null || true
fi

# Defensive sweeper (TINA-685 RCA): the platform moves routine_execution issues
# to `blocked` when continuation retries fail (e.g. Claude rate limit). Once
# the underlying outage clears, nothing re-tries them — they accumulate as
# zombies in the CTO inbox. On every healthy tick, cancel any stale `blocked`
# siblings from this same routine that are older than the soak window. Scoped
# strictly by originId so we never touch unrelated blocked work.
sweep_count=0
if [ "$outcome" = "ok" ] && [ -n "$routine_id" ] && [ -n "${PAPERCLIP_COMPANY_ID:-}" ] && [ -n "${PAPERCLIP_AGENT_ID:-}" ]; then
  sweep_cutoff_iso=$(date -u -d '30 minutes ago' +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || echo "")
  blocked_resp=$(api GET "/api/companies/$PAPERCLIP_COMPANY_ID/issues?status=blocked&assigneeAgentId=$PAPERCLIP_AGENT_ID")
  if [ -n "$sweep_cutoff_iso" ]; then
    stale_ids=$(echo "$blocked_resp" | jq -r --arg rid "$routine_id" --arg cutoff "$sweep_cutoff_iso" \
      '(if type=="array" then . else (.issues // .items // []) end)
       | map(select(.originKind == "routine_execution" and .originId == $rid and .updatedAt < $cutoff))
       | .[].id' 2>/dev/null || true)
    for sid in $stale_ids; do
      [ -z "$sid" ] && continue
      sweep_body='{"status":"cancelled","comment":"cancelled by uptime-probe sweeper — superseded by healthy probe at '"$now_iso"' (TINA-685)"}'
      api PATCH "/api/issues/$sid" -d "$sweep_body" >/dev/null || true
      sweep_count=$((sweep_count + 1))
    done
  fi
fi

echo "uptime-probe: outcome=$outcome codes=$codes_csv failRuns=$new_fail_runs okRuns=$new_ok_runs action=$action sweptStale=$sweep_count"
