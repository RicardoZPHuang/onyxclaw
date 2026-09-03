import assert from "node:assert/strict";
import test from "node:test";

import { OnyxclawTransport } from "../../onyxclaw-channel/src/transport-websocket.js";
import { WsPlatformSimulator } from "../../test-orchestrator/src/ws-simulator.js";
import { CloudConsoleController } from "../src/cloud-controller.js";

function fixture() {
  const calls = [];
  const adapter = {
    async createSandbox(options) {
      calls.push(["create", options]);
      return { sandboxId: "sandbox-1", status: "running" };
    },
    async connectSandbox(id) {
      calls.push(["connect", id]);
      return { sandboxId: id, status: "running" };
    },
    async killSandbox(id) {
      calls.push(["kill", id]);
    },
    async pauseSandbox(id) {
      calls.push(["pause", id]);
    },
  };
  const saga = {
    async prepareSandbox(options) {
      calls.push(["prepare", options]);
      return { ...options, status: "prepared" };
    },
    async bootstrapSandbox(options) {
      calls.push(["bootstrap", options]);
      return { ...options, connectionId: "connection-1", status: "ready" };
    },
    async readPersistentSoul(sandboxId) {
      calls.push(["read-soul", sandboxId]);
      return {
        content: "# Soul restored from SFS Turbo",
        size: 30,
        sha256: "persistent-hash",
      };
    },
  };
  const controller = new CloudConsoleController({
    adapter,
    saga,
    simulator: {
      resetInstance(instanceId) {
        calls.push(["reset-channel", instanceId]);
      },
    },
    instanceIdFactory: () => "instance-1",
    traceIdFactory: () => "trace-1",
    defaultSoul: "# Default lobster",
    buildConfig: ({ instanceId }) => ({ instanceId }),
  });
  return { calls, controller };
}

test("new users allocate first, then bootstrap the same Sandbox after SOUL confirmation", async () => {
  const { calls, controller } = fixture();

  assert.deepEqual(await controller.startLobsterMode(), {
    mode: "allocated",
    currentStep: "soul",
    soulConfirmed: false,
    sandboxId: "sandbox-1",
    instanceId: "instance-1",
    connectionId: null,
    traceId: "trace-1",
    error: null,
  });
  const soul = await controller.getSoul();
  assert.equal(soul.content, "# Default lobster");
  await controller.confirmSoul("# Brave lobster");
  assert.equal(controller.getStatus().currentStep, "chat");
  assert.equal(controller.getStatus().soulConfirmed, true);
  assert.deepEqual(calls.map(([name]) => name), ["create", "prepare", "bootstrap"]);
  assert.equal(calls[1][1].sandboxId, "sandbox-1");
  assert.equal(calls[2][1].sandboxId, "sandbox-1");
});

test("existing users connect by Sandbox ID and skip personality confirmation", async () => {
  const { calls, controller } = fixture();
  const status = await controller.startLobsterMode({ sandboxId: "saved-sandbox" });

  assert.equal(status.mode, "connected");
  assert.equal(status.currentStep, "chat");
  assert.equal(status.soulConfirmed, true);
  assert.deepEqual(calls.map(([name]) => name), ["connect", "bootstrap"]);
});

test("existing users wait for the resumed OpenClaw Channel before chat is enabled", async () => {
  const { calls } = fixture();
  const controller = new CloudConsoleController({
    adapter: {
      async connectSandbox(id) {
        calls.push(["connect", id]);
        return { sandboxId: id, status: "running" };
      },
    },
    saga: {
      async bootstrapSandbox(options) {
        calls.push(["bootstrap", options]);
        return { connectionId: "resumed-connection" };
      },
    },
    buildConfig: () => ({}),
    timeoutMs: 30_000,
  });

  const status = await controller.startLobsterMode({
    sandboxId: "saved-sandbox",
    instanceId: "saved-claw",
  });

  assert.equal(calls[1][0], "bootstrap");
  assert.equal(calls[1][1].instanceId, "saved-claw");
  assert.equal(status.connectionId, "resumed-connection");
  assert.equal(status.mode, "connected");
});

