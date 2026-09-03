import path from "node:path";

const SANDBOX_SERVICE_TARGET = "E2B-Compatible Sandbox API";

function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${label} is required`);
  }
  return value.trim();
}

function redact(message, secrets) {
  let safe = String(message);
  for (const secret of Object.values(secrets)) {
    if (typeof secret === "string" && secret) safe = safe.replaceAll(secret, "[REDACTED]");
  }
  return safe;
}

function safeCommandSummary(command, secrets) {
  return redact(command, secrets)
    .replace(/((?:api[_-]?key|access[_-]?token|auth[_-]?token|bootstrap[_-]?token|password|secret)\s*[=:]\s*)([^\s;&|]+)/gi, "$1[REDACTED]")
    .replace(/(--(?:api-key|token|password|secret)(?:=|\s+))([^\s;&|]+)/gi, "$1[REDACTED]")
    .slice(0, 2_000);
}

function defaultLogger(record) {
  process.stderr.write(`${JSON.stringify({
    timestamp: new Date().toISOString(),
    ...record,
  })}\n`);
}

function safeError(error, secrets) {
  return {
    name: error instanceof Error ? error.name : "Error",
    code: typeof error?.code === "string" ? error.code : undefined,
    message: redact(error instanceof Error ? error.message : error, secrets),
    statusCode: typeof error?.statusCode === "number" || typeof error?.statusCode === "string"
      ? error.statusCode
      : undefined,
    requestId: typeof error?.requestId === "string" ? error.requestId : undefined,
  };
}

export class CloudRuntimeError extends Error {
  constructor(stage, error, secrets, providerId) {
    const detail = redact(error instanceof Error ? error.message : error, secrets);
    super(`Sandbox provider ${stage} failed: ${detail}`, { cause: error });
    this.name = "CloudRuntimeError";
    this.stage = stage;
    this.providerId = providerId;
    this.code = `CLOUD_RUNTIME_${stage.toUpperCase()}_FAILED`;
    if (error?.statusCode !== undefined) this.statusCode = error.statusCode;
    if (error?.requestId !== undefined) this.requestId = error.requestId;
  }
}

export class E2BCompatibleAdapter {
  #providerId;
  #provider;
  #secrets;
  #client;
  #sessions = new Map();
  #operationMonitor;
  #logger;

  constructor({
    provider,
    providerId = "default",
    secrets,
    clientFactory,
    operationMonitor,
    logger = defaultLogger,
  }) {
    if (typeof clientFactory !== "function") throw new TypeError("clientFactory is required");
    requiredString(provider?.api?.baseUrl, "provider.api.baseUrl");
    requiredString(provider?.sandbox?.templateId, "provider.sandbox.templateId");
    requiredString(provider?.sandbox?.defaultUser, "provider.sandbox.defaultUser");
    requiredString(secrets?.apiKey, "secrets.apiKey");
    if (!Number.isInteger(provider.sandbox.timeoutMs) || provider.sandbox.timeoutMs <= 0) {
      throw new TypeError("provider.sandbox.timeoutMs must be a positive integer");
    }
    this.#provider = provider;
    this.#providerId = providerId;
    this.#secrets = secrets;
    this.#operationMonitor = operationMonitor;
    this.#logger = logger;
    this.#client = clientFactory({
      apiKey: secrets.apiKey,
      baseUrl: provider.api.baseUrl,
      ...(provider.api.sandboxUrl ? { sandboxUrl: provider.api.sandboxUrl } : {}),
      requestTimeoutMs: provider.api.requestTimeoutMs,
      sdkPatch: provider.api.sdkPatch ?? "none",
    });
  }

  async #perform(stage, telemetry, operation) {
    const callId = this.#operationMonitor?.begin({
      api: telemetry.api,
      target: telemetry.target,
      object: telemetry.object,
      operationContext: telemetry.operationContext,
    });
    try {
      const result = await operation();
      this.#operationMonitor?.succeed(callId, {
        object: telemetry.resultObject?.(result) ?? telemetry.object,
      });
      return result;
    } catch (error) {
      const failure = safeError(error, this.#secrets);
      this.#operationMonitor?.fail(callId, {
        object: telemetry.failureObject ?? (telemetry.object
          ? { ...telemetry.object, state: "failed" }
          : undefined),
        error: failure,
      });
      this.#logger({
        level: "error",
        event: "sandbox.provider.operation_failed",
        providerId: this.#providerId,
        providerName: this.#provider.displayName,
        protocol: this.#provider.protocol,
        stage,
        api: telemetry.api,
        target: telemetry.target,
        error: failure,
      });
      if (error instanceof CloudRuntimeError) throw error;
      throw new CloudRuntimeError(stage, error, this.#secrets, this.#providerId);
    }
  }

  #remember(session, fallbackId) {
    const sandboxId = requiredString(session?.sandboxId ?? fallbackId, "sandboxId");
    this.#sessions.set(sandboxId, session);
    return { sandboxId, status: "running" };
  }

  async createSandbox({ metadata, envs } = {}) {
    return this.#perform("create", {
      api: "Sandbox.create",
      target: SANDBOX_SERVICE_TARGET,
      operationContext: { label: "TEMPLATE", value: this.#provider.sandbox.templateId },
      resultObject: (result) => ({
        type: "Sandbox",
        id: result.sandboxId,
        state: "running",
      }),
    }, async () => {
      const session = await this.#client.create({
        template: this.#provider.sandbox.templateId,
        timeoutSeconds: Math.ceil(this.#provider.sandbox.timeoutMs / 1000),
        ...(this.#provider.sandbox.onTimeout
          ? { onTimeout: this.#provider.sandbox.onTimeout }
          : {}),
        secure: this.#provider.sandbox.secure,
        metadata: {
          ...(this.#provider.sandbox.metadata ?? {}),
          ...(metadata ?? {}),
        },
        envs,
      });
      return this.#remember(session);
    });
  }

  async connectSandbox(sandboxId) {
    const id = requiredString(sandboxId, "sandboxId");
    return this.#perform("connect", {
      api: "Sandbox.connect",
      target: SANDBOX_SERVICE_TARGET,
      operationContext: { label: "SANDBOX", value: id },
      object: { type: "Sandbox", id, state: "connecting" },
      resultObject: (result) => ({ type: "Sandbox", id: result.sandboxId, state: "running" }),
    }, async () => {
      // A paused Sandbox keeps the wrapper created with its original traffic
      // and envd tokens. Normal resume must reuse it instead of reconnecting.
      if (this.#sessions.has(id)) {
        await this.#sessions.get(id).resume();
        return { sandboxId: id, status: "running" };
      }
      const session = await this.#client.connect(id);
      return this.#remember(session, id);
    });
  }

  async pauseSandbox(sandboxId) {
    const id = requiredString(sandboxId, "sandboxId");
    return this.#perform("pause", {
      api: "Sandbox.pause",
      target: SANDBOX_SERVICE_TARGET,
      operationContext: { label: "SANDBOX", value: id },
      object: { type: "Sandbox", id, state: "pausing" },
      resultObject: () => ({ type: "Sandbox", id, state: "paused" }),
    }, async () => {
      const session = await this.#getSession(id);
      await session.pause();
      // Keep the wrapper until kill succeeds; paused sessions resume in place.
      return { sandboxId: id, status: "paused" };
    });
  }

  async #getSession(sandboxId) {
    const id = requiredString(sandboxId, "sandboxId");
    if (!this.#sessions.has(id)) await this.connectSandbox(id);
    return this.#sessions.get(id);
  }

  async runCommand(sandboxId, command) {
    requiredString(command, "command");
    const id = requiredString(sandboxId, "sandboxId");
    return this.#perform("command", {
      api: "Commands.run",
      target: "Sandbox envd",
      operationContext: {
        label: "COMMAND",
        value: safeCommandSummary(command, this.#secrets),
      },
      object: { type: "Process", id, state: "running" },
      resultObject: (result) => ({
        type: "Process",
        id,
        state: `exited:${result.exitCode}`,
      }),
    }, async () => {
      const session = await this.#getSession(sandboxId);
      return session.runCommand(command, { user: this.#provider.sandbox.defaultUser });
    });
  }

  async writeFile(sandboxId, filePath, content) {
    if (!path.posix.isAbsolute(filePath)) throw new TypeError("filePath must be absolute");
    if (typeof content !== "string" && !Buffer.isBuffer(content)) {
      throw new TypeError("content must be a string or Buffer");
    }
    return this.#perform("file-write", {
      api: "Files.write",
      target: "Sandbox envd",
      operationContext: { label: "PATH", value: filePath },
      object: { type: "File", id: filePath, state: "writing" },
      resultObject: () => ({ type: "File", id: filePath, state: "written" }),
    }, async () => {
      const session = await this.#getSession(sandboxId);
      return session.writeFile(filePath, content, {
        user: this.#provider.sandbox.defaultUser,
      });
    });
  }

  async readFile(sandboxId, filePath) {
    if (!path.posix.isAbsolute(filePath)) throw new TypeError("filePath must be absolute");
    return this.#perform("file-read", {
      api: "Files.read",
      target: "Sandbox envd",
      operationContext: { label: "PATH", value: filePath },
      object: { type: "File", id: filePath, state: "reading" },
      resultObject: () => ({ type: "File", id: filePath, state: "read" }),
    }, async () => {
      const session = await this.#getSession(sandboxId);
      return session.readFile(filePath, { user: this.#provider.sandbox.defaultUser });
    });
  }

  async killSandbox(sandboxId) {
    const id = requiredString(sandboxId, "sandboxId");
    return this.#perform("kill", {
      api: "Sandbox.kill",
      target: SANDBOX_SERVICE_TARGET,
      operationContext: { label: "SANDBOX", value: id },
      object: { type: "Sandbox", id, state: "terminating" },
      resultObject: () => ({ type: "Sandbox", id, state: "terminated" }),
    }, async () => {
      const session = await this.#getSession(id);
      await session.kill();
      this.#sessions.delete(id);
      return { sandboxId: id, status: "killed" };
    });
  }

  close() {
    this.#client.close?.();
  }
}

export function createE2BCompatibleAdapter({
  registry,
  providerId = registry.defaultProviderId,
  provider,
  clientFactory,
  operationMonitor,
  logger,
}) {
  return new E2BCompatibleAdapter({
    providerId,
    provider: provider ?? registry.getProvider(providerId),
    secrets: registry.getSecrets(providerId),
    clientFactory,
    operationMonitor,
    logger,
  });
}
