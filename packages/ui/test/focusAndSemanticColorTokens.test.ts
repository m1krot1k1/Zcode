import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const stylesUrl = new URL("../src/styles.css", import.meta.url);

describe("focus and semantic color tokens", () => {
  it("defines the ring and muted-foreground tokens consumed by component utilities", async () => {
    const styles = await readFile(stylesUrl, "utf8");

    // 组件（button/badge/input/scroll-area 等）直接用 ring-ring 与 text-muted-foreground；
    // token 缺失时这两个 utility 会静默失效，焦点环和弱化文字一起消失。
    expect(styles).toMatch(/--color-ring:\s*var\(--color-brand\)/u);
    expect(styles).toMatch(/--color-muted-foreground:\s*var\(--color-foreground-subtle\)/u);
  });

  it("keeps keyboard focus visible while suppressing pointer-only outlines", async () => {
    const styles = await readFile(stylesUrl, "utf8");

    // 回归门禁：全局 !important 会同时抹掉浏览器默认 focus-visible 与组件基于 box-shadow 的 ring，
    // 键盘用户因此失去焦点指示。只允许 `:focus:not(:focus-visible)` 抑制鼠标焦点框。
    expect(styles).not.toMatch(/\*:focus[^{]*\{[^}]*outline:\s*none\s*!important/u);
    expect(styles).not.toMatch(/\*:focus[^{]*\{[^}]*box-shadow:\s*none\s*!important/u);
    expect(styles).toContain(":focus:not(:focus-visible)");
  });
});
