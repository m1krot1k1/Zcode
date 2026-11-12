import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("desktop main logger", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    const services = await import("@zcode/services/node");
    services.resetProcessFsFaultInjectorForTests();
    services.setDataBaseDir(null);
    vi.resetModules();
  });

  it("swallows injected append faults for main and dedicated log files", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-desktop-log-fault-"));
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      vi.resetModules();
      const services = await import("@zcode/services/node");
      services.setDataBaseDir(tempRoot);
      services.setFsFaultInjectorForTests(
        services.createFsFaultInjector([
          {
            id: "D05-desktop-main-log-append-enospc",
            code: "ENOSPC",
            maxMatches: 0,
            operations: ["appendFile"],
            pathEndsWith: ".log",
          },
        ]),
      );

      const { logger, webRemoteControlRelayLogger, flushLoggerForTests } =
        await import("../src/main/logger.js");

      expect(() => logger.info("main log append fault")).not.toThrow();
      expect(() => webRemoteControlRelayLogger.warn("relay log append fault")).not.toThrow();
      await flushLoggerForTests();

      const logDir = join(tempRoot, ".zcode", "v2", "logs");
      await expect(readdir(logDir)).resolves.toEqual(["web-remote-control"]);
      await expect(readdir(join(logDir, "web-remote-control"))).resolves.toEqual([]);

      expect(services.getProcessFsFaultInjector().getHits()).toMatchObject([
        {
          code: "ENOSPC",
          id: "D05-desktop-main-log-append-enospc",
          operation: "appendFile",
        },
        {
          code: "ENOSPC",
          id: "D05-desktop-main-log-append-enospc",
          operation: "appendFile",
        },
      ]);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("redacts credential-looking fields and keeps write order", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-desktop-log-redact-"));
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      vi.resetModules();
      const services = await import("@zcode/services/node");
      services.setDataBaseDir(tempRoot);

      const { logger, flushLoggerForTests } = await import("../src/main/logger.js");

      logger.info("first", {
        apiKey: "sk-live-secret",
        authorization: "Bearer secret-token",
        nested: { password: "hunter2" },
        status: "ok",
      });
      logger.info("second", "Authorization: Bearer abc.def.ghi");

      await flushLoggerForTests();

      const logDir = join(tempRoot, ".zcode", "v2", "logs");
      const files = await readdir(logDir);
      expect(files).toHaveLength(1);
      const content = await readFile(join(logDir, files[0]!), "utf-8");

      expect(content).not.toContain("sk-live-secret");
      expect(content).not.toContain("secret-token");
      expect(content).not.toContain("hunter2");
      expect(content).not.toContain("abc.def.ghi");
      expect(content).toContain("[Redacted]");
      expect(content).toContain("{redacted}");
      expect(content.indexOf("first")).toBeLessThan(content.indexOf("second"));
      expect(content).toContain('"status":"ok"');
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
