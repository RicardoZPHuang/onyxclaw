#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadProviderRegistry } from "../../cloud-config/src/provider-registry.js";
import { createLocalConsoleServer } from "../../local-console/src/server.js";
import { createSandboxServiceMonitor } from "../../local-console/src/observability.js";
import { WsPlatformSimulator } from "../../test-orchestrator/src/ws-simulator.js";
import {
  createE2BCompatibleAdapter,
} from "./e2b-compatible-adapter.js";
import { CloudConsoleController } from "./cloud-controller.js";
import { buildOpenClawConfig, CloudGatewayProbe } from "./cloud-app-support.js";
import { OpenClawBootstrapSaga } from "./openclaw-bootstrap.js";
import { createPythonE2BClientFactory } from "./python-e2b-client.js";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const providerConfigPath = process.env.ONYXCLAW_PROVIDER_CONFIG ??
  path.join(repositoryRoot, "config/providers.huaweicloud-agentsphere.example.json");
const baseConfigSource = process.env.ONYXCLAW_OPENCLAW_BASE_CONFIG_JSON;
if (!baseConfigSource) throw new Error("ONYXCLAW_OPENCLAW_BASE_CONFIG_JSON is required");
const baseConfig = JSON.parse(baseConfigSource);

const registry = await loadProviderRegistry({ configPath: providerConfigPath });
const providerId = registry.defaultProviderId;
const configuredProvider = registry.getProvider(providerId);
const sandboxUrlOverride = process.env.ONYXCLAW_E2B_SANDBOX_URL?.trim();
const provider = sandboxUrlOverride
  ? {
      ...configuredProvider,
      api: {
        ...configuredProvider.api,
        sandboxUrl: sandboxUrlOverride,
      },
    }
  : configuredProvider;
const secrets = registry.getSecrets(providerId);
const operationMonitor = createSandboxServiceMonitor();
const adapter = createE2BCompatibleAdapter({
  registry,
  providerId,
  provider,
  secrets,
  clientFactory: createPythonE2BClientFactory(),
  operationMonitor,
});
const simulator = new WsPlatformSimulator({
  host: process.env.CHANNEL_HOST ?? "0.0.0.0",
  port: Number(process.env.CHANNEL_PORT ?? "18890"),
});
const gateway = new CloudGatewayProbe({
  adapter,
  timeoutMs: Number(process.env.CLOUD_GATEWAY_TIMEOUT_MS ?? "120000"),
});
const saga = new OpenClawBootstrapSaga({
  adapter,
  channel: simulator,
  gateway,
  gatewayPort: provider.openclaw.gatewayPort,
  configPath: `${provider.sandbox.homeDir.replace(/\/$/, "")}/.openclaw/openclaw.json`,
  workspaceDir: provider.sandbox.workspaceDir,
});
const controller = new CloudConsoleController({
  adapter,
  saga,
  simulator,
  defaultSoul: process.env.ONYXCLAW_DEFAULT_SOUL ?? "# OnyxClaw\n友好、直接、可靠。\n",
  buildConfig: ({ instanceId, bootstrapToken }) => buildOpenClawConfig({
    baseConfig,
    modelApiKey: secrets.modelApiKey,
    platformUrl: provider.channel.publicUrl,
    instanceId,
    bootstrapToken,
  }),
});
const app = createLocalConsoleServer({
  controller,
  operationMonitor,
  uiConfig: {
    deploymentMode: "cloud",
    providerId,
    providerName: provider.displayName,
    region: process.env.ONYXCLAW_CLOUD_REGION || null,
    templateId: provider.sandbox?.templateId ?? null,
    gatewayPort: provider.openclaw?.gatewayPort ?? null,
    e2bHost: (() => {
      try {
        return provider.api?.baseUrl ? new URL(provider.api.baseUrl).host : null;
      } catch {
        return null;
      }
    })(),
    protocol: provider.protocol ?? null,
    capabilities: provider.capabilities ?? null,
    modelProvider: provider.model?.provider ?? null,
    modelName: provider.model?.model ?? null,
  },
  host: process.env.APP_HOST ?? "0.0.0.0",
  port: Number(process.env.APP_PORT ?? "3000"),
});

await simulator.start();
await app.start();
process.stdout.write(`OnyxClaw cloud APP listening on ${app.url}\n`);

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  process.stdout.write(`received ${signal}, cleaning up\n`);
  try {
    await app.stop();
    await simulator.stop();
    adapter.close();
  } catch (error) {
    process.stderr.write(`cloud APP cleanup failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
