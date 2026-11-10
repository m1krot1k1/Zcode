import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export async function createAppBundle(
  appPath,
  {
    version = "3.17.1",
    architecture = "arm64",
    signature = "signed-stapled",
    ticket = "stapled-ticket",
    bundleId = "dev.zcode.app",
    unsigned = false,
  } = {},
) {
  await mkdir(path.join(appPath, "Contents", "MacOS"), { recursive: true });
  if (!unsigned) await mkdir(path.join(appPath, "Contents", "_CodeSignature"), { recursive: true });
  await writeFile(
    path.join(appPath, "Contents", "Info.plist"),
    `CFBundleShortVersionString=${version}\nCFBundleIdentifier=${bundleId}\nCFBundleExecutable=ZCode\n`,
  );
  await writeFile(path.join(appPath, "Contents", "MacOS", "ZCode"), architecture);
  if (!unsigned) {
    await writeFile(path.join(appPath, "Contents", "_CodeSignature", "CodeResources"), signature);
    await writeFile(path.join(appPath, "Contents", "ticket"), ticket);
  }
}

export async function createReleaseFixture(
  root,
  {
    zipVersion = "3.17.1",
    zipArch = "arm64",
    zipSignature = "signed-stapled",
    zipTicket = "stapled-ticket",
    dmgVersion = "3.17.1",
    dmgArch = "arm64",
    dmgSignature = "signed-stapled",
    dmgTicket = "stapled-ticket",
    zipEntries,
    doctorRejectAt,
    productName = "ZCode",
    appBundleName = `${productName}.app`,
    bundleId = "dev.zcode.app",
    unsigned = false,
    artifactSuffix = "",
  } = {},
) {
  const distDir = path.join(root, "dist");
  const appName = appBundleName;
  const sourceAppPath = path.join(distDir, "mac-arm64", appName);
  const zipAppPath = path.join(root, "zip-payload", appName);
  const dmgAppPath = path.join(root, "dmg-payload", appName);
  await createAppBundle(sourceAppPath, { bundleId, unsigned });
  await createAppBundle(zipAppPath, {
    version: zipVersion,
    architecture: zipArch,
    signature: zipSignature,
    ticket: zipTicket,
    bundleId,
    unsigned,
  });
  await createAppBundle(dmgAppPath, {
    version: dmgVersion,
    architecture: dmgArch,
    signature: dmgSignature,
    ticket: dmgTicket,
    bundleId,
    unsigned,
  });
  const zipPath = path.join(distDir, `${productName}-3.17.1-mac-arm64${artifactSuffix}.zip`);
  const dmgPath = path.join(distDir, `${productName}-3.17.1-mac-arm64${artifactSuffix}.dmg`);
  await writeFile(zipPath, "fake zip bytes");
  await writeFile(dmgPath, "fake dmg bytes");
  const commands = [];
  const doctorCalls = [];
  const entries = zipEntries ?? [
    `${appName}/`,
    `${appName}/Contents/`,
    `${appName}/Contents/Info.plist`,
    `${appName}/Contents/MacOS/`,
    `${appName}/Contents/MacOS/ZCode`,
    ...(unsigned
      ? []
      : [`${appName}/Contents/_CodeSignature/CodeResources`, `${appName}/Contents/ticket`]),
  ];
  const captureCommand = async (command) => {
    commands.push(command);
    if (command[0] === "unzip" && command[1] === "-Z1") return entries.join("\n");
    if (command[0] === "/usr/libexec/PlistBuddy") {
      const plist = await readFile(command[3], "utf8");
      const field = command[2].replace("Print :", "");
      const match = new RegExp(`^${field}=(.*)$`, "mu").exec(plist);
      if (!match) throw new Error(`missing fixture plist field ${field}`);
      return match[1];
    }
    if (command[0] === "lipo" && command[1] === "-archs") {
      return readFile(command[2], "utf8");
    }
    throw new Error(`unexpected fake capture command: ${command[0]}`);
  };
  const runCommand = async (command, options) => {
    commands.push(command);
    if (command[0] === "bash") {
      doctorCalls.push({ appPath: command[2], options });
      if (doctorCalls.length === doctorRejectAt) {
        throw new Error("fake signature/Gatekeeper/staple rejection");
      }
      return;
    }
    if (command[0] === "ditto") {
      await cp(zipAppPath, path.join(command[4], appName), { recursive: true });
      return;
    }
    if (command[0] === "hdiutil" && command[1] === "attach") {
      const mountPoint = command[6];
      await cp(dmgAppPath, path.join(mountPoint, appName), { recursive: true });
      return;
    }
    if (command[0] === "hdiutil" && command[1] === "detach") return;
    throw new Error(`unexpected fake command: ${command[0]}`);
  };
  return {
    distDir,
    sourceAppPath,
    zipPath,
    dmgPath,
    commands,
    doctorCalls,
    captureCommand,
    runCommand,
  };
}
