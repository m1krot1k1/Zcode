import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
const workspace = process.argv[2];
const a = await import(pathToFileURL(join(workspace, "src/a.mjs")).href);
const b = await import(pathToFileURL(join(workspace, "src/b.mjs")).href);
const clampSource = await readFile(join(workspace, "src/clamp.mjs"), "utf8");
const aSource = await readFile(join(workspace, "src/a.mjs"), "utf8");
const bSource = await readFile(join(workspace, "src/b.mjs"), "utf8");
if (!/export function clamp|export const clamp/.test(clampSource)) {
  console.error("clamp module does not export clamp");
  process.exit(1);
}
if (
  !/from\s+["']\.\/clamp\.mjs["']/.test(aSource) ||
  !/from\s+["']\.\/clamp\.mjs["']/.test(bSource)
) {
  console.error("a/b do not import ./clamp.mjs");
  process.exit(1);
}
if (
  /function clamp|const clamp/.test(aSource.replace(/import[^;]+;/g, "")) ||
  /function clamp|const clamp/.test(bSource.replace(/import[^;]+;/g, ""))
) {
  console.error("a/b still declare a local clamp");
  process.exit(1);
}
if (
  a.percent(120) !== "100%" ||
  a.percent(-5) !== "0%" ||
  b.volume(12) !== 11 ||
  b.volume(-1) !== 0
) {
  console.error("behavior changed");
  process.exit(1);
}
console.log("clamp refactor acceptance ok");
