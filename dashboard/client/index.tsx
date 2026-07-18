import type React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import {
  usePluginSend,
  useSessionEvents,
  useShellConnectionStatus,
} from "@blackbelt-technology/dashboard-plugin-runtime";
import type { DashboardSession } from "@blackbelt-technology/pi-dashboard-shared/types.js";
import {
  BTW_DASHBOARD_ACTION_EVENT,
  BTW_DASHBOARD_HISTORY_EVENT,
  BTW_DASHBOARD_STATE_EVENT,
  formatBtwDashboardCommand,
  isBtwDashboardHistoryChunk,
  isBtwDashboardState,
  mergeBtwDashboardExchanges,
  mergeLatestBtwHistoryChunks,
  type BtwDashboardState,
  type BtwDashboardTranscriptEntry,
} from "../protocol";

type BtwPanelHostProps = {
  session: DashboardSession;
};

type EventLike = {
  eventType: string;
  data: Record<string, unknown>;
};

const OPEN_REQUEST_WINDOW_MS = 5_000;

export function findLatestBtwState(events: readonly EventLike[]): BtwDashboardState | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.eventType !== BTW_DASHBOARD_STATE_EVENT) continue;
    if (isBtwDashboardState(event.data)) return event.data;
  }
  return null;
}

export function findLatestBtwHistory(events: readonly EventLike[]) {
  const chunks = events
    .filter((event) => event.eventType === BTW_DASHBOARD_HISTORY_EVENT)
    .map((event) => event.data)
    .filter(isBtwDashboardHistoryChunk);
  return mergeLatestBtwHistoryChunks(chunks);
}

export function selectLatestBtwState(
  eventState: BtwDashboardState | null,
  serverState: BtwDashboardState | null,
): BtwDashboardState | null {
  if (!eventState) return serverState;
  if (!serverState) return eventState;
  const newest = eventState.updatedAt >= serverState.updatedAt ? eventState : serverState;
  if (eventState.threadId !== serverState.threadId) return newest;
  return {
    ...newest,
    exchanges: mergeBtwDashboardExchanges(serverState.exchanges, eventState.exchanges),
  };
}

function statusColor(state: BtwDashboardState | null): string {
  if (!state) return "#6b7280";
  if (state.phase === "running") return "#fbbf24";
  if (state.phase === "error") return "#f87171";
  return "#34d399";
}

export function buildBtwDashboardPrompt(question: string): string | null {
  const trimmed = question.trim();
  if (!trimmed || /[\r\n]/u.test(trimmed)) return null;
  return `/btw ${trimmed}`;
}

export function selectLatestBtwTurn(
  transcript: readonly BtwDashboardTranscriptEntry[],
): BtwDashboardTranscriptEntry[] {
  const latestTurnId = transcript.reduce((latest, entry) => Math.max(latest, entry.turnId), -1);
  return latestTurnId < 0 ? [] : transcript.filter((entry) => entry.turnId === latestTurnId);
}

function ToolCards({ transcript }: { transcript: BtwDashboardTranscriptEntry[] }) {
  const calls = transcript.filter((entry) => entry.type === "tool-call");
  if (calls.length === 0) return null;
  return (
    <section aria-label="Live BTW tool activity">
      <h3 style={sectionTitleStyle}>Live tools</h3>
      {calls.map((call) => {
        const result = transcript.findLast(
          (entry): entry is Extract<BtwDashboardTranscriptEntry, { type: "tool-result" }> =>
            entry.type === "tool-result" && entry.toolCallId === call.toolCallId,
        );
        return (
          <details key={call.id} style={toolCardStyle}>
            <summary style={{ cursor: "pointer", fontSize: 12 }}>
              {call.toolName} · {result ? (result.isError ? "error" : result.streaming ? "streaming" : "complete") : "running"}
            </summary>
            <pre style={preStyle}>{call.args}</pre>
            {result ? <pre style={preStyle}>{result.content}</pre> : null}
          </details>
        );
      })}
    </section>
  );
}

