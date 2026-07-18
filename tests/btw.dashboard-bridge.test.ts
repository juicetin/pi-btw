import { describe, expect, it, vi } from "vitest";
import activate from "../dashboard/bridge/index";
import { BTW_DASHBOARD_BRIDGE_READY_EVENT } from "../dashboard/protocol";

describe("BTW dashboard bridge", () => {
  it("announces dashboard bridge activation through the process-wide Pi event bus", () => {
    const emit = vi.fn();

    activate({ events: { emit } });

    expect(emit).toHaveBeenCalledWith(BTW_DASHBOARD_BRIDGE_READY_EVENT, { version: 1 });
  });

  it("fails fast without an event bus", () => {
    expect(() => activate({})).toThrow("BTW dashboard bridge requires the Pi event bus");
  });
});
