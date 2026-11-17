import { spawn, type ChildProcess, type StdioOptions } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { applyBashSourcesToExecutionRequest } from "./bash-startup-script.js";
import { createBashResourceTelemetry } from "./bash-resource-telemetry.js";
import { createCwdCapturePlan } from "./cwd-capture.js";
import {
  applyResolvedShellCommand,
  buildExecutionEnv,
  resolveExecutionCommand,
  setResolvedShellLoginMode,
} from "./execution-command.js";
import { NodeExecutionAdapterResults } from "./node-execution-adapter-results.js";
import { createExecutionOutputStreamDecoder } from "./outputEncoding.js";
import type { OutputCollector } from "./output-collector.js";
import {
  BASH_SIGTERM_TO_SIGKILL_MS,
  signalPosixProcessTree,
  terminateGenericPosixProcessGroup,
} from "./process-tree.js";
import { createExecutionSandbox } from "./sandbox/execution-sandbox.js";
import type { SandboxedCommand } from "./sandbox/contract.js";
import {
  revalidateShellInitSnapshotForExecution,
  supportsShellInitSnapshot,
} from "./shell-init-snapshot.js";
import {
  IO_DRAIN_TIMEOUT_MS,
  resolveDefaultOutputRootDir,
  sanitizePathSegment,
  waitForPromise,
} from "./execution-utils.js";
import type {
  ExitState,
  InternalExecutionRunOptions,
  PreparedChildSpawn,
} from "./execution-adapter-types.js";
import type {
  ExecutionRequest,
  ExecutionRunOptions,
  ExecutionSandboxReport,
} from "@zcode/contracts";

export class NodeExecutionAdapterProcess extends NodeExecutionAdapterResults {
  protected trackBashResources(
    child: ChildProcess,
    isBash: boolean,
    stopState: () => { timedOut: boolean; killed: boolean },
  ): (state: ExitState) => void {
    if (!isBash || !this.options.onToolExecResource) return () => {};
    const telemetry = createBashResourceTelemetry({
      platform: this.platform,
      processGroupId: child.pid,
      onComplete: this.options.onToolExecResource,
    });
    return (state) => {
      const stop = stopState();
      telemetry.finish(
        stop.timedOut
          ? "timeout"
          : stop.killed || state.signal
            ? "killed"
            : state.error
              ? "error"
              : "completed",
      );
    };
  }

  protected async prepareChildSpawn(request: ExecutionRequest): Promise<PreparedChildSpawn> {
    const env = buildExecutionEnv(request.env, {
      network: this.options.network,
      platform: this.platform,
      processEnv: this.processEnv,
    });
    const resolvedCommand = resolveExecutionCommand(request.command, {
      cwd: request.cwd,
      env,
      platform: this.platform,
    });
    const rootDir =
      this.options.outputRootDir ?? resolveDefaultOutputRootDir(this.options.processEnv);
    const sessionId = sanitizePathSegment(String(request.trace?.sessionId ?? "unknown-session"));
    const snapshotEnv = resolvedCommand.envOverlay
      ? { ...env, ...resolvedCommand.envOverlay }
      : env;
    const shellInitSnapshot =
      request.command.mode === "shell" &&
      request.command.shellProfile === "posix-bash" &&
      resolvedCommand.shell === false &&
      supportsShellInitSnapshot(resolvedCommand.cwdDialect)
        ? await revalidateShellInitSnapshotForExecution(
            await this.shellInitSnapshots.getOrCreate({
              env: snapshotEnv,
              rootDir,
              shellDialect: resolvedCommand.cwdDialect,
              shellPath: resolvedCommand.file,
            }),
          )
        : undefined;
    const useLoginShell = shellInitSnapshot ? false : true;
    const resolvedShell = setResolvedShellLoginMode(resolvedCommand, useLoginShell);
    const requestWithSources = applyBashSourcesToExecutionRequest(request, {
      leadingSources: shellInitSnapshot
        ? [
            {
              optional: true,
              path: shellInitSnapshot.path,
              shellPath: shellInitSnapshot.shellPath,
            },
          ]
        : [],
      rootDir,
      sessionId,
      shellDialect: resolvedCommand.cwdDialect,
    });
    const capturePlan = createCwdCapturePlan(requestWithSources, {
      dialect: resolvedCommand.cwdDialect,
      platform: this.platform,
    });
    const command =
      capturePlan.command === requestWithSources.command
        ? requestWithSources.command.mode === "shell"
          ? applyResolvedShellCommand(resolvedShell, requestWithSources.command.command)
          : resolvedShell
        : resolveExecutionCommand(capturePlan.command, {
            cwd: request.cwd,
            env,
            platform: this.platform,
            resolvedShell,
          });
    const spawnEnv = command.envOverlay ? { ...env, ...command.envOverlay } : env;

    // 沙箱: реальная обёртка bwrap/seatbelt либо честный degraded-fallback.
    // Применяется только когда Bash-политика попросила изоляцию.
    const sandboxed = await this.applySandboxWrap(request, command, spawnEnv, capturePlan);

    const baseOptions = {
      cwd: sandboxed?.cwd ?? request.cwd,
      detached: this.platform !== "win32",
      env: sandboxed?.env ?? spawnEnv,
      shell: sandboxed ? false : command.shell,
      stdio: [
        request.stdin === undefined ? "ignore" : "pipe",
        "pipe",
        "pipe",
      ] satisfies StdioOptions,
      windowsHide: true,
    };

    return {
      command: sandboxed
        ? { ...command, file: sandboxed.file, args: sandboxed.args, shell: false }
        : command,
      cwdDialect: command.cwdDialect,
      cwdFilePath: capturePlan.cwdFilePath,
      spawnOptions: baseOptions,
      ...(sandboxed?.report ? { sandboxReport: sandboxed.report } : {}),
    };
  }

