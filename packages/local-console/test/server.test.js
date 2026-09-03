import assert from "node:assert/strict";
import test from "node:test";

import { createSandboxServiceMonitor } from "../src/observability.js";
import { createLocalConsoleServer } from "../src/server.js";

function createController() {
  return {
    getStatus: () => ({ mode: "idle", instanceId: "local-mac" }),
    startLobsterMode: async () => ({ mode: "connected", connectionId: "c-1" }),
    stopLobsterMode: async () => ({ mode: "idle" }),
    pauseLobsterMode: async () => ({ mode: "paused", connectionId: null }),
    resumeLobsterMode: async () => ({ mode: "connected", connectionId: "c-2" }),
    resetNewUser: async () => ({ mode: "idle", currentStep: "mode", soulConfirmed: false }),
    getSoul: async () => ({ content: "# Soul\n", sha256: "abc", size: 7 }),
    saveSoul: async (content) => ({ content, sha256: "def", size: content.length }),
    restoreSoul: async () => ({ content: "# Original\n", sha256: "old", size: 11 }),
    confirmSoul: async (content) => ({
      content,
      sha256: "confirmed",
      soulConfirmed: true,
      currentStep: "chat",
    }),
    sendMessage: async (text) => ({ text: `reply:${text}`, durationMs: 4 }),
    sayHello: async () => ({ text: "personality hello", alreadySent: false }),
  };
}

test("Phase 1 API exposes status, lobster mode, SOUL, and chat", async (t) => {
  const app = createLocalConsoleServer({
    controller: createController(),
    host: "127.0.0.1",
    port: 0,
  });
  await app.start();
  t.after(() => app.stop({ cleanup: false }));

  const status = await fetch(`${app.url}/api/status`).then((response) => response.json());
  assert.equal(status.mode, "idle");

  const started = await fetch(`${app.url}/api/lobster/start`, {
    method: "POST",
    headers: { "x-onyxclaw-request": "local-ui" },
  }).then((response) => response.json());
  assert.equal(started.connectionId, "c-1");

  const paused = await fetch(`${app.url}/api/lobster/pause`, {
    method: "POST",
    headers: { "x-onyxclaw-request": "local-ui" },
  }).then((response) => response.json());
  assert.equal(paused.mode, "paused");

  const resumed = await fetch(`${app.url}/api/lobster/resume`, {
    method: "POST",
    headers: { "x-onyxclaw-request": "local-ui" },
  }).then((response) => response.json());
  assert.equal(resumed.connectionId, "c-2");

  const soul = await fetch(`${app.url}/api/soul`).then((response) => response.json());
  assert.equal(soul.content, "# Soul\n");

  const saved = await fetch(`${app.url}/api/soul`, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      "x-onyxclaw-request": "local-ui",
    },
    body: JSON.stringify({ content: "updated" }),
  }).then((response) => response.json());
  assert.equal(saved.sha256, "def");

  const confirmed = await fetch(`${app.url}/api/soul/confirm`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-onyxclaw-request": "local-ui",
    },
    body: JSON.stringify({ content: "updated" }),
  }).then((response) => response.json());
  assert.equal(confirmed.soulConfirmed, true);

  const hello = await fetch(`${app.url}/api/chat/hello`, {
    method: "POST",
    headers: { "x-onyxclaw-request": "local-ui" },
  }).then((response) => response.json());
  assert.equal(hello.text, "personality hello");

  const chat = await fetch(`${app.url}/api/chat`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-onyxclaw-request": "local-ui",
    },
    body: JSON.stringify({ text: "hello" }),
  }).then((response) => response.json());
  assert.equal(chat.text, "reply:hello");
});

