import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, readlink } from "node:fs/promises";
import path from "node:path";

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export async function sha256File(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

export async function hashMacAppBundle(appPath) {
  const hash = createHash("sha256");
  const rootInfo = await lstat(appPath);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error(`Release app bundle должен быть обычной директорией: ${appPath}`);
  }

  async function visit(directoryPath, relativePath) {
    const entries = (await readdir(directoryPath)).sort((left, right) => left.localeCompare(right));
    for (const name of entries) {
      const entryPath = path.join(directoryPath, name);
      const entryRelativePath = relativePath ? `${relativePath}/${name}` : name;
      const info = await lstat(entryPath);
      const kind = info.isSymbolicLink()
        ? "symlink"
        : info.isDirectory()
          ? "directory"
          : info.isFile()
            ? "file"
            : "other";
      hash.update(`${entryRelativePath}\0${kind}\0${info.mode & 0o7777}\0`);
      if (kind === "symlink") {
        const target = await readlink(entryPath);
        hash.update(`${Buffer.byteLength(target)}\0${target}`);
      } else if (kind === "directory") {
        await visit(entryPath, entryRelativePath);
      } else if (kind === "file") {
        hash.update(`${info.size}\0`);
        for await (const chunk of createReadStream(entryPath)) hash.update(chunk);
      } else {
        throw new Error(`Неподдерживаемый тип файла в release app: ${entryRelativePath}`);
      }
    }
  }

  hash.update(`ZCode.app\0directory\0${rootInfo.mode & 0o7777}\0`);
  await visit(appPath, "");
  return hash.digest("hex");
}
