export const BTW_DASHBOARD_ACTION_EVENT = "btw:dashboard-action";
export const BTW_DASHBOARD_BRIDGE_READY_EVENT = "btw:dashboard-bridge-ready";
export const BTW_DASHBOARD_HISTORY_EVENT = "btw:dashboard-history";
export const BTW_DASHBOARD_STATE_EVENT = "btw:dashboard-state";
export const BTW_DASHBOARD_ARRAY_LIMIT = 18;
export const BTW_DASHBOARD_STRING_LIMIT = 16_384;
export const BTW_DASHBOARD_REQUEST_FLAG = "--btw-dashboard-request=";

const BTW_DASHBOARD_REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/u;

export type BtwDashboardMode = "contextual" | "tangent";
export type BtwDashboardPhase = "idle" | "running" | "error";

export type BtwDashboardExchange = {
  question: string;
  answer: string;
  thinking: string;
  timestamp: number;
  provider: string;
  model: string;
};

export type BtwDashboardTranscriptEntry =
  | { id: number; turnId: number; type: "turn-boundary"; phase: "start" | "end" }
  | { id: number; turnId: number; type: "user-message"; text: string }
  | { id: number; turnId: number; type: "thinking"; text: string; streaming: boolean }
  | { id: number; turnId: number; type: "assistant-text"; text: string; streaming: boolean }
  | { id: number; turnId: number; type: "tool-call"; toolCallId: string; toolName: string; args: string }
  | {
      id: number;
      turnId: number;
      type: "tool-result";
      toolCallId: string;
      toolName: string;
      content: string;
      truncated: boolean;
      isError: boolean;
      streaming: boolean;
    };

export type BtwDashboardSnapshot = {
  threadId: string;
  mode: BtwDashboardMode;
  phase: BtwDashboardPhase;
  busy: boolean;
  abortable: boolean;
  modelOverride: string | null;
  thinkingOverride: string | null;
  statusText: string | null;
  exchanges: BtwDashboardExchange[];
  transcript: BtwDashboardTranscriptEntry[];
};

export type BtwDashboardState = BtwDashboardSnapshot & {
  version: 1;
  revision: number;
  updatedAt: number;
  openRequestedAt?: number;
};

export type BtwDashboardAction = { action: "snapshot" | "abort" };

export function formatBtwDashboardCommand(command: string, args: string, requestId: string): string {
  if (!BTW_DASHBOARD_REQUEST_ID_PATTERN.test(requestId)) {
    throw new Error("BTW dashboard request id must contain 8-128 letters, numbers, underscores, or hyphens.");
  }
  const prefix = `/${command}${args.trim() ? ` ${args.trim()}` : ""}`;
  return `${prefix} ${BTW_DASHBOARD_REQUEST_FLAG}${requestId}`;
}

export function extractBtwDashboardRequest(args: string): { args: string; requestId: string | null } {
  const match = args.match(/(?:^|\s)--btw-dashboard-request=([A-Za-z0-9_-]{8,128})\s*$/u);
  if (!match) return { args: args.trim(), requestId: null };
  return {
    args: args.slice(0, match.index).trim(),
    requestId: match[1],
  };
}

export type BtwDashboardHistoryChunk = {
  version: 1;
  requestId: string;
  threadId: string;
  chunkIndex: number;
  totalChunks: number;
  updatedAt: number;
  exchanges: BtwDashboardExchange[];
};

export function boundBtwDashboardText(value: string): string {
  return value.length <= BTW_DASHBOARD_STRING_LIMIT
    ? value
    : `${value.slice(0, BTW_DASHBOARD_STRING_LIMIT)}\n…[truncated for dashboard]`;
}

export function boundBtwDashboardExchange(exchange: BtwDashboardExchange): BtwDashboardExchange {
  return {
    ...exchange,
    question: boundBtwDashboardText(exchange.question),
    answer: boundBtwDashboardText(exchange.answer),
    thinking: "",
    provider: boundBtwDashboardText(exchange.provider),
    model: boundBtwDashboardText(exchange.model),
  };
}

export function boundBtwDashboardTranscriptEntry(
  entry: BtwDashboardTranscriptEntry,
): BtwDashboardTranscriptEntry {
  if (entry.type === "user-message" || entry.type === "thinking" || entry.type === "assistant-text") {
    return { ...entry, text: boundBtwDashboardText(entry.text) };
  }
  if (entry.type === "tool-call") return { ...entry, args: boundBtwDashboardText(entry.args) };
  if (entry.type === "tool-result") return { ...entry, content: boundBtwDashboardText(entry.content) };
  return { ...entry };
}

export function mergeBtwDashboardExchanges(
  ...groups: ReadonlyArray<readonly BtwDashboardExchange[]>
): BtwDashboardExchange[] {
  const merged = new Map<string, BtwDashboardExchange>();
  for (const exchanges of groups) {
    for (const exchange of exchanges) {
      merged.set(`${exchange.timestamp}\u0000${exchange.question}`, exchange);
    }
  }
  return [...merged.values()].sort((left, right) => left.timestamp - right.timestamp);
}