test("UI config exposes safe runtime identity without provider secrets", async (t) => {
  const app = createLocalConsoleServer({
    controller: createController(),
    host: "127.0.0.1",
    port: 0,
    uiConfig: {
      deploymentMode: "cloud",
      providerId: "huaweicloud-agentsphere",
      providerName: "Huawei Cloud AgentSphere Sandbox",
      region: "cn-south-1",
      templateId: "agentsphere-template",
      gatewayPort: 18789,
      e2bHost: "agentsphere.example.internal",
      protocol: "e2b-compatible",
      capabilities: {
        pauseResume: true,
        memoryPersistence: true,
        publicEgress: true,
        vpc: true,
      },
    },
  });
  await app.start();
  t.after(() => app.stop({ cleanup: false }));

  const config = await fetch(`${app.url}/api/ui-config`).then((response) => response.json());

  assert.deepEqual(config, {
    deploymentMode: "cloud",
    providerId: "huaweicloud-agentsphere",
    providerName: "Huawei Cloud AgentSphere Sandbox",
    region: "cn-south-1",
    templateId: "agentsphere-template",
    gatewayPort: 18789,
    e2bHost: "agentsphere.example.internal",
    protocol: "e2b-compatible",
    capabilities: {
      pauseResume: true,
      memoryPersistence: true,
      publicEgress: true,
      vpc: true,
    },
  });
  assert.doesNotMatch(JSON.stringify(config), /apiKey|secret|baseUrl/i);
});

test("API rejects malformed JSON and unknown routes", async (t) => {
  const app = createLocalConsoleServer({
    controller: createController(),
    host: "127.0.0.1",
    port: 0,
  });
  await app.start();
  t.after(() => app.stop({ cleanup: false }));

  const malformed = await fetch(`${app.url}/api/chat`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-onyxclaw-request": "local-ui",
    },
    body: "{",
  });
  assert.equal(malformed.status, 400);

  const missing = await fetch(`${app.url}/api/missing`);
  assert.equal(missing.status, 404);
});

test("mutating API rejects requests without the local UI header", async (t) => {
  const app = createLocalConsoleServer({
    controller: createController(),
    host: "127.0.0.1",
    port: 0,
  });
  await app.start();
  t.after(() => app.stop({ cleanup: false }));

  const response = await fetch(`${app.url}/api/lobster/start`, { method: "POST" });

  assert.equal(response.status, 403);
});

test("observability API reports only injected Sandbox Service calls and objects", async (t) => {
  const monitor = createSandboxServiceMonitor();
  const call = monitor.begin({ api: "Sandbox.create", target: "Sandbox Manager" });
  monitor.succeed(call, {
    object: { type: "Sandbox", id: "sandbox-1", state: "running" },
  });
  const app = createLocalConsoleServer({
    controller: createController(),
    operationMonitor: monitor,
    host: "127.0.0.1",
    port: 0,
  });
  await app.start();
  t.after(() => app.stop({ cleanup: false }));

  await fetch(`${app.url}/api/status`);
  const observation = await fetch(`${app.url}/api/observability`).then((response) => response.json());

  assert.equal(observation.calls[0].api, "Sandbox.create");
  assert.equal(observation.calls[0].state, "succeeded");
  assert.equal(observation.objects[0].id, "sandbox-1");
  assert.doesNotMatch(JSON.stringify(observation), /x-onyxclaw-request|content-type/);
});

test("ordinary BFF and OpenClaw calls do not enter Sandbox Service telemetry", async (t) => {
  const app = createLocalConsoleServer({
    controller: createController(),
    host: "127.0.0.1",
    port: 0,
  });
  await app.start();
  t.after(() => app.stop({ cleanup: false }));

  await fetch(`${app.url}/api/chat`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-onyxclaw-request": "local-ui",
    },
    body: JSON.stringify({ text: "not measured" }),
  });
  const observation = await fetch(`${app.url}/api/observability`).then((response) => response.json());
  assert.deepEqual(observation.calls, []);
  assert.deepEqual(observation.objects, []);
});

test("session reset returns the BFF to new-user state and clears Sandbox Service telemetry", async (t) => {
  const monitor = createSandboxServiceMonitor();
  const call = monitor.begin({ api: "Sandbox.create", target: "Sandbox Manager" });
  monitor.succeed(call, {
    object: { type: "Sandbox", id: "sandbox-1", state: "running" },
  });
  assert.equal(monitor.snapshot().calls.length, 1);

  let resetCalls = 0;
  let resetOptions;
  const controller = createController();
  controller.resetNewUser = async (options) => {
    resetCalls += 1;
    resetOptions = options;
    return {
      mode: "idle",
      currentStep: "mode",
      soulConfirmed: false,
      sandboxId: null,
      connectionId: null,
    };
  };
  const app = createLocalConsoleServer({
    controller,
    operationMonitor: monitor,
    host: "127.0.0.1",
    port: 0,
  });
  await app.start();
  t.after(() => app.stop({ cleanup: false }));

  const reset = await fetch(`${app.url}/api/session/reset`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-onyxclaw-request": "local-ui",
    },
    body: JSON.stringify({ skipSandboxCleanup: true }),
  }).then((response) => response.json());

  assert.equal(resetCalls, 1);
  assert.deepEqual(resetOptions, { skipSandboxCleanup: true });
  assert.equal(reset.mode, "idle");
  assert.equal(reset.soulConfirmed, false);
  assert.deepEqual(monitor.snapshot().calls, []);
  assert.deepEqual(monitor.snapshot().objects, []);
});