const THINKING_LEVELS = ["clear", "off", "minimal", "low", "medium", "high", "xhigh"] as const;

export function createBtwDashboardRequestId(): string {
  return globalThis.crypto.randomUUID();
}

function BtwControls({
  disabled,
  hasThread,
  modelOverride,
  thinkingOverride,
  dispatch,
}: {
  disabled: boolean;
  hasThread: boolean;
  modelOverride: string | null;
  thinkingOverride: string | null;
  dispatch(command: string, args?: string): void;
}) {
  const [confirmClear, setConfirmClear] = useState(false);
  const [model, setModel] = useState(modelOverride ?? "");
  const confirmButton = useRef<HTMLButtonElement>(null);

  useEffect(() => setModel(modelOverride ?? ""), [modelOverride]);
  useEffect(() => {
    if (confirmClear) confirmButton.current?.focus();
  }, [confirmClear]);

  function applyModel(event: FormEvent): void {
    event.preventDefault();
    if (model.trim()) dispatch("btw:model", model);
  }

  function clearThread(): void {
    dispatch("btw:clear");
    setConfirmClear(false);
  }

  return (
    <details style={controlsStyle}>
      <summary style={{ cursor: "pointer", fontSize: 12 }}>Thread controls</summary>
      <div style={controlGridStyle}>
        <button type="button" disabled={disabled} onClick={() => dispatch("btw:new")} style={buttonStyle}>New thread</button>
        <button type="button" disabled={disabled} onClick={() => dispatch("btw:tangent")} style={buttonStyle}>Use tangent mode</button>
        <button type="button" disabled={disabled || !hasThread} onClick={() => dispatch("btw:inject")} style={buttonStyle}>Inject thread</button>
        <button type="button" disabled={disabled || !hasThread} onClick={() => dispatch("btw:summarize")} style={buttonStyle}>Summarize and inject</button>
      </div>
      {confirmClear ? (
        <div style={confirmRowStyle} aria-live="polite">
          <span style={subtleStyle}>Clear the full BTW thread?</span>
          <button ref={confirmButton} type="button" disabled={disabled} onClick={clearThread} style={dangerButtonStyle}>Confirm clear</button>
          <button type="button" onClick={() => setConfirmClear(false)} style={buttonStyle}>Cancel clear</button>
        </div>
      ) : (
        <button type="button" disabled={disabled || !hasThread} onClick={() => setConfirmClear(true)} style={dangerButtonStyle}>Clear thread</button>
      )}
      <form onSubmit={applyModel} style={controlFormStyle}>
        <input
          aria-label="BTW model override"
          value={model}
          onChange={(event) => setModel(event.target.value)}
          placeholder="provider model api"
          disabled={disabled}
          style={inputStyle}
        />
        <button type="submit" disabled={disabled || !model.trim()} style={buttonStyle}>Apply model override</button>
        <button type="button" disabled={disabled} onClick={() => dispatch("btw:model", "clear")} style={buttonStyle}>Use main model</button>
      </form>
      <label style={controlFormStyle}>
        <span style={subtleStyle}>Thinking</span>
        <select
          aria-label="BTW thinking override"
          value={thinkingOverride ?? "clear"}
          disabled={disabled}
          onChange={(event) => dispatch("btw:thinking", event.target.value)}
          style={inputStyle}
        >
          {THINKING_LEVELS.map((level) => <option key={level} value={level}>{level === "clear" ? "Use main setting" : level}</option>)}
        </select>
      </label>
    </details>
  );
}

