import { posix } from "node:path";

/** 当前各包都是直接 oxlint；未知脚本必须显式接入，不能被枚举器悄悄漏过。 */
export function parseLintCommand(command) {
  if (!/^oxlint(?: [\w./*-]+)*$/u.test(command) || /(?:--format| -f)(?: |$)/u.test(command))
    throw new Error(`不支持的 CLI lint 命令：${command}`);
  return command.split(" ").slice(1);
}

/**
 * oxlint печатает человекочитаемый преамбул («No files found to lint…») перед
 * JSON-отчётом, когда путь не дал совпадений. JSON.parse на всём stdout падал,
 * хотя отчёт валиден и diagnostics пуст. Выделяем объект отчёта и проверяем форму.
 */
export function parseOxlintReport(stdout, packageName = "package") {
  const start = stdout.indexOf("{");
  if (start < 0)
    throw new Error(`${packageName}: oxlint не вернул JSON-отчёт`);
  let report;
  try {
    report = JSON.parse(stdout.slice(start));
  } catch {
    throw new Error(`${packageName}: 无法解析 oxlint 结果`);
  }
  if (!Array.isArray(report.diagnostics))
    throw new Error(`${packageName}: 无法解析 oxlint 结果`);
  return report;
}

export function classifyLintDiagnostics(diagnostics, { relativeDirectory, pristine }) {
  const accepted = [],
    errors = [],
    warnings = [];
  for (const diagnostic of diagnostics) {
    const path = posix.normalize(
      posix.join(relativeDirectory, diagnostic.filename.replaceAll("\\", "/")),
    );
    if (diagnostic.severity !== "error") warnings.push(diagnostic);
    else if (diagnostic.code === "eslint(max-lines)" && pristine.has(path))
      accepted.push(diagnostic);
    else errors.push(diagnostic);
  }
  return { accepted, errors, warnings };
}
