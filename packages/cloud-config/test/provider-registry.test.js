import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadProviderRegistry } from "../src/provider-registry.js";

function validConfig() {
  return {
    schemaVersion: 1,
    defaultProvider: "vendor-a",
    providers: {
      "vendor-a": {
        displayName: "Vendor A",
        protocol: "e2b-compatible",
        api: {
          baseUrl: "https://sandbox.vendor-a.example",
          sandboxUrl: "https://envd.vendor-a.example",
          apiKeyEnv: "VENDOR_A_E2B_API_KEY",
          compatibilityVersion: "e2b-v2",
          requestTimeoutMs: 30_000,
        },
        sandbox: {
          templateId: "openclaw-template",
          timeoutMs: 600_000,
          onTimeout: "pause",
          secure: true,
          defaultUser: "user",
          homeDir: "/home/user",
          workspaceDir: "/home/user/.openclaw/workspace",
        },
        openclaw: {
          binary: "openclaw",
          gatewayPort: 18789,
          installMode: "preinstalled",
          pluginInstallMode: "upload-package",
        },
        channel: {
          publicUrl: "wss://channel.example/internal/channel/connect",
          connectTimeoutMs: 120_000,
        },
        model: {
          provider: "openai-compatible",
          model: "test-model",
          apiKeyEnv: "VENDOR_A_MODEL_API_KEY",
        },
        cleanupPolicy: "pause",
        capabilities: {
          pauseResume: true,
          memoryPersistence: true,
          publicEgress: true,
          vpc: false,
        },
      },
    },
  };
}

async function fixture(t, config = validConfig(), env = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "onyxclaw-provider-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, "providers.json");
  await writeFile(configPath, JSON.stringify(config));
  return loadProviderRegistry({ configPath, env });
}

test("loads a named E2B-compatible provider and supports a trusted default override", async (t) => {
  const config = validConfig();
  config.providers["vendor-b"] = {
    ...config.providers["vendor-a"],
    displayName: "Vendor B",
    api: {
      ...config.providers["vendor-a"].api,
      baseUrl: "https://sandbox.vendor-b.example",
    },
  };
  const registry = await fixture(t, config, { ONYXCLAW_PROVIDER: "vendor-b" });

  assert.equal(registry.defaultProviderId, "vendor-b");
  assert.equal(registry.getProvider("vendor-a").sandbox.templateId, "openclaw-template");
  assert.equal(registry.getProvider("vendor-b").displayName, "Vendor B");
});

test("keeps secret values outside provider config and public summaries", async (t) => {
  const registry = await fixture(t, validConfig(), {
    VENDOR_A_E2B_API_KEY: "cloud-secret-value",
    VENDOR_A_MODEL_API_KEY: "model-secret-value",
  });

  assert.deepEqual(registry.getSecrets("vendor-a"), {
    apiKey: "cloud-secret-value",
    modelApiKey: "model-secret-value",
  });
  const serialized = JSON.stringify(registry.toPublicSummary());
  assert.doesNotMatch(serialized, /cloud-secret-value|model-secret-value|apiKeyEnv/);
  assert.deepEqual(registry.toPublicSummary().providers[0], {
    id: "vendor-a",
    displayName: "Vendor A",
    protocol: "e2b-compatible",
    capabilities: validConfig().providers["vendor-a"].capabilities,
  });
});

test("reports all missing secret environment variables before a run starts", async (t) => {
  const registry = await fixture(t);

  assert.throws(
    () => registry.getSecrets("vendor-a"),
    /VENDOR_A_E2B_API_KEY.*VENDOR_A_MODEL_API_KEY/,
  );
});

test("rejects unsafe endpoints and invalid sandbox paths", async (t) => {
  const config = validConfig();
  config.providers["vendor-a"].api.baseUrl = "http://remote.example";
  config.providers["vendor-a"].sandbox.workspaceDir = "relative/workspace";

  await assert.rejects(
    fixture(t, config),
    /api\.baseUrl must use https|workspaceDir must be absolute/,
  );
});

test("accepts string metadata and rejects non-string Sandbox metadata values", async (t) => {
  const config = validConfig();
  config.providers["vendor-a"].sandbox.metadata = {
    "agentsandbox.storage.sfs": "{\"sfsTurboMounts\":[]}",
  };
  const registry = await fixture(t, config);
  assert.equal(
    registry.getProvider("vendor-a").sandbox.metadata["agentsandbox.storage.sfs"],
    "{\"sfsTurboMounts\":[]}",
  );

  config.providers["vendor-a"].sandbox.metadata["agentsandbox.storage.sfs"] = {
    sfsTurboMounts: [],
  };
  await assert.rejects(fixture(t, config), /sandbox\.metadata\.agentsandbox\.storage\.sfs/);
});