function BtwDrawer({
  sessionId,
  state,
  loadError,
  connected,
  onClose,
}: {
  sessionId: string;
  state: BtwDashboardState | null;
  loadError: string | null;
  connected: boolean;
  onClose(): void;
}) {
  const send = usePluginSend();
  const [draft, setDraft] = useState("");
  const [saveExchange, setSaveExchange] = useState(false);
  const [submissionError, setSubmissionError] = useState<string | null>(null);
  const busy = state?.busy ?? false;
  const liveTranscript = selectLatestBtwTurn(state?.transcript ?? []);
  const liveTurnStarted = liveTranscript.some((entry) => entry.type === "turn-boundary" && entry.phase === "start");
  const liveTurnEnded = liveTranscript.some((entry) => entry.type === "turn-boundary" && entry.phase === "end");
  const showLiveTranscript = busy && liveTurnStarted && !liveTurnEnded;
  const liveAnswer = liveTranscript.findLast((entry) => entry.type === "assistant-text");

  function dispatchCommand(command: string, args = ""): void {
    if (busy || !connected) return;
    send({
      type: "send_prompt",
      sessionId,
      text: formatBtwDashboardCommand(command, args, createBtwDashboardRequestId()),
    });
  }

  function submit(event: FormEvent): void {
    event.preventDefault();
    if (busy || !connected) return;
    const prompt = buildBtwDashboardPrompt(draft);
    if (!prompt) {
      setSubmissionError("BTW prompts must be a non-empty single line.");
      return;
    }
    const command = state?.mode === "tangent" ? "btw:tangent" : "btw";
    dispatchCommand(command, `${saveExchange ? "--save " : ""}${draft.trim()}`);
    setSubmissionError(null);
    setDraft("");
  }

  function abort(): void {
    if (!connected) return;
    send({
      type: "ui_management",
      sessionId,
      action: "abort",
      event: BTW_DASHBOARD_ACTION_EVENT,
    });
  }

  return (
    <aside aria-label="BTW side conversation" style={drawerStyle} data-testid="btw-drawer">
      <header style={drawerHeaderStyle}>
        <div>
          <strong>BTW side conversation</strong>
          <div style={subtleStyle}>{state?.mode === "tangent" ? "Contextless tangent" : "Main-session context"}</div>
        </div>
        <button type="button" onClick={onClose} aria-label="Hide BTW panel" style={buttonStyle}>×</button>
      </header>

      <div style={scrollStyle}>
        {loadError ? <div role="alert" style={errorStyle}>{loadError}</div> : null}
        {state?.exchanges.length ? (
          <section aria-label="BTW conversation history">
            <h3 style={sectionTitleStyle}>Conversation</h3>
            {state.exchanges.map((exchange) => (
              <div key={`${exchange.timestamp}-${exchange.question}`} style={exchangeStyle}>
                <div style={questionStyle}>You: {exchange.question}</div>
                <div style={answerStyle}>{exchange.answer}</div>
                <div style={subtleStyle}>{exchange.provider}/{exchange.model}</div>
              </div>
            ))}
          </section>
        ) : <div style={emptyStyle}>No BTW exchanges yet.</div>}

        {showLiveTranscript && liveAnswer?.type === "assistant-text" && liveAnswer.text ? (
          <section aria-label="Streaming BTW answer">
            <h3 style={sectionTitleStyle}>Streaming answer</h3>
            <div style={answerStyle}>{liveAnswer.text}</div>
          </section>
        ) : null}
        {showLiveTranscript ? <ToolCards transcript={liveTranscript} /> : null}
      </div>

      <footer style={composerStyle}>
        <div aria-live="polite" style={{ ...subtleStyle, color: statusColor(state) }}>
          {!connected ? "Dashboard connection unavailable" : state?.statusText ?? (busy ? "Running…" : "Ready")}
        </div>
        {submissionError ? <div role="alert" style={errorStyle}>{submissionError}</div> : null}
        <BtwControls
          disabled={busy || !connected}
          hasThread={(state?.exchanges.length ?? 0) > 0}
          modelOverride={state?.modelOverride ?? null}
          thinkingOverride={state?.thinkingOverride ?? null}
          dispatch={dispatchCommand}
        />
        <form onSubmit={submit}>
          <textarea
            aria-label="Ask BTW"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            disabled={busy || !connected}
            rows={3}
            style={textareaStyle}
          />
          <div style={actionRowStyle}>
            <label style={saveLabelStyle}>
              <input
                type="checkbox"
                checked={saveExchange}
                onChange={(event) => setSaveExchange(event.target.checked)}
                disabled={busy || !connected}
              />
              Save exchange
            </label>
            <button type="submit" disabled={busy || !connected || !draft.trim()} style={buttonStyle}>Send</button>
            <button type="button" disabled={!state?.abortable || !connected} onClick={abort} style={dangerButtonStyle}>Abort</button>
          </div>
        </form>
      </footer>
    </aside>
  );
}

