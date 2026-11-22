import { mkdir } from "node:fs/promises";
import { join } from "node:path";

export function requirePluginManualReview(): void {
  const runningPendingSpec = process.argv.some((arg) =>
    arg.replaceAll("\\", "/").includes("/plugins/manual-review/"),
  );
  if (runningPendingSpec && process.env.ZCODE_E2E_MANUAL_REVIEW !== "1") {
    throw new Error("Plugin lifecycle pending specs require ZCODE_E2E_MANUAL_REVIEW=1");
  }
}

export async function capturePluginManualReview(caseId: string, label: string): Promise<string> {
  const artifactDir = join(
    process.cwd(),
    ".e2e-artifacts",
    "plugin-management",
    caseId.toLowerCase(),
  );
  await mkdir(artifactDir, { recursive: true });
  const path = join(artifactDir, `${label.replaceAll(/[^a-z0-9-]/giu, "-")}.png`);
  // 人工评审截图要反映稳定态：等有限时长的过渡/动画（分段切换、面板展开）结束，
  // 否则会截到旧选中态与新内容并存的中间帧。无限循环的加载动画不参与判断。
  await browser
    .waitUntil(
      async () =>
        browser.execute(
          () =>
            document
              .getAnimations()
              .filter(
                (animation) =>
                  animation.playState === "running" &&
                  animation.effect?.getTiming().iterations !== Infinity,
              ).length === 0,
        ),
      { timeout: 3000, interval: 100 },
    )
    .catch(() => undefined);
  await browser.saveScreenshot(path);
  return path;
}
