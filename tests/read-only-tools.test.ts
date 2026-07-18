import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildSystemdRunArgs, DEFAULT_SANDBOX_OPTIONS } from "../extensions/read-only-sandbox";
import {
  createReadOnlyBtwToolDefinitions,
  type ReadOnlySandboxLimits,
} from "../extensions/read-only-tools";

const createdDirectories: string[] = [];

async function createProject(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-btw-read-only-"));
  createdDirectories.push(directory);
  await writeFile(join(directory, "public.txt"), "public contents\n");
  await writeFile(join(directory, ".env"), "SECRET_VALUE=must-not-leak\n");
  await mkdir(join(directory, ".git"));
  await writeFile(join(directory, ".git", "config"), "url = https://credential@example.com/repo\n");
  return directory;
}

function findTool(cwd: string, name: "read" | "bash", limits?: Partial<ReadOnlySandboxLimits>) {
  const tool = createReadOnlyBtwToolDefinitions(cwd, { limits }).find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Missing ${name} tool`);
  return tool;
}

async function execute(tool: ReturnType<typeof findTool>, params: Record<string, unknown>) {
  return tool.execute("test-call", params as never, undefined, undefined, { model: undefined } as never);
}

afterEach(async () => {
  await Promise.all(createdDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("read-only BTW tools", () => {
  it("reads ordinary project files but rejects secret-bearing paths", async () => {
    const cwd = await createProject();
    const read = findTool(cwd, "read");

    const result = await execute(read, { path: "public.txt" });

    expect(result.content).toEqual([{ type: "text", text: "public contents\n" }]);
    await expect(execute(read, { path: ".env" })).rejects.toThrow("BTW read blocked for secret-bearing path: .env");
    await expect(execute(read, { path: ".git/config" })).rejects.toThrow(
      "BTW read blocked for secret-bearing path: .git/config",
    );
  });

  it("mounts the project read-only while leaving temporary storage writable", async () => {
    const cwd = await createProject();
    const bash = findTool(cwd, "bash");

    const result = await execute(bash, {
      command: "printf changed > public.txt 2>/dev/null || true; printf temporary > /tmp/result; cat /tmp/result",
    });

    expect(result.content[0]).toMatchObject({ type: "text" });
    expect((result.content[0] as { text: string }).text).toContain("Read-only file system");
    expect((result.content[0] as { text: string }).text).toContain("temporary");
    expect(await readFile(join(cwd, "public.txt"), "utf8")).toBe("public contents\n");
  });

  it("blocks read symlinks that resolve outside the project", async () => {
    const cwd = await createProject();
    const read = findTool(cwd, "read");
    await symlink("/etc/hosts", join(cwd, "outside-link"));

    await expect(execute(read, { path: "outside-link" })).rejects.toThrow(
      "BTW read blocked outside the project: outside-link",
    );
  });

  it("masks secret-bearing files from sandboxed shell commands, including nested dependency files", async () => {
    const cwd = await createProject();
    const bash = findTool(cwd, "bash");
    await mkdir(join(cwd, "node_modules", "fixture"), { recursive: true });
    await writeFile(join(cwd, "node_modules", "fixture", ".env"), "NESTED_SECRET=must-not-leak\n");

    await expect(
      execute(bash, { command: "cat .env; cat .git/config; cat node_modules/fixture/.env" }),
    ).rejects.toThrow(/Permission denied|No such file/);
  });

  it("cannot connect to a project-local Unix socket", async () => {
    const cwd = await createProject();
    const bash = findTool(cwd, "bash");
    const socketPath = join(cwd, "service.sock");
    let connections = 0;
    const server = createServer((_request, response) => {
      connections += 1;
      response.end("unexpected");
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));

    try {
      await expect(
        execute(bash, {
          command: `python3 -c "import socket; s=socket.socket(socket.AF_UNIX); s.connect('${socketPath}')"`,
        }),
      ).rejects.toThrow(/Address family not supported|Permission denied|Operation not permitted/);
      expect(connections).toBe(0);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("bounds bash output without writing a host-side full-output artifact", async () => {
    const cwd = await createProject();
    const bash = findTool(cwd, "bash");

    const result = await execute(bash, { command: "yes output | head -c 200000" });
    const text = (result.content[0] as { text: string }).text;

    expect(Buffer.byteLength(text)).toBeLessThan(53 * 1024);
    expect(text).toContain("Output truncated to the last 50KB");
    expect(text).not.toContain("Full output:");
    expect(result.details).toBeUndefined();
  });

  it("rejects image decoding outside the sandbox", async () => {
    const cwd = await createProject();
    const read = findTool(cwd, "read");
    await writeFile(join(cwd, "image.png"), Buffer.from("89504e470d0a1a0a", "hex"));

    await expect(execute(read, { path: "image.png" })).rejects.toThrow(
      "BTW read blocked for image files because decoding is not sandboxed",
    );
  });

  it("rejects files larger than the bounded read limit", async () => {
    const cwd = await createProject();
    const read = findTool(cwd, "read");
    await writeFile(join(cwd, "large.bin"), Buffer.alloc(11 * 1024 * 1024, 1));

    await expect(execute(read, { path: "large.bin" })).rejects.toThrow(
      "BTW read blocked because the file exceeds 10 MiB",
    );
  });

  it("fails fast instead of falling back when Bubblewrap is unavailable", async () => {
    const cwd = await createProject();
    const bash = createReadOnlyBtwToolDefinitions(cwd, { bubblewrapPath: "/missing/bwrap" }).find(
      (candidate) => candidate.name === "bash",
    );
    if (!bash) throw new Error("Missing bash tool");

    await expect(execute(bash, { command: "echo unsafe" })).rejects.toThrow(
      "BTW read-only shell requires Bubblewrap at /missing/bwrap",
    );
  });

  it("stops a blocked read sandbox when the read is aborted", async () => {
    const cwd = await createProject();
    const read = findTool(cwd, "read");
    const fifo = join(cwd, "blocked-input");
    execFileSync("/usr/bin/mkfifo", [fifo]);
    const controller = new AbortController();
    const startedAt = Date.now();
    const execution = read.execute(
      "test-call",
      { path: "blocked-input" },
      controller.signal,
      undefined,
      { model: undefined } as never,
    );
    setTimeout(() => controller.abort(), 300);

    await expect(execution).rejects.toThrow("Operation aborted");
    expect(Date.now() - startedAt).toBeLessThan(4_000);
  });

  it("rejects an already-aborted command before starting a sandbox", async () => {
    const cwd = await createProject();
    const bash = findTool(cwd, "bash");
    const controller = new AbortController();
    controller.abort();

    await expect(
      bash.execute("test-call", { command: "sleep 5" }, controller.signal, undefined, { model: undefined } as never),
    ).rejects.toThrow("Command aborted");
  });

  it("stops an active sandbox when its command is aborted", async () => {
    const cwd = await createProject();
    const bash = findTool(cwd, "bash");
    const controller = new AbortController();
    const startedAt = Date.now();
    const execution = bash.execute(
      "test-call",
      { command: "sleep 30" },
      controller.signal,
      undefined,
      { model: undefined } as never,
    );
    setTimeout(() => controller.abort(), 100);

    await expect(execution).rejects.toThrow("Command aborted");
    expect(Date.now() - startedAt).toBeLessThan(4_000);
  });

  it("enforces the configured command deadline", async () => {
    const cwd = await createProject();
    const limits: Partial<ReadOnlySandboxLimits> = { runtimeSeconds: 1 };
    const bash = findTool(cwd, "bash", limits);
    const startedAt = Date.now();

    await expect(execute(bash, { command: "sleep 5" })).rejects.toThrow(/timed out after 1 second|terminated/);
    expect(Date.now() - startedAt).toBeLessThan(4_000);
  });

  it("enforces the configured memory ceiling through the user service manager", async () => {
    const cwd = await createProject();
    const limits: Partial<ReadOnlySandboxLimits> = { memoryMax: "64M" };
    const bash = findTool(cwd, "bash", limits);

    await expect(
      execute(bash, { command: "python3 -c 'x = bytearray(128 * 1024 * 1024); print(len(x))'" }),
    ).rejects.toThrow(/exited with code|terminated|Killed/);
  });

  it("clears the host environment and uses an isolated home", async () => {
    const cwd = await createProject();
    const bash = findTool(cwd, "bash");
    process.env.BTW_TEST_SECRET = "must-not-leak";

    try {
      const result = await execute(bash, {
        command: "if { env; tr '\\0' '\\n' < /proc/1/environ; } | grep -q '^BTW_TEST_SECRET='; then printf leaked; else printf unset; fi; printf '|%s' \"$HOME\"",
      });
      expect((result.content[0] as { text: string }).text).toBe("unset|/home/btw");
    } finally {
      delete process.env.BTW_TEST_SECRET;
    }
  });

  it("retains explicitly approved outbound HTTP access", async () => {
    const cwd = await createProject();
    const bash = findTool(cwd, "bash");
    const server = createServer((_request, response) => response.end("network-ok"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test server address");

    try {
      const result = await execute(bash, { command: `curl -fsS http://127.0.0.1:${address.port}` });
      expect((result.content[0] as { text: string }).text).toBe("network-ok");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("passes every approved resource limit to the user service manager", () => {
    const args = buildSystemdRunArgs("pi-btw-test", DEFAULT_SANDBOX_OPTIONS, {
      cwd: process.cwd(),
      executable: "/bin/true",
      args: [],
    });

    expect(args).toContain("--property=MemoryMax=1G");
    expect(args).toContain("--property=MemorySwapMax=0");
    expect(args).toContain("--property=TasksMax=128");
    expect(args).toContain("--property=CPUQuota=400%");
    expect(args).toContain("--property=RestrictAddressFamilies=AF_INET AF_INET6");
    expect(args).toContain("--property=IPAddressDeny=link-local");
    expect(args).toContain("--property=IPAddressDeny=fd00:ec2::254/128");
    expect(args).toContain("--property=IPAddressDeny=100.100.100.200/32");
    expect(args).toContain("--property=RuntimeMaxSec=60");
  });

  it("fails closed when the secret scan exceeds its depth bound", async () => {
    const cwd = await createProject();
    const bash = findTool(cwd, "bash");
    let directory = cwd;
    for (let depth = 0; depth < 66; depth += 1) {
      directory = join(directory, `d${depth}`);
      await mkdir(directory);
    }

    await expect(execute(bash, { command: "true" })).rejects.toThrow(
      "BTW sandbox blocked because the project secret scan exceeded its depth limit",
    );
  });

  it("does not create project files as a side effect of sandbox setup", async () => {
    const cwd = await createProject();
    const bash = findTool(cwd, "bash");

    await execute(bash, { command: "true" });

    await expect(stat(join(cwd, "tmp"))).rejects.toThrow();
  });
});
