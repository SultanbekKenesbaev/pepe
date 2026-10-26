#!/bin/sh
set -eu

# Compose starts this script only after acquiring /data/process.lock with flock.
# A PID from a previous container can be reused by the new container process.
# Production backups hold the same OS lock. A terminated helper can leave its
# maintenance marker behind, but cannot still be copying while we own this lock.
# Never unlink process.lock: its inode is the shared exclusion mechanism.
rm -f /data/server.lock /data/maintenance.lock
exec node --import tsx server/start.ts
