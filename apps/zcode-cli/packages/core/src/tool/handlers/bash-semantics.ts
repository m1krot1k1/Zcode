import type { ExecutionResult } from "@zcode/contracts";
import { analyzeBashCommand, isBashCommandPermissionSafe } from "./bash-command-parser.js";
import {
  analysisContainsGitAndDirectoryChange,
  analysisContainsGitCommand,
  isGitRuntimeContextUnsafe,
  type BashReadonlyRuntimeContext,
} from "./bash-git-runtime-safety.js";
import {
  evaluateBashReadonlyPolicy,
  hasKnownBashWriteOption,
} from "./bash-readonly-policy.js";

export type BashPermissionMatcher = (pattern: string) => boolean;

const BASH_SEMANTIC_NEUTRAL_COMMANDS = new Set(["", ":", "echo", "false", "printf", "true"]);
const BASH_SILENT_COMMANDS = new Set([
  "cd",
  "chgrp",
  "chmod",
  "chown",
  "cp",
  "export",
  "ln",
  "mkdir",
  "mv",
  "rm",
  "rmdir",
  "touch",
  "unset",
  "wait",
]);
const SEMANTIC_NON_ERROR_MESSAGES = new Set([
  "Condition is false",
  "Files differ",
  "No matches found",
  "Some directories were inaccessible",
]);
const SEMANTIC_NO_MATCH_COMMANDS = new Set(["egrep", "fgrep", "grep", "rg"]);
const CLAUDE_CODE_HINT_LINE_RE = /^[ \t]*<claude-code-hint\s+([^>]*?)\s*\/>[ \t]*$/gm;

export function isRuntimeReadOnlyBashCommand(
  command: string,
  context?: BashReadonlyRuntimeContext,
): boolean {
  const analysis = analyzeBashCommand(command);
  if (!isBashCommandPermissionSafe(analysis)) return false;
  if (analysis.commands.length === 0) return false;
  if (analysisContainsGitAndDirectoryChange(analysis.commands)) return false;
  if (analysisContainsGitCommand(analysis.commands) && isGitRuntimeContextUnsafe(context))
    return false;

  let hasReadOnlyCommand = false;

  for (const commandPart of analysis.commands) {
    if (hasKnownBashWriteOption(commandPart)) return false;

    const policyResult = evaluateBashReadonlyPolicy(commandPart);
    if (policyResult === false) return false;
    if (policyResult === true) {
      hasReadOnlyCommand = true;
      continue;
    }

    return false;
  }

  return hasReadOnlyCommand;
}

export function prepareBashPermissionMatcherForCommand(
  command: string,
): BashPermissionMatcher | undefined {
  const trimmed = command.trim();
  if (trimmed.length === 0) return () => false;

  const analysis = analyzeBashCommand(command);
  if (!isBashCommandPermissionSafe(analysis) || analysis.commands.length !== 1) {
    return () => true;
  }

  const commandPart = analysis.commands[0]!;
  if (commandPart.hasAssignmentPrefix || commandPart.hasRedirects) return () => true;

  const normalizedCommand = commandPart.argv.join(" ");
  if (normalizedCommand.length === 0) return () => false;
  return (pattern) => matchesBashPermissionPattern(pattern, normalizedCommand);
}

function _hasBestEffortWritePattern(command: string): boolean {
  const analysis = analyzeBashCommand(command);
  if (analysis.hasParseErrors) return false;
  return analysis.commands.some(hasKnownBashWriteOption);
}

export function isSilentBashCommand(command: string): boolean {
  const analysis = analyzeBashCommand(command);
  if (analysis.hasParseErrors || analysis.hasUnsupportedSyntax || analysis.hasDynamicWords)
    return false;
  if (analysis.commands.length === 0) return false;

  let hasNonFallbackCommand = false;

  for (const commandPart of analysis.commands) {
    const commandName = commandPart.name;
    if (!commandName) continue;
    if (commandPart.operatorBefore === "||" && BASH_SEMANTIC_NEUTRAL_COMMANDS.has(commandName)) {
      continue;
    }

    hasNonFallbackCommand = true;
    if (!BASH_SILENT_COMMANDS.has(commandName)) return false;
  }

  return hasNonFallbackCommand;
}

