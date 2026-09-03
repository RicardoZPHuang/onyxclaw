ARG OPENCLAW_IMAGE=swr.cn-north-4.myhuaweicloud.com/ddn-k8s/ghcr.io/openclaw/openclaw@sha256:6212bdac7b9e558bdba7c967e69e4fcea21f0a014b5d8c1e9b8d29fc965a9129
FROM ${OPENCLAW_IMAGE}

USER root

COPY --chown=root:root envd /usr/bin/envd
COPY --chown=root:root envd-healthcheck.sh /home/node/envd-healthcheck.sh
COPY --chown=root:root entrypoint.sh /home/node/entrypoint.sh
COPY --chown=node:node openclaw.default.json /opt/openclaw/openclaw.default.json

RUN chmod 0755 \
      /usr/bin/envd \
      /home/node/envd-healthcheck.sh \
      /home/node/entrypoint.sh \
    && install -d -m 0700 -o node -g node /home/node/.openclaw \
    && install -d -m 0755 -o node -g node /home/node/.openclaw/workspace

ENV HOME=/home/node \
    OPENCLAW_HOME=/home/node \
    OPENCLAW_STATE_DIR=/home/node/.openclaw \
    OPENCLAW_CONFIG_PATH=/home/node/.openclaw/openclaw.json \
    OPENCLAW_WORKSPACE_DIR=/home/node/.openclaw/workspace \
    OPENCLAW_GATEWAY_TOKEN_FILE=/home/node/.openclaw/gateway-token \
    OPENCLAW_GATEWAY_PORT=18789 \
    ENVD_PORT=49983

WORKDIR /app

EXPOSE 18789 49983

HEALTHCHECK --interval=30s --timeout=12s --start-period=15s --retries=3 \
  CMD ["/home/node/envd-healthcheck.sh"]

ENTRYPOINT ["tini", "-s", "--", "/bin/bash", "/home/node/entrypoint.sh"]
