import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { formatErrorMessage, isErrnoException, isRecord } from "./utils.js";

const SECRET_CONFIG_FILE_MODE = 0o600;

export async function readJsonObject(filePath: string): Promise<Record<string, unknown> | null> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") {
      return null;
    }
    throw new Error(`无法读取 MCP 配置文件 ${filePath}: ${formatErrorMessage(error)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    // 远端 MCP 导入必须先确认现有 config.json 可读可合并；
    // JSON 损坏时如果当作空对象继续写，会静默覆盖 provider、MCP 和 secret 配置。
    throw new Error(`无法解析 MCP 配置文件 ${filePath}: ${formatErrorMessage(error)}`);
  }
  if (!isRecord(parsed)) {
    throw new Error(`MCP 配置文件 ${filePath} 必须是 JSON 对象`);
  }
  return parsed;
}

export async function writeTextAtomic(filePath: string, content: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tempPath = join(
    dirname(filePath),
    `${basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  try {
    // 远端 MCP 配置会持久化 env/header/token 等 secret；
    // 临时文件权限不能依赖远端 umask，否则 rename 后 config.json 可能被同组或其他用户读取。
    await writeFile(tempPath, content, {
      encoding: "utf-8",
      mode: SECRET_CONFIG_FILE_MODE,
    });
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}
