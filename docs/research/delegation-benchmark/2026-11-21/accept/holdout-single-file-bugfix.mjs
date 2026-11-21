import { readdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
const workspace = process.argv[2];
const { slugify } = await import(pathToFileURL(join(workspace, "src/slugify.mjs")).href);
const cases = [
  ["Hello, World!", "hello-world"],
  ["  A  B  ", "a-b"],
  ["C++ & Rust", "c-rust"],
  ["Hello---World", "hello-world"],
];
for (const [input, expected] of cases) {
  const actual = slugify(input);
  if (actual !== expected) {
    console.error(JSON.stringify({ input, expected, actual }));
    process.exit(1);
  }
}
const entries = await readdir(join(workspace, "src"));
if (entries.some((entry) => entry !== "slugify.mjs")) {
  console.error("unexpected files in src: " + entries.join(","));
  process.exit(1);
}
console.log("slugify acceptance ok");
