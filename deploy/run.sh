#!/usr/bin/env bash
# Run only on a trusted push to main, after downloading the checked artifact.
set -euo pipefail
: "${GITHUB_SHA:?checked commit required}"
: "${SLOTRUSH_KEY_FILE:?private key file required}"
: "${SLOTRUSH_HOSTS_FILE:?pinned known_hosts required}"
bundle=${1:-bundle}
ssh_options=(-p 4020 -i "$SLOTRUSH_KEY_FILE" -o IdentitiesOnly=yes -o BatchMode=yes
  -o StrictHostKeyChecking=yes -o "UserKnownHostsFile=$SLOTRUSH_HOSTS_FILE"
  -o HostKeyAlgorithms=ssh-ed25519 -o ConnectTimeout=20 -o ServerAliveInterval=15 -o ServerAliveCountMax=3)
remote=slotrush-deploy@213.165.91.221
sum=$(PYTHONPATH=deploy timeout --kill-after=5s 30s python3 -c 'import artifact,sys; print(artifact.load(sys.argv[1],sys.argv[2])["archive_sha256"])' "$bundle" "$GITHUB_SHA")
# Fail before switching anything if public DNS/TLS is not ready.
curl --fail --silent --show-error --max-time 30 https://slotrush.jdwd40.com/ >/dev/null
status_field() {
  python3 -c 'import json,sys; print(json.load(sys.stdin)[sys.argv[1]] or "")' "$1"
}
remote_status() { timeout --kill-after=5s 30s ssh "${ssh_options[@]}" "$remote" status; }
previous=$(remote_status | status_field current)
[[ "$previous" =~ ^[0-9]{8}T[0-9]{6}([0-9]{6})?Z-[0-9a-f]{12}$ ]] || { printf 'No safe rollback target\n' >&2; exit 1; }
# Preassign the exact candidate so a lost deploy acknowledgement is recoverable.
# The receiver validates this name, its commit suffix, and refuses existing names.
candidate=$(python3 -c 'import datetime,sys; print(datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%S%fZ-")+sys.argv[1][:12])' "$GITHUB_SHA")
pending=false
child=
# wait on an asynchronous child so Bash runs INT/TERM traps immediately rather
# than deferring them until a foreground verifier/SSH process eventually exits.
run_child() {
  local code=0
  "$@" <&0 &
  child=$!
  wait "$child" || code=$?
  child=
  return "$code"
}
recover() {
  local state current
  if ! state=$(remote_status) || ! current=$(status_field current <<< "$state"); then
    printf 'RECOVERY UNCONFIRMED: remote status unreachable/invalid; inspect status manually (candidate %s, old %s).\n' "$candidate" "$previous" >&2
    return 1
  fi
  if [[ "$current" == "$previous" ]]; then
    printf 'Captured old release remains current: %s\n' "$previous" >&2
    return 0
  fi
  if [[ "$current" != "$candidate" ]]; then
    printf 'Recovery left unrelated current release untouched: %s (candidate %s).\n' "$current" "$candidate" >&2
    return 1
  fi
  # The comparison and rollback share the receiver lock, preventing a TOCTOU
  # rollback of a different publisher between the status query and this command.
  if ! timeout --kill-after=5s 30s ssh "${ssh_options[@]}" "$remote" "rollback-if $candidate $previous"; then
    printf 'Rollback command failed or acknowledgement lost; reconciling status.\n' >&2
  fi
  if state=$(remote_status) && current=$(status_field current <<< "$state") && [[ "$current" == "$previous" ]]; then
    printf 'Restored captured old release: %s\n' "$previous" >&2
    return 0
  fi
  printf 'RECOVERY UNCONFIRMED: captured old release not confirmed; inspect status manually (candidate %s, old %s).\n' "$candidate" "$previous" >&2
  return 1
}
on_exit() {
  local code=$?
  trap - EXIT
  trap '' INT TERM
  if [[ -n "$child" ]]; then
    kill -TERM "$child" 2>/dev/null || true
    wait "$child" 2>/dev/null || true
  fi
  if [[ "$pending" == true ]]; then
    # An unverified candidate must never result in a successful job, even when
    # rollback succeeds. Recovery errors must not obscure the original failure.
    [[ "$code" != 0 ]] || code=1
    recover || true
  fi
  exit "$code"
}
trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
# Mark pending BEFORE SSH: ssh may return 255 after the server published current.
pending=true
if ! run_child timeout --kill-after=5s 120s ssh "${ssh_options[@]}" "$remote" "deploy $GITHUB_SHA $sum $candidate" < "$bundle/dist.tgz"; then
  printf 'Deploy SSH failed; reconciling unverified candidate.\n' >&2
  exit 1
fi
# One global deadline, not a fresh 30-second allowance for every built file.
# Along with bounded deploy/status/recovery this leaves room in the 10-minute job.
if ! run_child timeout --kill-after=5s 120s python3 deploy/artifact.py verify "$bundle" "$GITHUB_SHA" https://slotrush.jdwd40.com; then
  printf 'Public verification failed; reconciling unverified candidate.\n' >&2
  exit 1
fi
state=$(remote_status)
[[ "$(status_field current <<< "$state")" == "$candidate" &&
   "$(status_field revision <<< "$state")" == "$GITHUB_SHA" &&
   "$(status_field artifact_sha256 <<< "$state")" == "$sum" ]] || { printf 'Remote candidate identity changed during verification\n' >&2; exit 1; }
pending=false
printf '%s\n' "$state"