function _extractBashSearchText(output: { stderr?: string; stdout?: string }): string {
  const stdout = output.stdout ?? "";
  const stderr = output.stderr ?? "";
  return stderr ? `${stdout}\n${stderr}` : stdout;
}

function _isBashResultTruncated(output: { stderr?: string; stdout?: string }): boolean {
  return lineCount(output.stdout ?? "") > 4 || lineCount(output.stderr ?? "") > 4;
}

export function stripClaudeCodeHintLines(stdout: string): string {
  if (!stdout.includes("<claude-code-hint")) return stdout;
  // 修复原因：成功路径上先剥离内部 claude-code-hint 行，再继续 image/persisted mapping；
  // 这些内部 hint 不应成为 provider-visible Bash stdout。
  return stdout.replace(CLAUDE_CODE_HINT_LINE_RE, "").replace(/\n{3,}/g, "\n\n");
}

export function interpretBashReturnCode(
  command: string,
  result: Pick<ExecutionResult, "error" | "exitCode" | "signal" | "status">,
): string | undefined {
  if (result.error?.type === "output_limit") {
    return "Command stopped because output exceeded the configured limit";
  }
  if (result.status === "timed_out") return "Command timed out";
  if (result.status === "cancelled") return "Command was cancelled";
  if (result.status === "spawn_error") return "Command failed to start";
  if (result.exitCode !== undefined && result.exitCode !== 0) {
    const semantic = semanticNonErrorExit(command, result.exitCode);
    return semantic ?? `Command exited with code ${result.exitCode}`;
  }
  if (result.signal) return `Command exited due to signal ${result.signal}`;
  return undefined;
}

function isSemanticNonErrorInterpretation(message: string | undefined): boolean {
  return message !== undefined && SEMANTIC_NON_ERROR_MESSAGES.has(message);
}

export function isBashProviderErrorStatus(output: {
  exitCode?: unknown;
  returnCodeInterpretation?: unknown;
  status?: unknown;
}): boolean {
  if (output.status !== "failed") return false;
  if (typeof output.exitCode !== "number" || output.exitCode === 0) return false;
  return !isSemanticNonErrorInterpretation(
    typeof output.returnCodeInterpretation === "string"
      ? output.returnCodeInterpretation
      : undefined,
  );
}

function semanticNonErrorExit(command: string, exitCode: number): string | undefined {
  if (exitCode !== 1) return undefined;
  const commandName = statusCommandNameForExitOne(command);
  return commandName === undefined ? undefined : semanticExitOneInterpretation(commandName);
}

function statusCommandNameForExitOne(command: string): string | undefined {
  const analysis = analyzeBashCommand(command);
  if (analysis.hasParseErrors || analysis.hasUnsupportedSyntax) return undefined;
  const statusCommand = analysis.commands.at(-1);
  if (statusCommand === undefined) return undefined;

  // 不能因为命令行前面出现过 rg/grep，就把后续 test/exit 的 1 误判成 No matches found。
  if (statusCommand.name === "git") {
    const gitSubcommand = gitSemanticSubcommandName(statusCommand.argv);
    if (gitSubcommand === "grep") return "grep";
    if (gitSubcommand === "diff") return "diff";
  }
  return statusCommand.name;
}

function semanticExitOneInterpretation(commandName: string): string | undefined {
  if (SEMANTIC_NO_MATCH_COMMANDS.has(commandName)) return "No matches found";
  if (commandName === "find") return "Some directories were inaccessible";
  if (commandName === "diff") return "Files differ";
  if (commandName === "test" || commandName === "[") return "Condition is false";
  return undefined;
}

function gitSemanticSubcommandName(argv: readonly string[]): string | undefined {
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;
    if (arg.startsWith("-")) {
      if (arg === "-C" || arg === "-c") index += 1;
      continue;
    }
    return arg;
  }
  return undefined;
}

function matchesBashPermissionPattern(pattern: string, command: string): boolean {
  const prefix = permissionPatternPrefix(pattern);
  if (prefix !== null) return command === prefix || command.startsWith(`${prefix} `);
  return wildcardToRegExp(pattern).test(command);
}

function permissionPatternPrefix(pattern: string): string | null {
  return pattern.endsWith(":*") ? pattern.slice(0, -2) : null;
}

function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

function lineCount(value: string): number {
  if (value.length === 0) return 0;
  return value.split("\n").length;
}
