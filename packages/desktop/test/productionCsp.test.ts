import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { hardenProductionCsp } from "../scripts/production-csp.js";

const rendererIndexPath = fileURLToPath(new URL("../src/renderer/index.html", import.meta.url));

describe("production CSP", () => {
  it("removes inline scripts from the production policy but keeps dev needs intact", () => {
    const html = readFileSync(rendererIndexPath, "utf8");
    const hardened = hardenProductionCsp(html);

    const scriptSrc = /script-src [^;]*;/u.exec(hardened)?.[0] ?? "";
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    expect(scriptSrc).toContain("'wasm-unsafe-eval'");
    // style-src по-прежнему допускает inline: стили компонентов встраиваются стилями UI.
    expect(hardened).toContain("style-src 'self' 'unsafe-inline'");
    expect(hardened).not.toBe(html);
  });

  it("is idempotent for documents without the directive", () => {
    expect(hardenProductionCsp("<html></html>")).toBe("<html></html>");
  });
});
