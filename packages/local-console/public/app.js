import { resolveLandingView, resolveTabState } from "./ui-state.js";
import { architectureStateFor, formatDuration, summarizeCalls } from "./observability-ui.js";
import { calculateViewportFit } from "./viewport-fit.js";
import { runtimePresentation } from "./runtime-ui.js";

if ("scrollRestoration" in history) history.scrollRestoration = "manual";
window.scrollTo(0, 0);
requestAnimationFrame(() => window.scrollTo(0, 0));

const workspace = document.querySelector(".workspace-shell");
let fitFrame;

function fitWorkspaceToViewport() {
  workspace.classList.remove("viewport-fitted");
  workspace.style.removeProperty("left");
  workspace.style.removeProperty("transform");
  workspace.style.removeProperty("width");
  const contentWidth = workspace.offsetWidth;
  const contentHeight = Math.max(workspace.scrollHeight, workspace.offsetHeight);
  const fit = calculateViewportFit({
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    contentWidth,
    contentHeight,
  });
  if (!fit.enabled) return;
  workspace.classList.add("viewport-fitted");
  workspace.style.width = `${fit.renderWidth}px`;
  workspace.style.left = `${fit.left}px`;
  workspace.style.transform = `scale(${fit.scale})`;
  window.scrollTo(0, 0);
}

function scheduleViewportFit() {
  cancelAnimationFrame(fitFrame);
  fitFrame = requestAnimationFrame(fitWorkspaceToViewport);
}

window.addEventListener("resize", scheduleViewportFit);

const elements = {
  status: document.querySelector("#global-status"),
  statusText: document.querySelector("#global-status-text"),
  modeNotice: document.querySelector("#mode-notice"),
  soul: document.querySelector("#soul-editor"),
  soulSize: document.querySelector("#soul-size"),
  soulHash: document.querySelector("#soul-hash"),
  soulNotice: document.querySelector("#soul-notice"),
  confirmSoul: document.querySelector("#confirm-soul"),
  restoreSoul: document.querySelector("#restore-soul"),
  reloadSoul: document.querySelector("#reload-soul"),
  chatState: document.querySelector("#chat-state"),
  messages: document.querySelector("#messages"),
  chatForm: document.querySelector("#chat-form"),
  chatInput: document.querySelector("#chat-input"),
  send: document.querySelector(".send-button"),
  resetUser: document.querySelector("#reset-user"),
  skipReset: document.querySelector("#skip-reset"),
  apiCallList: document.querySelector("#api-call-list"),
  callsCount: document.querySelector("#calls-count"),
  callsTotal: document.querySelector("#calls-total"),
  callsSucceeded: document.querySelector("#calls-succeeded"),
  callsRunning: document.querySelector("#calls-running"),
  callsFailed: document.querySelector("#calls-failed"),
  failedApiSummary: document.querySelector("#failed-api-summary"),
  failedApiList: document.querySelector("#failed-api-list"),
  pollStatus: document.querySelector("#poll-status"),
  activeOperation: document.querySelector("#active-operation"),
  environmentLabel: document.querySelector("#environment-label"),
  modeCopy: document.querySelector("#mode-copy"),
  runtimeStrip: document.querySelector("#runtime-strip"),
  runtimeSandboxId: document.querySelector("#runtime-sandbox-id"),
  runtimeInstanceId: document.querySelector("#runtime-instance-id"),
  runtimeConnectionId: document.querySelector("#runtime-connection-id"),
  enterLobsterMode: document.querySelector("#enter-lobster-mode"),
  pauseSandbox: document.querySelector("#pause-sandbox"),
  resumeSandbox: document.querySelector("#resume-sandbox"),
  providerManagerLabel: document.querySelector("#provider-manager-label"),
  modelProviderLabel: document.querySelector("#model-provider-label"),
  modelNameLabel: document.querySelector("#model-name-label"),
};

let helloShown = false;
let helloLoading = false;
let initialLanding = true;
let uiConfig = { deploymentMode: "local" };
let currentCalls = [];
let uiSessionGeneration = 0;
let uiSessionAbortController = new AbortController();