test("web UI exposes a single reset button, full-width architecture, and 5-column SDK calls", async (t) => {
  const app = createLocalConsoleServer({
    controller: createController(),
    host: "127.0.0.1",
    port: 0,
  });
  await app.start();
  t.after(() => app.stop({ cleanup: false }));

  const response = await fetch(app.url);
  const html = await response.text();
  const styles = await fetch(`${app.url}/styles.css`).then((result) => result.text());
  const browserApp = await fetch(`${app.url}/app.js`).then((result) => result.text());

  assert.equal(response.status, 200);
  assert.match(html, /龙虾模式/);
  assert.match(html, /性格设定/);
  assert.match(html, /对话龙虾/);
  assert.match(html, /id="reset-user"/);
  assert.match(html, /id="skip-reset"/);
  assert.match(html, /确认性格并继续/);
  assert.match(html, /data-step="soul"/);
  assert.doesNotMatch(html, /class="tab[^>]*>\s*<b>\d+<\/b>/);
  assert.match(html, /class="phone-frame"/);
  assert.match(html, /SYSTEM ARCHITECTURE/);
  assert.doesNotMatch(html, /API OBJECTS/);
  assert.match(html, /E2B SDK API/);
  assert.match(html, /id="architecture-map"/);
  assert.match(html, /手机APP UI/);
  assert.match(html, /后端管理平台/);
  assert.match(html, /AgentSphere 管理面/);
  assert.match(html, /E2B API Server/);
  assert.match(html, /E2B API\/SDK/);
  assert.match(html, /Sandbox实例/);
  assert.match(html, /data-edge="sandbox-model"/);
  assert.doesNotMatch(html, /data-edge="openclaw-model"/);
  assert.match(html, /name="color-scheme" content="light"/);
  assert.match(html, /id="api-call-list"/);
  assert.match(html, /id="api-summary"/);
  assert.match(html, /id="failed-api-list"/);
  assert.doesNotMatch(html, /id="resource-grid"/);
  // Removed multi-tenant entry controls
  assert.doesNotMatch(html, /id="cloud-entry"/);
  assert.doesNotMatch(html, /data-user-type="new"/);
  assert.doesNotMatch(html, /id="sandbox-id"/);
  assert.doesNotMatch(html, /id="start-mode"/);
  assert.doesNotMatch(html, /id="stop-mode"/);
  assert.doesNotMatch(html, /id="chat-stop"/);
  assert.doesNotMatch(html, /id="metric-mode"/);
  assert.doesNotMatch(html, /id="metric-connection"/);
  // 5-column SDK call table head
  assert.match(html, /<span>API<\/span>\s*<span>OBJECT<\/span>\s*<span>SERVICE<\/span>\s*<span>STATUS<\/span>\s*<span>TIME<\/span>/);
  assert.match(html, /src="\/app\.js"/);
  assert.match(styles, /body\s*\{[^}]*overflow-y:\s*auto/);
  assert.doesNotMatch(styles, /body\s*\{[^}]*overflow:\s*hidden/);
  assert.match(styles, /\.workbench\s*\{[\s\S]*?height:\s*calc\(100dvh - 84px\)/);
  assert.match(styles, /\.workbench\s*\{[\s\S]*?grid-template-columns:\s*minmax\(340px,\s*min\(420px,\s*30vw\)\)\s+minmax\(0,\s*1fr\)/);
  assert.match(styles, /\.customer-stage\s*\{[^}]*min-height:\s*0/);
  assert.match(styles, /\.phone-frame\s*\{[\s\S]*?aspect-ratio:\s*430\s*\/\s*780/);
  assert.match(styles, /\.phone-frame\s*\{[^}]*max-width:\s*100%/);
  // service-workbench is a 2-row layout with full-width architecture and SDK cards.
  assert.match(styles, /\.service-workbench\s*\{[\s\S]*?grid-template-rows:\s*minmax\(0,\s*1fr\)\s+minmax\(0,\s*1\.05fr\)/);
  assert.doesNotMatch(styles, /\.observability-top\s*\{[^}]*grid-template-columns/);
  assert.match(styles, /\.architecture-card\s*\{[^}]*width:\s*100%/);
  assert.doesNotMatch(styles, /\.cloud-entry/);
  assert.doesNotMatch(styles, /\.mini-metrics/);
  assert.match(styles, /\.api-table-head,\s*\.api-row\s*\{[\s\S]*?grid-template-columns:\s*minmax\(120px,\s*1\.05fr\)\s+minmax\(150px,\s*1\.25fr\)\s+minmax\(120px,\s*1fr\)\s+88px\s+64px/);
  assert.match(styles, /\.architecture-map\s*\{[^}]*width:\s*100%/);
  assert.match(styles, /\.console-card\s*\{[^}]*background:\s*#ffffff/);
  assert.match(styles, /#soul-editor\s*\{[^}]*background:\s*#ffffff/);
  assert.match(styles, /\.api-name b\s*\{[^}]*font:\s*750 12px/);
  assert.match(styles, /\.api-duration\s*\{[^}]*font:\s*750 11px/);
  assert.match(styles, /\.api-row\.failed\s*\{/);
  assert.match(styles, /\.api-operation-detail\s*\{/);
  assert.match(browserApp, /summarizeCalls\(calls\)/);
  assert.match(browserApp, /providerManagerLabel\.textContent\s*=\s*"E2B API Server"/);
  assert.match(browserApp, /call\.operationContext\?\.value/);
  assert.doesNotMatch(styles, /@media\s*\(max-width:\s*860px\)/);
  assert.match(styles, /@media\s*\(max-width:\s*1180px\)/);
  assert.match(styles, /@media\s*\(max-width:\s*680px\)/);
  assert.doesNotMatch(styles, /phone-hardware\s*\{[^}]*display:\s*none/);
  assert.match(styles, /\.composer textarea\s*\{[\s\S]*?caret-color:\s*var\(--coral-dark\)/);
  assert.match(styles, /\.composer\s*\{[^}]*flex:\s*0 0 auto/);
  assert.match(styles, /\.messages\s*\{[^}]*flex:\s*1 1 0/);
  assert.match(styles, /\.chat-panel\s*\{[^}]*overflow:\s*hidden/);
  assert.match(browserApp, /history\.scrollRestoration\s*=\s*"manual"/);
  assert.match(browserApp, /window\.scrollTo\(0,\s*0\)/);
  // UI no longer probes Sandbox ID / instance ID or metric states
  assert.doesNotMatch(browserApp, /buildStartPayload/);
  assert.doesNotMatch(browserApp, /cloudStartLabel/);
  assert.doesNotMatch(browserApp, /metricInstance/);
  assert.doesNotMatch(browserApp, /metricConnection/);
  // The single reset button handles enter + stop + reset
  assert.match(browserApp, /async function disconnectAndReset/);
  assert.match(browserApp, /skipSandboxCleanup/);
  assert.match(browserApp, /function beginNewUiSession/);
  assert.match(browserApp, /uiSessionAbortController\.abort\(\)/);
  assert.match(browserApp, /generation !== uiSessionGeneration/);
  assert.match(browserApp, /const chatReady = connected && status\.soulConfirmed && !helloLoading/);
  assert.match(browserApp, /if \(!text \|\| helloLoading\) return/);
  assert.match(browserApp, /async function enterLobsterMode/);
  assert.match(browserApp, /clearApiCallsUi/);
  assert.match(browserApp, /resolveTabState/);
  assert.match(browserApp, /document\.querySelectorAll\("\.tab"\)/);
  assert.doesNotMatch(
    browserApp,
    /function showStep[\s\S]*?scheduleViewportFit\(\)[\s\S]*?async function refreshStatus/,
  );
  assert.doesNotMatch(
    browserApp,
    /function addMessage[\s\S]*?scheduleViewportFit\(\)[\s\S]*?function resetChatView/,
  );
});