export function mergeLatestBtwHistoryChunks(
  chunks: readonly BtwDashboardHistoryChunk[],
): { threadId: string; exchanges: BtwDashboardExchange[] } | null {
  const groups = new Map<string, BtwDashboardHistoryChunk[]>();
  for (const chunk of chunks) {
    const group = groups.get(chunk.requestId) ?? [];
    group.push(chunk);
    groups.set(chunk.requestId, group);
  }
  const latest = [...groups.values()].sort(
    (left, right) => Math.max(...right.map((chunk) => chunk.updatedAt)) - Math.max(...left.map((chunk) => chunk.updatedAt)),
  )[0];
  if (!latest || new Set(latest.map((chunk) => chunk.chunkIndex)).size !== latest[0].totalChunks) return null;
  const ordered = [...latest].sort((left, right) => left.chunkIndex - right.chunkIndex);
  return {
    threadId: latest[0].threadId,
    exchanges: mergeBtwDashboardExchanges(...ordered.map((chunk) => chunk.exchanges)),
  };
}

function isBoundedString(value: unknown): value is string {
  return typeof value === "string" && value.length <= BTW_DASHBOARD_STRING_LIMIT + 30;
}

export function isBtwDashboardExchange(value: unknown): value is BtwDashboardExchange {
  if (!value || typeof value !== "object") return false;
  const exchange = value as Partial<BtwDashboardExchange>;
  return (
    isBoundedString(exchange.question) &&
    isBoundedString(exchange.answer) &&
    isBoundedString(exchange.thinking) &&
    typeof exchange.timestamp === "number" &&
    isBoundedString(exchange.provider) &&
    isBoundedString(exchange.model)
  );
}

export function isBtwDashboardTranscriptEntry(value: unknown): value is BtwDashboardTranscriptEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<BtwDashboardTranscriptEntry>;
  if (typeof entry.id !== "number" || typeof entry.turnId !== "number" || typeof entry.type !== "string") return false;
  if (entry.type === "turn-boundary") return entry.phase === "start" || entry.phase === "end";
  if (entry.type === "user-message") return isBoundedString(entry.text);
  if (entry.type === "thinking" || entry.type === "assistant-text") {
    return isBoundedString(entry.text) && typeof entry.streaming === "boolean";
  }
  if (entry.type === "tool-call") {
    return isBoundedString(entry.toolCallId) && isBoundedString(entry.toolName) && isBoundedString(entry.args);
  }
  if (entry.type !== "tool-result") return false;
  return (
    isBoundedString(entry.toolCallId) &&
    isBoundedString(entry.toolName) &&
    isBoundedString(entry.content) &&
    typeof entry.truncated === "boolean" &&
    typeof entry.isError === "boolean" &&
    typeof entry.streaming === "boolean"
  );
}

export function isBtwDashboardHistoryChunk(value: unknown): value is BtwDashboardHistoryChunk {
  if (!value || typeof value !== "object") return false;
  const chunk = value as Partial<BtwDashboardHistoryChunk>;
  return (
    chunk.version === 1 &&
    isBoundedString(chunk.requestId) &&
    isBoundedString(chunk.threadId) &&
    Number.isInteger(chunk.chunkIndex) &&
    Number.isInteger(chunk.totalChunks) &&
    (chunk.chunkIndex ?? -1) >= 0 &&
    (chunk.totalChunks ?? 0) > 0 &&
    (chunk.chunkIndex ?? 0) < (chunk.totalChunks ?? 0) &&
    typeof chunk.updatedAt === "number" &&
    Array.isArray(chunk.exchanges) &&
    chunk.exchanges.length <= BTW_DASHBOARD_ARRAY_LIMIT &&
    chunk.exchanges.every(isBtwDashboardExchange)
  );
}

export function isBtwDashboardAction(value: unknown): value is BtwDashboardAction {
  if (!value || typeof value !== "object") return false;
  const action = (value as { action?: unknown }).action;
  return action === "snapshot" || action === "abort";
}

export function isBtwDashboardState(value: unknown): value is BtwDashboardState {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<BtwDashboardState>;
  return (
    state.version === 1 &&
    typeof state.revision === "number" &&
    typeof state.updatedAt === "number" &&
    isBoundedString(state.threadId) &&
    (state.mode === "contextual" || state.mode === "tangent") &&
    (state.phase === "idle" || state.phase === "running" || state.phase === "error") &&
    typeof state.busy === "boolean" &&
    typeof state.abortable === "boolean" &&
    (state.modelOverride === null || isBoundedString(state.modelOverride)) &&
    (state.thinkingOverride === null || isBoundedString(state.thinkingOverride)) &&
    (state.statusText === null || isBoundedString(state.statusText)) &&
    Array.isArray(state.exchanges) &&
    state.exchanges.length <= BTW_DASHBOARD_ARRAY_LIMIT &&
    state.exchanges.every(isBtwDashboardExchange) &&
    Array.isArray(state.transcript) &&
    state.transcript.length <= BTW_DASHBOARD_ARRAY_LIMIT &&
    state.transcript.every(isBtwDashboardTranscriptEntry)
  );
}