function beginNewUiSession() {
  uiSessionGeneration += 1;
  uiSessionAbortController.abort();
  uiSessionAbortController = new AbortController();
  return uiSessionGeneration;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    signal: options.signal ?? uiSessionAbortController.signal,
    headers: {
      "x-onyxclaw-request": "local-ui",
      ...(options.body ? { "content-type": "application/json" } : {}),
    },
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body;
}

function notice(element, message, error = false) {
  element.textContent = message;
  element.classList.toggle("error", error);
  element.hidden = !message;
}

function applyRuntimePresentation(config) {
  const presentation = runtimePresentation(config);
  elements.environmentLabel.textContent = presentation.environmentLabel;
  elements.modeCopy.textContent = presentation.modeCopy;
  elements.providerManagerLabel.textContent = "E2B API Server";
  elements.modelProviderLabel.textContent = (config.modelProvider || "MODEL API").toUpperCase();
  elements.modelNameLabel.textContent = config.modelName || "Configured model";
  // The runtime strip is shown only in cloud mode (when the provider is
  // configured) so local macOS mode keeps the original phone layout.
  const cloud = config.deploymentMode === "cloud";
  elements.runtimeStrip.hidden = !cloud;
}

function renderRuntimeStrip(status) {
  if (!elements.runtimeStrip || elements.runtimeStrip.hidden) return;
  const sandboxId = status?.sandboxId ?? null;
  const instanceId = status?.instanceId ?? null;
  const connectionId = status?.connectionId ?? null;
  elements.runtimeSandboxId.textContent = sandboxId || "尚未创建 Sandbox";
  elements.runtimeSandboxId.title = sandboxId || "";
  elements.runtimeInstanceId.textContent = instanceId || "等待分配";
  elements.runtimeInstanceId.title = instanceId || "";
  elements.runtimeConnectionId.textContent = connectionId || "Channel 未连接";
  elements.runtimeConnectionId.title = connectionId || "";
}

function renderStatus(status) {
  const labels = {
    idle: "尚未连接",
    starting: "正在启动 OpenClaw…",
    allocated: "云端 Sandbox 已创建，等待确认性格",
    connected: "OpenClaw 已连接",
    pausing: "正在暂停 Sandbox…",
    paused: "Sandbox 已暂停",
    resuming: "正在恢复 Sandbox…",
    "resume-data-pending": "数据面尚未就绪，可重试恢复",
    "resume-confirmation": "已读取持久化性格，等待确认",
    error: "连接异常",
  };
  elements.status.className = `status-pill ${status.mode}`;
  elements.statusText.textContent = labels[status.mode] ?? status.mode;
  const connected = status.mode === "connected";
  const allocated = status.mode === "allocated";
  const chatReady = connected && status.soulConfirmed && !helloLoading;
  const busy = ["starting", "pausing", "resuming"].includes(status.mode);
  const pauseResume = uiConfig.deploymentMode === "cloud" &&
    uiConfig.capabilities?.pauseResume === true;
  const landing = resolveLandingView({ initialLanding, status });
  elements.resetUser.textContent = busy ? "正在重置…" : "重置新用户";
  elements.resetUser.disabled = busy;
  // The phone's CTA button only makes sense before a sandbox exists.
  elements.enterLobsterMode.disabled = busy;
  elements.enterLobsterMode.hidden = status.mode !== "idle";
  elements.enterLobsterMode.textContent = busy ? "正在进入…" : "进入龙虾模式";
  elements.pauseSandbox.hidden = !pauseResume || status.mode !== "connected";
  elements.pauseSandbox.disabled = busy;
  elements.resumeSandbox.hidden = !pauseResume ||
    !["paused", "resume-data-pending"].includes(status.mode);
  elements.resumeSandbox.disabled = busy;
  elements.resumeSandbox.textContent = status.mode === "resume-data-pending"
    ? "重试恢复"
    : "恢复";
  elements.chatInput.disabled = !chatReady;
  elements.send.disabled = !chatReady;
  elements.chatState.textContent = chatReady ? "已连接 · 可以发送" : "等待完成设置";
  const tabState = resolveTabState(status);
  document.querySelector(".tabs")?.classList.toggle("personality-confirmed", Boolean(status.soulConfirmed));
  document.querySelectorAll(".tab").forEach((tab) => {
    const state = tabState[tab.dataset.step];
    tab.disabled = !state?.enabled;
    tab.hidden = Boolean(state?.hidden);
  });
  showStep(landing.visibleStep, status);
  if (status.error) notice(elements.modeNotice, status.error, true);
}

