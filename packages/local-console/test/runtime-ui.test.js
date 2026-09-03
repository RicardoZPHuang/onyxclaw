import assert from "node:assert/strict";
import test from "node:test";

import { cloudProviderPresentation, runtimePresentation } from "../public/runtime-ui.js";

test("local presentation keeps macOS copy and identity", () => {
  assert.deepEqual(runtimePresentation({ deploymentMode: "local" }), {
    environmentLabel: "LOCAL MACOS",
    modeCopy: "连接这台 Mac 上的 OpenClaw，创建一只拥有专属性格的智能龙虾。",
  });
});

test("cloud presentation identifies the configured provider and reflects the single-tenant copy", () => {
  assert.deepEqual(runtimePresentation({
    deploymentMode: "cloud",
    providerId: "huaweicloud-agentsphere",
    providerName: "Huawei Cloud AgentSphere Sandbox",
  }), {
    environmentLabel: "HUAWEI CLOUD AGENTSPHERE SANDBOX · CLOUD",
    modeCopy: "系统同时只存在一个客户。点击右上「重置新用户」即开始新会话（云端会自动释放 Sandbox）。",
  });
});

test("cloudProviderPresentation returns null locally and projects safe provider fields in cloud mode", () => {
  assert.equal(cloudProviderPresentation({ deploymentMode: "local" }), null);
  assert.equal(cloudProviderPresentation({ deploymentMode: "cloud" }), null);
  assert.deepEqual(cloudProviderPresentation({
    deploymentMode: "cloud",
    region: "cn-south-1",
    templateId: "agentsphere-template",
    gatewayPort: 18789,
    e2bHost: "agentsphere.example.internal",
    protocol: "e2b-compatible",
    capabilities: { pauseResume: true, memoryPersistence: true, publicEgress: true, vpc: true },
  }), {
    region: "cn-south-1",
    templateId: "agentsphere-template",
    gatewayPort: 18789,
    e2bHost: "agentsphere.example.internal",
    protocol: "e2b-compatible",
    capabilities: { pauseResume: true, memoryPersistence: true, publicEgress: true, vpc: true },
  });
});
