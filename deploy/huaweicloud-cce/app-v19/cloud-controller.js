import { createHash, randomUUID } from "node:crypto";

import { createInboundMessage } from "../../test-orchestrator/src/protocol.js";

function soulFile(content) {
  return {
    content,
    size: Buffer.byteLength(content),
    sha256: createHash("sha256").update(content).digest("hex"),
  };
}

function isMissingDataSession(error) {
  let current = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    const message = current instanceof Error ? current.message : String(current);
    if (/session(?: id)? not found/i.test(message)) return true;
    current = current instanceof Error ? current.cause : null;
  }
  return false;
}

export class CloudConsoleController {
  #adapter;
  #saga;
  #instanceIdFactory;
  #traceIdFactory;
  #buildConfig;
  #defaultSoul;
  #simulator;
  #accountId;
  #timeoutMs;
  #eventIdFactory;
  #chatId;
  #helloResponse;
  #soul;
  #soulRestore;
  #status;
  #lifecycleRevision = 0;

  constructor({
    adapter,
    saga,
    instanceIdFactory = randomUUID,
    traceIdFactory = randomUUID,
    defaultSoul = "# OnyxClaw\n",
    buildConfig,
    simulator,
    accountId = "default",
    timeoutMs = 120_000,
    eventIdFactory = randomUUID,
    chatId = `cloud-${randomUUID()}`,
  }) {
    this.#adapter = adapter;
    this.#saga = saga;
    this.#instanceIdFactory = instanceIdFactory;
    this.#traceIdFactory = traceIdFactory;
    this.#buildConfig = buildConfig;
    this.#defaultSoul = defaultSoul;
    this.#simulator = simulator;
    this.#accountId = accountId;
    this.#timeoutMs = timeoutMs;
    this.#eventIdFactory = eventIdFactory;
    this.#chatId = chatId;
    this.#soul = defaultSoul;
    this.#soulRestore = defaultSoul;
    this.#status = {
      mode: "idle",
      currentStep: "mode",
      soulConfirmed: false,
      sandboxId: null,
      instanceId: null,
      connectionId: null,
      traceId: null,
      error: null,
    };
  }

  getStatus() {
    return { ...this.#status };
  }

  async startLobsterMode({ sandboxId, instanceId: savedInstanceId } = {}) {
    if (this.#status.mode !== "idle") return this.getStatus();
    const lifecycleRevision = this.#lifecycleRevision;
    this.#status = { ...this.#status, mode: "starting", error: null };
    try {
      if (sandboxId) {
        const instanceId = savedInstanceId || sandboxId;
        this.#status = {
          ...this.#status,
          sandboxId,
          instanceId,
          connectionId: null,
        };
        await this.#adapter.connectSandbox(sandboxId);
        const ready = await this.#saga.bootstrapSandbox({
          sandboxId,
          instanceId,
          traceId: this.#status.traceId,
          soul: this.#soul,
        });
        if (lifecycleRevision !== this.#lifecycleRevision) {
          throw new Error("本次操作已被重置新用户取消");
        }
        this.#status = {
          ...this.#status,
          mode: "connected",
          currentStep: "chat",
          soulConfirmed: true,
          connectionId: ready.connectionId,
        };
        return this.getStatus();
      }
      const instanceId = this.#instanceIdFactory();
      const traceId = this.#traceIdFactory();
      const created = await this.#adapter.createSandbox({
        metadata: { instanceId, traceId },
      });
      if (lifecycleRevision !== this.#lifecycleRevision) {
        try {
          await this.#adapter.killSandbox(created.sandboxId);
        } catch {}
        throw new Error("本次操作已被重置新用户取消");
      }
      await this.#saga.prepareSandbox({
        sandboxId: created.sandboxId,
        instanceId,
        traceId,
        buildConfig: this.#buildConfig,
      });
      if (lifecycleRevision !== this.#lifecycleRevision) {
        throw new Error("本次操作已被重置新用户取消");
      }
      this.#status = {
        ...this.#status,
        mode: "allocated",
        currentStep: "soul",
        soulConfirmed: false,
        sandboxId: created.sandboxId,
        instanceId,
        connectionId: null,
        traceId,
        error: null,
      };
      return this.getStatus();
    } catch (error) {
      if (lifecycleRevision !== this.#lifecycleRevision) throw error;
      this.#status = {
        ...this.#status,
        mode: "error",
        currentStep: "mode",
        error: error instanceof Error ? error.message : String(error),
      };
      throw error;
    }
  }

  getSoul() {
    return soulFile(this.#soul);
  }

  saveSoul(content) {
    if (typeof content !== "string") throw new TypeError("SOUL.md 内容必须是字符串");
    this.#soul = content;
    return soulFile(content);
  }

  restoreSoul() {
    this.#soul = this.#soulRestore;
    return soulFile(this.#soul);
  }

  async confirmSoul(content) {
    const resumeConfirmation = this.#status.mode === "resume-confirmation";
    if (this.#status.mode !== "allocated" && !resumeConfirmation) {
      throw new Error("请先创建云端 Sandbox 或恢复暂停的 Sandbox");
    }
    const lifecycleRevision = this.#lifecycleRevision;
    const sandboxId = this.#status.sandboxId;
    const instanceId = this.#status.instanceId;
    const traceId = this.#status.traceId;
    const file = this.saveSoul(content);
    try {
      const ready = await this.#saga.bootstrapSandbox({
        sandboxId,
        instanceId,
        traceId,
        soul: content,
        cleanupOnFailure: !resumeConfirmation,
      });
      if (lifecycleRevision !== this.#lifecycleRevision) {
        throw new Error("本次操作已被重置新用户取消");
      }
      this.#soulRestore = content;
      this.#status = {
        ...this.#status,
        mode: "connected",
        currentStep: "chat",
        soulConfirmed: true,
        connectionId: ready.connectionId,
        error: null,
      };
      return { ...file, soulConfirmed: true, currentStep: "chat" };
    } catch (error) {
      if (lifecycleRevision !== this.#lifecycleRevision) throw error;
      if (resumeConfirmation) {
        try {
          await this.#adapter.pauseSandbox(this.#status.sandboxId);
        } catch {}
        this.#status = {
          ...this.#status,
          mode: "paused",
          currentStep: "chat",
          soulConfirmed: true,
          connectionId: null,
          error: error instanceof Error ? error.message : String(error),
        };
      }
      throw error;
    }
  }

  async pauseLobsterMode() {
    if (this.#status.mode !== "connected" || !this.#status.sandboxId) {
      throw new Error("云端 OpenClaw 尚未连接，不能暂停");
    }
    const lifecycleRevision = this.#lifecycleRevision;
    const sandboxId = this.#status.sandboxId;
    this.#status = { ...this.#status, mode: "pausing", error: null };
    try {
      await this.#adapter.pauseSandbox(sandboxId);
      if (lifecycleRevision !== this.#lifecycleRevision) {
        throw new Error("本次操作已被重置新用户取消");
      }
      this.#status = {
        ...this.#status,
        mode: "paused",
        currentStep: "chat",
        connectionId: null,
      };
      return this.getStatus();
    } catch (error) {
      if (lifecycleRevision !== this.#lifecycleRevision) throw error;
      this.#status = {
        ...this.#status,
        mode: "connected",
        error: error instanceof Error ? error.message : String(error),
      };
      throw error;
    }
  }

  async resumeLobsterMode() {
    const retryDataSession = this.#status.mode === "resume-data-pending";
    if ((this.#status.mode !== "paused" && !retryDataSession) || !this.#status.sandboxId) {
      throw new Error("Sandbox 当前不是暂停状态");
    }
    const lifecycleRevision = this.#lifecycleRevision;
    const sandboxId = this.#status.sandboxId;
    const instanceId = this.#status.instanceId;
    const traceId = this.#status.traceId;
    this.#status = { ...this.#status, mode: "resuming", error: null };
    let connectedForResume = false;
    try {
      // A successful control-plane connect does not guarantee that Agent
      // Gateway created the data session. A user-triggered retry must connect
      // again to obtain a fresh routed session before retrying Files.write.
      await this.#adapter.connectSandbox(sandboxId);
      connectedForResume = true;
      if (lifecycleRevision !== this.#lifecycleRevision) {
        throw new Error("本次操作已被重置新用户取消");
      }
      // AgentSphere restores a paused Sandbox by rebuilding its runtime while
      // preserving the logical Sandbox ID. Recreate the non-persistent config
      // first so the image entrypoint can start the Gateway, then load the
      // persistent personality from the SFS-backed workspace for confirmation.
      await this.#saga.prepareSandbox({
        sandboxId,
        instanceId,
        traceId,
        buildConfig: this.#buildConfig,
        cleanupOnFailure: false,
      });
      if (lifecycleRevision !== this.#lifecycleRevision) {
        throw new Error("本次操作已被重置新用户取消");
      }
      const persistentSoul = await this.#saga.readPersistentSoul(
        sandboxId,
      );
      if (lifecycleRevision !== this.#lifecycleRevision) {
        throw new Error("本次操作已被重置新用户取消");
      }
      this.#soul = persistentSoul.content;
      this.#soulRestore = persistentSoul.content;
      this.#status = {
        ...this.#status,
        mode: "resume-confirmation",
        currentStep: "soul",
        soulConfirmed: false,
        connectionId: null,
      };
      return this.getStatus();
    } catch (error) {
      if (lifecycleRevision !== this.#lifecycleRevision) throw error;
      const dataSessionPending = connectedForResume && isMissingDataSession(error);
      if (connectedForResume && !dataSessionPending) {
        try {
          await this.#adapter.pauseSandbox(this.#status.sandboxId);
        } catch {}
      }
      this.#status = {
        ...this.#status,
        mode: dataSessionPending ? "resume-data-pending" : "paused",
        currentStep: "chat",
        soulConfirmed: true,
        connectionId: null,
        error: error instanceof Error ? error.message : String(error),
      };
      throw error;
    }
  }

  async stopLobsterMode() {
    this.#lifecycleRevision += 1;
    const sandboxId = this.#status.sandboxId;
    const instanceId = this.#status.instanceId;
    if (sandboxId) {
      await this.#adapter.killSandbox(sandboxId);
    }
    this.#simulator?.resetInstance?.(instanceId);
    return this.#clearLocalState();
  }

  #clearLocalState(extra = {}) {
    this.#soul = this.#defaultSoul;
    this.#soulRestore = this.#defaultSoul;
    this.#helloResponse = undefined;
    this.#status = {
      mode: "idle",
      currentStep: "mode",
      soulConfirmed: false,
      sandboxId: null,
      instanceId: null,
      connectionId: null,
      traceId: null,
      error: null,
    };
    return { ...this.getStatus(), ...extra };
  }

  resetNewUser({ skipSandboxCleanup = false } = {}) {
    if (!skipSandboxCleanup) return this.stopLobsterMode();
    this.#lifecycleRevision += 1;
    const orphanedSandboxId = this.#status.sandboxId;
    this.#simulator?.resetInstance?.(this.#status.instanceId);
    return this.#clearLocalState({
      cleanupSkipped: true,
      orphanedSandboxId,
    });
  }

  async sendMessage(text) {
    if (this.#status.mode !== "connected" || !this.#status.soulConfirmed) {
      throw new Error("云端 OpenClaw 尚未就绪");
    }
    if (!this.#simulator) throw new Error("Channel Simulator 未配置");
    if (typeof text !== "string" || !text.trim()) throw new TypeError("消息不能为空");
    const eventId = this.#eventIdFactory();
    const started = Date.now();
    this.#simulator.sendInbound(
      this.#status.instanceId,
      createInboundMessage({
        eventId,
        instanceId: this.#status.instanceId,
        accountId: this.#accountId,
        senderId: "cloud-app-user",
        chatId: this.#chatId,
        text: text.trim(),
      }),
    );
    const outbound = await this.#simulator.waitForNextOutbound(this.#timeoutMs);
    return {
      text: outbound.payload.text,
      inboundEventId: eventId,
      outboundEventId: outbound.eventId,
      durationMs: Date.now() - started,
      traceId: eventId,
    };
  }

  async sayHello() {
    if (this.#helloResponse) return { ...this.#helloResponse, alreadySent: true };
    const response = await this.sendMessage(
      "这是你和新用户的第一次见面。请基于当前性格设定主动说一声 hello，并做一句简短的自我介绍。",
    );
    this.#helloResponse = { ...response, alreadySent: false };
    return this.#helloResponse;
  }
}
