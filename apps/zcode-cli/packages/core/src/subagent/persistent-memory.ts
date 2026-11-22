import { join, resolve } from "node:path";

import {
  SessionEventType,
  type FileSystemPort,
  type Logger,
  type SessionEvent,
  type TraceContext,
} from "@zcode/contracts";

import { ensureMemoryDirectoryExists } from "../memory/directory.js";
import type { MemoryRuntimeConfig } from "../runtime/types.js";
import type { AgentDefinitionsSnapshot } from "./definitions.js";
import type { AgentProfile, AgentMemoryScope } from "./profile.js";
import { buildPersistentAgentMemoryPrompt } from "./persistent-memory-prompt.js";

const PERSISTENT_MEMORY_TOOLS = ["Write", "Edit"] as const;

export function sanitizePersistentAgentMemoryKey(agentName: string): string {
  const key = agentName.replace(/[^a-zA-Z0-9_-]/g, "-");
  return key === "" ? "unknown" : key;
}

export function resolvePersistentAgentMemoryRoot(input: {
  agentName: string;
  scope: AgentMemoryScope;
  storageRoot: string;
  workspaceRoot: string;
}): string {
  const agentKey = sanitizePersistentAgentMemoryKey(input.agentName);
  if (input.scope === "user") {
    return join(input.storageRoot, "agent-memory", agentKey);
  }
  const workspace = resolve(input.workspaceRoot);
  return input.scope === "project"
    ? join(workspace, ".zcode", "agent-memory", agentKey)
    : join(workspace, ".zcode", "agent-memory-local", agentKey);
}

function isPersistentAgentMemoryEnabled(
  memory: MemoryRuntimeConfig | undefined,
): memory is MemoryRuntimeConfig & { storageRoot: string } {
  return memory?.enabled === true && memory.use !== false && Boolean(memory.storageRoot);
}

function withPersistentAgentMemoryTools(profile: AgentProfile): AgentProfile {
  if (!profile.memory || profile.tools === undefined) return profile;

  const tools = [...profile.tools];
  for (const tool of PERSISTENT_MEMORY_TOOLS) {
    if (!tools.includes(tool)) tools.push(tool);
  }
  return tools.length === profile.tools.length ? profile : { ...profile, tools };
}

export function projectPersistentAgentMemoryTools(
  definitions: AgentDefinitionsSnapshot,
  memory: MemoryRuntimeConfig | undefined,
): AgentDefinitionsSnapshot {
  if (!isPersistentAgentMemoryEnabled(memory)) return definitions;
  const profiles = definitions.activeAgents;

  const projected = profiles.map(withPersistentAgentMemoryTools);
  if (projected.every((profile, index) => profile === profiles[index])) return definitions;
  return {
    ...definitions,
    activeAgents: projected,
  };
}

interface PersistentAgentMemory {
  rootDir: string;
  prompt: string;
}

export async function loadPersistentAgentMemory(input: {
  fileSystemPort: FileSystemPort | undefined;
  memory: MemoryRuntimeConfig | undefined;
  logger?: Logger;
  profile: AgentProfile;
  traceContext?: TraceContext;
  workspaceRoot: string;
}): Promise<PersistentAgentMemory | undefined> {
  if (!input.profile.memory || !input.fileSystemPort) return undefined;
  if (!isPersistentAgentMemoryEnabled(input.memory)) return undefined;

  const rootDir = resolvePersistentAgentMemoryRoot({
    agentName: input.profile.name,
    scope: input.profile.memory,
    storageRoot: input.memory.storageRoot,
    workspaceRoot: input.workspaceRoot,
  });
  await ensureMemoryDirectoryExists(
    input.fileSystemPort,
    rootDir,
    input.traceContext,
    input.logger,
  );

  let indexContent = "";
  try {
    indexContent = (await input.fileSystemPort.readTextFile({ path: join(rootDir, "MEMORY.md") }))
      .content;
  } catch {
    // 不存在或不可读的 MEMORY.md 都使用基线的 empty index 文案。
  }

  return {
    rootDir,
    prompt: buildPersistentAgentMemoryPrompt({
      indexContent,
      rootDir,
      scope: input.profile.memory,
    }),
  };
}

const LESSON_TOKEN = /^[A-Za-z][A-Za-z0-9_.:-]{0,80}$/;
const LESSON_CODE = /^[A-Za-z0-9_.:-]{1,40}$/;
const SECRET_TOKEN = /sk-|bearer|token|password|api[_-]?key/i;
const MAX_LESSON_INDEX_LINES = 200;

interface EvidenceGatedLesson {
  errorCode?: string;
  errorType: string;
  toolName: string;
}

/**
 * 原因：只承认同一回合里同一工具先失败、后一次调用成功。
 * 不复制错误正文和工具输出，避免把密钥或猜测写进记忆。
 */
