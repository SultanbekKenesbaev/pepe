#!/bin/bash
set -euo pipefail
umask 077
cd /opt/ai-teacher
mkdir -p operations backups
chmod 0755 operations
exec 9>/opt/ai-teacher/operation.lock
flock --exclusive --nonblock 9 || { echo 'Another backup/deployment is running'; exit 75; }

snapshot_name="server-$(date -u +%Y%m%dT%H%M%SZ)"
image=$(docker inspect --format '{{.Config.Image}}' routemotion-ai-teacher)
compose=(docker compose --env-file release.env -f compose.production.yaml)
helper=routemotion-ai-teacher-backup

# The status is deliberately free of paths, credentials, and student data.
status() {
  python3 - "$1" "$snapshot_name" <<'PY'
import json,sys,datetime,os
from pathlib import Path
p=Path('/opt/ai-teacher/operations/backup-status.json')
try: old=json.loads(p.read_text())
except (OSError,ValueError): old={}
now=datetime.datetime.now(datetime.timezone.utc).isoformat()
new={**old,'status':sys.argv[1],'lastAttemptAt':now,'attemptSnapshot':sys.argv[2]}
if sys.argv[1]=='success': new.update(lastSuccessAt=now,snapshot=sys.argv[2])
temp=p.with_suffix('.next');temp.write_text(json.dumps(new));temp.chmod(0o644);os.replace(temp,p)
PY
}
stop_helper() {
  local helper_id
  # ps distinguishes an absent helper (empty output) from an unavailable daemon (failure).
  helper_id=$(docker ps --all --filter "name=^/${helper}$" --format '{{.ID}}') || return 1
  if [ -n "$helper_id" ]; then
    docker stop --time 15 "$helper" >/dev/null 2>&1 || true
    # --rm may already remove it after stop. A racing auto-removal is successful cleanup.
    helper_id=$(docker ps --all --filter "name=^/${helper}$" --format '{{.ID}}') || return 1
    if [ -n "$helper_id" ]; then
      docker rm --force "$helper" >/dev/null 2>&1 || {
        helper_id=$(docker ps --all --filter "name=^/${helper}$" --format '{{.ID}}') || return 1
        [ -z "$helper_id" ]
      }
    fi
  fi
}
remove_partial() {
  python3 - "$snapshot_name" <<'PY'
from pathlib import Path
import sys,re,shutil
name=sys.argv[1]
if not re.fullmatch(r'server-\d{8}T\d{6}Z',name): raise SystemExit('Invalid backup name')
p=Path('/opt/ai-teacher/backups')/name
if p.is_dir() and not p.is_symlink() and not (p/'backup-manifest.json').is_file(): shutil.rmtree(p)
PY
}
finish() {
  result=$?
  trap - EXIT TERM INT
  set +e
  # Always recover service, including after a failed copy. Mark success only after healthcheck.
  # Remove the named helper before restarting: Docker can outlive its CLI after interruption.
  if stop_helper; then remove_partial || result=1; else result=1; fi
  if ! "${compose[@]}" up -d --no-build --wait --wait-timeout 90 ai-teacher; then result=1; fi
  if [ "$result" -eq 0 ]; then status success || result=1; else status failed || true; fi
  exit "$result"
}
trap finish EXIT
trap 'exit 143' TERM
trap 'exit 130' INT
status running
stop_helper
"${compose[@]}" stop ai-teacher
docker run --rm --name "$helper" --network none --read-only --tmpfs /tmp:rw,size=128m,mode=1777 \
  --user 0:0 \
  -v /opt/ai-teacher/data:/data \
  -v /opt/ai-teacher/backups:/backups \
  -e DATA_DIR=/data \
  "$image" flock --exclusive --nonblock --no-fork /data/process.lock \
  /bin/sh -c 'rm -f /data/server.lock; exec node --import tsx scripts/backup.ts "$1"' \
  sh "/backups/$snapshot_name"

# Retain at least 14 verified daily snapshots. Original migration and manual archives are untouched.
python3 - <<'PY'
from pathlib import Path
import re,json,datetime,shutil
root=Path('/opt/ai-teacher/backups')
verified=[]
for p in root.iterdir():
    if not p.is_dir() or p.is_symlink() or not re.fullmatch(r'server-\d{8}T\d{6}Z',p.name): continue
    try:
        m=json.loads((p/'backup-manifest.json').read_text())
        if m.get('version')==1 and isinstance(m.get('files'),list) and m['files']: verified.append(p)
    except (OSError,ValueError): pass
verified.sort(key=lambda p:p.name,reverse=True)
cutoff=datetime.datetime.now(datetime.timezone.utc)-datetime.timedelta(days=14)
for p in verified[14:]:
    date=datetime.datetime.strptime(p.name,'server-%Y%m%dT%H%M%SZ').replace(tzinfo=datetime.timezone.utc)
    if date<cutoff: shutil.rmtree(p)
PY
