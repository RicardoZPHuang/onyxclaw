import assert from "node:assert/strict";
import test from "node:test";

import { createSandboxServiceMonitor } from "../src/observability.js";

test("monitor records only Sandbox Service API metadata and backend objects", () => {
  let now = 1_000;
  const monitor = createSandboxServiceMonitor({ now: () => now });
  const callId = monitor.begin({
    api: "Files.write",
    target: "AgentSphere Sandbox envd",
    object: { type: "File", id: "/home/node/.openclaw/bootstrap/SOUL.md", state: "writing" },
    content: "must never be retained",
    command: "must never be retained either",
  });

  now = 1_125;
  let snapshot = monitor.snapshot();
  assert.deepEqual(
    snapshot.calls.map(({ api, target, state, durationMs, object }) => ({
      api, target, state, durationMs, object,
    })),
    [{
      api: "Files.write",
      target: "AgentSphere Sandbox envd",
      state: "running",
      durationMs: 125,
      object: {
        type: "File",
        id: "/home/node/.openclaw/bootstrap/SOUL.md",
        state: "writing",
      },
    }],
  );
  assert.doesNotMatch(JSON.stringify(snapshot), /must never be retained/);

  now = 1_240;
  monitor.succeed(callId, {
    object: { type: "File", id: "/home/node/.openclaw/bootstrap/SOUL.md", state: "written" },
  });
  snapshot = monitor.snapshot();
  assert.equal(snapshot.calls[0].state, "succeeded");
  assert.equal(snapshot.calls[0].durationMs, 240);
  assert.equal(snapshot.objects[0].state, "written");
});

test("monitor updates Sandbox object lifecycle and retains bounded history", () => {
  let now = 0;
  const monitor = createSandboxServiceMonitor({ now: () => now, historyLimit: 2 });
  const create = monitor.begin({ api: "Sandbox.create", target: "Sandbox Manager" });
  now += 10;
  monitor.succeed(create, {
    object: { type: "Sandbox", id: "sandbox-1", state: "running" },
  });
  const command = monitor.begin({
    api: "Commands.run",
    target: "Sandbox envd",
    object: { type: "Process", id: "sandbox-1", state: "running" },
    command: "secret command",
    operationContext: { label: "COMMAND", value: "node --check app.js" },
  });
  now += 20;
  monitor.fail(command, {
    object: { type: "Process", id: "sandbox-1", state: "failed" },
    error: {
      name: "CommandException",
      code: "COMMAND_FAILED",
      message: "envd returned 503",
      statusCode: 503,
      requestId: "request-1",
      unsafe: "must not be retained",
    },
  });
  const kill = monitor.begin({
    api: "Sandbox.kill",
    target: "Sandbox Manager",
    object: { type: "Sandbox", id: "sandbox-1", state: "terminating" },
  });
  now += 30;
  monitor.succeed(kill, {
    object: { type: "Sandbox", id: "sandbox-1", state: "terminated" },
  });

  const snapshot = monitor.snapshot();
  assert.deepEqual(snapshot.calls.map((call) => call.api), ["Sandbox.kill", "Commands.run"]);
  assert.equal(snapshot.calls[1].state, "failed");
  assert.deepEqual(snapshot.calls[1].operationContext, {
    label: "COMMAND",
    value: "node --check app.js",
  });
  assert.deepEqual(snapshot.calls[1].error, {
    name: "CommandException",
    code: "COMMAND_FAILED",
    message: "envd returned 503",
    statusCode: 503,
    requestId: "request-1",
  });
  assert.equal(snapshot.objects.find((object) => object.type === "Sandbox").state, "terminated");
  assert.doesNotMatch(JSON.stringify(snapshot), /secret command|must not be retained/);
});

test("monitor exposes operation context while running and after success", () => {
  const monitor = createSandboxServiceMonitor({ now: () => 0 });
  const callId = monitor.begin({
    api: "Commands.run",
    target: "Sandbox envd",
    operationContext: { label: "COMMAND", value: "pwd" },
  });
  assert.deepEqual(monitor.snapshot().calls[0].operationContext, {
    label: "COMMAND",
    value: "pwd",
  });
  monitor.succeed(callId);
  assert.deepEqual(monitor.snapshot().calls[0].operationContext, {
    label: "COMMAND",
    value: "pwd",
  });
});

test("reset clears the live activity, history, and tracked objects for a new tenant", () => {
  const monitor = createSandboxServiceMonitor({ now: () => 0 });
  const callId = monitor.begin({ api: "Sandbox.create", target: "Sandbox Manager" });
  monitor.succeed(callId, {
    object: { type: "Sandbox", id: "sandbox-1", state: "running" },
  });
  assert.equal(monitor.snapshot().calls.length, 1);
  assert.equal(monitor.snapshot().objects.length, 1);

  monitor.reset();

  const snapshot = monitor.snapshot();
  assert.deepEqual(snapshot.calls, []);
  assert.deepEqual(snapshot.objects, []);
});