  /**
   * Применяет политику песочницы из `request.sandbox.wrap`.
   *
   * Возвращает `undefined`, когда изоляция не запрошена: тогда spawn идёт
   * существующим путём без изменения argv и окружения.
   */
  private async applySandboxWrap(
    request: ExecutionRequest,
    command: PreparedChildSpawn["command"],
    env: NodeJS.ProcessEnv,
    capturePlan: { cwdFilePath?: string },
  ): Promise<
    | {
        file: string;
        args: string[];
        env: Record<string, string>;
        cwd: string;
        report: ExecutionSandboxReport;
      }
    | undefined
  > {
    const wrap = request.sandbox?.wrap;
    if (!wrap || this.platform === "win32") return undefined;

    const captureDir = capturePlan.cwdFilePath
      ? dirname(capturePlan.cwdFilePath)
      : wrap.cwdCaptureDir;
    try {
      if (captureDir) mkdirSync(captureDir, { recursive: true });
    } catch {
      // Каталог захвата cwd уже создан createCwdCapturePlan либо недоступен;
      // недоступность не должна блокировать запуск — она лишь убирает bind.
    }

    const sandbox = createExecutionSandbox({
      platform: this.platform,
      processEnv: env as NodeJS.ProcessEnv,
    });
    const wrapped: SandboxedCommand = await sandbox.wrap(
      { file: command.file, args: command.args },
      {
        profile: wrap.profile ?? "workspace-write",
        cwd: request.cwd ?? wrap.workspacePath,
        workspacePath: wrap.workspacePath,
        ...(wrap.writableRoots ? { writableRoots: wrap.writableRoots } : {}),
        ...(wrap.readOnlyRoots ? { readOnlyRoots: wrap.readOnlyRoots } : {}),
        networkAccess: wrap.networkAccess ?? "allow",
        ...(wrap.env ? { env: wrap.env } : {}),
        ...(captureDir ? { cwdCaptureDir: captureDir } : {}),
        ...(wrap.limits ? { limits: wrap.limits } : {}),
      },
    );

    return {
      file: wrapped.file,
      args: wrapped.args,
      env: wrapped.env,
      cwd: wrapped.cwd,
      report: {
        mode: wrapped.sandboxMode,
        ...(wrapped.sandboxReason ? { reason: wrapped.sandboxReason } : {}),
        filesystemIsolated: wrapped.filesystemIsolated,
        networkIsolated: wrapped.networkIsolated,
        ...(Object.keys(wrapped.limits).length > 0 ? { limits: wrapped.limits } : {}),
      },
    };
  }

