import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createPythonE2BClientFactory } from "../src/python-e2b-client.js";

function fakeSpawner({ diagnostic } = {}) {
  const calls = [];
  const requests = [];
  const spawnImpl = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new Writable({
      write(chunk, _encoding, callback) {
        const request = JSON.parse(chunk.toString());
        requests.push(request);
        const results = {
          create: { sandboxId: "sandbox-1" },
          connect: { sandboxId: request.params.sandboxId },
          command: { exitCode: 0, stdout: "ok", stderr: "" },
          writeFile: { written: true },
          readFile: { content: "hello" },
          pause: { paused: true },
          kill: { killed: true },
        };
        queueMicrotask(() => {
          child.stdout.write(`${JSON.stringify({
            id: request.id,
            result: results[request.op],
            ...(diagnostic ? { diagnostic } : {}),
          })}\n`);
        });
        callback();
      },
    });
    child.kill = () => child.emit("exit", 0, null);
    return child;
  };
  return { calls, requests, spawnImpl };
}

test("maps the adapter client contract to a long-lived Python JSON bridge", async () => {
  const fake = fakeSpawner();
  const factory = createPythonE2BClientFactory({
    pythonPath: "/venv/bin/python",
    bridgePath: "/app/e2b-bridge.py",
    spawnImpl: fake.spawnImpl,
  });
  const client = factory({
    apiKey: "runtime-secret",
    baseUrl: "http://sandbox-manager.sandbox-system.svc.cluster.local:7788",
    sandboxUrl: "http://envd-gateway.sandbox-system.svc.cluster.local:49983",
    requestTimeoutMs: 30_000,
    sdkPatch: "none",
  });
  const session = await client.create({ template: "onyxclaw", timeoutSeconds: 300 });

  assert.equal(session.sandboxId, "sandbox-1");
  assert.deepEqual(await session.runCommand("id", { user: "node" }), {
    exitCode: 0,
    stdout: "ok",
    stderr: "",
  });
  await session.writeFile("/tmp/test", "hello", { user: "node" });
  assert.equal(await session.readFile("/tmp/test", { user: "node" }), "hello");
  await session.pause();
  await session.resume();
  await session.kill();

  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].command, "/venv/bin/python");
  assert.deepEqual(fake.calls[0].args, ["/app/e2b-bridge.py"]);
  assert.equal(fake.calls[0].options.env.E2B_API_KEY, "runtime-secret");
  assert.equal(fake.calls[0].options.env.E2B_BASE_URL, "http://sandbox-manager.sandbox-system.svc.cluster.local:7788");
  assert.equal(
    fake.calls[0].options.env.E2B_SANDBOX_URL,
    "http://envd-gateway.sandbox-system.svc.cluster.local:49983",
  );
  assert.equal(
    fake.calls[0].options.env.E2B_SDK_PATCH,
    "none",
  );
  assert.equal(fake.calls[0].options.env.E2B_DATA_SESSION_WAIT_SECONDS, "5");
  assert.doesNotMatch(JSON.stringify(fake.requests), /runtime-secret/);
  assert.deepEqual(fake.requests.map(({ op }) => op), [
    "create",
    "command",
    "writeFile",
    "readFile",
    "pause",
    "connect",
    "kill",
  ]);
});

