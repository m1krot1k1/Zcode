import type { ReadFileStateMap } from "../../tool/types.js";

function normalizeWorkspaceDirectory(value: string | undefined): string {
  const trimmed = (value ?? ".").replace(/[\\/]+$/u, "");
  return trimmed.length === 0 ? "." : trimmed;
}

export function sameWorkspaceDirectory(
  left: string | undefined,
  right: string | undefined,
): boolean {
  return normalizeWorkspaceDirectory(left) === normalizeWorkspaceDirectory(right);
}

/** Child runtimes in the same workspace reuse the parent's Read range cache. */
export function sharedReadFileStateForChild(
  parentDirectory: string | undefined,
  childDirectory: string | undefined,
  readFileState: ReadFileStateMap,
): { sharedReadFileState: ReadFileStateMap } | Record<string, never> {
  if (!sameWorkspaceDirectory(parentDirectory, childDirectory)) return {};
  return { sharedReadFileState: readFileState };
}
