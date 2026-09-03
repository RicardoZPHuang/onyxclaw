import assert from "node:assert/strict";
import test from "node:test";

import {
  E2BCompatibleAdapter,
  CloudRuntimeError,
  createE2BCompatibleAdapter,
} from "../src/e2b-compatible-adapter.js";
import { createSandboxServiceMonitor } from "../../local-console/src/observability.js";

function provider() {
  return {
    displayName: "Vendor A Sandbox",
    protocol: "e2b-compatible",
    api: {
      baseUrl: "http://127.0.0.1:18081",
      requestTimeoutMs: 30_000,
    },
    sandbox: {
      templateId: "onyxclaw",
      timeoutMs: 300_000,
      onTimeout: "pause",
      secure: false,
      defaultUser: "node",
      metadata: { "agentsandbox.storage.sfs": "configured-mount" },
    },
  };
}

function fixture({ createError, commandError, killError } = {}) {
  const calls = [];
  const files = new Map();
  const session = {
    sandboxId: "default--onyxclaw-test",
    async runCommand(command, options) {
      calls.push(["command", command, options]);
      if (commandError) throw commandError;
      return { exitCode: 0, stdout: "ok", stderr: "" };
    },
    async writeFile(path, content, options) {
      calls.push(["write", path, options]);
      files.set(path, content);
    },
    async readFile(path, options) {
      calls.push(["read", path, options]);
      return files.get(path);
    },
    async kill() {
      calls.push(["kill"]);
      if (killError) throw killError;
    },
    async pause() {
      calls.push(["pause"]);
    },
    async resume() {
      calls.push(["resume"]);
    },
  };
  const client = {
    async create(options) {
      calls.push(["create", options]);
      if (createError) throw createError;
      return session;
    },
    async connect(sandboxId) {
      calls.push(["connect", sandboxId]);
      return { ...session, sandboxId };
    },
  };
  const clientFactory = (options) => {
    calls.push(["factory", options]);
    return client;
  };
  return { calls, clientFactory };
}

test("maps provider configuration into an E2B-compatible client", async () => {
  const { calls, clientFactory } = fixture();
  const adapter = new E2BCompatibleAdapter({
    provider: provider(),
    secrets: { apiKey: "runtime-secret" },
    clientFactory,
  });

  const created = await adapter.createSandbox({
    metadata: { traceId: "trace-1" },
    envs: { ONYXCLAW_INSTANCE_ID: "instance-1" },
  });

  assert.deepEqual(created, {
    sandboxId: "default--onyxclaw-test",
    status: "running",
  });
  assert.deepEqual(calls[0], ["factory", {
    apiKey: "runtime-secret",
    baseUrl: "http://127.0.0.1:18081",
    requestTimeoutMs: 30_000,
    sdkPatch: "none",
  }]);
  assert.deepEqual(calls[1], ["create", {
    template: "onyxclaw",
    timeoutSeconds: 300,
    onTimeout: "pause",
    secure: false,
    metadata: {
      "agentsandbox.storage.sfs": "configured-mount",
      traceId: "trace-1",
    },
    envs: { ONYXCLAW_INSTANCE_ID: "instance-1" },
  }]);
});

test("pause and resume preserve the session created with the Sandbox", async () => {
  const { calls, clientFactory } = fixture();
  const adapter = new E2BCompatibleAdapter({
    provider: provider(),
    secrets: { apiKey: "runtime-secret" },
    clientFactory,
  });
  const { sandboxId } = await adapter.createSandbox();

  await adapter.pauseSandbox(sandboxId);
  await adapter.connectSandbox(sandboxId);
  await adapter.readFile(sandboxId, "/home/node/.openclaw/workspace/SOUL.md");

  assert.deepEqual(calls.slice(2), [
    ["pause"],
    ["resume"],
    ["read", "/home/node/.openclaw/workspace/SOUL.md", { user: "node" }],
  ]);
  assert.equal(calls.some(([name]) => name === "connect"), false);
});

