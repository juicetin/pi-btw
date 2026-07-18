import type {
  BtwDashboardAction,
  BtwDashboardSnapshot,
  BtwDashboardState,
} from "./protocol";

export type BtwDashboardController = {
  snapshot(): BtwDashboardSnapshot;
  abort(): Promise<void>;
};

type PublishOptions = {
  force?: boolean;
  immediate?: boolean;
  openPanel?: boolean;
};

type Listener = (state: BtwDashboardState) => void;

export type BtwDashboardPort = {
  registerController(controller: BtwDashboardController): () => void;
  subscribe(listener: Listener): () => void;
  publish(options?: PublishOptions): void;
  dispatch(action: BtwDashboardAction): Promise<void>;
};

const PUBLISH_INTERVAL_MS = 250;

export function createBtwDashboardPort(): BtwDashboardPort {
  let controller: BtwDashboardController | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let revision = 0;
  let openRequestedAt: number | undefined;
  let lastState: BtwDashboardState | undefined;
  let lastFingerprint = "";
  const listeners = new Set<Listener>();

  function emit(snapshot: BtwDashboardSnapshot, force = false): void {
    const fingerprint = JSON.stringify({ snapshot, openRequestedAt });
    if (!force && fingerprint === lastFingerprint) return;
    lastFingerprint = fingerprint;
    lastState = {
      ...snapshot,
      version: 1,
      revision: ++revision,
      updatedAt: Date.now(),
      ...(openRequestedAt ? { openRequestedAt } : {}),
    };
    for (const listener of listeners) listener(lastState);
  }

  function flush(force = false): void {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (controller) emit(controller.snapshot(), force);
  }

  function publish(options: PublishOptions = {}): void {
    if (options.openPanel) openRequestedAt = Math.max(Date.now(), (openRequestedAt ?? 0) + 1);
    if (options.immediate || options.openPanel) {
      flush(options.force);
      return;
    }
    timer ??= setTimeout(flush, PUBLISH_INTERVAL_MS);
  }

  return {
    registerController(nextController) {
      controller = nextController;
      publish({ force: true, immediate: true });
      return () => {
        if (controller === nextController) controller = null;
        if (timer) clearTimeout(timer);
        timer = undefined;
      };
    },
    subscribe(listener) {
      listeners.add(listener);
      if (lastState) listener(lastState);
      return () => listeners.delete(listener);
    },
    publish,
    async dispatch(action) {
      if (!controller) {
        emit({
          threadId: "unavailable",
          mode: "contextual",
          phase: "error",
          busy: false,
          abortable: false,
          modelOverride: null,
          thinkingOverride: null,
          statusText: "BTW dashboard controller is unavailable.",
          exchanges: [],
          transcript: [],
        });
        return;
      }
      if (action.action === "abort") await controller.abort();
      publish({ force: action.action === "snapshot", immediate: true });
    },
  };
}

const btwDashboardPort = createBtwDashboardPort();

export const registerBtwDashboardController = btwDashboardPort.registerController;
export const subscribeBtwDashboardState = btwDashboardPort.subscribe;
export const publishBtwDashboardState = btwDashboardPort.publish;
export const dispatchBtwDashboardAction = btwDashboardPort.dispatch;
