import { readFile } from "node:fs/promises";
import { join } from "node:path";
const workspace = process.argv[2];
const pkg = JSON.parse(await readFile(join(workspace, "package.json"), "utf8"));
const changelog = await readFile(join(workspace, "CHANGELOG.md"), "utf8");
const dist = (await readFile(join(workspace, "dist/app.txt"), "utf8")).trim();
const build = await readFile(join(workspace, "build.mjs"), "utf8");
if (pkg.version !== "1.1.0") {
  console.error("version mismatch");
  process.exit(1);
}
if (!/^## 1\.1\.0/m.test(changelog)) {
  console.error("changelog missing 1.1.0");
  process.exit(1);
}
if (!dist.includes("v1.1.0")) {
  console.error("dist mismatch: " + dist);
  process.exit(1);
}
if (!build.includes("pkg.version") || build.includes("1.1.0")) {
  console.error("build.mjs changed");
  process.exit(1);
}
console.log("release acceptance ok");