function BtwPanelSession({ session }: BtwPanelHostProps) {
  const events = useSessionEvents(session.id) as readonly EventLike[];
  const send = usePluginSend();
  const connectionStatus = useShellConnectionStatus();
  const eventState = useMemo(() => findLatestBtwState(events), [events]);
  const eventHistory = useMemo(() => findLatestBtwHistory(events), [events]);
  const [serverState, setServerState] = useState<BtwDashboardState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const seenOpenRequest = useRef(0);
  const selectedState = selectLatestBtwState(eventState, serverState);
  const state = selectedState
    ? {
        ...selectedState,
        exchanges: eventHistory?.threadId === selectedState.threadId
          ? mergeBtwDashboardExchanges(selectedState.exchanges, eventHistory.exchanges)
          : selectedState.exchanges,
      }
    : null;

  useEffect(() => {
    setServerState(null);
    setLoadError(null);
    if (connectionStatus !== "connected") return;
    const controller = new AbortController();
    void fetch(`/api/plugins/btw/sessions/${encodeURIComponent(session.id)}/snapshot`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`BTW snapshot request failed with HTTP ${response.status}`);
        return response.json() as Promise<{ snapshot?: unknown }>;
      })
      .then((payload) => {
        if (payload.snapshot === null || payload.snapshot === undefined) return;
        if (!isBtwDashboardState(payload.snapshot)) throw new Error("BTW snapshot response was malformed");
        setServerState(payload.snapshot);
      })
      .catch((error) => {
        if ((error as Error).name !== "AbortError") setLoadError((error as Error).message);
      });
    return () => controller.abort();
  }, [connectionStatus, session.id]);

  useEffect(() => {
    if (connectionStatus !== "connected") return;
    send({ type: "subscribe", sessionId: session.id, lastSeq: 0 });
    send({
      type: "ui_management",
      sessionId: session.id,
      action: "snapshot",
      event: BTW_DASHBOARD_ACTION_EVENT,
    });
  }, [connectionStatus, send, session.id]);

  useEffect(() => {
    const requestedAt = state?.openRequestedAt ?? 0;
    if (requestedAt <= seenOpenRequest.current) return;
    seenOpenRequest.current = requestedAt;
    if (Date.now() - requestedAt <= OPEN_REQUEST_WINDOW_MS) setOpen(true);
  }, [state?.openRequestedAt]);

  return (
    <div style={hostStyle}>
      <button
        type="button"
        onClick={() => setOpen(true)}
        style={headerButtonStyle}
        title={state?.statusText ?? "Open BTW side conversation"}
        data-testid="btw-header-button"
      >
        <span aria-hidden="true" style={{ ...dotStyle, background: statusColor(state) }} />BTW
      </button>
      {open ? (
        <BtwDrawer
          sessionId={session.id}
          state={state}
          loadError={loadError}
          connected={connectionStatus === "connected"}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </div>
  );
}

export function BtwPanelHost({ session }: BtwPanelHostProps) {
  return <BtwPanelSession key={session.id} session={session} />;
}

const hostStyle: React.CSSProperties = { display: "flex", justifyContent: "flex-end", padding: "2px 8px" };
const drawerStyle: React.CSSProperties = { position: "fixed", zIndex: 80, top: 0, right: 0, bottom: 0, width: "min(520px, 100vw)", display: "flex", flexDirection: "column", background: "var(--bg-primary, #111827)", color: "var(--text-primary, #f3f4f6)", borderLeft: "1px solid var(--border-color, #374151)", boxShadow: "-12px 0 30px rgba(0,0,0,.35)" };
const drawerHeaderStyle: React.CSSProperties = { display: "flex", justifyContent: "space-between", alignItems: "center", padding: 14, borderBottom: "1px solid var(--border-color, #374151)" };
const scrollStyle: React.CSSProperties = { flex: 1, overflowY: "auto", padding: 14 };
const composerStyle: React.CSSProperties = { padding: 14, borderTop: "1px solid var(--border-color, #374151)" };
const textareaStyle: React.CSSProperties = { width: "100%", boxSizing: "border-box", marginTop: 8, padding: 10, resize: "vertical", color: "inherit", background: "var(--bg-secondary, #1f2937)", border: "1px solid var(--border-color, #4b5563)", borderRadius: 6 };
const buttonStyle: React.CSSProperties = { padding: "5px 10px", borderRadius: 5, border: "1px solid #4b5563", color: "inherit", background: "#1f2937", cursor: "pointer" };
const dangerButtonStyle: React.CSSProperties = { ...buttonStyle, borderColor: "#ef4444", color: "#fca5a5" };
const headerButtonStyle: React.CSSProperties = { ...buttonStyle, display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11, padding: "3px 7px" };
const dotStyle: React.CSSProperties = { width: 7, height: 7, borderRadius: "50%" };
const actionRowStyle: React.CSSProperties = { display: "flex", gap: 8, marginTop: 8, justifyContent: "flex-end" };
const subtleStyle: React.CSSProperties = { color: "var(--text-muted, #9ca3af)", fontSize: 11, marginTop: 3 };
const sectionTitleStyle: React.CSSProperties = { fontSize: 11, textTransform: "uppercase", letterSpacing: ".08em", color: "var(--text-muted, #9ca3af)", margin: "14px 0 8px" };
const exchangeStyle: React.CSSProperties = { padding: 10, marginBottom: 8, background: "var(--bg-secondary, #1f2937)", borderRadius: 7 };
const questionStyle: React.CSSProperties = { fontWeight: 600, marginBottom: 6 };
const answerStyle: React.CSSProperties = { whiteSpace: "pre-wrap", lineHeight: 1.45 };
const toolCardStyle: React.CSSProperties = { marginBottom: 7, padding: 8, border: "1px solid #374151", borderRadius: 6 };
const preStyle: React.CSSProperties = { whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontSize: 11, margin: "7px 0 0" };
const errorStyle: React.CSSProperties = { padding: 8, border: "1px solid #ef4444", color: "#fca5a5", borderRadius: 6 };
const emptyStyle: React.CSSProperties = { color: "var(--text-muted, #9ca3af)", padding: "18px 0" };
const controlsStyle: React.CSSProperties = { margin: "8px 0", padding: 8, border: "1px solid #374151", borderRadius: 6 };
const controlGridStyle: React.CSSProperties = { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, margin: "8px 0" };
const confirmRowStyle: React.CSSProperties = { display: "flex", alignItems: "center", flexWrap: "wrap", gap: 6, margin: "8px 0" };
const controlFormStyle: React.CSSProperties = { display: "flex", alignItems: "center", gap: 6, marginTop: 8 };
const inputStyle: React.CSSProperties = { minWidth: 0, flex: 1, padding: 6, color: "inherit", background: "var(--bg-secondary, #1f2937)", border: "1px solid var(--border-color, #4b5563)", borderRadius: 5 };
const saveLabelStyle: React.CSSProperties = { display: "inline-flex", alignItems: "center", gap: 5, marginRight: "auto", fontSize: 12 };