test("concurrent chat replies are matched to their inbound event", async (t) => {
  const simulator = new WsPlatformSimulator({ port: 0 });
  await simulator.start();
  t.after(() => simulator.stop());
  simulator.issueBootstrapToken("instance-1", "bootstrap-token");

  const transport = new OnyxclawTransport({
    platformUrl: simulator.url,
    instanceId: "instance-1",
    accountId: "default",
    bootstrapToken: "bootstrap-token",
    pluginVersion: "0.1.0",
    heartbeatIntervalMs: 25,
    onInbound: async (event, connection) => {
      if (event.payload.text !== "second") return;
      connection.sendOutbound({
        eventId: "out-second",
        chatId: event.payload.chatId,
        text: "reply to second",
        inReplyTo: event.eventId,
      });
    },
  });
  t.after(() => transport.stop());
  await transport.start();
  await simulator.waitForConnection("instance-1");

  const eventIds = ["in-first", "in-second"];
  const controller = new CloudConsoleController({
    adapter: {
      async createSandbox() {
        return { sandboxId: "sandbox-1" };
      },
    },
    saga: {
      async prepareSandbox() {},
      async bootstrapSandbox() {
        return { connectionId: "connection-1" };
      },
    },
    simulator,
    instanceIdFactory: () => "instance-1",
    eventIdFactory: () => eventIds.shift(),
    buildConfig: () => ({}),
    timeoutMs: 50,
  });
  await controller.startLobsterMode();
  await controller.confirmSoul("# Concurrent lobster");

  const [first, second] = await Promise.allSettled([
    controller.sendMessage("first"),
    controller.sendMessage("second"),
  ]);

  assert.equal(first.status, "rejected");
  assert.match(first.reason.message, /reply to in-first/);
  assert.equal(second.status, "fulfilled");
  assert.equal(second.value.inboundEventId, "in-second");
  assert.equal(second.value.text, "reply to second");
});

test("registers each reply waiter before sending concurrent inbound events", async () => {
  const eventIds = ["in-slow", "in-fast"];
  const replyWaiters = new Map();
  const sent = [];
  const controller = new CloudConsoleController({
    adapter: { async connectSandbox() {} },
    saga: { async bootstrapSandbox() { return { connectionId: "connection-1" }; } },
    simulator: {
      waitForReply(instanceId, eventId) {
        assert.equal(instanceId, "saved-claw");
        return new Promise((resolve) => replyWaiters.set(eventId, resolve));
      },
      cancelReply(eventId, error) {
        replyWaiters.get(eventId)?.(Promise.reject(error));
      },
      sendInbound(_instanceId, event) {
        assert.equal(replyWaiters.has(event.eventId), true, "waiter must exist before send");
        sent.push(event.eventId);
        if (event.eventId !== "in-fast") return;
        queueMicrotask(() => {
          replyWaiters.get("in-fast")({
            eventId: "out-fast",
            payload: { text: "fast reply", inReplyTo: "in-fast" },
          });
          replyWaiters.get("in-slow")({
            eventId: "out-slow",
            payload: { text: "slow reply", inReplyTo: "in-slow" },
          });
        });
      },
    },
    buildConfig: () => ({}),
    eventIdFactory: () => eventIds.shift(),
  });
  await controller.startLobsterMode({ sandboxId: "sandbox-1", instanceId: "saved-claw" });

  const [slow, fast] = await Promise.all([
    controller.sendMessage("slow"),
    controller.sendMessage("fast"),
  ]);

  assert.deepEqual(sent, ["in-slow", "in-fast"]);
  assert.equal(slow.outboundEventId, "out-slow");
  assert.equal(fast.outboundEventId, "out-fast");
});

test("resume starts OpenClaw before loading the persistent SFS personality", async () => {
  const { calls, controller } = fixture();
  await controller.startLobsterMode();
  await controller.confirmSoul("# Persistent lobster");

  const paused = await controller.pauseLobsterMode();
  assert.equal(paused.mode, "paused");
  assert.equal(paused.connectionId, null);

  const resumed = await controller.resumeLobsterMode();
  assert.equal(resumed.mode, "resume-confirmation");
  assert.equal(resumed.currentStep, "soul");
  assert.equal(resumed.soulConfirmed, false);
  assert.equal(resumed.connectionId, null);
  assert.equal(controller.getSoul().content, "# Soul restored from SFS Turbo");
  assert.deepEqual(calls.slice(-4).map(([name]) => name), [
    "pause",
    "connect",
    "prepare",
    "read-soul",
  ]);
  assert.equal(calls.at(-2)[1].cleanupOnFailure, false);
  assert.equal(calls.at(-2)[1].buildConfig instanceof Function, true);

  await controller.confirmSoul("# Confirmed persistent soul");
  assert.equal(controller.getStatus().mode, "connected");
  assert.deepEqual(calls.slice(-5).map(([name]) => name), [
    "pause",
    "connect",
    "prepare",
    "read-soul",
    "bootstrap",
  ]);
  assert.equal(calls.at(-1)[1].soul, "# Confirmed persistent soul");
  assert.equal(calls.at(-1)[1].cleanupOnFailure, false);
});

test("a failed resume remains paused so the user can retry connect", async () => {
  let connectAttempts = 0;
  const controller = new CloudConsoleController({
    adapter: {
      async createSandbox() {
        return { sandboxId: "sandbox-1" };
      },
      async pauseSandbox() {},
      async connectSandbox() {
        connectAttempts += 1;
        if (connectAttempts === 1) throw new Error("temporary auth failure");
        return { sandboxId: "sandbox-1" };
      },
    },
    saga: {
      async prepareSandbox() {},
      async bootstrapSandbox() {
        return { connectionId: "connection-2" };
      },
      async readPersistentSoul() {
        return { content: "# Retry lobster", size: 15, sha256: "hash" };
      },
    },
    buildConfig: () => ({}),
  });
  await controller.startLobsterMode();
  await controller.confirmSoul("# Retry lobster");
  await controller.pauseLobsterMode();

  await assert.rejects(controller.resumeLobsterMode(), /temporary auth failure/);
  assert.equal(controller.getStatus().mode, "paused");
  assert.equal(controller.getStatus().connectionId, null);

  const resumed = await controller.resumeLobsterMode();
  assert.equal(resumed.mode, "resume-confirmation");
  await controller.confirmSoul(controller.getSoul().content);
  assert.equal(controller.getStatus().mode, "connected");
  assert.equal(controller.getStatus().connectionId, "connection-2");
});

