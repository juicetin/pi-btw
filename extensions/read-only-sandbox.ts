import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, constants, type Dirent, lstatSync, opendirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";

export type ReadOnlySandboxLimits = {
  runtimeSeconds: number;
  memoryMax: string;
  tasksMax: number;
  cpuQuotaPercent: number;
};

export type SandboxOptions = {
  bubblewrapPath: string;
  systemdRunPath: string;
  systemctlPath: string;
  limits: ReadOnlySandboxLimits;
};

export type SandboxCommand = {
  cwd: string;
  executable: string;
  args: string[];
  signal?: AbortSignal;
  onData?: (data: Buffer) => void;
};

export const DEFAULT_SANDBOX_LIMITS: ReadOnlySandboxLimits = {
  runtimeSeconds: 60,
  memoryMax: "1G",
  tasksMax: 128,
  cpuQuotaPercent: 400,
};

export const DEFAULT_SANDBOX_OPTIONS: SandboxOptions = {
  bubblewrapPath: "/usr/bin/bwrap",
  systemdRunPath: "/usr/bin/systemd-run",
  systemctlPath: "/usr/bin/systemctl",
  limits: DEFAULT_SANDBOX_LIMITS,
};

const SENSITIVE_DIRECTORY_NAMES = new Set([
  ".aws",
  ".azure",
  ".config",
  ".docker",
  ".git",
  ".gnupg",
  ".kube",
  ".ssh",
  ".worktrees",
]);
const SENSITIVE_FILE_NAMES = new Set([
  ".git",
  ".git-credentials",
  ".netrc",
  ".npmrc",
  ".pypirc",
  ".terraformrc",
  ".vault-token",
  ".yarnrc.yml",
  "auth.json",
  "credentials.json",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "id_rsa",
  "terraform.rc",
]);
const SAFE_ENV_SUFFIXES = [".example", ".sample", ".template"];
const MAX_SCAN_DEPTH = 64;
const MAX_SCAN_ENTRIES = 200_000;
const MAX_SCAN_MS = 5_000;

function isSensitiveFileName(name: string): boolean {
  const lower = name.toLowerCase();
  if (SENSITIVE_FILE_NAMES.has(lower)) return true;
  if (lower === ".env") return true;
  if (lower.startsWith(".env.") && !SAFE_ENV_SUFFIXES.some((suffix) => lower.endsWith(suffix))) return true;
  if (/\.(?:key|p12|pem|pfx|tfvars)$/u.test(lower)) return true;
  return /^service-account.*\.json$/u.test(lower);
}

export function isSensitiveProjectPath(cwd: string, absolutePath: string): boolean {
  const rel = relative(cwd, absolutePath);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return rel !== "";
  const segments = rel.split(sep);
  return segments.some((segment) => SENSITIVE_DIRECTORY_NAMES.has(segment.toLowerCase())) || isSensitiveFileName(segments.at(-1) ?? "");
}

export function resolveAllowedProjectPath(cwd: string, requestedPath: string): string {
  const root = realpathSync(cwd);
  const absolutePath = resolve(root, requestedPath);
  const lexicalRelativePath = relative(root, absolutePath);
  if (lexicalRelativePath === ".." || lexicalRelativePath.startsWith(`..${sep}`) || isAbsolute(lexicalRelativePath)) {
    throw new Error(`BTW read blocked outside the project: ${requestedPath}`);
  }
  const canonicalPath = realpathSync(absolutePath);
  const canonicalRelativePath = relative(root, canonicalPath);
  if (canonicalRelativePath === ".." || canonicalRelativePath.startsWith(`..${sep}`) || isAbsolute(canonicalRelativePath)) {
    throw new Error(`BTW read blocked outside the project: ${lexicalRelativePath || requestedPath}`);
  }
  if (isSensitiveProjectPath(root, absolutePath) || isSensitiveProjectPath(root, canonicalPath)) {
    throw new Error(`BTW read blocked for secret-bearing path: ${lexicalRelativePath || requestedPath}`);
  }
  return absolutePath;
}

type ScanItem = { directory: string; depth: number };
type ScanState = { entries: number; deadline: number };

