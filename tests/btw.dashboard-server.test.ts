import { describe, expect, it, vi } from "vitest";
import {
  findLatestBtwSnapshot,
  registerPlugin,
} from "../dashboard/server/index";
import { BTW_DASHBOARD_STATE_EVENT } from "../dashboard/protocol";

const state = {
  version: 1 as const,
  threadId: "thread-1",
  revision: 2,
  updatedAt: 20,
  mode: "contextual" as const,
  phase: "idle" as const,
  busy: false,
  statusText: null,
  exchanges: [],
  transcript: [],
};

describe("BTW dashboard server", () => {
  it("selects the latest valid snapshot from persisted session events", () => {
    expect(
      findLatestBtwSnapshot([
        {
          event: {
            eventType: BTW_DASHBOARD_STATE_EVENT,
            data: {
              ...state,
              revision: 1,
              exchanges: [{ question: "older", answer: "answer", thinking: "", timestamp: 1, provider: "p", model: "m" }],
            },
          },
        },
        { event: { eventType: "turn_end", data: {} } },
        { event: { eventType: BTW_DASHBOARD_STATE_EVENT, data: state } },
      ]),
    ).toEqual({
      ...state,
      exchanges: [{ question: "older", answer: "answer", thinking: "", timestamp: 1, provider: "p", model: "m" }],
    });
  });

  it("drops prior exchanges after a thread reset boundary", () => {
    const oldExchange = { question: "old", answer: "old", thinking: "", timestamp: 1, provider: "p", model: "m" };
    const result = findLatestBtwSnapshot([
      { event: { eventType: BTW_DASHBOARD_STATE_EVENT, data: { ...state, threadId: "old", exchanges: [oldExchange] } } },
      { event: { eventType: BTW_DASHBOARD_STATE_EVENT, data: { ...state, threadId: "new", updatedAt: 30 } } },
    ]);

    expect(result?.threadId).toBe("new");
    expect(result?.exchanges).toEqual([]);
  });

  it("registers a session-scoped snapshot route with explicit unknown-session handling", async () => {
    let routeHandler: ((request: any, reply: any) => unknown) | undefined;
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    await registerPlugin({
      fastify: {
        get(_path: string, handler: (request: any, reply: any) => unknown) {
          routeHandler = handler;
        },
      },
      sessionManager: {
        getSession: (id: string) => (id === "known" ? { id } : undefined),
        listActive: () => [],
        listAll: () => [],
      },
      eventStore: {
        getEvents: () => [{ event: { eventType: BTW_DASHBOARD_STATE_EVENT, data: state } }],
        getLatestEvent: () => undefined,
      },
      broadcastToSubscribers: vi.fn(),
      registerPiHandler: vi.fn(),
      registerBrowserHandler: vi.fn(),
      getPluginConfig: () => ({}),
      updatePluginConfig: vi.fn(),
      logger,
    } as never);

    const reply = { code: vi.fn().mockReturnThis(), send: vi.fn((value) => value) };
    expect(await routeHandler?.({ params: { sessionId: "known" } }, reply)).toEqual({ snapshot: state });
    expect(await routeHandler?.({ params: { sessionId: "missing" } }, reply)).toEqual({ error: "Unknown dashboard session" });
    expect(reply.code).toHaveBeenCalledWith(404);
  });
});
