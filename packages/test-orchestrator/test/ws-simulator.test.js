import assert from "node:assert/strict";
import test from "node:test";

import { OnyxclawTransport } from "../../onyxclaw-channel/src/transport-websocket.js";
import { createInboundMessage } from "../src/protocol.js";
import { WsPlatformSimulator } from "../src/ws-simulator.js";

test("plugin transport registers, receives inbound, and returns outbound", async (t) => {
  const simulator = new WsPlatformSimulator({ port: 0 });
  await simulator.start();
  t.after(() => simulator.stop());
  simulator.issueBootstrapToken("local-mac", "bootstrap-secret");

  const received = [];
  const transport = new OnyxclawTransport({
    platformUrl: simulator.url,
    instanceId: "local-mac",
    accountId: "default",
    bootstrapToken: "bootstrap-secret",
    pluginVersion: "0.1.0",
    heartbeatIntervalMs: 25,
    onInbound: async (event, connection) => {
      received.push(event);
      connection.sendOutbound({
        eventId: "out-1",
        chatId: event.payload.chatId,
        text: "pong",
        inReplyTo: event.eventId,
      });
    },
  });
  t.after(() => transport.stop());

  await transport.start();
  await simulator.waitForConnection("local-mac");
  simulator.sendInbound(
    "local-mac",
    createInboundMessage({
      eventId: "in-1",
      instanceId: "local-mac",
      accountId: "default",
      senderId: "tester",
      chatId: "phase0",
      text: "ping",
    }),
  );
  const outbound = await simulator.waitForReplyTo("in-1");

  assert.equal(received.length, 1);
  assert.equal(outbound.payload.text, "pong");
  assert.equal(outbound.payload.inReplyTo, "in-1");
  assert.equal(transport.status, "connected");
});

test("plugin transport reconnects with its session and handles a second message", async (t) => {
  const simulator = new WsPlatformSimulator({ port: 0 });
  await simulator.start();
  t.after(() => simulator.stop());
  simulator.issueBootstrapToken("local-mac", "bootstrap-secret");

  let replySequence = 0;
  const transport = new OnyxclawTransport({
    platformUrl: simulator.url,
    instanceId: "local-mac",
    accountId: "default",
    bootstrapToken: "bootstrap-secret",
    pluginVersion: "0.1.0",
    reconnectMinDelayMs: 10,
    reconnectMaxDelayMs: 20,
    onInbound: async (event, connection) => {
      replySequence += 1;
      connection.sendOutbound({
        eventId: `out-reconnect-${replySequence}`,
        chatId: event.payload.chatId,
        text: `pong-${replySequence}`,
        inReplyTo: event.eventId,
      });
    },
  });
  t.after(() => transport.stop());

  await transport.start();
  const first = await simulator.waitForConnection("local-mac");
  simulator.forceDisconnect("local-mac");
  const second = await simulator.waitForConnection("local-mac", {
    afterConnectionId: first.connectionId,
    timeoutMs: 2_000,
  });

  assert.notEqual(second.connectionId, first.connectionId);
  simulator.sendInbound(
    "local-mac",
    createInboundMessage({
      eventId: "in-reconnect-1",
      instanceId: "local-mac",
      accountId: "default",
      senderId: "tester",
      chatId: "phase0",
      text: "ping again",
    }),
  );
  const outbound = await simulator.waitForNextOutbound();
  assert.equal(outbound.payload.text, "pong-1");
  assert.equal(transport.status, "connected");
});

test("simulator correlates concurrent replies even when they arrive out of order", async (t) => {
  const simulator = new WsPlatformSimulator({ port: 0 });
  await simulator.start();
  t.after(() => simulator.stop());
  simulator.issueBootstrapToken("local-mac", "bootstrap-secret");

  const transport = new OnyxclawTransport({
    platformUrl: simulator.url,
    instanceId: "local-mac",
    accountId: "default",
    bootstrapToken: "bootstrap-secret",
    pluginVersion: "0.1.0",
    onInbound: async (event, connection) => {
      if (event.eventId === "in-slow") await new Promise((resolve) => setTimeout(resolve, 25));
      connection.sendOutbound({
        eventId: `out-${event.eventId}`,
        chatId: event.payload.chatId,
        text: `reply-${event.eventId}`,
        inReplyTo: event.eventId,
      });
    },
  });
  t.after(() => transport.stop());
  await transport.start();
  await simulator.waitForConnection("local-mac");

  const slowReply = simulator.waitForReply("local-mac", "in-slow");
  const fastReply = simulator.waitForReply("local-mac", "in-fast");
  for (const eventId of ["in-slow", "in-fast"]) {
    simulator.sendInbound("local-mac", createInboundMessage({
      eventId,
      instanceId: "local-mac",
      accountId: "default",
      senderId: "tester",
      chatId: "phase0",
      text: eventId,
    }));
  }

  const [slow, fast] = await Promise.all([slowReply, fastReply]);
  assert.equal(slow.payload.text, "reply-in-slow");
  assert.equal(fast.payload.text, "reply-in-fast");
});

test("simulator can be stopped and started again for another UI session", async () => {
  const simulator = new WsPlatformSimulator();

  await simulator.start();
  await simulator.stop();
  await simulator.start();
  assert.match(simulator.url, /^ws:\/\/127\.0\.0\.1:\d+$/);
  await simulator.stop();
});