function renderCalls(calls) {
  currentCalls = calls;
  elements.apiCallList.replaceChildren();
  const summary = summarizeCalls(calls);
  elements.callsTotal.textContent = String(summary.total);
  elements.callsSucceeded.textContent = String(summary.succeeded);
  elements.callsRunning.textContent = String(summary.running);
  elements.callsFailed.textContent = String(summary.failed);
  elements.failedApiList.replaceChildren();
  for (const failure of summary.failedApis) {
    const item = document.createElement("span");
    item.className = "failed-api-item";
    item.textContent = `${failure.api} ×${failure.count}`;
    elements.failedApiList.append(item);
  }
  elements.failedApiSummary.hidden = summary.failed === 0;
  if (!calls.length) {
    const empty = document.createElement("div");
    empty.className = "empty-activity";
    const glyph = document.createElement("span");
    glyph.textContent = "⌁";
    const copy = document.createElement("p");
    copy.textContent = "尚未调用 E2B SDK API。";
    empty.append(glyph, copy);
    elements.apiCallList.append(empty);
    elements.callsCount.textContent = "0";
    return;
  }
  for (const call of calls) {
    const row = document.createElement("article");
    row.className = `api-row ${call.state}`;
    const name = document.createElement("div");
    name.className = "api-name";
    const apiName = document.createElement("b");
    apiName.textContent = call.api;
    const object = document.createElement("small");
    object.className = "api-object";
    object.textContent = call.object
      ? `${call.object.type} · ${call.object.id}`
      : "等待后端对象";
    name.append(apiName);
    const target = document.createElement("span");
    target.className = "api-target";
    target.textContent = call.target;
    target.title = call.target;
    const state = document.createElement("span");
    state.className = `api-status ${call.state}`;
    state.textContent = call.state;
    const duration = document.createElement("span");
    duration.className = "api-duration";
    duration.textContent = formatDuration(call.durationMs);
    row.append(name, object, target, state, duration);
    if (call.operationContext?.value) {
      const detail = document.createElement("div");
      detail.className = "api-operation-detail";
      const label = document.createElement("strong");
      label.textContent = call.operationContext.label || "DETAIL";
      const value = document.createElement("code");
      value.textContent = call.operationContext.value;
      value.title = call.operationContext.value;
      detail.append(label, value);
      row.append(detail);
    }
    if (call.error?.message) {
      const detail = document.createElement("div");
      detail.className = "api-operation-detail api-error-detail";
      const label = document.createElement("strong");
      label.textContent = call.error.statusCode
        ? `ERROR ${call.error.statusCode}`
        : "ERROR";
      const value = document.createElement("code");
      value.textContent = call.error.message;
      value.title = call.error.requestId
        ? `${call.error.message} · requestId=${call.error.requestId}`
        : call.error.message;
      detail.append(label, value);
      row.append(detail);
    }
    elements.apiCallList.append(row);
  }
  elements.callsCount.textContent = String(calls.length);
}

function renderArchitecture(calls, objects) {
  const architecture = architectureStateFor(calls);
  document.querySelectorAll("[data-edge]").forEach((edge) => {
    edge.classList.toggle("active", architecture.edges.includes(edge.dataset.edge));
    edge.classList.toggle("recent", !architecture.activeApi && calls.length > 0 &&
      ["app-bff", "bff-e2b", "e2b-sandbox"].includes(edge.dataset.edge));
  });
  document.querySelectorAll("[data-node]").forEach((node) => {
    node.classList.toggle("active", architecture.nodes.includes(node.dataset.node));
    node.classList.remove("healthy", "error");
  });
  const sandboxObject = objects.find((object) => object.type === "Sandbox");
  if (sandboxObject?.state === "running") {
    document.querySelector('[data-node="sandbox"]')?.classList.add("healthy");
  } else if (sandboxObject?.state === "failed") {
    document.querySelector('[data-node="sandbox"]')?.classList.add("error");
  }
  const active = calls.find((call) => call.state === "running");
  elements.activeOperation.textContent = active
    ? `${active.api} · ${formatDuration(active.durationMs)}`
    : calls[0]
      ? `${calls[0].api} · ${calls[0].state}`
      : "等待 Sandbox Service 调用";
}