test("rejects an unsafe sandbox data-plane endpoint", async (t) => {
  const config = validConfig();
  config.providers["vendor-a"].api.sandboxUrl = "http://envd.vendor-a.example";

  await assert.rejects(fixture(t, config), /api\.sandboxUrl must use https/);
});

test("rejects unknown provider-specific SDK patches", async (t) => {
  const config = validConfig();
  config.providers["vendor-a"].api.sdkPatch = "another-vendor-patch";

  await assert.rejects(
    fixture(t, config),
    /api\.sdkPatch must be none/,
  );
});

test("allows insecure endpoints only when explicitly restricted to a VPC", async (t) => {
  const config = validConfig();
  const selected = config.providers["vendor-a"];
  selected.api.baseUrl = "http://sandbox-manager.sandbox-system.svc.cluster.local:7788";
  selected.api.privateNetworkOnly = true;
  selected.channel.publicUrl = "ws://channel.default.svc.cluster.local:8080/connect";
  selected.channel.privateNetworkOnly = true;
  selected.capabilities.vpc = true;

  const registry = await fixture(t, config);
  assert.equal(registry.getProvider().api.privateNetworkOnly, true);

  selected.api.baseUrl = "http://public.example.com";
  await assert.rejects(fixture(t, config), /api\.baseUrl must use https/);

  selected.api.baseUrl = "http://sandbox-manager.sandbox-system.svc.cluster.local:7788";
  selected.capabilities.vpc = false;
  await assert.rejects(
    fixture(t, config),
    /api\.baseUrl must use https|channel\.publicUrl must use wss/,
  );
});

test("rejects an unknown selected provider", async (t) => {
  await assert.rejects(
    fixture(t, validConfig(), { ONYXCLAW_PROVIDER: "missing" }),
    /default provider missing is not configured/,
  );
});

test("committed Huawei Provider example remains valid and references external secrets", async () => {
  const repositoryRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../..",
  );
  const registry = await loadProviderRegistry({
    configPath: path.join(repositoryRoot, "config", "providers.huaweicloud-agentsphere.example.json"),
    env: {
      HUAWEICLOUD_AGENTSPHERE_E2B_API_KEY: "test-only",
      HUAWEICLOUD_AGENTSPHERE_MODEL_API_KEY: "test-only",
      HUAWEICLOUD_AGENTSPHERE_CHANNEL_SIGNING_SECRET: "test-only",
    },
  });

  assert.equal(registry.defaultProviderId, "huaweicloud-agentsphere");
  assert.equal(registry.toPublicSummary().providers.length, 1);
  assert.equal(registry.getSecrets().channelSigningSecret, "test-only");
});

test("committed Huawei AgentSphere provider uses placeholder endpoints and node paths", async () => {
  const repositoryRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../..",
  );
  const registry = await loadProviderRegistry({
    configPath: path.join(repositoryRoot, "config", "providers.huaweicloud-agentsphere.example.json"),
    env: {
      HUAWEICLOUD_AGENTSPHERE_E2B_API_KEY: "test-only",
      HUAWEICLOUD_AGENTSPHERE_MODEL_API_KEY: "test-only",
      HUAWEICLOUD_AGENTSPHERE_CHANNEL_SIGNING_SECRET: "test-only",
    },
  });
  const provider = registry.getProvider("huaweicloud-agentsphere");

  assert.equal(provider.api.privateNetworkOnly, true);
  assert.equal(provider.api.baseUrl, "https://agentsphere-control-plane.example.invalid");
  assert.equal(provider.api.sandboxUrl, "https://agentsphere-sandbox-gateway.example.invalid");
  assert.equal(provider.channel.publicUrl, "wss://onyxclaw-channel.example.invalid/connect");
  assert.equal(provider.sandbox.templateId, "<agentsphere-template-id>");
  assert.equal(provider.sandbox.defaultUser, "node");
  assert.equal(provider.sandbox.workspaceDir, "/home/node/.openclaw/workspace");
  assert.equal(provider.openclaw.pluginInstallMode, "preinstalled");
  assert.equal(provider.capabilities.vpc, true);
});