test("logs safe routing snapshots that correlate connect and data operations", async () => {
  const diagnostic = {
    sandboxId: "sandbox-1",
    sessionGeneration: 2,
    claimedSandboxDomain: "dynamic.example.internal",
    fixedSandboxUrlHost: "gateway.example.internal",
    fixedSandboxUrlPort: 49983,
    trafficToken: { present: true, length: 20, sha256: "0123456789ab" },
    envdToken: { present: true, length: 24, sha256: "abcdef012345" },
    headerNames: ["E2b-Sandbox-Id", "E2B-Traffic-Access-Token"],
    sandboxIdHeaderMatches: true,
    sandboxPortHeaderMatches: true,
    trafficHeaderMatches: true,
    elapsedMs: 17,
  };
  const fake = fakeSpawner({ diagnostic });
  const logs = [];
  const client = createPythonE2BClientFactory({
    spawnImpl: fake.spawnImpl,
    logger: (record) => logs.push(record),
  })({
    apiKey: "runtime-secret",
    baseUrl: "http://127.0.0.1:18081",
    requestTimeoutMs: 1000,
  });

  const session = await client.connect("sandbox-1");
  await session.writeFile("/tmp/openclaw.json", "{}");

  assert.deepEqual(logs.map((record) => ({
    event: record.event,
    operation: record.operation,
    outcome: record.outcome,
    generation: record.routing.sessionGeneration,
  })), [
    {
      event: "e2b.bridge.routing_snapshot",
      operation: "connect",
      outcome: "succeeded",
      generation: 2,
    },
    {
      event: "e2b.bridge.routing_snapshot",
      operation: "writeFile",
      outcome: "succeeded",
      generation: 2,
    },
  ]);
  assert.doesNotMatch(JSON.stringify(logs), /runtime-secret/);
});

test("surfaces detailed bridge errors and logs redacted bridge stderr", async () => {
  const fake = fakeSpawner();
  const logs = [];
  const original = fake.spawnImpl;
  fake.spawnImpl = (...args) => {
    const child = original(...args);
    queueMicrotask(() =>
      child.stderr.write("SDK traceback: api_key=runtime-secret\n"));
    child.stdin = new Writable({
      write(chunk, _encoding, callback) {
        const request = JSON.parse(chunk.toString());
        queueMicrotask(() => child.stdout.write(`${JSON.stringify({
          id: request.id,
          error: {
            code: "E2B_CREATE_FAILED",
            type: "AuthenticationException",
            message: "invalid credential",
            statusCode: 401,
            requestId: "cloud-request-1",
          },
          diagnostic: {
            sandboxId: "sandbox-1",
            sessionGeneration: 3,
            trafficToken: { present: true, length: 20, sha256: "0123456789ab" },
          },
        })}\n`));
        callback();
      },
    });
    return child;
  };
  const client = createPythonE2BClientFactory({
    spawnImpl: fake.spawnImpl,
    logger: (record) => logs.push(record),
  })({
    apiKey: "runtime-secret",
    baseUrl: "http://127.0.0.1:18081",
    requestTimeoutMs: 1000,
  });

  await assert.rejects(client.create({ template: "onyxclaw" }), (error) => {
    assert.equal(error.name, "AuthenticationException");
    assert.equal(error.code, "E2B_CREATE_FAILED");
    assert.equal(error.message, "invalid credential");
    assert.equal(error.statusCode, 401);
    assert.equal(error.requestId, "cloud-request-1");
    return true;
  });
  const stderrLog = logs.find(({ event }) => event === "e2b.bridge.stderr");
  assert.match(stderrLog.message, /\[REDACTED\]/);
  const routingLog = logs.find(({ event }) => event === "e2b.bridge.routing_snapshot");
  assert.equal(routingLog.operation, "create");
  assert.equal(routingLog.outcome, "failed");
  assert.equal(routingLog.routing.sessionGeneration, 3);
  assert.doesNotMatch(JSON.stringify(logs), /runtime-secret/);
});

