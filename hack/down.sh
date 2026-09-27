#!/usr/bin/env bash
H="$(cd "$(dirname "$0")" && pwd)"
for n in portal web core; do f="$H/logs/$n.pid"; [ -f "$f" ] && { pkill -TERM -P "$(cat "$f")" 2>/dev/null; kill "$(cat "$f")" 2>/dev/null; rm -f "$f"; }; done
for p in 8081 8082 8084; do lsof -ti tcp:$p -sTCP:LISTEN | xargs kill 2>/dev/null; done; echo stopped
