import { readFile } from "node:fs/promises";
import path from "node:path";

const cleanupPolicies = new Set(["pause", "kill", "keep-running"]);
const timeoutPolicies = new Set(["pause", "kill"]);
const installModes = new Set(["preinstalled", "install-at-runtime"]);
const pluginInstallModes = new Set(["upload-package", "preinstalled"]);
const sdkPatches = new Set(["none"]);

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function requiredString(value, label, errors) {
  if (typeof value !== "string" || !value.trim()) errors.push(`${label} is required`);
}

function positiveInteger(value, label, errors) {
  if (!Number.isInteger(value) || value <= 0) errors.push(`${label} must be a positive integer`);
}

function isPrivateHostname(hostname) {
  const normalized = hostname.toLowerCase();
  if (["127.0.0.1", "localhost", "::1"].includes(normalized)) return true;
  if (/^10\./.test(normalized) || /^192\.168\./.test(normalized)) return true;
  const match = normalized.match(/^172\.(\d+)\./);
  if (match && Number(match[1]) >= 16 && Number(match[1]) <= 31) return true;
  if (/^(fc|fd)[0-9a-f]{2}:/i.test(normalized)) return true;
  return [".svc", ".svc.cluster.local", ".internal", ".local"].some((suffix) =>
    normalized.endsWith(suffix),
  );
}

function validateEndpoint(
  value,
  label,
  secureProtocol,
  localProtocol,
  errors,
  { allowPrivateInsecure = false } = {},
) {
  try {
    const url = new URL(value);
    const loopback = ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
    if (
      url.protocol !== secureProtocol &&
      !(loopback && url.protocol === localProtocol) &&
      !(
        allowPrivateInsecure &&
        url.protocol === localProtocol &&
        isPrivateHostname(url.hostname)
      )
    ) {
      errors.push(`${label} must use ${secureProtocol.slice(0, -1)}`);
    }
  } catch {
    errors.push(`${label} must be a valid URL`);
  }
}

function validateProvider(id, provider) {
  const errors = [];
  requiredString(provider?.displayName, `${id}.displayName`, errors);
  if (provider?.protocol !== "e2b-compatible") {
    errors.push(`${id}.protocol must be e2b-compatible`);
  }

  requiredString(provider?.api?.apiKeyEnv, `${id}.api.apiKeyEnv`, errors);
  requiredString(
    provider?.api?.compatibilityVersion,
    `${id}.api.compatibilityVersion`,
    errors,
  );
  const vpcPrivateApi =
    provider?.capabilities?.vpc === true && provider?.api?.privateNetworkOnly === true;
  validateEndpoint(
    provider?.api?.baseUrl,
    `${id}.api.baseUrl`,
    "https:",
    "http:",
    errors,
    { allowPrivateInsecure: vpcPrivateApi },
  );
  if (provider?.api?.sandboxUrl !== undefined) {
    validateEndpoint(
      provider.api.sandboxUrl,
      `${id}.api.sandboxUrl`,
      "https:",
      "http:",
      errors,
      { allowPrivateInsecure: vpcPrivateApi },
    );
  }
  positiveInteger(provider?.api?.requestTimeoutMs, `${id}.api.requestTimeoutMs`, errors);
  if (!sdkPatches.has(provider?.api?.sdkPatch ?? "none")) {
    errors.push(
      `${id}.api.sdkPatch must be none`,
    );
  }

  requiredString(provider?.sandbox?.templateId, `${id}.sandbox.templateId`, errors);
  positiveInteger(provider?.sandbox?.timeoutMs, `${id}.sandbox.timeoutMs`, errors);
  if (!timeoutPolicies.has(provider?.sandbox?.onTimeout)) {
    errors.push(`${id}.sandbox.onTimeout must be pause or kill`);
  }
  requiredString(provider?.sandbox?.defaultUser, `${id}.sandbox.defaultUser`, errors);
  if (provider?.sandbox?.metadata !== undefined) {
    if (!provider.sandbox.metadata || typeof provider.sandbox.metadata !== "object" || Array.isArray(provider.sandbox.metadata)) {
      errors.push(`${id}.sandbox.metadata must be an object`);
    } else {
      for (const [key, value] of Object.entries(provider.sandbox.metadata)) {
        requiredString(key, `${id}.sandbox.metadata key`, errors);
        requiredString(value, `${id}.sandbox.metadata.${key}`, errors);
      }
    }
  }
  for (const field of ["homeDir", "workspaceDir"]) {
    const value = provider?.sandbox?.[field];
    if (typeof value !== "string" || !path.posix.isAbsolute(value)) {
      errors.push(`${id}.sandbox.${field} must be absolute`);
    }
  }

  requiredString(provider?.openclaw?.binary, `${id}.openclaw.binary`, errors);
  positiveInteger(provider?.openclaw?.gatewayPort, `${id}.openclaw.gatewayPort`, errors);
  if (!installModes.has(provider?.openclaw?.installMode)) {
    errors.push(`${id}.openclaw.installMode is invalid`);
  }
  if (!pluginInstallModes.has(provider?.openclaw?.pluginInstallMode)) {
    errors.push(`${id}.openclaw.pluginInstallMode is invalid`);
  }

  validateEndpoint(
    provider?.channel?.publicUrl,
    `${id}.channel.publicUrl`,
    "wss:",
    "ws:",
    errors,
    {
      allowPrivateInsecure:
        provider?.capabilities?.vpc === true &&
        provider?.channel?.privateNetworkOnly === true,
    },
  );
  positiveInteger(
    provider?.channel?.connectTimeoutMs,
    `${id}.channel.connectTimeoutMs`,
    errors,
  );

  requiredString(provider?.model?.provider, `${id}.model.provider`, errors);
  requiredString(provider?.model?.model, `${id}.model.model`, errors);
  requiredString(provider?.model?.apiKeyEnv, `${id}.model.apiKeyEnv`, errors);
  if (!cleanupPolicies.has(provider?.cleanupPolicy)) {
    errors.push(`${id}.cleanupPolicy must be pause, kill, or keep-running`);
  }
  for (const capability of [
    "pauseResume",
    "memoryPersistence",
    "publicEgress",
    "vpc",
  ]) {
    if (typeof provider?.capabilities?.[capability] !== "boolean") {
      errors.push(`${id}.capabilities.${capability} must be boolean`);
    }
  }
  return errors;
}

