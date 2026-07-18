import { BTW_DASHBOARD_BRIDGE_READY_EVENT } from "../protocol";

type EventBus = {
  emit(channel: string, data: unknown): void;
};

type PiBridgeContext = {
  events?: EventBus;
};

/**
 * Dashboard-managed bridge entry.
 *
 * Pi loads bridge entries through an isolated Jiti instance, so this module
 * communicates only through the process-wide Pi EventBus. The canonical BTW
 * extension owns state, action handling, and the in-process controller.
 */
export default function activate(context: PiBridgeContext | { pi?: PiBridgeContext }): void {
  const nested = (context as { pi?: PiBridgeContext }).pi;
  const pi = nested ?? (context as PiBridgeContext);
  if (!pi.events) throw new Error("BTW dashboard bridge requires the Pi event bus");
  pi.events.emit(BTW_DASHBOARD_BRIDGE_READY_EVENT, { version: 1 });
}