function inspectScanEntry(
  entry: Dirent,
  current: ScanItem,
  pending: ScanItem[],
  sensitive: string[],
  state: ScanState,
): void {
  state.entries += 1;
  if (state.entries > MAX_SCAN_ENTRIES || Date.now() > state.deadline) {
    throw new Error("BTW sandbox blocked because the project secret scan exceeded its safety limit");
  }
  const absolutePath = join(current.directory, entry.name);
  if (entry.isSymbolicLink()) return;
  if (entry.isSocket() || (entry.isDirectory() && SENSITIVE_DIRECTORY_NAMES.has(entry.name.toLowerCase()))) {
    sensitive.push(absolutePath);
  } else if (entry.isFile() && isSensitiveFileName(entry.name)) {
    sensitive.push(absolutePath);
  } else if (entry.isDirectory()) {
    if (current.depth >= MAX_SCAN_DEPTH) {
      throw new Error("BTW sandbox blocked because the project secret scan exceeded its depth limit");
    }
    pending.push({ directory: absolutePath, depth: current.depth + 1 });
  }
}

function scanDirectory(current: ScanItem, pending: ScanItem[], sensitive: string[], state: ScanState): void {
  const directory = opendirSync(current.directory);
  try {
    for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
      inspectScanEntry(entry, current, pending, sensitive, state);
    }
  } finally {
    directory.closeSync();
  }
}

function collectSensitivePaths(cwd: string): string[] {
  const sensitive: string[] = [];
  const pending: ScanItem[] = [{ directory: cwd, depth: 0 }];
  const state = { entries: 0, deadline: Date.now() + MAX_SCAN_MS };
  while (pending.length > 0) {
    const current = pending.pop();
    if (current) scanDirectory(current, pending, sensitive, state);
  }
  return sensitive;
}

function addParentDirectories(args: string[], absolutePath: string): void {
  const root = parse(absolutePath).root;
  const parents: string[] = [];
  for (let current = dirname(absolutePath); current !== root; current = dirname(current)) parents.push(current);
  for (const parent of parents.reverse()) args.push("--dir", parent);
}

function addSystemMounts(args: string[]): void {
  args.push(
    "--ro-bind", "/usr", "/usr",
    "--symlink", "usr/bin", "/bin",
    "--symlink", "usr/lib", "/lib",
    "--symlink", "usr/lib64", "/lib64",
    "--proc", "/proc",
    "--dev", "/dev",
    "--tmpfs", "/tmp",
    "--dir", "/home",
    "--dir", "/home/btw",
    "--dir", "/etc",
  );
  for (const path of ["/etc/hosts", "/etc/nsswitch.conf", "/etc/resolv.conf", "/etc/ssl/certs"]) {
    args.push("--ro-bind-try", path, path);
  }
}

export function buildBubblewrapArgs(command: SandboxCommand): string[] {
  const cwd = resolve(command.cwd);
  const args = [
    "--unshare-user",
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    "--unshare-cgroup-try",
    "--die-with-parent",
    "--new-session",
    "--cap-drop", "ALL",
    "--clearenv",
    "--setenv", "HOME", "/home/btw",
    "--setenv", "LANG", "C.UTF-8",
    "--setenv", "PATH", "/usr/bin:/bin",
    "--setenv", "PWD", cwd,
  ];
  addSystemMounts(args);
  addParentDirectories(args, cwd);
  args.push("--ro-bind", cwd, cwd);

  for (const sensitivePath of collectSensitivePaths(cwd)) {
    if (lstatSync(sensitivePath).isDirectory()) args.push("--tmpfs", sensitivePath);
    else args.push("--ro-bind", "/dev/null", sensitivePath);
  }

  args.push("--chdir", cwd, command.executable, ...command.args);
  return args;
}

export function buildSystemdRunArgs(unit: string, options: SandboxOptions, command: SandboxCommand): string[] {
  const limits = options.limits;
  return [
    "--user",
    "--pipe",
    "--wait",
    "--collect",
    "--quiet",
    `--unit=${unit}`,
    `--property=MemoryMax=${limits.memoryMax}`,
    "--property=MemorySwapMax=0",
    `--property=TasksMax=${limits.tasksMax}`,
    `--property=CPUQuota=${limits.cpuQuotaPercent}%`,
    "--property=RestrictAddressFamilies=AF_INET AF_INET6",
    "--property=IPAddressDeny=link-local",
    "--property=IPAddressDeny=fd00:ec2::254/128",
    "--property=IPAddressDeny=100.100.100.200/32",
    `--property=RuntimeMaxSec=${limits.runtimeSeconds}`,
    "--property=TimeoutStopSec=1s",
    "--property=KillMode=control-group",
    "--property=SendSIGKILL=yes",
    options.bubblewrapPath,
    ...buildBubblewrapArgs(command),
  ];
}

