import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { SOURCE_SERVER_RELEASE_TARGETS } from "@zcode/shared";

import { BUNDLED_SOURCE_SERVER_TARGETS } from "../scripts/bundled-remote-assets-targets.mjs";

describe("bundled Source Server target set", () => {
  it("bundles every resolver-supported remote target, not only the build host", () => {
    // Bug 根因: упаковка собирала --target <хост>, поэтому macOS-приложение
    // не содержало linux-x64 и подключение к Linux падало на descriptor.
    expect([...BUNDLED_SOURCE_SERVER_TARGETS]).toEqual([...SOURCE_SERVER_RELEASE_TARGETS]);
  });

  it("stages the full target set instead of a host-only --target", async () => {
    const source = await readFile(
      new URL("../scripts/prepare-bundled-remote-assets.mjs", import.meta.url),
      "utf8",
    );
    expect(source).toContain("BUNDLED_SOURCE_SERVER_TARGETS");
    expect(source).not.toMatch(/"--target"/u);
  });
});
