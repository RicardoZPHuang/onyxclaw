#!/bin/bash
set -euo pipefail

: "${ENVD_PORT:=49983}"
: "${OPENCLAW_GATEWAY_PORT:=18789}"
: "${OPENCLAW_GATEWAY_TOKEN_FILE:=/home/node/.openclaw/gateway-token}"

readonly openclaw_config=/home/node/.openclaw/openclaw.json
readonly default_config=/opt/openclaw/openclaw.default.json

install -d -m 0700 -o node -g node /home/node/.openclaw
install -d -m 0755 -o node -g node /home/node/.openclaw/workspace

# Seed only a missing config. Interactive OpenClaw changes remain intact.
if [[ ! -s "${openclaw_config}" ]]; then
  install -m 0600 -o node -g node "${default_config}" "${openclaw_config}"
fi

echo "Starting envd on port ${ENVD_PORT}..."
/usr/bin/envd \
  -isnotfc \
  -port "${ENVD_PORT}" \
  -verbose \
  -no-cgroups &
envd_pid=$!

if ! /home/node/envd-healthcheck.sh; then
  echo "envd failed its startup health check" >&2
  kill "${envd_pid}" 2>/dev/null || true
  wait "${envd_pid}" 2>/dev/null || true
  exit 1
fi
if ! kill -0 "${envd_pid}" 2>/dev/null; then
  echo "envd exited after passing its startup health check" >&2
  exit 1
fi
echo "envd is ready (pid=${envd_pid})"

# Do not bake a shared secret into the image. Generate one per Sandbox unless
# OPENCLAW_GATEWAY_TOKEN was supplied by the caller.
if [[ -z "${OPENCLAW_GATEWAY_TOKEN:-}" ]]; then
  if [[ -s "${OPENCLAW_GATEWAY_TOKEN_FILE}" ]]; then
    OPENCLAW_GATEWAY_TOKEN=$(<"${OPENCLAW_GATEWAY_TOKEN_FILE}")
  else
    OPENCLAW_GATEWAY_TOKEN=$(node -e \
      "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))")
    token_tmp="${OPENCLAW_GATEWAY_TOKEN_FILE}.tmp"
    umask 077
    printf '%s' "${OPENCLAW_GATEWAY_TOKEN}" >"${token_tmp}"
    chown node:node "${token_tmp}"
    chmod 0600 "${token_tmp}"
    mv -f "${token_tmp}" "${OPENCLAW_GATEWAY_TOKEN_FILE}"
  fi
  export OPENCLAW_GATEWAY_TOKEN
fi

exec setpriv --reuid=node --regid=node --init-groups \
  node /app/openclaw.mjs gateway run \
    --port "${OPENCLAW_GATEWAY_PORT}" \
    --bind lan \
    --allow-unconfigured
