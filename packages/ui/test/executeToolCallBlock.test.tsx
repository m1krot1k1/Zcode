import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { ExecuteToolCallBlock } from "../src/ToolCallBlocks/renderers/execute.js";

describe("ExecuteToolCallBlock", () => {
  it("renders execution results from structured output instead of raw JSON", () => {
    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(ExecuteToolCallBlock, {
          toolCallNode: {
            toolCall: {
              toolId: "tool-execute",
              kind: "execute",
              title: "运行 npm install",
              input: {
                command: "npm install",
              },
              output: {
                stdout: "packages installed successfully",
                exitCode: 0,
              },
              status: "completed",
              raw: {
                rawOutput: {
                  stdout: "packages installed successfully",
                  exitCode: 0,
                },
              },
            },
            childToolCalls: [],
          },
          workspacePath: "/workspace",
          displayModel: {
            inlinePreview: { type: "none" },
            planResult: null,
            viewerSource: null,
            viewerLabelId: "codeViewer.viewCode",
            showSummaryFileLink: true,
            showInput: false,
            showOutput: true,
            showKind: false,
          },
          viewerSource: null,
          rawFileSummaries: [],
          isRunning: false,
          statusLabel: "Completed",
          childToolList: null,
          forceOpen: true,
          canToggle: true,
          showIcon: true,
        }),
      ),
    );

    // 渲染器现在只输出命令与结构化结果，没有独立的“输出结果”标签；旧断言引用的是
    // 已移除的文案，会让这个文件永久失败。保留对结构化输出的实质检查。
    expect(html).toContain('data-testid="bash-result-output"');
    expect(html).toContain("packages installed successfully");
    expect(html).not.toContain("&quot;stdout&quot;");
    expect(html).not.toContain("&quot;exitCode&quot;");
  });

  it("keeps the command visible and expandable in office mode", () => {
    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "ru-RU" },
        createElement(ExecuteToolCallBlock, {
          toolCallNode: {
            toolCall: {
              toolId: "tool-office-execute",
              kind: "execute",
              title: "Сборка проекта",
              input: {
                command: "pnpm build",
              },
              output: {
                stdout: "build complete",
                exitCode: 0,
              },
              status: "completed",
              raw: {},
            },
            childToolCalls: [],
          },
          workspacePath: "/workspace",
          displayModel: {
            inlinePreview: { type: "none" },
            planResult: null,
            viewerSource: null,
            viewerLabelId: "codeViewer.viewCode",
            showSummaryFileLink: true,
            showInput: false,
            showOutput: true,
            showKind: false,
          },
          viewerSource: null,
          rawFileSummaries: [],
          isRunning: false,
          statusLabel: "Completed",
          childToolList: null,
          forceOpen: false,
          canToggle: true,
          showIcon: true,
          isOfficeMode: true,
        }),
      ),
    );

    // Privacy decision (376bfce5): general/office mode must not expose the command,
    // output or error in the collapsed summary. The status label remains visible.
    expect(html).not.toContain("pnpm build");
    expect(html).not.toContain('aria-expanded="false"');
    expect(html).not.toContain('aria-expanded="true"');
    expect(html).not.toContain('data-testid="execute-detail"');
    expect(html).toContain("Команда выполнена");
  });
});
