#!/bin/bash
set -euo pipefail
umask 077
if [ "$(id -u)" -ne 0 ]; then echo 'Run setup as the server administrator.' >&2; exit 1; fi
cd /opt/ai-teacher
test -d codex-auth
test -f worker-seccomp.json
install -d -o 1000 -g 1000 -m 0700 author-2d-jobs
install -d -m 0700 secrets
python3 - <<'PY'
from pathlib import Path
import secrets,os
p=Path('/opt/ai-teacher/secrets/author-2d-worker.token')
if not p.exists():
 fd=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o400)
 with os.fdopen(fd,'w') as f:f.write(secrets.token_hex(32)+'\n')
assert p.is_file() and not p.is_symlink()
os.chown(p,1000,1000);p.chmod(0o400)
PY
printf '%s\n' 'Separate 2D job directory and worker token are ready. Existing 3D queue and Codex login are preserved.'