function selectEvidenceGatedLesson(
  events: readonly SessionEvent[],
): EvidenceGatedLesson | undefined {
  const toolNames = new Map<string, string>();
  const failures = new Map<string, EvidenceGatedLesson & { toolCallId: string }>();
  for (const event of events) {
    if (
      event.type === SessionEventType.ToolCallScheduled ||
      event.type === SessionEventType.ToolCallStarted
    ) {
      const payload = event.payload as { toolCallId?: string; toolName?: string };
      if (
        typeof payload?.toolCallId === "string" &&
        typeof payload.toolName === "string" &&
        LESSON_TOKEN.test(payload.toolName)
      ) {
        toolNames.set(payload.toolCallId, payload.toolName);
      }
      continue;
    }
    if (event.type === SessionEventType.ToolCallError) {
      const payload = event.payload as {
        error?: { code?: string; type?: string };
        toolCallId?: string;
      };
      const toolCallId = payload?.toolCallId;
      const toolName = toolCallId ? toolNames.get(toolCallId) : undefined;
      const errorType = payload?.error?.type;
      if (
        !toolCallId ||
        !toolName ||
        !errorType ||
        !LESSON_CODE.test(errorType) ||
        SECRET_TOKEN.test(errorType)
      ) {
        continue;
      }
      if (failures.has(toolName)) continue;
      const errorCode =
        payload.error?.code &&
        LESSON_CODE.test(payload.error.code) &&
        !SECRET_TOKEN.test(payload.error.code)
          ? payload.error.code
          : undefined;
      failures.set(toolName, { errorCode, errorType, toolCallId, toolName });
      continue;
    }
    if (event.type !== SessionEventType.ToolCallResult) continue;
    const payload = event.payload as { toolCallId?: string };
    const toolCallId = payload?.toolCallId;
    const toolName = toolCallId ? toolNames.get(toolCallId) : undefined;
    if (!toolName || !toolCallId) continue;
    const failure = failures.get(toolName);
    if (failure && failure.toolCallId !== toolCallId) {
      return { errorCode: failure.errorCode, errorType: failure.errorType, toolName };
    }
  }
  return undefined;
}

function lessonFileName(lesson: EvidenceGatedLesson): string {
  return `${[lesson.toolName, lesson.errorType, lesson.errorCode ?? "none"].join("-").replace(/:/g, "_")}.md`;
}

function evidenceId(value: string): string {
  const trimmed = value.trim().slice(0, 80);
  return LESSON_CODE.test(trimmed) ? trimmed : "redacted";
}

export async function captureEvidenceGatedLesson(input: {
  events: readonly SessionEvent[];
  fileSystemPort: FileSystemPort | undefined;
  memory: MemoryRuntimeConfig | undefined;
  remoteWorkspace: boolean;
  sessionId: string;
  turnId: string;
  workspaceRoot: string;
}): Promise<{ written: boolean }> {
  const memory = input.memory;
  if (input.remoteWorkspace || !input.fileSystemPort || !isPersistentAgentMemoryEnabled(memory)) {
    return { written: false };
  }
  const lesson = selectEvidenceGatedLesson(input.events);
  if (!lesson) return { written: false };

  const rootDir = resolvePersistentAgentMemoryRoot({
    agentName: "knowledge-curator",
    scope: "project",
    storageRoot: memory.storageRoot,
    workspaceRoot: input.workspaceRoot,
  });
  const fileName = lessonFileName(lesson);
  const marker = `(lessons/${fileName})`;
  const indexPath = join(rootDir, "MEMORY.md");
  const lessonPath = join(rootDir, "lessons", fileName);
  try {
    await ensureMemoryDirectoryExists(input.fileSystemPort, join(rootDir, "lessons"));
    let index = "";
    try {
      index = (await input.fileSystemPort.readTextFile({ path: indexPath })).content;
    } catch {
      index = "";
    }
    if (index.includes(marker)) return { written: false };
    const occupied = index.split("\n").filter((line) => line.trim().length > 0).length;
    if (occupied >= MAX_LESSON_INDEX_LINES) return { written: false };

    const hook = lesson.errorCode ? `${lesson.errorType}/${lesson.errorCode}` : lesson.errorType;
    const body = [
      `# ${lesson.toolName} recovered after ${lesson.errorType}`,
      "",
      `Evidence: session ${evidenceId(input.sessionId)} turn ${evidenceId(input.turnId)}`,
      "The same tool failed and a later call in that turn succeeded.",
      "Tool output and error messages are not stored.",
      "",
    ].join("\n");
    await input.fileSystemPort.writeTextFile({ content: body, path: lessonPath });
    let line = `- [${lesson.toolName} recovered](lessons/${fileName}) — ${hook}`;
    if (line.length > 150) line = `${line.slice(0, 147)}...`;
    const next =
      index.length === 0
        ? `${line}\n`
        : index.endsWith("\n")
          ? `${index}${line}\n`
          : `${index}\n${line}\n`;
    await input.fileSystemPort.writeTextFile({ content: next, path: indexPath });
    return { written: true };
  } catch {
    return { written: false };
  }
}