  protected terminateProcessTree(child: ChildProcess, useBashProcessTreeStop: boolean): void {
    if (!child.pid) {
      child.kill("SIGTERM");
      return;
    }

    if (this.platform === "win32") {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      const completion = new Promise<void>((resolve) => {
        killer.once("error", () => {
          child.kill("SIGKILL");
          resolve();
        });
        killer.once("close", () => resolve());
      });
      if (useBashProcessTreeStop) {
        // 直写后不再等待 pipe EOF，shutdown 必须显式等待 taskkill 收尾，避免提前释放资源。
        this.pendingBashProcessTreeKills.set(completion, killer);
        void completion.finally(() => this.pendingBashProcessTreeKills.delete(completion));
      }
      return;
    }

    if (!useBashProcessTreeStop) {
      // PPID 后代枚举只修复 Bash job-control 的跨 PGID 清理；通用 hook、
      // shell 和 argv execution 必须保留既有进程组边界，避免修复能力扩散到其它调用方。
      terminateGenericPosixProcessGroup(child);
      return;
    }

    const rootPid = child.pid;
    // Bash job control、pipeline、xargs 和 PTY 可以把 worker 放入不同 PGID。
    // 两阶段清理各自快照当时的 PPID 后代，不跨阶段记忆进程身份。
    void signalPosixProcessTree(rootPid, "SIGTERM");
    let timer!: NodeJS.Timeout;
    const escalation = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        try {
          process.kill(-rootPid, "SIGKILL");
        } catch {
          // 直接的 force group kill 只做 best effort，随后仍会执行完整杀树。
        }
        // shutdown 等待实际查表与信号发送，不能在异步杀树刚启动时就释放清理所有权。
        void signalPosixProcessTree(rootPid, "SIGKILL").then(resolve);
      }, BASH_SIGTERM_TO_SIGKILL_MS);
      timer.unref?.();
    });
    this.pendingBashProcessTreeKills.set(escalation, timer);
    void escalation.finally(() => {
      this.pendingBashProcessTreeKills.delete(escalation);
    });
  }

  protected destroyChildOutputStreams(child: ChildProcess): void {
    child.stdout?.destroy();
    child.stderr?.destroy();
  }

  protected attachPipedOutput(
    child: ChildProcess,
    stdout: OutputCollector,
    stderr: OutputCollector,
    encoding: string | null,
    options: ExecutionRunOptions,
  ): void {
    for (const [name, collector] of [
      ["stdout", stdout],
      ["stderr", stderr],
    ] as const) {
      const stream = child[name];
      const decoder = createExecutionOutputStreamDecoder(encoding);
      stream?.on("data", (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        collector.append(buffer, stream);
        this.emit(options, {
          type: name,
          chunk: buffer,
          text: decoder.write(buffer),
          timestamp: new Date(),
        });
      });
    }
  }

  protected writeChildInput(
    child: ChildProcess,
    input: ExecutionRequest["stdin"],
  ): () => Error | undefined {
    let failure: Error | undefined;
    if (input !== undefined && child.stdin) {
      const capture = (error: Error) => {
        failure ??= error;
      };
      // Hook 可以提前关闭 stdin，异步 EPIPE 必须有监听，不能让 Agent 崩溃。
      child.stdin.on("error", capture);
      try {
        child.stdin.end(input);
      } catch (error) {
        capture(error instanceof Error ? error : new Error(String(error)));
      }
    }
    return () => failure;
  }

  protected async drainChildOutput(
    child: ChildProcess,
    closed: Promise<void>,
    options: InternalExecutionRunOptions,
    terminationRequested: boolean,
  ): Promise<void> {
    if (await waitForPromise(closed, IO_DRAIN_TIMEOUT_MS)) return;
    // 通用 argv/Hook 保留 pipe EOF 所有权；Bash 直写文件不会进入此路径。
    if (options.shouldRetainExecutionAfterRootExit?.() === true) {
      await closed;
      return;
    }
    if (!terminationRequested) this.terminateProcessTree(child, false);
    if (!(await waitForPromise(closed, IO_DRAIN_TIMEOUT_MS))) this.destroyChildOutputStreams(child);
  }
}
