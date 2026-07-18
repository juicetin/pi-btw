/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DashboardSession } from "@blackbelt-technology/pi-dashboard-shared/types.js";
import {
  BTW_DASHBOARD_HISTORY_EVENT,
  BTW_DASHBOARD_STATE_EVENT,
  type BtwDashboardState,
} from "../dashboard/protocol";

const mocks = vi.hoisted(() => ({
  events: [] as Array<{ eventType: string; data: Record<string, unknown> }>,
  send: vi.fn(),
  connectionStatus: "connected",
}));

vi.mock("@blackbelt-technology/dashboard-plugin-runtime", () => ({
  usePluginSend: () => mocks.send,
  useSessionEvents: () => mocks.events,
  useShellConnectionStatus: () => mocks.connectionStatus,
}));

import {
  BtwPanelHost,
  buildBtwDashboardPrompt,
  findLatestBtwHistory,
  selectLatestBtwState,
  selectLatestBtwTurn,
} from "../dashboard/client/index";

const session = {
  id: "session-1",
  cwd: "/repo",
  source: "headless",
  status: "active",
  startedAt: Date.now(),
} as DashboardSession;

function state(overrides: Partial<BtwDashboardState> = {}): BtwDashboardState {
  return {
    version: 1,
    threadId: "thread-1",
    revision: 1,
    updatedAt: Date.now(),
    openRequestedAt: Date.now(),
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

afterEach(() => cleanup());

beforeEach(() => {
  mocks.events = [];
  mocks.send.mockReset();
  mocks.connectionStatus = "connected";
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ snapshot: null }) })));
});

