import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
const workspace = process.argv[2];
const source = await readFile(join(workspace, "src/shared.mjs"), "utf8");
if (
  (source.match(/function formatName/g) ?? []).length !== 1 ||
  (source.match(/function formatDate/g) ?? []).length !== 1
) {
  console.error("duplicate function definitions");
  process.exit(1);
}
const shared = await import(pathToFileURL(join(workspace, "src/shared.mjs")).href);
if (shared.formatName("  ada lovelace ") !== "Ada Lovelace") {
  console.error("formatName mismatch: " + shared.formatName("  ada lovelace "));
  process.exit(1);
}
if (shared.formatDate(new Date("2026-11-21T00:00:00Z")) !== "2026-11-21") {
  console.error("formatDate mismatch");
  process.exit(1);
}
console.log("duplicate probe acceptance ok");