async function refreshObservability() {
  const generation = uiSessionGeneration;
  try {
    const observation = await api("/api/observability");
    if (generation !== uiSessionGeneration) return;
    renderCalls(observation.calls);
    renderArchitecture(observation.calls, observation.objects);
    elements.pollStatus.textContent = "LIVE";
    elements.pollStatus.className = "poll-status ready";
  } catch {
    if (generation !== uiSessionGeneration) return;
    elements.pollStatus.textContent = "OFFLINE";
    elements.pollStatus.className = "poll-status error";
  }
}

function clearApiCallsUi() {
  currentCalls = [];
  elements.apiCallList.replaceChildren();
  const empty = document.createElement("div");
  empty.className = "empty-activity";
  const glyph = document.createElement("span");
  glyph.textContent = "⌁";
  const copy = document.createElement("p");
  copy.textContent = "尚未调用 E2B SDK API。";
  empty.append(glyph, copy);
  elements.apiCallList.append(empty);
  elements.callsCount.textContent = "0";
  elements.callsTotal.textContent = "0";
  elements.callsSucceeded.textContent = "0";
  elements.callsRunning.textContent = "0";
  elements.callsFailed.textContent = "0";
  elements.failedApiList.replaceChildren();
  elements.failedApiSummary.hidden = true;
}

function showStep(step, status = {}) {
  document.querySelectorAll(".panel").forEach((item) => item.classList.remove("active"));
  document.querySelector(`#panel-${step}`)?.classList.add("active");
  document.querySelectorAll(".tab").forEach((item) => {
    const order = { mode: 1, soul: 2, chat: 3 };
    item.classList.toggle("active", item.dataset.step === step);
    item.classList.toggle("complete", order[item.dataset.step] < order[step]);
  });
  if (step === "soul") void loadSoul();
  if (step === "chat" && status.soulConfirmed) void ensureHello();
}

async function refreshStatus() {
  const status = await api("/api/status");
  renderStatus(status);
  renderRuntimeStrip(status);
}

function renderSoul(file) {
  elements.soul.value = file.content;
  elements.soulSize.textContent = `${file.size} bytes`;
  elements.soulHash.textContent = `SHA-256 ${file.sha256.slice(0, 16)}…`;
}

async function loadSoul() {
  const generation = uiSessionGeneration;
  elements.soul.disabled = true;
  try {
    const soul = await api("/api/soul");
    if (generation !== uiSessionGeneration) return;
    renderSoul(soul);
    notice(elements.soulNotice, "");
  } catch (error) {
    if (generation !== uiSessionGeneration) return;
    notice(elements.soulNotice, error.message, true);
  } finally {
    if (generation !== uiSessionGeneration) return;
    elements.soul.disabled = false;
  }
}

function addMessage(role, text, metadata) {
  document.querySelector(".empty-chat")?.remove();
  const message = document.createElement("div");
  message.className = `message ${role}`;
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.textContent = text;
  const meta = document.createElement("div");
  meta.className = "message-meta";
  meta.textContent = metadata;
  message.append(bubble, meta);
  elements.messages.append(message);
  elements.messages.scrollTop = elements.messages.scrollHeight;
}

function resetChatView() {
  elements.messages.replaceChildren();
  const empty = document.createElement("div");
  empty.className = "empty-chat";
  const glyph = document.createElement("div");
  glyph.textContent = "⌁";
  const copy = document.createElement("p");
  copy.textContent = "龙虾准备好后会先向你问好。";
  empty.append(glyph, copy);
  elements.messages.append(empty);
  elements.chatInput.value = "";
}

