import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { rmSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  collectExternalRuntimeModuleNames,
  copyRuntimeModulePackage,
} from "../scripts/runtime-dependency-closure.mjs";

const desktopRoot = resolve(import.meta.dirname, "..");

function readModuleList(filePath: string, declaration: string): string[] {
  const source = readFileSync(resolve(desktopRoot, filePath), "utf8");
  const declarationStart = source.indexOf(declaration);
  expect(declarationStart, `${filePath} must declare ${declaration}`).toBeGreaterThanOrEqual(0);
  const listStart = source.indexOf("[", declarationStart);
  const listEnd = source.indexOf("];", listStart);
  expect(listStart).toBeGreaterThanOrEqual(0);
  expect(listEnd).toBeGreaterThan(listStart);
  return [...source.slice(listStart, listEnd).matchAll(/^\s*"([^"]+)"\s*,?$/gm)].map(
    (match) => match[1],
  );
}

describe("desktop runtime module packaging", () => {
  it("keeps external yaml in both the app.asar injection and final bundle verification lists", () => {
    const injectedModules = readModuleList(
      "electron-builder.config.js",
      "const REQUIRED_ASAR_RUNTIME_MODULES =",
    );
    const verifiedModules = readModuleList("scripts/bundle.mjs", "const requiredRuntimeModules =");

    expect(injectedModules).toContain("yaml");
    expect(verifiedModules).toContain("yaml");
    expect(injectedModules).toContain("@arms/rum-electron");
    expect(verifiedModules).toContain("@arms/rum-electron");
    expect(verifiedModules.every((moduleName) => injectedModules.includes(moduleName))).toBe(true);
  });

  it("keeps the external TypeScript compiler in both app.asar runtime lists", () => {
    const injectedModules = readModuleList(
      "electron-builder.config.js",
      "const REQUIRED_ASAR_RUNTIME_MODULES =",
    );
    const verifiedModules = readModuleList("scripts/bundle.mjs", "const requiredRuntimeModules =");

    expect(injectedModules).toContain("typescript");
    expect(verifiedModules).toContain("typescript");
  });

  it("packages the tree-sitter runtime used by the code index", () => {
    const injectedModules = readModuleList(
      "electron-builder.config.js",
      "const REQUIRED_ASAR_RUNTIME_MODULES =",
    );
    const verifiedModules = readModuleList("scripts/bundle.mjs", "const requiredRuntimeModules =");

    for (const moduleName of ["web-tree-sitter", "tree-sitter-wasms"]) {
      expect(injectedModules).toContain(moduleName);
      expect(verifiedModules).toContain(moduleName);
    }
  });

  it("finds package roots imported by external main and host bundles", () => {
    expect(
      collectExternalRuntimeModuleNames([
        'import { init } from "@arms/rum-electron"; import yaml from "yaml";',
        'const runtime = await import("@opentelemetry/api-logs"); require("ssh2/lib/client");',
        'import fs from "node:fs"; import { join } from "path"; import "./local-chunk.js";',
      ]),
    ).toEqual(["@arms/rum-electron", "@opentelemetry/api-logs", "ssh2", "yaml"]);
  });

  it("does not copy pnpm workspace node_modules links inside packages", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "zcode-runtime-copy-test-"));
    const sourceRoot = join(tempRoot, "source", "rum-electron");
    const targetRoot = join(tempRoot, "target", "rum-electron");
    try {
      mkdirSync(join(sourceRoot, "node_modules", ".bin"), { recursive: true });
      writeFileSync(join(sourceRoot, "index.js"), "export const ready = true;\n");
      symlinkSync("/missing/electron", join(sourceRoot, "node_modules", ".bin", "electron"));

      copyRuntimeModulePackage(sourceRoot, targetRoot);

      expect(readFileSync(join(targetRoot, "index.js"), "utf8")).toContain("ready");
      expect(() => readFileSync(join(targetRoot, "node_modules", ".bin", "electron"))).toThrow();
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });
});
