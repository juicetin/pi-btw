import { AsyncLocalStorage } from "node:async_hooks";
import { extname } from "node:path";
import {
  createBashToolDefinition,
  createReadToolDefinition,
  type CreateAgentSessionOptions,
  type ReadOperations,
} from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_SANDBOX_LIMITS,
  resolveAllowedProjectPath,
  runReadOnlySandboxCommand,
  type ReadOnlySandboxLimits,
  type SandboxOptions,
} from "./read-only-sandbox";

export type { ReadOnlySandboxLimits } from "./read-only-sandbox";

type SessionToolDefinition = NonNullable<CreateAgentSessionOptions["customTools"]>[number];

export type ReadOnlyBtwToolsOptions = {
  bubblewrapPath?: string;
  systemdRunPath?: string;
  systemctlPath?: string;
  limits?: Partial<ReadOnlySandboxLimits>;
};

const MAX_BASH_OUTPUT_BYTES = 50 * 1024;
const MAX_READ_BYTES = 10 * 1024 * 1024;
const OUTPUT_UPDATE_INTERVAL_MS = 100;

class BoundedOutput {
  private buffer = Buffer.alloc(0);
  private discarded = false;

  constructor(private readonly maxBytes: number) {}

  append(chunk: Buffer): void {
    const combined = Buffer.concat([this.buffer, chunk]);
    if (combined.length > this.maxBytes) {
      this.buffer = combined.subarray(combined.length - this.maxBytes);
      this.discarded = true;
    } else {
      this.buffer = combined;
    }
  }

  toDisplayText(emptyText = "(no output)"): string {
    const text = this.buffer.toString("utf8") || emptyText;
    return this.discarded
      ? `${text}\n\n[Output truncated to the last ${this.maxBytes / 1024}KB; earlier output was discarded.]`
      : text;
  }
}

class OutputPublisher {
  private timer: NodeJS.Timeout | undefined;
  private dirty = false;

  constructor(
    private readonly output: BoundedOutput,
    private readonly publish: ((text: string) => void) | undefined,
  ) {}

  append(chunk: Buffer): void {
    this.output.append(chunk);
    if (!this.publish) return;
    this.dirty = true;
    this.timer ??= setTimeout(() => this.flush(), OUTPUT_UPDATE_INTERVAL_MS);
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.dirty || !this.publish) return;
    this.dirty = false;
    this.publish(this.output.toDisplayText(""));
  }
}

function sandboxOverrides(options: ReadOnlyBtwToolsOptions, runtimeSeconds?: number) {
  const configuredRuntime = options.limits?.runtimeSeconds ?? DEFAULT_SANDBOX_LIMITS.runtimeSeconds;
  const effectiveRuntime = runtimeSeconds && runtimeSeconds > 0
    ? Math.min(configuredRuntime, runtimeSeconds)
    : configuredRuntime;
  return {
    ...(options.bubblewrapPath ? { bubblewrapPath: options.bubblewrapPath } : {}),
    ...(options.systemdRunPath ? { systemdRunPath: options.systemdRunPath } : {}),
    ...(options.systemctlPath ? { systemctlPath: options.systemctlPath } : {}),
    limits: { ...options.limits, runtimeSeconds: effectiveRuntime },
  } as Partial<SandboxOptions> & { limits: Partial<ReadOnlySandboxLimits> };
}

function formatExecutionError(error: unknown, output: BoundedOutput): Error {
  const message = error instanceof Error ? error.message : String(error);
  const status = message === "aborted"
    ? "Command aborted"
    : message.startsWith("timeout:")
      ? `Command timed out after ${message.slice("timeout:".length)} seconds`
      : message;
  const text = output.toDisplayText("");
  return new Error(text ? `${text}\n\n${status}` : status);
}

function createSandboxedBashDefinition(cwd: string, options: ReadOnlyBtwToolsOptions) {
  const bash = createBashToolDefinition(cwd);
  bash.execute = async (_toolCallId, { command, timeout }, signal, onUpdate) => {
    const output = new BoundedOutput(MAX_BASH_OUTPUT_BYTES);
    const publisher = new OutputPublisher(output, onUpdate
      ? (text) => onUpdate({ content: [{ type: "text", text }], details: undefined })
      : undefined);
    let result: { exitCode: number | null };
    try {
      result = await runReadOnlySandboxCommand(
        { cwd, executable: "/bin/bash", args: ["-lc", command], signal, onData: (chunk) => publisher.append(chunk) },
        sandboxOverrides(options, timeout),
      );
    } catch (error) {
      publisher.flush();
      throw formatExecutionError(error, output);
    }
    publisher.flush();
    const text = output.toDisplayText();
    if (result.exitCode !== 0) throw new Error(`${text}\n\nCommand exited with code ${result.exitCode}`);
    return { content: [{ type: "text" as const, text }], details: undefined };
  };
  return bash;
}

