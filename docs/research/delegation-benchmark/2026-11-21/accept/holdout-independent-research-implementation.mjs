import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
const workspace = process.argv[2];
const docs = await readFile(join(workspace, "docs/api.md"), "utf8");
if (
  !/add\s*\(/i.test(docs) ||
  !/subtract\s*\(/i.test(docs) ||
  !/\x60\x60\x60|\x60[^\x60]+\x60/.test(docs)
) {
  console.error("docs/api.md is missing signatures or examples");
  process.exit(1);
}
const calc = await import(pathToFileURL(join(workspace, "src/calculator.mjs")).href);
if (calc.multiply(6, 7) !== 42 || calc.divide(8, 2) !== 4) {
  console.error("multiply/divide are wrong");
  process.exit(1);
}
let threw = false;
try {
  calc.divide(1, 0);
} catch (error) {
  threw = error instanceof RangeError;
}
if (!threw) {
  console.error("divide(1,0) did not throw RangeError");
  process.exit(1);
}
console.log("calculator + docs acceptance ok");
