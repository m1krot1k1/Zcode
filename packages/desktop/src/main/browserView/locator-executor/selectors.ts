// 响应式页面可能同时保留 desktop/mobile 两份 DOM。若仅因匹配数大于 1 就在 host
// 侧抛通用错误，会错过唯一可见元素，也会丢失 Playwright 提供的候选详情。
export const STRICT_VISIBLE_SELECTOR_HELPER = `
function querySelectorStrictWithVisibleFallback(injected, parsedSelector, root) {
  const matches = injected.querySelectorAll(parsedSelector, root);
  if (!matches.length) {
    injected.checkDeprecatedSelectorUsage(parsedSelector, matches);
    return null;
  }

  if (matches.length === 1) {
    injected.checkDeprecatedSelectorUsage(parsedSelector, matches);
    return matches[0];
  }

  const visibleMatches = matches.filter((element) => {
    const state = injected.elementState(element, "visible");
    return !!state.matches;
  });
  if (visibleMatches.length === 1) return visibleMatches[0];

  throw injected.strictModeViolationError(parsedSelector, matches);
}
`;

export function strictVisibleSelectorSetup(selector: string): string {
  return `${STRICT_VISIBLE_SELECTOR_HELPER}
      const parsedSelector = injected.parseSelector(${JSON.stringify(selector)});
      const resolvedElement = querySelectorStrictWithVisibleFallback(injected, parsedSelector, root);
      const elements = resolvedElement ? [resolvedElement] : [];`;
}

export function splitSelectorTokens(selector: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote = "";
  let escaped = false;
  for (let index = 0; index < selector.length; index += 1) {
    const character = selector[index] ?? "";
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === "\\") {
      current += character;
      escaped = true;
      continue;
    }
    if (quote) {
      current += character;
      if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      current += character;
      quote = character;
      continue;
    }
    if (selector.slice(index, index + 4) === " >> ") {
      tokens.push(current.trim());
      current = "";
      index += 3;
      continue;
    }
    current += character;
  }
  if (current.trim()) tokens.push(current.trim());
  return tokens;
}

export function frameSegments(selector: string): string[] {
  const segments: string[] = [];
  let current: string[] = [];
  for (const token of splitSelectorTokens(selector)) {
    if (token === "internal:control=enter-frame") {
      if (current.length === 0) throw new Error("frame locator is missing a frame selector");
      segments.push(current.join(" >> "));
      current = [];
      continue;
    }
    current.push(token);
  }
  if (current.length === 0) throw new Error("frame locator is missing a child selector");
  segments.push(current.join(" >> "));
  return segments;
}
