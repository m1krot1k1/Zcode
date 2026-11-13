import { mkdir, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getWorkspaceHash } from "#src/paths.js";
import { pathExists } from "./fileSystem.js";
import {
  SourceServerWorkspaceConfigConflictError,
  type SessionConfigEntries,
  type SourceServerWorkspaceAliasContext,
} from "./types.js";

export function getSessionConfigDirectory(
  ctx: SourceServerWorkspaceAliasContext,
  workspacePath: string,
  workspaceKey: string,
): string {
  return join(dirname(ctx.taskDbPath), "sessions", getWorkspaceHash(workspacePath, workspaceKey));
}

export async function assertSessionConfigDirectoriesMergeable(
  ctx: SourceServerWorkspaceAliasContext,
  workspacePath: string,
  canonicalKey: string,
  mergedKeys: string[],
): Promise<void> {
  const seen = new Map<
    string,
    ({ kind: "directory" } | { kind: "file"; content: Buffer }) & { workspaceKey: string }
  >();
  for (const workspaceKey of [canonicalKey, ...mergedKeys]) {
    const entries = await readSessionConfigEntries(
      getSessionConfigDirectory(ctx, workspacePath, workspaceKey),
    );
    for (const [relativePath, entry] of entries) {
      const existing = seen.get(relativePath);
      if (!existing) {
        seen.set(relativePath, { ...entry, workspaceKey });
        continue;
      }
      const matches =
        existing.kind === entry.kind &&
        (existing.kind === "directory" ||
          (entry.kind === "file" && existing.content.equals(entry.content)));
      if (!matches) {
        throw new SourceServerWorkspaceConfigConflictError(
          workspacePath,
          relativePath,
          workspaceKey,
        );
      }
    }
  }
}

export async function readSessionConfigEntries(
  root: string,
  relativeRoot = "",
): Promise<SessionConfigEntries> {
  const result: SessionConfigEntries = new Map();
  if (!(await pathExists(root))) return result;
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const relativePath = relativeRoot ? `${relativeRoot}/${entry.name}` : entry.name;
    const absolutePath = join(root, entry.name);
    if (entry.isDirectory()) {
      result.set(relativePath, { kind: "directory" });
      const nested = await readSessionConfigEntries(absolutePath, relativePath);
      for (const item of nested) result.set(...item);
      continue;
    }
    if (entry.isFile()) {
      result.set(relativePath, { kind: "file", content: await readFile(absolutePath) });
      continue;
    }
    throw new SourceServerWorkspaceConfigConflictError(root, relativePath, root);
  }
  return result;
}

export async function readVariantConfigSnapshots(
  ctx: SourceServerWorkspaceAliasContext,
  workspacePath: string,
  variants: string[],
): Promise<Map<string, SessionConfigEntries>> {
  return new Map(
    await Promise.all(
      variants.map(
        async (variant) =>
          [
            variant,
            await readSessionConfigEntries(getSessionConfigDirectory(ctx, workspacePath, variant)),
          ] as const,
      ),
    ),
  );
}

export async function mergeSessionConfigDirectories(
  ctx: SourceServerWorkspaceAliasContext,
  workspacePath: string,
  canonicalKey: string,
  mergedKeys: string[],
): Promise<void> {
  const canonicalDir = getSessionConfigDirectory(ctx, workspacePath, canonicalKey);
  for (const sourceKey of mergedKeys) {
    const sourceDir = getSessionConfigDirectory(ctx, workspacePath, sourceKey);
    if (sourceDir === canonicalDir || !(await pathExists(sourceDir))) continue;
    if (!(await pathExists(canonicalDir))) {
      await mkdir(dirname(canonicalDir), { recursive: true });
      await rename(sourceDir, canonicalDir);
      continue;
    }
    await mergeSessionConfigDirectoryContents({
      sourceDir,
      canonicalDir,
      workspacePath,
      sourceKey,
    });
    await rm(sourceDir, { recursive: true, force: true });
  }
}

async function mergeSessionConfigDirectoryContents(input: {
  sourceDir: string;
  canonicalDir: string;
  workspacePath: string;
  sourceKey: string;
  relativeRoot?: string;
}): Promise<void> {
  const { sourceDir, canonicalDir, workspacePath, sourceKey, relativeRoot = "" } = input;
  await mkdir(canonicalDir, { recursive: true });
  const entries = await readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = join(sourceDir, entry.name);
    const canonicalPath = join(canonicalDir, entry.name);
    const relativePath = relativeRoot ? `${relativeRoot}/${entry.name}` : entry.name;
    const canonicalStat = await stat(canonicalPath).catch(() => null);
    if (!canonicalStat) {
      await rename(sourcePath, canonicalPath);
      continue;
    }
    if (entry.isDirectory() && canonicalStat.isDirectory()) {
      await mergeSessionConfigDirectoryContents({
        sourceDir: sourcePath,
        canonicalDir: canonicalPath,
        workspacePath,
        sourceKey,
        relativeRoot: relativePath,
      });
      await rm(sourcePath, { recursive: true, force: true });
      continue;
    }
    if (entry.isFile() && canonicalStat.isFile()) {
      const [sourceContent, canonicalContent] = await Promise.all([
        readFile(sourcePath),
        readFile(canonicalPath),
      ]);
      if (!sourceContent.equals(canonicalContent)) {
        throw new SourceServerWorkspaceConfigConflictError(workspacePath, relativePath, sourceKey);
      }
      await rm(sourcePath, { force: true });
      continue;
    }
    throw new SourceServerWorkspaceConfigConflictError(workspacePath, relativePath, sourceKey);
  }
}
