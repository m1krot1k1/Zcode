import { afterEach, describe, expect, it } from "vitest";
import {
  isDesktopTelemetryEnabled,
  isDoNotTrackEnabled,
  setDesktopTelemetryAllowed,
} from "../src/main/desktopTelemetryGate.js";

describe("desktop telemetry gate", () => {
  afterEach(() => setDesktopTelemetryAllowed(true));

  it("honors DO_NOT_TRACK values", () => {
    for (const value of ["1", "true", "yes", "on", " TRUE "]) {
      expect(isDoNotTrackEnabled({ DO_NOT_TRACK: value })).toBe(true);
    }
    expect(isDoNotTrackEnabled({ DO_NOT_TRACK: "0" })).toBe(false);
    expect(isDoNotTrackEnabled({})).toBe(false);
  });

  it("requires both the setting and the environment to allow sending", () => {
    setDesktopTelemetryAllowed(false);
    expect(isDesktopTelemetryEnabled({})).toBe(false);
    setDesktopTelemetryAllowed(true);
    expect(isDesktopTelemetryEnabled({})).toBe(true);
    expect(isDesktopTelemetryEnabled({ DO_NOT_TRACK: "1" })).toBe(false);
  });
});
