import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createBtwDashboardPort,
  type BtwDashboardController,
} from "../dashboard/port";
import {
  BTW_DASHBOARD_ACTION_EVENT,
  BTW_DASHBOARD_STATE_EVENT,
  BTW_DASHBOARD_STRING_LIMIT,
  boundBtwDashboardExchange,
  extractBtwDashboardRequest,
  formatBtwDashboardCommand,
  isBtwDashboardState,
  type BtwDashboardSnapshot,
} from "../dashboard/protocol";

function snapshot(overrides: Partial<BtwDashboardSnapshot> = {}): BtwDashboardSnapshot {
  return {
    threadId: "thread-1",
    mode: "contextual",
    phase: "idle",
    busy: false,
    abortable: false,
    modelOverride: null,
    thinkingOverride: null,
    statusText: null,
    exchanges: [],
    transcript: [],
    ...overrides,
  };
}

afterEach(() => vi.useRealTimers());

describe("BTW dashboard protocol", () => {
  it("uses stable event names and rejects malformed state", () => {
    expect(BTW_DASHBOARD_ACTION_EVENT).toBe("btw:dashboard-action");
    expect(BTW_DASHBOARD_STATE_EVENT).toBe("btw:dashboard-state");
    expect(isBtwDashboardState({ version: 1, revision: 1, updatedAt: Date.now(), ...snapshot() })).toBe(true);
    expect(isBtwDashboardState({ version: 1, revision: "bad" })).toBe(false);
  });

  it("round-trips bounded dashboard request ids without exposing them as command arguments", () => {
    const command = formatBtwDashboardCommand("btw:model", "provider model api", "request_123");

    expect(command).toBe("/btw:model provider model api --btw-dashboard-request=request_123");
    expect(extractBtwDashboardRequest("provider model api --btw-dashboard-request=request_123")).toEqual({
      args: "provider model api",
      requestId: "request_123",
    });
    expect(extractBtwDashboardRequest("question --btw-dashboard-request=bad/id")).toEqual({
      args: "question --btw-dashboard-request=bad/id",
      requestId: null,
    });
  });

  it("bounds dashboard strings and deeply rejects malformed payloads", () => {
    const oversized = "x".repeat(BTW_DASHBOARD_STRING_LIMIT + 1);
    const exchange = boundBtwDashboardExchange({
      question: oversized,
      answer: oversized,
      thinking: oversized,
      timestamp: 1,
      provider: "provider",
      model: "model",
    });
    const state = { version: 1, revision: 1, updatedAt: Date.now(), ...snapshot({ exchanges: [exchange] }) };

    expect(exchange.question).toContain("[truncated for dashboard]");
    expect(exchange.thinking).toBe("");
    expect(isBtwDashboardState(state)).toBe(true);
    expect(isBtwDashboardState({ ...state, exchanges: [{ question: 42 }] })).toBe(false);
    expect(isBtwDashboardState({ ...state, transcript: [{ id: 1, turnId: 1, type: "tool-call" }] })).toBe(false);
  });
});

describe("BTW dashboard port", () => {
  it("publishes a current snapshot immediately when a controller attaches", () => {
    const port = createBtwDashboardPort();
    const states: unknown[] = [];
    port.subscribe((state) => states.push(state));

    port.registerController({ snapshot: () => snapshot(), abort: vi.fn() });

    expect(states).toHaveLength(1);
    expect(states[0]).toMatchObject({ version: 1, revision: 1, phase: "idle" });
  });

  it("coalesces streaming updates but publishes panel-open requests immediately", () => {
    vi.useFakeTimers();
    const port = createBtwDashboardPort();
    const states: Array<{ revision: number; openRequestedAt?: number }> = [];
    let current = snapshot({ phase: "running", busy: true });
    port.registerController({ snapshot: () => current, abort: vi.fn() });
    port.subscribe((state) => states.push(state));
    states.splice(0);

    current = snapshot({ phase: "running", busy: true, statusText: "streaming token" });
    port.publish();
    port.publish();
    expect(states).toHaveLength(0);
    vi.advanceTimersByTime(250);
    expect(states).toHaveLength(1);

    port.publish({ openPanel: true, immediate: true });
    expect(states).toHaveLength(2);
    expect(states[1].openRequestedAt).toEqual(expect.any(Number));
    expect(states[1].revision).toBeGreaterThan(states[0].revision);
  });

  it("routes abort and snapshot actions through the registered controller", async () => {
    let current = snapshot();
    const abort = vi.fn(async () => {
      current = snapshot({ statusText: "Request aborted." });
    });
    const controller: BtwDashboardController = { snapshot: () => current, abort };
    const port = createBtwDashboardPort();
    const states: unknown[] = [];
    port.registerController(controller);
    port.subscribe((state) => states.push(state));
    states.splice(0);

    await port.dispatch({ action: "abort" });
    await port.dispatch({ action: "snapshot" });

    expect(abort).toHaveBeenCalledOnce();
    expect(states).toHaveLength(2);
    expect(states[0]).toMatchObject({ statusText: "Request aborted." });
    expect(states[1]).toMatchObject({ statusText: "Request aborted." });
  });

  it("fails closed when an action arrives before the BTW controller", async () => {
    const port = createBtwDashboardPort();
    const states: Array<{ phase: string; statusText: string | null }> = [];
    port.subscribe((state) => states.push(state));

    await port.dispatch({ action: "abort" });

    expect(states.at(-1)).toMatchObject({
      phase: "error",
      statusText: "BTW dashboard controller is unavailable.",
    });
  });
});
