#!/usr/bin/env bash
# Local QM: core (8081, via hsec for ANTHROPIC_API_KEY), web-ui (8082), portal (8084 = open this).
set -euo pipefail
H="$(cd "$(dirname "$0")" && pwd)"; R="$(dirname "$H")"
mkdir -p "$H/logs"
set -a; source "$H/secrets.env"; set +a
export PATH="$HOME/.local/bin:/opt/homebrew/bin:$PATH"
ORG=acme; ADMIN="${QM_ADMIN:-touko}"
CORE=8081; WEB=8082; PORTAL=8084
common=(ORG_ID=$ORG CORE_ORG_ID=$ORG)
# Memorable procedural memory (native provider). Key only via hsec at exec time; store lives in the hack's MEMORABLE_HOME.
MEMORABLE_CLI="${MEMORABLE_CLI:-$HOME/.npm/_npx/6698cd1a61ba9a37/node_modules/memorable-cli/dist/cli.js}"
MEM_CFG='{"providers":[{"id":"procedures","type":"memorable","bin":["node","'"$MEMORABLE_CLI"'"],"passEnv":["MEMORABLE_NO_KEYCHAIN"]}],"routes":[{"provider":"default","scopes":["personal","channel","group","team","org"],"capture":"automatic"},{"provider":"procedures","scopes":["personal","channel","group","team"],"capture":"off","manage":false,"label":"Procedures (Memorable)"}]}'
memorable=(MEMORY_PROVIDER_CONFIG="$MEM_CFG" MEMORABLE_BACKEND=local MEMORABLE_NO_KEYCHAIN=1 \
  MEMORABLE_HOME="${MEMORABLE_HOME:-$(dirname "$R")/own-your-intelligence-hack/.memorable-home}" \
  MEMORABLE_API_URL=https://memorable-extraction-api.memorable.workers.dev)
start() { local name=$1 dir=$2; shift 2; (cd "$dir" && nohup env "$@" >"$H/logs/$name.log" 2>&1 & echo $! >"$H/logs/$name.pid"); }
start core "$R" "${common[@]}" "${memorable[@]}" HARNESS=pi PORT=$CORE COMPILED_ROUTES="${COMPILED_ROUTES:-1}" \
  DATABASE_URL=postgres://$USER@localhost:5432/qm_hack SESSION_STORE=postgres RUN_STORE=postgres \
  ADMIN_GRANTS="$ADMIN:org_admin" PUBLIC_WEB_URL=http://localhost:$PORTAL \
  SANDBOX_BACKEND=local LOCAL_SANDBOX_IMAGE=qm-sandbox-local:latest PUBLIC_API_URL=http://host.docker.internal:$CORE \
  SLACK_BOT_TOKEN= SLACK_APP_TOKEN= DEV_INSTANCE_NO_SLACK=1 SHUTDOWN_DRAIN_MS=2000 \
  /Users/touko/.local/bin/hsec exec --only ANTHROPIC_API_KEY,MEMORABLE_API_KEY -- node src/index.ts
start web "$R/plugins/web-ui" "${common[@]}" PORT=$WEB CORE_API_URL=http://localhost:$CORE WEB_UI_BASE=/ \
  WEB_UI_PRINCIPALS= WEB_UI_PUBLIC_URL=http://localhost:$PORTAL node server/index.ts
start portal "$R/plugins/portal" "${common[@]}" PORT=$PORTAL PORTAL_PUBLIC_URL=http://localhost:$PORTAL \
  CORE_API_URL=http://localhost:$CORE WEB_UI_UPSTREAM=http://localhost:$WEB ADMIN_UPSTREAM=http://localhost:$WEB/admin \
  NODE_ENV=development PORTAL_LOCAL_AUTH_BYPASS=1 PORTAL_DEV_PRINCIPAL="$ADMIN" node src/index.ts
echo "started; open http://localhost:$PORTAL  (logs: $H/logs)"
