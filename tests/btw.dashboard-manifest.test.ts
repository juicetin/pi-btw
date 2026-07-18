import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { validateManifest } from "@blackbelt-technology/dashboard-plugin-runtime/manifest-validator";

describe("BTW dashboard plugin manifest", () => {
  it("ships one package with client, server, bridge, and a session-scoped header claim", async () => {
    const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    const manifest = pkg["pi-dashboard-plugin"];

    expect(manifest).toMatchObject({
      id: "btw",
      client: "./dashboard/client/index.tsx",
      server: "./dashboard/server/index.ts",
      bridge: "./dashboard/bridge/index.ts",
      claims: [
        {
          slot: "content-header-sticky",
          component: "BtwPanelHost",
        },
      ],
    });
    expect(validateManifest(manifest)).toMatchObject({ id: "btw", claims: [{ slot: "content-header-sticky" }] });
    expect(pkg.files).toContain("dashboard");
    expect(pkg.exports["."]).toEqual({
      types: manifest.client,
      default: manifest.client,
    });
    expect(manifest.requires).toEqual({
      piExtensions: ["pi-btw"],
      binaries: ["bwrap", "systemd-run", "systemctl"],
    });
    expect(pkg.dependencies).toMatchObject({
      "@blackbelt-technology/dashboard-plugin-runtime": "^0.5.4",
      "@blackbelt-technology/pi-dashboard-shared": "^0.5.4",
    });
  });
});
