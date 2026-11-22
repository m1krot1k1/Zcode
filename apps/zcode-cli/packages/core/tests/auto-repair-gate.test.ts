import { describe, expect, it } from "vitest";
import {
  AUTO_REPAIR_GATE_MAX_RUNS,
  collectAgentAutoRepairSignals,
  parseLintOutput,
  parseTypecheckOutput,
  runAgentAutoRepairGate,
  type AgentAutoRepairGateOptions,
} from "../src/runtime/auto-repair-loop/index.js";

function makeGateOptions(options: {
  enabled?: boolean;
  maxIterations?: number;
  results?: Record<string, { status?: string; stdout?: string; stderr?: string }>;
}): { gateOptions: AgentAutoRepairGateOptions; calls: Array<{ file: string; args: string[] }> } {
  const calls: Array<{ file: string; args: string[] }> = [];
  const gateOptions = {
    enabled: options.enabled ?? true,
    workingDirectory: "/workspace",
    ...(options.maxIterations === undefined ? {} : { maxIterations: options.maxIterations }),
    executionPort: {
      async run(request: { command: { file: string; args?: string[] } }) {
        calls.push({ file: request.command.file, args: request.command.args ?? [] });
        const preset = options.results?.[request.command.file];
        if (!preset) {
          return {
            status: "spawn_error",
            stdout: { text: "", bytes: 0, truncated: false },
            stderr: { text: "ENOENT", bytes: 0, truncated: false },
            durationMs: 0,
            timedOut: false,
            cancelled: false,
            startedAt: new Date(),
            completedAt: new Date(),
          };
        }
        return {
          status: preset.status ?? "completed",
          exitCode: 0,
          stdout: { text: preset.stdout ?? "", bytes: 0, truncated: false },
          stderr: { text: preset.stderr ?? "", bytes: 0, truncated: false },
          durationMs: 1,
          timedOut: false,
          cancelled: false,
          startedAt: new Date(),
          completedAt: new Date(),
        };
      },
    },
  } as unknown as AgentAutoRepairGateOptions;
  return { gateOptions, calls };
}

describe("parseTypecheckOutput", () => {
  it("извлекает ошибки tsc с файлом, строкой и кодом", () => {
    const signals = parseTypecheckOutput(
      "src/a.ts(12,34): error TS2345: Argument of type 'string' is not assignable.\nsrc/b.ts(1,2): warning TS6133: unused.",
    );
    expect(signals).toHaveLength(2);
    expect(signals[0]).toMatchObject({
      source: "typecheck",
      severity: "blocking",
      file: "src/a.ts",
      line: 12,
      column: 34,
      code: "TS2345",
    });
    expect(signals[1]?.severity).toBe("warning");
  });

  it("не выдумывает дефекты из посторонних строк", () => {
    expect(parseTypecheckOutput("Build succeeded\n42 files checked")).toEqual([]);
  });
});

describe("parseLintOutput", () => {
  it("извлекает замечания линтера с правилом", () => {
    const signals = parseLintOutput("src/a.ts:3:5: Unexpected var  no-var");
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ source: "lint", file: "src/a.ts", line: 3, code: "no-var" });
  });

  it("игнорирует служебные строки линтера", () => {
    expect(parseLintOutput("Found 0 warnings and 0 errors.\nFinished in 12ms")).toEqual([]);
  });
});

describe("collectAgentAutoRepairSignals", () => {
  it("отсутствие исполнителя превращается в предупреждение, а не в «всё чисто»", async () => {
    const { gateOptions } = makeGateOptions({ results: {} });
    const signals = await collectAgentAutoRepairSignals(gateOptions);
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ source: "tool-call", severity: "warning" });
    expect(signals[0]?.message).toContain("Не считайте это отсутствием ошибок");
  });

  it("реальный вывод tsc даёт блокирующие сигналы", async () => {
    const { gateOptions } = makeGateOptions({
      results: {
        "node_modules/.bin/tsc": { stdout: "src/x.ts(1,1): error TS1005: ';' expected." },
        "node_modules/.bin/oxlint": { stdout: "" },
      },
    });
    const signals = await collectAgentAutoRepairSignals(gateOptions);
    expect(signals.some((signal) => signal.severity === "blocking")).toBe(true);
  });
});

describe("runAgentAutoRepairGate", () => {
  it("при выключенном флаге не запускает ни одной команды", async () => {
    const { gateOptions, calls } = makeGateOptions({ enabled: false });
    const outcome = await runAgentAutoRepairGate({ ...gateOptions, runsSoFar: 0 });
    expect(outcome.kind).toBe("skipped");
    expect(calls).toEqual([]);
  });

  it("при включённом флаге запускает реальные проверки", async () => {
    const { gateOptions, calls } = makeGateOptions({
      results: {
        "node_modules/.bin/tsc": { stdout: "" },
        "node_modules/.bin/oxlint": { stdout: "" },
      },
    });
    const outcome = await runAgentAutoRepairGate({ ...gateOptions, runsSoFar: 0 });
    expect(calls.map((call) => call.file)).toEqual([
      "node_modules/.bin/tsc",
      "node_modules/.bin/oxlint",
    ]);
    expect(outcome.kind).toBe("clean");
    expect(outcome.runsUsed).toBe(1);
  });

  it("блокирующий дефект возвращает диагноз и уважает лимит запусков", async () => {
    const { gateOptions, calls } = makeGateOptions({
      maxIterations: 1,
      results: {
        "node_modules/.bin/tsc": { stdout: "src/x.ts(1,1): error TS1005: ';' expected." },
        "node_modules/.bin/oxlint": { stdout: "" },
      },
    });
    const first = await runAgentAutoRepairGate({ ...gateOptions, runsSoFar: 0 });
    expect(first.kind).toBe("repair");
    expect(first.report).toContain("TS1005");
    const callsAfterFirst = calls.length;

    const second = await runAgentAutoRepairGate({ ...gateOptions, runsSoFar: first.runsUsed });
    expect(second.kind).toBe("skipped");
    expect(calls.length).toBe(callsAfterFirst);
  });

  it("по умолчанию допускает не больше AUTO_REPAIR_GATE_MAX_RUNS запусков", async () => {
    const { gateOptions } = makeGateOptions({
      results: {
        "node_modules/.bin/tsc": { stdout: "src/x.ts(1,1): error TS1005: ';' expected." },
        "node_modules/.bin/oxlint": { stdout: "" },
      },
    });
    let runs = 0;
    for (let index = 0; index < AUTO_REPAIR_GATE_MAX_RUNS; index += 1) {
      const outcome = await runAgentAutoRepairGate({ ...gateOptions, runsSoFar: runs });
      expect(outcome.kind).toBe("repair");
      runs = outcome.runsUsed;
    }
    expect((await runAgentAutoRepairGate({ ...gateOptions, runsSoFar: runs })).kind).toBe("skipped");
  });
});