function assertExecutablesAvailable(options: SandboxOptions): void {
  const executables = [
    ["Bubblewrap", options.bubblewrapPath],
    ["systemd-run", options.systemdRunPath],
    ["systemctl", options.systemctlPath],
  ] as const;
  for (const [label, path] of executables) {
    try {
      accessSync(path, constants.X_OK);
    } catch {
      throw new Error(`BTW read-only shell requires ${label} at ${path}`);
    }
  }
}

function runSystemctlStop(options: SandboxOptions, unit: string): Promise<number | null> {
  return new Promise((resolvePromise, reject) => {
    const stop = spawn(options.systemctlPath, ["--user", "stop", "--no-block", unit], { stdio: "ignore" });
    stop.once("error", reject);
    stop.once("close", resolvePromise);
  });
}

async function stopUnit(options: SandboxOptions, unit: string, child: ChildProcess): Promise<void> {
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const code = await runSystemctlStop(options, unit);
    if (code === 0 || child.exitCode !== null) return;
    if (code !== 5 || attempt === 5) {
      throw new Error(`Failed to stop BTW sandbox unit ${unit}: systemctl exited with code ${code}`);
    }
    // systemd-run can receive an abort just before the transient unit is
    // registered. Retry only that explicit "unit not found" race.
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
}

type TerminationController = {
  didTimeOut: () => boolean;
  waitForExit: (exit: Promise<number | null>) => Promise<number | null>;
  wait: () => Promise<void>;
  dispose: () => void;
};

function createTerminationController(
  child: ChildProcess,
  options: SandboxOptions,
  unit: string,
  signal?: AbortSignal,
): TerminationController {
  let timedOut = false;
  let termination: Promise<void> | undefined;
  let rejectTermination!: (error: unknown) => void;
  const terminationFailure = new Promise<never>((_resolve, reject) => {
    rejectTermination = reject;
  });
  const terminate = () => {
    if (termination) return;
    termination = stopUnit(options, unit, child);
    void termination.catch(rejectTermination);
  };
  const timeout = setTimeout(() => {
    timedOut = true;
    terminate();
  }, options.limits.runtimeSeconds * 1000);
  signal?.addEventListener("abort", terminate, { once: true });
  if (signal?.aborted) terminate();
  return {
    didTimeOut: () => timedOut,
    waitForExit: (exit) => Promise.race([exit, terminationFailure]),
    wait: async () => termination,
    dispose: () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", terminate);
    },
  };
}

function waitForChild(child: ChildProcess): Promise<number | null> {
  return new Promise((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("close", resolvePromise);
  });
}

export async function runReadOnlySandboxCommand(
  command: SandboxCommand,
  overrides: Partial<SandboxOptions> & { limits?: Partial<ReadOnlySandboxLimits> } = {},
): Promise<{ exitCode: number | null }> {
  const options = { ...DEFAULT_SANDBOX_OPTIONS, ...overrides, limits: { ...DEFAULT_SANDBOX_LIMITS, ...overrides.limits } };
  assertExecutablesAvailable(options);
  if (command.signal?.aborted) throw new Error("aborted");
  const unit = `pi-btw-${process.pid}-${randomUUID()}`;
  const child = spawn(options.systemdRunPath, buildSystemdRunArgs(unit, options, command), {
    cwd: command.cwd,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const termination = createTerminationController(child, options, unit, command.signal);
  child.stdout?.on("data", command.onData ?? (() => {}));
  child.stderr?.on("data", command.onData ?? (() => {}));
  try {
    const exitCode = await termination.waitForExit(waitForChild(child));
    await termination.wait();
    if (command.signal?.aborted) throw new Error("aborted");
    if (termination.didTimeOut()) throw new Error(`timeout:${options.limits.runtimeSeconds}`);
    return { exitCode };
  } finally {
    termination.dispose();
  }
}