test("Python bridge applies the provider patch before E2B import and returns safe errors", async () => {
  const source = await readFile(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/e2b-bridge.py"),
    "utf8",
  );
  assert.ok(source.indexOf("sdk_patch ==") < source.indexOf("from e2b import Sandbox"));
  assert.ok(source.indexOf("patch_e2b(") < source.indexOf("from e2b import Sandbox"));
  assert.match(source, /os\.environ\["E2B_API_URL"\] = api_url/);
  assert.match(source, /"api_url": api_url/);
  assert.match(source, /sandbox_url=sandbox_url/);
  assert.match(source, /"E2B-Traffic-Access-Token"/);
  assert.match(source, /"E2b-Sandbox-Id"\] = session\.sandbox_id/);
  assert.match(source, /"E2b-Sandbox-Port"\] = str\(original\.envd_port\)/);
  assert.match(source, /traffic_access_token/);
  assert.match(source, /def connection_snapshot\(sandbox_id\):/);
  assert.match(source, /sessionGeneration/);
  assert.match(source, /hashlib\.sha256/);
  assert.match(source, /response\["diagnostic"\]/);
  assert.match(source, /"create"|op == "create"/);
  assert.match(source, /"connect"|op == "connect"/);
  assert.match(source, /"command"|op == "command"/);
  assert.match(source, /"writeFile"|op == "writeFile"/);
  assert.match(source, /"readFile"|op == "readFile"/);
  assert.match(source, /"kill"|op == "kill"/);
  assert.match(source, /"pause"|op == "pause"/);
  assert.match(source, /on_timeout/);
  assert.match(source, /control_api_options/);
  assert.doesNotMatch(source, /is_control_auth_error/);
  assert.doesNotMatch(source, /run_control_operation/);
  assert.match(source, /claimed = Sandbox\.create\(/);
  assert.match(source, /Sandbox\.pause\(sandbox_id, \*\*control_api_options\(\)\)/);
  assert.match(source, /Sandbox\.connect\(sandbox_id, \*\*control_api_options\(\)\)/);
  assert.match(source, /claimed\.kill\(\)/);
  assert.match(source, /def session_for\(sandbox_id\):/);
  assert.match(source, /def connect_session\(sandbox_id\):/);
  assert.match(source, /if sandbox_id not in sessions:/);
  assert.doesNotMatch(source, /connect_session\(sandbox_id, refresh=True\)/);
  assert.ok(source.indexOf('if op == "create":') < source.indexOf('if op == "pause":'));
  assert.ok(source.indexOf('if op == "pause":') < source.indexOf('if op == "connect":'));
  assert.ok(source.indexOf('if op == "connect":') < source.indexOf('if op == "kill":'));
  const pauseBlock = source.slice(
    source.indexOf('if op == "pause":'),
    source.indexOf('if op == "connect":'),
  );
  assert.doesNotMatch(pauseBlock, /sessions\.pop/);
  const connectBlock = source.slice(
    source.indexOf('if op == "connect":'),
    source.indexOf('if op == "kill":'),
  );
  assert.match(connectBlock, /connect_session\(sandbox_id\)/);
  const connectSessionBlock = source.slice(
    source.indexOf("def connect_session(sandbox_id):"),
    source.indexOf("def run_data_operation("),
  );
  assert.match(
    connectSessionBlock,
    /claimed = Sandbox\.connect\(sandbox_id, \*\*control_api_options\(\)\)/,
  );
  assert.match(
    connectSessionBlock,
    /sessions\[sandbox_id\] = \(claimed, routed\(claimed\)\)/,
  );
  assert.match(source, /if not sandbox_url and not route_domain and not traffic_token:/);
  const killBlock = source.slice(
    source.indexOf('if op == "kill":'),
    source.indexOf('_, session = session_for(sandbox_id)'),
  );
  assert.ok(killBlock.indexOf("claimed.kill()") < killBlock.indexOf("sessions.pop"));
  assert.doesNotMatch(killBlock, /connect_session/);
  const dataBlock = source.slice(source.indexOf('_, session = session_for(sandbox_id)'));
  assert.doesNotMatch(dataBlock, /connect_session/);
  assert.match(source, /run_data_operation/);
  assert.match(source, /session\(\?: id\)\? not found/);
  assert.match(source, /E2B_DATA_SESSION_WAIT_SECONDS/);
  assert.match(source, /time\.monotonic/);
  assert.match(source, /"statusCode"/);
  assert.match(source, /"requestId"/);
  assert.doesNotMatch(source, /print\([^\n]*(E2B_API_KEY|api_key)/);
});
