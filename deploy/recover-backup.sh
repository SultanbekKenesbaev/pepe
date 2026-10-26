#!/bin/bash
set -euo pipefail
umask 077
cd /opt/ai-teacher
mkdir -p operations backups
chmod 0755 operations
exec 9>/opt/ai-teacher/operation.lock
# A different backup or deployment owns recovery while it holds this lock.
flock --exclusive --nonblock 9 || exit 0

helper=routemotion-ai-teacher-backup
# A failed Docker query is not evidence that the helper has stopped.
helper_id=$(docker ps --all --filter "name=^/${helper}$" --format '{{.ID}}')
if [ -n "$helper_id" ]; then
  docker stop --time 15 "$helper" >/dev/null 2>&1 || true
  helper_id=$(docker ps --all --filter "name=^/${helper}$" --format '{{.ID}}')
  if [ -n "$helper_id" ]; then
    docker rm --force "$helper" >/dev/null 2>&1 || {
      helper_id=$(docker ps --all --filter "name=^/${helper}$" --format '{{.ID}}') || exit 1
      [ -z "$helper_id" ]
    }
  fi
fi

# Only the current incomplete attempt may be removed. Completed snapshots stay intact.
python3 - <<'PY'
from pathlib import Path
import datetime,json,os,re,shutil
p=Path('/opt/ai-teacher/operations/backup-status.json')
try: old=json.loads(p.read_text())
except (OSError,ValueError): old={}
attempt=old.get('attemptSnapshot','')
if isinstance(attempt,str) and re.fullmatch(r'server-\d{8}T\d{6}Z',attempt):
    partial=Path('/opt/ai-teacher/backups')/attempt
    if partial.is_dir() and not partial.is_symlink() and not (partial/'backup-manifest.json').is_file(): shutil.rmtree(partial)
interrupted=old.get('status')=='running' or os.environ.get('SERVICE_RESULT','success')!='success'
if interrupted:
    now=datetime.datetime.now(datetime.timezone.utc).isoformat()
    new={**old,'status':'failed','lastAttemptAt':old.get('lastAttemptAt') or now}
    temp=p.with_suffix('.next');temp.write_text(json.dumps(new));temp.chmod(0o644);os.replace(temp,p)
PY

# Startup acquires /data/process.lock before removing stale application/maintenance markers.
docker compose --env-file release.env -f compose.production.yaml \
  up -d --no-build --wait --wait-timeout 90 ai-teacher
