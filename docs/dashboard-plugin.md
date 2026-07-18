# BTW dashboard plugin

The `juicetin/pi-btw` dashboard branch ships the Pi extension and the dashboard plugin from one package. `extensions/btw.ts` remains the canonical owner of BTW state and execution.

## Requirements

- `@blackbelt-technology/pi-agent-dashboard` 0.5.4 or newer
- dashboard sessions spawned as headless RPC sessions
- `useRpcKeeper: true`
- the read-only sandbox requirements in [`read-only-sandbox.md`](read-only-sandbox.md)

Attached tmux sessions cannot dispatch extension slash commands. The panel submits through the dashboard's standard `send_prompt` slash-command path, so it requires a dashboard-spawned headless session.

The 0.5.4 dashboard discovers client plugins at build time from its `packages/*` workspaces. Installing `pi-btw` as a Pi package does not add the web panel to an already-built dashboard. The managed dashboard fork must include this package as a workspace and rebuild the client. The epic's installation slice owns that checkout wiring and deployment. The plugin manifest, server, and bridge entries are not a runtime substitute for the generated client registry.

## Package entries

`package.json#pi-dashboard-plugin` declares:

- `dashboard/client/index.tsx`: session-scoped button and fixed right-hand slide-over
- `dashboard/server/index.ts`: authenticated snapshot route backed by the dashboard event store
- `dashboard/bridge/index.ts`: dashboard activation handshake over Pi's process-wide EventBus
- `dashboard/protocol.ts`: versioned transport types and validators
- `dashboard/port.ts`: narrow in-process controller boundary used by `extensions/btw.ts`

The plugin claims `content-header-sticky`, the dashboard 0.5.4 slot nearest to the selected session header. The contribution renders a small BTW status button above session content. The fixed drawer overlays the right side, so the main conversation remains mounted and visible to its left on wide screens. On narrow screens the drawer uses the full viewport width.

## State flow

1. `extensions/btw.ts` owns the sub-session, persisted exchanges, live transcript, busy state, and abort operation.
2. The narrow port deduplicates unchanged state and coalesces streaming updates to at most one publication per 250 milliseconds.
3. The canonical extension emits `btw:dashboard-state` and listens for narrow dashboard actions on Pi's process-wide EventBus. The standard dashboard bridge forwards those events for the current session.
4. The separately loaded plugin bridge emits only `btw:dashboard-bridge-ready`. Pi loads extension entries through isolated module instances, so the bridge does not attempt to share the in-process port singleton.
5. The client reads live and replayed events with `useSessionEvents`.
6. The server snapshot route rebuilds persisted exchange history from valid state and history-chunk events for refresh and reconnect hydration.

Dashboard 0.5.4 truncates event arrays longer than 20 items. Each live state therefore carries at most the newest 18 exchanges and 18 transcript entries. Every snapshot request also makes the canonical extension emit the complete Pi-persisted exchange history in validated 18-item chunks. The server and client merge those chunks with newer bounded state. This rehydrates history after a dashboard restart without relying on old dashboard memory. Tool transcript remains intentionally live and recent.

Live events and the server snapshot are two explicit sources. The client selects by `updatedAt`, not by revision, because revisions restart when Pi restarts. Snapshot HTTP failures are shown in the panel; they are not silently replaced with empty history.

## Actions

The panel sends `/btw`, `/btw:new`, `/btw:clear`, `/btw:tangent`, `/btw:model`, `/btw:thinking`, `/btw:inject`, and `/btw:summarize` through the dashboard's standard `send_prompt` path. This gives every action a real command context and keeps the extension's slash commands as the only implementation. The composer has a Save exchange toggle that adds `--save`, matching `/btw --save`.

Each panel action includes a UUID in a private `--btw-dashboard-request` suffix. The extension removes that suffix before parsing command arguments, persists the UUID in the Pi session, and ignores later copies. Request IDs are restored from all session entries, including sibling branches. This gives each dashboard session at-most-once action handling across WebSocket reconnects and Pi process restarts. The client does not retry failed actions.

Clear requires a second click on Confirm clear. New thread, tangent mode, inject, summarize, model override, and thinking override use native panel controls. Model input retains the slash command's `provider model api` format. The model and thinking reset controls restore the main session settings.

Snapshot and abort use the dashboard's standard `ui_management` transport with event `btw:dashboard-action`. The canonical extension accepts only `snapshot` and `abort` actions. It does not expose a generic command or event executor.

A second submit while BTW is running is rejected by both the disabled client control and the extension-side busy check, including attempts to switch between contextual and tangent modes. Inject and summarize use the same exclusive busy guard, so two handoffs cannot run at once. The snapshot distinguishes busy work from abortable sub-session streaming. Abort targets only the BTW sub-session and stays disabled during a non-abortable handoff. Hiding the drawer does not abort; state and execution continue in the mounted contribution. Request, inject, and summarize failures include the original error text in dashboard state. The extension preserves the thread for another explicit action.

All mutating controls are disabled while the dashboard WebSocket is disconnected. The draft remains in the panel instead of being cleared into a dropped transport message. Selecting another dashboard session remounts the session-specific contribution, clearing the prior snapshot, errors, open state, and draft.

Typing `/btw`, `/btw:tangent`, or `/btw:new` in the main dashboard composer publishes a fresh panel-open request. Connected clients auto-open only when that request is at most five seconds old, which avoids reopening stale drawers after a later page refresh.

## Display model

Persisted exchanges show user question, assistant answer, and model identity. Snapshot state also carries the active BTW-only model and thinking overrides, so closing and reopening the drawer does not display main-session defaults while an override remains active. Live state can show the streaming answer and expandable tool call/result cards. Tool cards are not reconstructed after completion; the durable view remains the persisted question and answer.

The panel blocks concurrent submit, exposes explicit Abort, reports snapshot and transport failures, and shows idle, running, or error status in the button and composer footer.

## Validation

```bash
npm install
npm test
npx tsc --noEmit
npm pack --dry-run
```

The test suite covers the protocol, request-id extraction, duplicate suppression after reconnect and restart, lifecycle controls, clear confirmation, save parity, port coalescing, bridge action routing, server snapshot hydration, official dashboard manifest validation, React panel behavior, headless BTW streaming, concurrent-submit rejection, and sub-session abort.