function createHeadCollector(maxBytes: number) {
  const chunks: Buffer[] = [];
  let capturedBytes = 0;
  return {
    append(chunk: Buffer) {
      const captured = chunk.subarray(0, Math.max(0, maxBytes - capturedBytes));
      if (captured.length === 0) return;
      chunks.push(captured);
      capturedBytes += captured.length;
    },
    toBuffer: () => Buffer.concat(chunks, capturedBytes),
  };
}

async function runFileCommand(
  cwd: string,
  absolutePath: string,
  executable: string,
  args: string[],
  options: ReadOnlyBtwToolsOptions,
  maxBytes = MAX_READ_BYTES + 1,
  signal?: AbortSignal,
): Promise<Buffer> {
  resolveAllowedProjectPath(cwd, absolutePath);
  const output = createHeadCollector(maxBytes);
  const result = await runReadOnlySandboxCommand(
    { cwd, executable, args, signal, onData: output.append },
    sandboxOverrides(options),
  );
  const content = output.toBuffer();
  if (result.exitCode === 0) return content;
  const message = content.toString("utf8").trim();
  throw new Error(message || `Sandboxed file command exited with code ${result.exitCode}`);
}

const IMAGE_EXTENSIONS = new Set([".bmp", ".gif", ".jpeg", ".jpg", ".png", ".webp"]);

function createSandboxedReadDefinition(cwd: string, options: ReadOnlyBtwToolsOptions) {
  const signals = new AsyncLocalStorage<AbortSignal | undefined>();
  const operations: ReadOperations = {
    async access(absolutePath) {
      if (IMAGE_EXTENSIONS.has(extname(absolutePath).toLowerCase())) {
        throw new Error("BTW read blocked for image files because decoding is not sandboxed");
      }
      await runFileCommand(cwd, absolutePath, "/usr/bin/test", ["-r", absolutePath], options, 1024, signals.getStore());
    },
    async readFile(absolutePath) {
      const content = await runFileCommand(
        cwd,
        absolutePath,
        "/usr/bin/head",
        ["-c", String(MAX_READ_BYTES + 1), "--", absolutePath],
        options,
        MAX_READ_BYTES + 1,
        signals.getStore(),
      );
      if (content.length > MAX_READ_BYTES) {
        throw new Error(`BTW read blocked because the file exceeds ${MAX_READ_BYTES / 1024 / 1024} MiB`);
      }
      return content;
    },
  };
  const read = createReadToolDefinition(cwd, { operations });
  const execute = read.execute.bind(read);
  read.execute = (toolCallId, params, signal, onUpdate, ctx) =>
    signals.run(signal, () => execute(toolCallId, params, signal, onUpdate, ctx));
  return read;
}

export function createReadOnlyBtwToolDefinitions(
  cwd: string,
  options: ReadOnlyBtwToolsOptions = {},
) {
  const read = createSandboxedReadDefinition(cwd, options);
  const bash = createSandboxedBashDefinition(cwd, options);
  const limits = { ...DEFAULT_SANDBOX_LIMITS, ...options.limits };

  bash.description = [
    "Execute a bash command inside the BTW read-only Bubblewrap sandbox.",
    "The project and system files are read-only; only /tmp is writable.",
    "Host credentials and known secret-bearing project paths are unavailable.",
    `Commands are limited to ${limits.runtimeSeconds}s, ${limits.memoryMax} memory, ${limits.tasksMax} processes, and ${limits.cpuQuotaPercent}% CPU quota.`,
    "Output is bounded to 50KB and earlier output is discarded.",
    "Outbound network access is available and may have external side effects.",
  ].join(" ");
  bash.promptSnippet = "Inspect the project with bash inside a read-only filesystem sandbox";
  bash.promptGuidelines = [
    "Use bash only for non-mutating inspection. The filesystem sandbox rejects project and system writes.",
    "Do not send mutating network requests. Network access is not covered by the filesystem read-only guarantee.",
  ];

  // Pi's ToolDefinition is invariant in its parameter schema, so heterogeneous
  // concrete definitions require widening at the createAgentSession boundary.
  return [read, bash] as unknown as SessionToolDefinition[];
}
