# Full APP image for a new Huawei CCE environment. Existing v19 deployments
# should use app-v21/Dockerfile.chat-delivery-v21 for the smallest verified update.
FROM node:22-bookworm-slim

USER root

COPY deploy/huaweicloud-cce/requirements.txt /tmp/requirements.txt

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates python3 python3-venv \
    && python3 -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir -r /tmp/requirements.txt \
    && /opt/venv/bin/python -c 'from e2b import Sandbox' \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY config/ ./config/
COPY packages/ ./packages/

ENV NODE_ENV=production \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    ONYXCLAW_E2B_PYTHON=/opt/venv/bin/python \
    E2B_DATA_SESSION_WAIT_SECONDS=5 \
    APP_HOST=0.0.0.0 \
    APP_PORT=3000 \
    CHANNEL_HOST=0.0.0.0 \
    CHANNEL_PORT=18890

USER node

EXPOSE 3000 18890

CMD ["node", "packages/cloud-runtime/src/cloud-app.js"]