test("reset cleanup isolates a second Sandbox lifecycle from the first", async () => {
  const calls = [];
  let createCount = 0;
  const clientFactory = () => ({
    async create() {
      createCount += 1;
      const sandboxId = `sandbox-${createCount}`;
      return {
        sandboxId,
        async pause() { calls.push(["pause", sandboxId]); },
        async resume() { calls.push(["resume", sandboxId]); },
        async kill() { calls.push(["kill", sandboxId]); },
        async readFile() { calls.push(["read", sandboxId]); return "soul"; },
      };
    },
    async connect(sandboxId) {
      calls.push(["unexpected-connect", sandboxId]);
      throw new Error("create-time session was lost");
    },
  });
  const adapter = new E2BCompatibleAdapter({
    provider: provider(),
    secrets: { apiKey: "runtime-secret" },
    clientFactory,
  });

  const first = await adapter.createSandbox();
  await adapter.pauseSandbox(first.sandboxId);
  await adapter.connectSandbox(first.sandboxId);
  await adapter.killSandbox(first.sandboxId);

  const second = await adapter.createSandbox();
  await adapter.pauseSandbox(second.sandboxId);
  await adapter.connectSandbox(second.sandboxId);
  await adapter.readFile(second.sandboxId, "/home/node/.openclaw/workspace/SOUL.md");

  assert.deepEqual(calls, [
    ["pause", "sandbox-1"],
    ["resume", "sandbox-1"],
    ["kill", "sandbox-1"],
    ["pause", "sandbox-2"],
    ["resume", "sandbox-2"],
    ["read", "sandbox-2"],
  ]);
});

test("a failed kill preserves the existing session for later cleanup", async () => {
  const { calls, clientFactory } = fixture({ killError: new Error("temporary kill failure") });
  const adapter = new E2BCompatibleAdapter({
    provider: provider(),
    secrets: { apiKey: "runtime-secret" },
    clientFactory,
  });
  const { sandboxId } = await adapter.createSandbox();

  await assert.rejects(adapter.killSandbox(sandboxId), CloudRuntimeError);
  await adapter.runCommand(sandboxId, "id");

  assert.deepEqual(calls.slice(2), [
    ["kill"],
    ["command", "id", { user: "node" }],
  ]);
  assert.equal(calls.some(([name]) => name === "connect"), false);
});

test("uses the configured runtime user for commands and files, then kills", async () => {
  const { calls, clientFactory } = fixture();
  const adapter = new E2BCompatibleAdapter({
    provider: provider(),
    secrets: { apiKey: "runtime-secret" },
    clientFactory,
  });
  const { sandboxId } = await adapter.createSandbox();

  assert.deepEqual(await adapter.runCommand(sandboxId, "id"), {
    exitCode: 0,
    stdout: "ok",
    stderr: "",
  });
  await adapter.writeFile(sandboxId, "/home/node/test.txt", "hello");
  assert.equal(await adapter.readFile(sandboxId, "/home/node/test.txt"), "hello");
  await adapter.killSandbox(sandboxId);

  assert.deepEqual(calls.slice(2), [
    ["command", "id", { user: "node" }],
    ["write", "/home/node/test.txt", { user: "node" }],
    ["read", "/home/node/test.txt", { user: "node" }],
    ["kill"],
  ]);
});

test("connects an existing Sandbox ID before operating on it", async () => {
  const { calls, clientFactory } = fixture();
  const adapter = new E2BCompatibleAdapter({
    provider: provider(),
    secrets: { apiKey: "runtime-secret" },
    clientFactory,
  });

  assert.deepEqual(await adapter.connectSandbox("existing-sandbox"), {
    sandboxId: "existing-sandbox",
    status: "running",
  });
  await adapter.runCommand("existing-sandbox", "pwd");

  assert.deepEqual(calls.slice(1), [
    ["connect", "existing-sandbox"],
    ["command", "pwd", { user: "node" }],
  ]);
});

test("wraps provider failures with a stage and redacts secrets", async () => {
  const secret = "runtime-secret-value";
  const logs = [];
  const providerError = new Error(`authentication failed for ${secret}`);
  providerError.name = "AuthenticationException";
  providerError.code = "INVALID_API_KEY";
  providerError.statusCode = 401;
  providerError.requestId = "request-123";
  const { clientFactory } = fixture({
    createError: providerError,
  });
  const adapter = new E2BCompatibleAdapter({
    providerId: "vendor-a",
    provider: provider(),
    secrets: { apiKey: secret },
    clientFactory,
    logger: (record) => logs.push(record),
  });

  await assert.rejects(adapter.createSandbox(), (error) => {
    assert.ok(error instanceof CloudRuntimeError);
    assert.equal(error.stage, "create");
    assert.equal(error.providerId, "vendor-a");
    assert.equal(error.code, "CLOUD_RUNTIME_CREATE_FAILED");
    assert.equal(error.statusCode, 401);
    assert.equal(error.requestId, "request-123");
    assert.doesNotMatch(error.message, /provider-specific private protocol/i);
    assert.doesNotMatch(error.message, new RegExp(secret));
    assert.match(error.message, /\[REDACTED\]/);
    return true;
  });
  assert.deepEqual(logs, [{
    level: "error",
    event: "sandbox.provider.operation_failed",
    providerId: "vendor-a",
    providerName: "Vendor A Sandbox",
    protocol: "e2b-compatible",
    stage: "create",
    api: "Sandbox.create",
    target: "E2B-Compatible Sandbox API",
    error: {
      name: "AuthenticationException",
      code: "INVALID_API_KEY",
      message: "authentication failed for [REDACTED]",
      statusCode: 401,
      requestId: "request-123",
    },
  }]);
});