async function ensureHello() {
  if (helloShown || helloLoading) return;
  const generation = uiSessionGeneration;
  helloLoading = true;
  elements.chatInput.disabled = true;
  elements.send.disabled = true;
  elements.chatState.textContent = "龙虾正在准备第一声问候…";
  try {
    const hello = await api("/api/chat/hello", { method: "POST" });
    if (generation !== uiSessionGeneration) return;
    addMessage(
      "assistant",
      hello.text,
      `OpenClaw · 性格问候 · ${hello.durationMs} ms`,
    );
    helloShown = true;
  } catch (error) {
    if (generation !== uiSessionGeneration) return;
    addMessage("assistant", `问候生成失败：${error.message}`, "系统 · 可以刷新重试");
  } finally {
    if (generation !== uiSessionGeneration) return;
    helloLoading = false;
    elements.chatInput.disabled = false;
    elements.send.disabled = false;
    elements.chatState.textContent = "已连接 · 可以发送";
  }
}

async function enterLobsterMode() {
  elements.resetUser.disabled = true;
  notice(elements.modeNotice, "正在调用后端服务并准备 OpenClaw，请稍候…");
  try {
    const current = await api("/api/status");
    initialLanding = false;
    if (current.mode === "connected") {
      elements.resetUser.disabled = false;
      return;
    }
    renderStatus({ ...current, mode: "starting" });
    const status = await api("/api/lobster/start", { method: "POST" });
    renderStatus(status);
    notice(elements.modeNotice, "龙虾模式已就绪，可以编辑性格或开始对话。");
  } catch (error) {
    await refreshStatus();
    notice(elements.modeNotice, error.message, true);
  } finally {
    elements.resetUser.disabled = false;
  }
}

async function disconnectAndReset({ skipSandboxCleanup = false } = {}) {
  beginNewUiSession();
  elements.resetUser.disabled = true;
  elements.skipReset.disabled = true;
  initialLanding = false;
  showStep("mode");
  notice(elements.modeNotice, skipSandboxCleanup
    ? "正在跳过 Sandbox 清理并重置本地用户状态…"
    : uiConfig.deploymentMode === "cloud"
      ? "正在清理云端 Sandbox 和 Channel 连接…"
    : "正在禁用测试 Channel 并清理连接…");
  try {
    const status = await api("/api/session/reset", {
      method: "POST",
      body: JSON.stringify({ skipSandboxCleanup }),
    });
    helloShown = false;
    helloLoading = false;
    initialLanding = true;
    resetChatView();
    clearApiCallsUi();
    renderStatus(status);
    elements.skipReset.hidden = true;
    notice(elements.modeNotice, status.cleanupSkipped
      ? `已跳过旧 Sandbox 清理并重置用户。遗留 Sandbox：${status.orphanedSandboxId || "未知"}，请稍后手动清理。`
      : "已清理连接和会话状态，现在按全新用户流程开始。");
  } catch (error) {
    await refreshStatus();
    notice(elements.modeNotice, `重置失败：${error.message}`, true);
    elements.skipReset.hidden = false;
  } finally {
    elements.resetUser.disabled = false;
    elements.skipReset.disabled = false;
    elements.confirmSoul.disabled = false;
    elements.soul.disabled = false;
  }
}

elements.resetUser.addEventListener("click", async () => {
  let mode = "idle";
  try {
    const current = await api("/api/status");
    mode = current.mode;
  } catch (error) {
    notice(elements.modeNotice, `状态查询失败：${error.message}`, true);
    return;
  }
  if (mode === "idle") {
    await enterLobsterMode();
  } else {
    await disconnectAndReset();
  }
});

elements.skipReset.addEventListener("click", async () => {
  await disconnectAndReset({ skipSandboxCleanup: true });
});

// The big CTA inside the phone only triggers when no sandbox exists yet.
// Once a Sandbox is allocated/connected the button is hidden and the
// remaining flow (SOUL confirm + chat) takes over.
elements.enterLobsterMode.addEventListener("click", async () => {
  if (elements.enterLobsterMode.disabled) return;
  await enterLobsterMode();
});

