import { readFile } from "node:fs/promises";
import { join } from "node:path";
const workspace = process.argv[2];
const v1 = JSON.parse(await readFile(join(workspace, "config.v1.json"), "utf8"));
const v2 = JSON.parse(await readFile(join(workspace, "config.v2.json"), "utf8"));
const expected = {
  version: 2,
  server: { host: "localhost", port: 8080 },
  logging: { level: "debug" },
};
if (
  JSON.stringify(v1) !== JSON.stringify({ version: 1, host: "localhost", port: 8080, debug: true })
) {
  console.error("config.v1.json changed");
  process.exit(1);
}
if (JSON.stringify(v2) !== JSON.stringify(expected)) {
  console.error("config.v2.json mismatch: " + JSON.stringify(v2));
  process.exit(1);
}
const log = (await readFile(join(workspace, "migration.log"), "utf8")).trim().split(/\r?\n/);
if (JSON.stringify(log) !== JSON.stringify(["read v1", "write v2", "verify v2"])) {
  console.error("migration.log mismatch: " + JSON.stringify(log));
  process.exit(1);
}
console.log("migration acceptance ok");
