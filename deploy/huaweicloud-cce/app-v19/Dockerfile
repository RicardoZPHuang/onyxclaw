FROM swr.cn-south-1.myhuaweicloud.com/demo-test/onyxclaw-app@sha256:d5cdc18a427751f357c0c4aed8e75823ccfdc4eabe7b55a39125217c3d274f18
LABEL org.opencontainers.image.title="OnyxClaw APP session routing debug no delay wait 5s"
LABEL org.opencontainers.image.version="0.3.8-session-routing-debug-nodelay-wait5s-v19"
LABEL com.onyxclaw.image-purpose="debug-workaround"
LABEL com.onyxclaw.resume-data-plane-delay-ms="0"
LABEL com.onyxclaw.data-session-wait-seconds="5"
ENV E2B_DATA_SESSION_WAIT_SECONDS=5
COPY --chown=node:node cloud-controller.js /app/packages/cloud-runtime/src/cloud-controller.js
