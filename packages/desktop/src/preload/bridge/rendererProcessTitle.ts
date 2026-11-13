import { formatZCodeRendererProcessName } from "@zcode/shared";

function updateRendererProcessTitle(): void {
  process.title = formatZCodeRendererProcessName(document.title);
}

export function installRendererProcessTitle(): void {
  // 进程检索体验优化：renderer 在系统里通常只会显示成通用 helper 名称，
  // 这里在 preload 阶段补上 zcode-* title，便于按窗口角色筛选。
  updateRendererProcessTitle();
  window.addEventListener("DOMContentLoaded", updateRendererProcessTitle, {
    once: true,
  });
}
