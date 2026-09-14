#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

exec docker run --rm -it \
  --network host \
  -v "$SCRIPT_DIR:/work:ro" \
  -w /work \
  -e E2B_API_KEY \
  -e E2B_API_URL \
  -e E2B_SANDBOX_URL \
  -e E2B_SANDBOX_ID \
  e2b-sdk-tools:2.34.0 \
  /work/e2b_interactive_tty.py "$@"
