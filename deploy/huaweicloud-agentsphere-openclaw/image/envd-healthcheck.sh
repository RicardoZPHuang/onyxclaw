#!/bin/bash
set -euo pipefail

readonly max_retries=50
readonly retry_interval=0.2

for attempt in $(seq 1 "${max_retries}"); do
  status_code=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:49983/health")
  if [[ "${status_code}" == "204" ]]; then
    echo "ENVD Server is healthy"
    exit 0
  fi
  if (( attempt % 10 == 0 )); then
    echo "Waiting for ENVD Server to become healthy... (attempt ${attempt}/${max_retries})"
  fi
  sleep "${retry_interval}"
done

echo "ENVD Server health check failed after ${max_retries} attempts" >&2
exit 1
