import assert from "node:assert/strict";
import test from "node:test";

import { dispatchInboundEvent } from "../src/inbound.js";

test("dispatchInboundEvent routes a direct message and delivers the agent reply", async () => {
  const delivered = [];
  let capturedContext;
  const runtime = {
    routing: {
      resolveAgentRoute: () => ({
        agentId: "main",
        accountId: "default",
        sessionKey: "agent:main:onyxclaw:direct:phase0",
      }),
    },
    reply: {
      formatAgentEnvelope: ({ body }) => body,
      resolveEnvelopeFormatOptions: () => ({}),
      dispatchReplyWithBufferedBlockDispatcher: () => {},
    },
    inbound: {
      buildContext: (input) => {
        capturedContext = input;
        return input;
      },
      async dispatchReply(options) {
        assert.equal(options.routeSessionKey, "agent:main:onyxclaw:direct:phase0");
        await options.delivery.deliver({ text: "pong" });
      },
    },
    session: {
      resolveStorePath: () => "/tmp/session.json",
      recordInboundSession: () => {},
    },
  };

  await dispatchInboundEvent({
    event: {
      eventId: "in-1",
      timestamp: "2026-07-18T00:00:00.000Z",
      payload: {
        senderId: "tester",
        chatId: "phase0",
        text: "ping",
      },
    },
    accountId: "default",
    cfg: {},
    channelRuntime: runtime,
    deliver: async (reply) => delivered.push(reply),
  });

  assert.equal(capturedContext.conversation.kind, "direct");
  assert.equal(capturedContext.message.bodyForAgent, "ping");
  assert.equal(delivered[0].text, "pong");
  assert.equal(delivered[0].inReplyTo, "in-1");
});

test("dispatchInboundEvent returns an actionable reply when model generation fails", async () => {
  const delivered = [];
  const logs = [];
  const runtime = {
    routing: {
      resolveAgentRoute: () => ({
        agentId: "main",
        accountId: "default",
        sessionKey: "agent:main:onyxclaw:direct:phase0",
      }),
    },
    reply: {
      formatAgentEnvelope: ({ body }) => body,
      resolveEnvelopeFormatOptions: () => ({}),
      dispatchReplyWithBufferedBlockDispatcher: () => {},
    },
    inbound: {
      buildContext: (input) => input,
      async dispatchReply() {
        throw new Error("model endpoint unavailable");
      },
    },
    session: {
      resolveStorePath: () => "/tmp/session.json",
      recordInboundSession: () => {},
    },
  };

  await dispatchInboundEvent({
    event: {
      eventId: "in-failed",
      timestamp: "2026-07-18T00:00:00.000Z",
      payload: { senderId: "tester", chatId: "phase0", text: "hello" },
    },
    accountId: "default",
    cfg: {},
    channelRuntime: runtime,
    deliver: async (reply) => delivered.push(reply),
    log: { error: (message) => logs.push(message) },
  });

  assert.equal(delivered.length, 1);
  assert.match(delivered[0].text, /模型服务/);
  assert.equal(delivered[0].inReplyTo, "in-failed");
  assert.equal(logs[0], "OnyxClaw inbound generation failed");
});
