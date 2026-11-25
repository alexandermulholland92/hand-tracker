#!/bin/sh
# run-job.sh - one part of a cluster job ("Any command or script", modules/jobs.py) in a Windows PC's own Linux
# (Cluster-Linux under WSL), run by the service through wsl.exe in the part's own folder: the command in a process
# group of its own, as the cluster's ordinary user (uid 1000), or as root with --root (only once the service has
# checked the cluster password); held still while a ".pause" file is in the folder and ended when a ".stop" one
# appears (the service on Windows can't signal what runs in WSL itself). Its exit code is the command's.
#   run-job.sh [--root] -- <command> [its words...]
set -u
root=0
if [ "${1:-}" = "--root" ]; then root=1; shift; fi
if [ "${1:-}" = "--" ]; then shift; fi
if [ "$root" = 1 ]; then
  setsid "$@" &
else
  setsid setpriv --reuid=1000 --regid=1000 --clear-groups "$@" &
fi
child=$!
held=0
while kill -0 "$child" 2>/dev/null; do
  if [ -e .stop ]; then
    kill -CONT -"$child" 2>/dev/null
    kill -TERM -"$child" 2>/dev/null
    sleep 5
    kill -KILL -"$child" 2>/dev/null
    break
  fi
  if [ -e .pause ] && [ "$held" = 0 ]; then kill -STOP -"$child" 2>/dev/null; held=1; fi
  if [ ! -e .pause ] && [ "$held" = 1 ]; then kill -CONT -"$child" 2>/dev/null; held=0; fi
  sleep 1
done
wait "$child"
