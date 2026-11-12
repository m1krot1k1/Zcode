import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const tempHomes: string[] = [];
const originalDoNotTrack = process.env.DO_NOT_TRACK;

function makeTempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "zcode-telemetry-opt-out-"));
  tempHomes.push(home);
  return home;
}

const context = {
  clientTimezone: "UTC",
  clientLanguage: "en-US",
  screenResolution: "1280x800",
};

afterEach(() => {
  if (originalDoNotTrack === undefined) {
    delete process.env.DO_NOT_TRACK;
  } else {
    process.env.DO_NOT_TRACK = originalDoNotTrack;
  }
  vi.restoreAllMocks();
  while (tempHomes.length > 0) {
    const home = tempHomes.pop();
    if (home) rmSync(home, { recursive: true, force: true });
  }
});

describe("telemetry opt-out", () => {
  it("sends nothing when telemetry.enabled is false", async () => {
    const home = makeTempHome();
    const { createTelemetryCore } = await import("../src/telemetry/telemetryCore.js");
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    const core = createTelemetryCore({
      fetchImpl: fetchMock,
      homeDir: home,
      isEnabled: () => false,
    });

    await core.reportEvent({
      context,
      elementName: "message_completion",
      eventRegion: "app.session",
      eventType: "result",
      eventExtraDetail: { status: "success" },
    });
    await core.reportAppLaunch(context);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("DO_NOT_TRACK forces opt-out even when the setting allows telemetry", async () => {
    const home = makeTempHome();
    process.env.DO_NOT_TRACK = "1";
    const { createTelemetryCore } = await import("../src/telemetry/telemetryCore.js");
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    const core = createTelemetryCore({
      fetchImpl: fetchMock,
      homeDir: home,
      isEnabled: () => true,
    });

    await core.reportEvent({
      context,
      elementName: "message_completion",
      eventRegion: "app.session",
      eventType: "result",
      eventExtraDetail: { status: "success" },
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still sends when enabled and DO_NOT_TRACK is absent", async () => {
    const home = makeTempHome();
    delete process.env.DO_NOT_TRACK;
    const { createTelemetryCore } = await import("../src/telemetry/telemetryCore.js");
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    const core = createTelemetryCore({
      fetchImpl: fetchMock,
      homeDir: home,
      isEnabled: () => true,
    });

    await core.reportEvent({
      context,
      elementName: "message_completion",
      eventRegion: "app.session",
      eventType: "result",
      eventExtraDetail: { status: "success" },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
