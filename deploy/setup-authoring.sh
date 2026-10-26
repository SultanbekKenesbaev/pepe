#!/bin/bash
set -euo pipefail
umask 077
if [ "$(id -u)" -ne 0 ]; then echo 'Run setup as the server administrator.' >&2; exit 1; fi
script_dir=$(cd -- "$(dirname -- "$0")" && pwd)
cd /opt/ai-teacher
if ! command -v apparmor_parser >/dev/null; then echo 'AppArmor parser is required for the author sandbox.' >&2; exit 1; fi
if [ "$script_dir/worker-seccomp.json" != /opt/ai-teacher/worker-seccomp.json ]; then
  install -m 0644 "$script_dir/worker-seccomp.json" /opt/ai-teacher/worker-seccomp.json
else
  chmod 0644 /opt/ai-teacher/worker-seccomp.json
fi
install -m 0644 "$script_dir/worker-apparmor" /etc/apparmor.d/routemotion-lesson-author
apparmor_parser -r /etc/apparmor.d/routemotion-lesson-author
mkdir -p author-jobs codex-auth secrets
chown 1000:1000 author-jobs codex-auth
chmod 0700 author-jobs codex-auth
if [ ! -e secrets/author-worker.token ]; then
  python3 - <<'PY'
from pathlib import Path
import secrets,os
p=Path('/opt/ai-teacher/secrets/author-worker.token')
fd=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o400)
with os.fdopen(fd,'w') as f:f.write(secrets.token_hex(32)+'\n')
PY
fi
chown 1000:1000 secrets/author-worker.token
chmod 0400 secrets/author-worker.token
docker_gid=$(stat -c '%g' /var/run/docker.sock)
if [ ! -e authoring.env ]; then
  cat > authoring.env <<ENV
AI_TEACHER_DOCKER_GID=$docker_gid
AI_TEACHER_AUTHOR_JOBS=/opt/ai-teacher/author-jobs
AI_TEACHER_CODEX_AUTH=/opt/ai-teacher/codex-auth
AI_TEACHER_WORKER_TOKEN=/opt/ai-teacher/secrets/author-worker.token
ENV
  chmod 0600 authoring.env
fi
printf '%s\n' 'Authoring directories and private worker token are ready. No Codex login was copied.'
