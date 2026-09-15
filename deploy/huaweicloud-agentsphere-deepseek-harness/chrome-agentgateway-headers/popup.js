const RULE_ID = 1;
const STORAGE_KEY = "agentSphereGatewayConfig";
const ALLOWED_DOMAIN_SUFFIX = ".huaweicloud-agentnetwork.com";

const RESOURCE_TYPES = [
  "main_frame",
  "sub_frame",
  "stylesheet",
  "script",
  "image",
  "font",
  "object",
  "xmlhttprequest",
  "ping",
  "csp_report",
  "media",
  "websocket",
  "webbundle",
  "other"
];

const form = document.querySelector("#config-form");
const gatewayInput = document.querySelector("#gateway-url");
const sandboxInput = document.querySelector("#sandbox-id");
const portInput = document.querySelector("#sandbox-port");
const tokenInput = document.querySelector("#traffic-token");
const statusElement = document.querySelector("#status");
const openButton = document.querySelector("#open-gateway");

function setStatus(message, kind = "") {
  statusElement.textContent = message;
  statusElement.className = kind;
}

function normalizeConfig() {
  const parsed = new URL(gatewayInput.value.trim());
  if (parsed.protocol !== "https:") {
    throw new Error("Gateway URL 必须使用 https://");
  }
  const hostname = parsed.hostname.toLowerCase();
  if (!hostname.endsWith(ALLOWED_DOMAIN_SUFFIX)) {
    throw new Error("Gateway 必须属于 huaweicloud-agentnetwork.com");
  }
  const sandboxId = sandboxInput.value.trim();
  const trafficToken = tokenInput.value.trim();
  const port = Number(portInput.value);
  if (!sandboxId) throw new Error("请填写 Sandbox ID");
  if (!trafficToken) throw new Error("请填写 Traffic Access Token");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Sandbox Port 必须是 1 到 65535 之间的整数");
  }
  return {
    gatewayUrl: `${parsed.origin}/`,
    hostname,
    sandboxId,
    port: String(port),
    trafficToken
  };
}

function buildRule(config) {
  return {
    id: RULE_ID,
    priority: 1,
    action: {
      type: "modifyHeaders",
      requestHeaders: [
        { header: "E2b-Sandbox-Id", operation: "set", value: config.sandboxId },
        { header: "E2b-Sandbox-Port", operation: "set", value: config.port },
        {
          header: "E2B-Traffic-Access-Token",
          operation: "set",
          value: config.trafficToken
        }
      ]
    },
    condition: {
      urlFilter: `||${config.hostname}/`,
      resourceTypes: RESOURCE_TYPES
    }
  };
}

async function showEnabledState(enabled, message) {
  await chrome.action.setBadgeText({ text: enabled ? "ON" : "" });
  await chrome.action.setBadgeBackgroundColor({ color: "#16a34a" });
  openButton.disabled = !enabled;
  setStatus(message, enabled ? "success" : "");
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const config = normalizeConfig();
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [RULE_ID],
      addRules: [buildRule(config)]
    });
    await chrome.storage.local.set({ [STORAGE_KEY]: config });
    await showEnabledState(true, "已启用：页面、API 和 WebSocket 请求都会携带路由 Header");
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), "error");
  }
});

document.querySelector("#disable").addEventListener("click", async () => {
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [RULE_ID] });
  await showEnabledState(false, "规则已停用，配置仍保存在本机");
});

document.querySelector("#clear").addEventListener("click", async () => {
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [RULE_ID] });
  await chrome.storage.local.remove(STORAGE_KEY);
  form.reset();
  portInput.value = "3080";
  await showEnabledState(false, "动态规则和本地凭据已清除");
});

openButton.addEventListener("click", async () => {
  try {
    const config = normalizeConfig();
    await chrome.tabs.create({ url: config.gatewayUrl });
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), "error");
  }
});

async function initialize() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const config = stored[STORAGE_KEY];
  if (config) {
    gatewayInput.value = config.gatewayUrl ?? "";
    sandboxInput.value = config.sandboxId ?? "";
    portInput.value = config.port ?? "3080";
    tokenInput.value = config.trafficToken ?? "";
  }
  const rules = await chrome.declarativeNetRequest.getDynamicRules();
  const enabled = rules.some((rule) => rule.id === RULE_ID);
  await showEnabledState(enabled, enabled ? "规则已启用" : "请填写配置并启用规则");
}

initialize().catch((error) => {
  setStatus(error instanceof Error ? error.message : String(error), "error");
});
