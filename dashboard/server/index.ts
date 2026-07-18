import type { ServerPluginContext } from "@blackbelt-technology/dashboard-plugin-runtime/server";
import {
  BTW_DASHBOARD_HISTORY_EVENT,
  BTW_DASHBOARD_STATE_EVENT,
  isBtwDashboardHistoryChunk,
  isBtwDashboardState,
  mergeBtwDashboardExchanges,
  mergeLatestBtwHistoryChunks,
  type BtwDashboardExchange,
  type BtwDashboardHistoryChunk,
  type BtwDashboardState,
} from "../protocol";

type StoredDashboardEvent = {
  event?: {
    eventType?: string;
    data?: unknown;
  };
};

export function findLatestBtwSnapshot(events: unknown[]): BtwDashboardState | null {
  const states: BtwDashboardState[] = [];
  const historyChunks: BtwDashboardHistoryChunk[] = [];
  for (const value of events) {
    const stored = value as StoredDashboardEvent;
    if (stored?.event?.eventType === BTW_DASHBOARD_HISTORY_EVENT && isBtwDashboardHistoryChunk(stored.event.data)) {
      historyChunks.push(stored.event.data);
    }
    if (stored?.event?.eventType !== BTW_DASHBOARD_STATE_EVENT || !isBtwDashboardState(stored.event.data)) continue;
    states.push(stored.event.data);
  }
  const latest = states.at(-1) ?? null;
  if (!latest) return null;
  const exchangeGroups: BtwDashboardExchange[][] = states
    .filter((state) => state.threadId === latest.threadId)
    .map((state) => state.exchanges);
  const restoredHistory = mergeLatestBtwHistoryChunks(historyChunks);
  if (restoredHistory?.threadId === latest.threadId) exchangeGroups.push(restoredHistory.exchanges);
  return { ...latest, exchanges: mergeBtwDashboardExchanges(...exchangeGroups) };
}

export async function registerPlugin(ctx: ServerPluginContext): Promise<void> {
  ctx.fastify.get<{ Params: { sessionId: string } }>(
    "/api/plugins/btw/sessions/:sessionId/snapshot",
    async (request, reply) => {
      const sessionId = request.params.sessionId;
      if (!ctx.sessionManager.getSession(sessionId)) {
        return reply.code(404).send({ error: "Unknown dashboard session" });
      }
      const snapshot = findLatestBtwSnapshot(ctx.eventStore.getEvents(sessionId));
      return { snapshot };
    },
  );
  ctx.logger.info("BTW dashboard snapshot route registered");
}

export default registerPlugin;