describe("BTW dashboard client", () => {
  it("reconstructs a complete persisted exchange history from bounded chunks", () => {
    const exchange = (timestamp: number) => ({
      question: `q${timestamp}`,
      answer: `a${timestamp}`,
      thinking: "",
      timestamp,
      provider: "p",
      model: "m",
    });
    const events = [
      {
        eventType: BTW_DASHBOARD_HISTORY_EVENT,
        data: { version: 1, requestId: "request", threadId: "thread-1", chunkIndex: 0, totalChunks: 2, updatedAt: 10, exchanges: [exchange(1)] },
      },
      {
        eventType: BTW_DASHBOARD_HISTORY_EVENT,
        data: { version: 1, requestId: "request", threadId: "thread-1", chunkIndex: 1, totalChunks: 2, updatedAt: 11, exchanges: [exchange(2)] },
      },
    ];

    expect(findLatestBtwHistory(events)).toEqual({
      threadId: "thread-1",
      exchanges: [exchange(1), exchange(2)],
    });
  });

  it("scopes live transcript rendering to the latest turn", () => {
    const transcript = [
      { id: 1, turnId: 1, type: "assistant-text" as const, text: "old answer", streaming: false },
      { id: 2, turnId: 1, type: "tool-call" as const, toolCallId: "old", toolName: "read", args: "old" },
      { id: 3, turnId: 2, type: "assistant-text" as const, text: "new answer", streaming: true },
    ];

    expect(selectLatestBtwTurn(transcript)).toEqual([transcript[2]]);
  });

  it("prefers newer live state after a Pi process revision reset", () => {
    const persisted = state({ revision: 100, updatedAt: 100 });
    const live = state({ revision: 1, updatedAt: 200, statusText: "new process" });

    expect(selectLatestBtwState(live, persisted)?.statusText).toBe("new process");
  });

  it("does not merge exchanges across thread reset boundaries", () => {
    const oldThread = state({
      threadId: "old",
      updatedAt: 100,
      exchanges: [{ question: "old", answer: "old", thinking: "", timestamp: 1, provider: "p", model: "m" }],
    });
    const newThread = state({ threadId: "new", updatedAt: 200, exchanges: [] });

    expect(selectLatestBtwState(newThread, oldThread)?.exchanges).toEqual([]);
  });

  it("auto-opens for a fresh request and renders live tool activity", async () => {
    mocks.events = [{
      eventType: BTW_DASHBOARD_STATE_EVENT,
      data: state({
        phase: "running",
        busy: true,
        abortable: true,
        statusText: "running tool: read",
        transcript: [
          { id: 1, turnId: 1, type: "turn-boundary", phase: "start" },
          { id: 2, turnId: 1, type: "tool-call", toolCallId: "call-1", toolName: "read", args: "{\"path\":\"README.md\"}" },
          { id: 3, turnId: 1, type: "tool-result", toolCallId: "call-1", toolName: "read", content: "partial", truncated: false, isError: false, streaming: true },
        ],
      }),
    }];

    render(<BtwPanelHost session={session} />);

    expect(await screen.findByTestId("btw-drawer")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Live BTW tool activity" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Ask BTW" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Abort" }));
    expect(mocks.send).toHaveBeenCalledWith({
      type: "ui_management",
      sessionId: "session-1",
      action: "abort",
      event: "btw:dashboard-action",
    });

    fireEvent.click(screen.getByRole("button", { name: "Hide BTW panel" }));
    expect(screen.queryByTestId("btw-drawer")).not.toBeInTheDocument();
    expect(mocks.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "abort" }));
  });

  it("does not present the previous completed turn as live during request preparation", async () => {
    mocks.events = [{
      eventType: BTW_DASHBOARD_STATE_EVENT,
      data: state({
        busy: true,
        phase: "running",
        transcript: [
          { id: 1, turnId: 1, type: "turn-boundary", phase: "start" },
          { id: 2, turnId: 1, type: "assistant-text", text: "previous answer", streaming: false },
          { id: 3, turnId: 1, type: "turn-boundary", phase: "end" },
        ],
      }),
    }];

    render(<BtwPanelHost session={session} />);

    expect(await screen.findByTestId("btw-drawer")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Streaming BTW answer" })).not.toBeInTheDocument();
  });

  it("rejects multiline prompts before dashboard slash-command dispatch", () => {
    expect(buildBtwDashboardPrompt("first line\nsecond line")).toBeNull();
    expect(buildBtwDashboardPrompt("single line")).toBe("/btw single line");
  });

  it("submits contextual questions with save parity and a client request id", async () => {
    mocks.events = [{ eventType: BTW_DASHBOARD_STATE_EVENT, data: state({ openRequestedAt: undefined }) }];
    render(<BtwPanelHost session={session} />);

    fireEvent.click(screen.getByTestId("btw-header-button"));
    fireEvent.change(screen.getByRole("textbox", { name: "Ask BTW" }), { target: { value: "Why is this failing?" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Save exchange" }));
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(mocks.send).toHaveBeenCalledWith({
      type: "send_prompt",
      sessionId: "session-1",
      text: expect.stringMatching(/^\/btw --save Why is this failing\? --btw-dashboard-request=[A-Za-z0-9_-]{8,128}$/),
    });
  });

  it("dispatches native lifecycle, model, and thinking controls with request ids", () => {
    mocks.events = [{ eventType: BTW_DASHBOARD_STATE_EVENT, data: state({
      openRequestedAt: undefined,
      exchanges: [{ question: "q", answer: "a", thinking: "", timestamp: 1, provider: "p", model: "m" }],
    }) }];
    render(<BtwPanelHost session={session} />);
    fireEvent.click(screen.getByTestId("btw-header-button"));

    for (const name of ["New thread", "Use tangent mode", "Inject thread", "Summarize and inject"]) {
      fireEvent.click(screen.getByRole("button", { name }));
    }
    fireEvent.change(screen.getByRole("textbox", { name: "BTW model override" }), {
      target: { value: "provider model api" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply model override" }));
    fireEvent.change(screen.getByRole("combobox", { name: "BTW thinking override" }), {
      target: { value: "high" },
    });

    const prompts = mocks.send.mock.calls
      .map(([message]) => message)
      .filter((message) => message.type === "send_prompt")
      .map((message) => message.text);
    expect(prompts).toEqual([
      expect.stringMatching(/^\/btw:new --btw-dashboard-request=/),
      expect.stringMatching(/^\/btw:tangent --btw-dashboard-request=/),
      expect.stringMatching(/^\/btw:inject --btw-dashboard-request=/),
      expect.stringMatching(/^\/btw:summarize --btw-dashboard-request=/),
      expect.stringMatching(/^\/btw:model provider model api --btw-dashboard-request=/),
      expect.stringMatching(/^\/btw:thinking high --btw-dashboard-request=/),
    ]);
  });

  it("keeps tangent mode for composer follow-ups", () => {
    mocks.events = [{ eventType: BTW_DASHBOARD_STATE_EVENT, data: state({
      mode: "tangent",
      openRequestedAt: undefined,
    }) }];
    render(<BtwPanelHost session={session} />);
    fireEvent.click(screen.getByTestId("btw-header-button"));
    fireEvent.change(screen.getByRole("textbox", { name: "Ask BTW" }), { target: { value: "follow up" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({
      type: "send_prompt",
      text: expect.stringMatching(/^\/btw:tangent follow up --btw-dashboard-request=/),
    }));
  });

  it("shows persisted model and thinking overrides when reopened", () => {
    mocks.events = [{ eventType: BTW_DASHBOARD_STATE_EVENT, data: state({
      openRequestedAt: undefined,
      modelOverride: "provider model api",
      thinkingOverride: "high",
    }) }];
    render(<BtwPanelHost session={session} />);
    fireEvent.click(screen.getByTestId("btw-header-button"));

    expect(screen.getByRole("textbox", { name: "BTW model override" })).toHaveValue("provider model api");
    expect(screen.getByRole("combobox", { name: "BTW thinking override" })).toHaveValue("high");
  });

  it("requires explicit confirmation before clearing the BTW thread", () => {
    mocks.events = [{ eventType: BTW_DASHBOARD_STATE_EVENT, data: state({
      openRequestedAt: undefined,
      exchanges: [{ question: "q", answer: "a", thinking: "", timestamp: 1, provider: "p", model: "m" }],
    }) }];
    render(<BtwPanelHost session={session} />);
    fireEvent.click(screen.getByTestId("btw-header-button"));

    fireEvent.click(screen.getByRole("button", { name: "Clear thread" }));
    expect(mocks.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "send_prompt" }));
    expect(screen.getByRole("button", { name: "Confirm clear" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Confirm clear" }));

    expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({
      type: "send_prompt",
      text: expect.stringMatching(/^\/btw:clear --btw-dashboard-request=/),
    }));
  });

  it("refetches persisted state after reconnect", async () => {
    mocks.connectionStatus = "disconnected";
    const { rerender } = render(<BtwPanelHost session={session} />);
    expect(fetch).not.toHaveBeenCalled();

    mocks.connectionStatus = "connected";
    rerender(<BtwPanelHost session={session} />);

    await waitFor(() => expect(fetch).toHaveBeenCalledWith(
      "/api/plugins/btw/sessions/session-1/snapshot",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    ));
  });

  it("keeps multiline drafts and shows an explicit dispatch error", () => {
    mocks.events = [{ eventType: BTW_DASHBOARD_STATE_EVENT, data: state({ openRequestedAt: undefined }) }];
    render(<BtwPanelHost session={session} />);
    fireEvent.click(screen.getByTestId("btw-header-button"));
    const input = screen.getByRole("textbox", { name: "Ask BTW" });
    fireEvent.change(input, { target: { value: "first line\nsecond line" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(screen.getByRole("alert")).toHaveTextContent("single line");
    expect(input).toHaveValue("first line\nsecond line");
    expect(mocks.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "send_prompt" }));
  });

  it("keeps drafts and actions local while the dashboard is disconnected", () => {
    mocks.connectionStatus = "disconnected";
    mocks.events = [{ eventType: BTW_DASHBOARD_STATE_EVENT, data: state({ openRequestedAt: undefined }) }];
    render(<BtwPanelHost session={session} />);

    fireEvent.click(screen.getByTestId("btw-header-button"));
    const input = screen.getByRole("textbox", { name: "Ask BTW" });
    fireEvent.change(input, { target: { value: "keep this draft" } });

    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Abort" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "New thread" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "BTW model override" })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "BTW thinking override" })).toBeDisabled();
    expect(input).toHaveValue("keep this draft");
    expect(screen.getByText("Dashboard connection unavailable")).toBeInTheDocument();
    expect(mocks.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "send_prompt" }));
  });

  it("resets drawer state and drafts when the selected session changes", () => {
    mocks.events = [{ eventType: BTW_DASHBOARD_STATE_EVENT, data: state({ openRequestedAt: undefined }) }];
    const { rerender } = render(<BtwPanelHost session={session} />);
    fireEvent.click(screen.getByTestId("btw-header-button"));
    fireEvent.change(screen.getByRole("textbox", { name: "Ask BTW" }), { target: { value: "session one draft" } });

    rerender(<BtwPanelHost session={{ ...session, id: "session-2" }} />);

    expect(screen.queryByTestId("btw-drawer")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("btw-header-button"));
    expect(screen.getByRole("textbox", { name: "Ask BTW" })).toHaveValue("");
  });

  it("shows persisted snapshot failures instead of silently substituting empty history", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 503 })));
    render(<BtwPanelHost session={session} />);
    fireEvent.click(screen.getByTestId("btw-header-button"));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("HTTP 503"));
  });
});