test("records real E2B SDK timings, operation details, and backend objects without file content", async () => {
  let now = 100;
  const operationMonitor = createSandboxServiceMonitor({ now: () => now });
  const { clientFactory } = fixture();
  const adapter = new E2BCompatibleAdapter({
    provider: provider(),
    secrets: { apiKey: "runtime-secret" },
    clientFactory,
    operationMonitor,
  });

  const { sandboxId } = await adapter.createSandbox();
  now += 11;
  await adapter.writeFile(sandboxId, "/home/node/test.txt", "private file content");
  now += 12;
  await adapter.readFile(sandboxId, "/home/node/test.txt");
  now += 13;
  await adapter.runCommand(sandboxId, "private command");
  now += 14;
  await adapter.killSandbox(sandboxId);

  const snapshot = operationMonitor.snapshot();
  assert.deepEqual(snapshot.calls.map((call) => call.api), [
    "Sandbox.kill",
    "Commands.run",
    "Files.read",
    "Files.write",
    "Sandbox.create",
  ]);
  assert.deepEqual(snapshot.calls.map((call) => call.object.type), [
    "Sandbox",
    "Process",
    "File",
    "File",
    "Sandbox",
  ]);
  assert.equal(snapshot.calls[0].object.state, "terminated");
  assert.equal(snapshot.calls[1].object.state, "exited:0");
  assert.deepEqual(snapshot.calls[1].operationContext, {
    label: "COMMAND",
    value: "private command",
  });
  assert.deepEqual(snapshot.calls[2].operationContext, {
    label: "PATH",
    value: "/home/node/test.txt",
  });
  assert.doesNotMatch(JSON.stringify(snapshot), /private file content|runtime-secret/);
});

test("failed command telemetry includes the executed command with secrets redacted", async () => {
  const operationMonitor = createSandboxServiceMonitor({ now: () => 100 });
  const { clientFactory } = fixture({ commandError: new Error("command failed") });
  const adapter = new E2BCompatibleAdapter({
    provider: provider(),
    secrets: { apiKey: "runtime-secret" },
    clientFactory,
    operationMonitor,
  });
  const { sandboxId } = await adapter.createSandbox();
  await assert.rejects(
    adapter.runCommand(sandboxId, "curl -H 'Authorization: runtime-secret' --token hidden-value /readyz"),
    CloudRuntimeError,
  );

  const failed = operationMonitor.snapshot().calls[0];
  assert.equal(failed.state, "failed");
  assert.equal(failed.operationContext.label, "COMMAND");
  assert.match(failed.operationContext.value, /curl -H/);
  assert.match(failed.operationContext.value, /--token \[REDACTED\]/);
  assert.equal(failed.error.message, "command failed");
  assert.doesNotMatch(JSON.stringify(failed), /runtime-secret|hidden-value/);
});

test("builds the adapter from the shared provider registry", async () => {
  const { calls, clientFactory } = fixture();
  const registryCalls = [];
  const registry = {
    getProvider(providerId) {
      registryCalls.push(["provider", providerId]);
      return provider();
    },
    getSecrets(providerId) {
      registryCalls.push(["secrets", providerId]);
      return { apiKey: "runtime-secret" };
    },
  };

  const adapter = createE2BCompatibleAdapter({
    registry,
    providerId: "vendor-a",
    clientFactory,
  });
  await adapter.createSandbox();

  assert.deepEqual(registryCalls, [
    ["provider", "vendor-a"],
    ["secrets", "vendor-a"],
  ]);
  assert.equal(calls[0][0], "factory");
});