test("missing resumed data session reconnects before retrying preparation", async () => {
  const calls = [];
  let prepareAttempts = 0;
  const controller = new CloudConsoleController({
    adapter: {
      async createSandbox() {
        return { sandboxId: "sandbox-1" };
      },
      async connectSandbox(id) {
        calls.push(["connect", id]);
      },
      async pauseSandbox(id) {
        calls.push(["pause", id]);
      },
    },
    saga: {
      async prepareSandbox() {
        prepareAttempts += 1;
        calls.push(["prepare", prepareAttempts]);
        if (prepareAttempts === 2) {
          const error = new Error("OpenClaw bootstrap failed during PREPARING", {
            cause: new Error("Session ID not found"),
          });
          throw error;
        }
      },
      async bootstrapSandbox() {
        return { connectionId: "connection-3" };
      },
      async readPersistentSoul() {
        calls.push(["read-soul"]);
        return { content: "# Persistent from SFS", size: 21, sha256: "hash" };
      },
    },
    buildConfig: () => ({}),
  });
  await controller.startLobsterMode();
  await controller.confirmSoul("# Persistent");
  calls.length = 0;
  await controller.pauseLobsterMode();

  await assert.rejects(controller.resumeLobsterMode(), /PREPARING/);
  assert.equal(controller.getStatus().mode, "resume-data-pending");
  assert.deepEqual(calls, [["pause", "sandbox-1"], ["connect", "sandbox-1"], ["prepare", 2]]);

  const retried = await controller.resumeLobsterMode();
  assert.equal(retried.mode, "resume-confirmation");
  assert.deepEqual(calls, [
    ["pause", "sandbox-1"],
    ["connect", "sandbox-1"],
    ["prepare", 2],
    ["connect", "sandbox-1"],
    ["prepare", 3],
    ["read-soul"],
  ]);
  assert.equal(controller.getSoul().content, "# Persistent from SFS");
});

test("stop kills the cloud Sandbox and resets the serial flow", async () => {
  const { calls, controller } = fixture();
  await controller.startLobsterMode();
  const status = await controller.stopLobsterMode();

  assert.equal(status.mode, "idle");
  assert.equal(status.currentStep, "mode");
  assert.deepEqual(calls.slice(-2), [
    ["kill", "sandbox-1"],
    ["reset-channel", "instance-1"],
  ]);
});

test("resetNewUser uses cloud cleanup and returns to onboarding", async () => {
  const { calls, controller } = fixture();
  await controller.startLobsterMode();
  await controller.confirmSoul("# Confirmed");

  const reset = await controller.resetNewUser();

  assert.equal(reset.mode, "idle");
  assert.equal(reset.currentStep, "mode");
  assert.equal(reset.soulConfirmed, false);
  assert.deepEqual(calls.slice(-2), [
    ["kill", "sandbox-1"],
    ["reset-channel", "instance-1"],
  ]);
});

test("resetNewUser can abandon an undeletable Sandbox and continue onboarding", async () => {
  const { calls, controller } = fixture();
  await controller.startLobsterMode();

  const reset = await controller.resetNewUser({ skipSandboxCleanup: true });

  assert.equal(reset.mode, "idle");
  assert.equal(reset.cleanupSkipped, true);
  assert.equal(reset.orphanedSandboxId, "sandbox-1");
  assert.equal(calls.some(([name]) => name === "kill"), false);
  assert.deepEqual(calls.at(-1), ["reset-channel", "instance-1"]);
});

test("an in-flight bootstrap cannot restore stale state after reset", async () => {
  let finishBootstrap;
  const bootstrapPending = new Promise((resolve) => {
    finishBootstrap = resolve;
  });
  const controller = new CloudConsoleController({
    adapter: {
      async createSandbox() { return { sandboxId: "sandbox-1" }; },
      async killSandbox() {},
    },
    saga: {
      async prepareSandbox() {},
      async bootstrapSandbox() {
        await bootstrapPending;
        return { connectionId: "stale-connection" };
      },
    },
    simulator: { resetInstance() {} },
    instanceIdFactory: () => "instance-1",
    traceIdFactory: () => "trace-1",
    buildConfig: () => ({}),
  });
  await controller.startLobsterMode();
  const confirming = controller.confirmSoul("# Pending");

  const reset = await controller.resetNewUser();
  finishBootstrap();

  await assert.rejects(confirming, /重置新用户取消/);
  assert.equal(reset.mode, "idle");
  assert.deepEqual(controller.getStatus(), reset);
});
