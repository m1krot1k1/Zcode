import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => ({
  app: {
    isPackaged: false,
    getAppPath: () => "/opt/zcode/app",
  },
}));

vi.mock("electron", () => ({ app: electron.app }));

import {
  platformSupported,
  resolveEngineBinary,
} from "../src/main/voice/hexVoiceServiceSupport.js";

const binaryName = process.platform === "win32" ? "hex-service.exe" : "hex-service";
const resourcesPath = "/opt/zcode/resources";

describe("hex voice engine resolution", () => {
  it("resolves the packaged engine from the resources directory", () => {
    electron.app.isPackaged = true;
    // Electron exposes the resources directory on the main process global.
    Object.defineProperty(process, "resourcesPath", {
      value: resourcesPath,
      configurable: true,
    });

    expect(resolveEngineBinary()).toBe(join(resourcesPath, "voice", binaryName));
  });

  it("resolves the development engine from the bundled voice directory", () => {
    electron.app.isPackaged = false;

    expect(resolveEngineBinary()).toContain(
      join("bundled-voice", `${process.platform}-${process.arch}`),
    );
  });

  it("keeps the platform supported list unchanged", () => {
    expect(platformSupported()).toBe(true);
  });
});