elements.pauseSandbox.addEventListener("click", async () => {
  elements.pauseSandbox.disabled = true;
  elements.chatState.textContent = "正在暂停 Sandbox…";
  try {
    const status = await api("/api/lobster/pause", { method: "POST" });
    renderStatus(status);
    elements.chatState.textContent = "Sandbox 已暂停 · workspace 已持久化";
  } catch (error) {
    notice(elements.modeNotice, `暂停失败：${error.message}`, true);
    await refreshStatus();
  } finally {
    elements.pauseSandbox.disabled = false;
  }
});

elements.resumeSandbox.addEventListener("click", async () => {
  elements.resumeSandbox.disabled = true;
  elements.chatState.textContent = "正在恢复 Sandbox、启动 OpenClaw 并读取 SOUL.md…";
  try {
    const status = await api("/api/lobster/resume", { method: "POST" });
    initialLanding = false;
    renderStatus(status);
    notice(elements.soulNotice, "OpenClaw 已开始启动，并已读取 SFS Turbo 挂载目录中的 workspace/SOUL.md；请确认是否使用该性格进入对话。");
    elements.chatState.textContent = "OpenClaw 启动中 · 已读取 SOUL.md，等待确认性格";
  } catch (error) {
    notice(elements.modeNotice, `恢复失败：${error.message}`, true);
    await refreshStatus();
  } finally {
    elements.resumeSandbox.disabled = false;
  }
});

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", async () => {
    if (tab.disabled) return;
    const status = await api("/api/status");
    const state = resolveTabState(status)[tab.dataset.step];
    if (!state?.enabled) return;
    initialLanding = false;
    showStep(tab.dataset.step, status);
  });
});

elements.reloadSoul.addEventListener("click", loadSoul);
elements.confirmSoul.addEventListener("click", async () => {
  const generation = uiSessionGeneration;
  elements.confirmSoul.disabled = true;
  try {
    const file = await api("/api/soul/confirm", {
      method: "POST",
      body: JSON.stringify({ content: elements.soul.value }),
    });
    if (generation !== uiSessionGeneration) return;
    renderSoul(file);
    notice(elements.soulNotice, "性格已确认，正在进入对话…");
    await refreshStatus();
  } catch (error) {
    if (generation !== uiSessionGeneration) return;
    notice(elements.soulNotice, error.message, true);
  } finally {
    if (generation !== uiSessionGeneration) return;
    elements.confirmSoul.disabled = false;
  }
});

elements.restoreSoul.addEventListener("click", async () => {
  try {
    const file = await api("/api/soul/restore", { method: "POST" });
    renderSoul(file);
    notice(elements.soulNotice, "已恢复为本次编辑前的版本。");
  } catch (error) {
    notice(elements.soulNotice, error.message, true);
  }
});

elements.chatForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = elements.chatInput.value.trim();
  if (!text || helloLoading) return;
  const generation = uiSessionGeneration;
  elements.chatInput.value = "";
  elements.chatInput.disabled = true;
  elements.send.disabled = true;
  addMessage("user", text, "你 · 刚刚");
  elements.chatState.textContent = "OpenClaw 正在思考…";
  try {
    const reply = await api("/api/chat", {
      method: "POST",
      body: JSON.stringify({ text }),
    });
    if (generation !== uiSessionGeneration) return;
    addMessage("assistant", reply.text, `OpenClaw · ${reply.durationMs} ms · ${reply.traceId.slice(0, 8)}`);
  } catch (error) {
    if (generation !== uiSessionGeneration) return;
    addMessage("assistant", `发送失败：${error.message}`, "系统");
  } finally {
    if (generation !== uiSessionGeneration) return;
    elements.chatInput.disabled = false;
    elements.send.disabled = false;
    elements.chatInput.focus();
    elements.chatState.textContent = "已连接 · 可以发送";
  }
});

elements.chatInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    elements.chatForm.requestSubmit();
  }
});

uiConfig = await api("/api/ui-config");
applyRuntimePresentation(uiConfig);
await Promise.all([refreshStatus(), loadSoul(), refreshObservability()]);
scheduleViewportFit();
setInterval(() => void refreshObservability(), 750);