export class ProviderRegistry {
  #config;
  #env;

  constructor(config, env) {
    this.#config = config;
    this.#env = env;
  }

  get defaultProviderId() {
    return this.#config.defaultProvider;
  }

  getProvider(providerId = this.defaultProviderId) {
    const provider = this.#config.providers[providerId];
    if (!provider) throw new Error(`provider ${providerId} is not configured`);
    return provider;
  }

  getSecrets(providerId = this.defaultProviderId) {
    const provider = this.getProvider(providerId);
    const mappings = [
      ["apiKey", provider.api.apiKeyEnv],
      ["modelApiKey", provider.model.apiKeyEnv],
      ...(provider.channel.signingSecretEnv
        ? [["channelSigningSecret", provider.channel.signingSecretEnv]]
        : []),
    ];
    const missing = mappings
      .filter(([, environmentName]) => !this.#env[environmentName])
      .map(([, environmentName]) => environmentName);
    if (missing.length > 0) {
      throw new Error(`missing provider secrets: ${missing.join(", ")}`);
    }
    return Object.fromEntries(
      mappings.map(([name, environmentName]) => [name, this.#env[environmentName]]),
    );
  }

  toPublicSummary() {
    return {
      defaultProvider: this.defaultProviderId,
      providers: Object.entries(this.#config.providers).map(([id, provider]) => ({
        id,
        displayName: provider.displayName,
        protocol: provider.protocol,
        capabilities: provider.capabilities,
      })),
    };
  }
}

export async function loadProviderRegistry({ configPath, env = process.env }) {
  let config;
  try {
    config = JSON.parse(await readFile(configPath, "utf8"));
  } catch (error) {
    throw new Error(`failed to load provider config ${configPath}: ${error.message}`);
  }
  const errors = [];
  if (config.schemaVersion !== 1) errors.push("schemaVersion must be 1");
  if (!config.providers || typeof config.providers !== "object") {
    errors.push("providers must be an object");
  } else {
    for (const [id, provider] of Object.entries(config.providers)) {
      if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
        errors.push(`provider id ${id} must use lowercase letters, numbers, and hyphens`);
      }
      errors.push(...validateProvider(id, provider));
    }
  }
  const selectedProvider = env.ONYXCLAW_PROVIDER || config.defaultProvider;
  if (!config.providers?.[selectedProvider]) {
    errors.push(`default provider ${selectedProvider} is not configured`);
  }
  if (errors.length > 0) throw new Error(`invalid provider config: ${errors.join("; ")}`);

  const normalized = structuredClone(config);
  normalized.defaultProvider = selectedProvider;
  return new ProviderRegistry(deepFreeze(normalized), env);
}
