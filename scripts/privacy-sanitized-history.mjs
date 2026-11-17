// 已净化历史基线（sanitized-history-baseline）的加载、校验与报告聚合。
//
// 用途：把「已经修好在 HEAD、但旧 blob 仍留在历史里」的命中登记成点对点抑制，
// 而不是关闭检查。机制说明见 docs/testing/pre-push-hook.md。
//
// 三条严格匹配规则（由 check-tracked-privacy.mjs 与 validateSanitizedHistory 共同
// 保证）：path + 完整 blobSha + findingTypes 必须同时匹配；只对 push 范围的历史
// blob 生效；索引与 HEAD 永不放行。

import { readFileSync } from "node:fs";
import { join } from "node:path";

export const SANITIZED_HISTORY_RELATIVE_PATH =
  "scripts/privacy-sanitized-history.json";
export const SANITIZED_HISTORY_VERSION = 1;
export const SANITIZED_FINDING_TYPES = new Set(["home-path", "email", "token"]);

/**
 * 读取抑制表；文件不存在视为空表（没有抑制，闸门照常工作）。
 *
 * 路径从 git root 解析且不接受环境变量覆盖：抑制表必须是被提交、被评审的那
 * 一份，否则任意变量就能把闸门变成空操作。
 */
export function loadSanitizedHistory(root) {
  const file = join(root, SANITIZED_HISTORY_RELATIVE_PATH);
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw new Error(
      `无法读取 ${SANITIZED_HISTORY_RELATIVE_PATH}：${error.message}`,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `${SANITIZED_HISTORY_RELATIVE_PATH} 不是合法 JSON：${error.message}`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${SANITIZED_HISTORY_RELATIVE_PATH} 顶层必须是对象`);
  }
  if (parsed.version !== SANITIZED_HISTORY_VERSION) {
    throw new Error(
      `${SANITIZED_HISTORY_RELATIVE_PATH} 的 version 必须是 ${SANITIZED_HISTORY_VERSION}（收到 ${parsed.version}）`,
    );
  }
  if (!Array.isArray(parsed.entries)) {
    throw new Error(`${SANITIZED_HISTORY_RELATIVE_PATH} 的 entries 必须是数组`);
  }
  return parsed.entries;
}

/** 逐条校验并展开成「路径 + blob + 类型」三元组；任何一条不合法都抛错。 */
export function validateSanitizedHistory(entries, deps) {
  if (entries.length === 0) return [];
  const { isAncestorOfHead, readBlobAtCommit, analyzeLine } = deps;
  const problems = [];
  const valid = [];
  const seen = new Set();

  const checkScalars = (entry, where) => {
    const { path, blobSha, findingTypes, count, sanitizedInCommit } = entry;
    if (typeof path !== "string" || path.trim() === "")
      return `${where} 缺少 path`;
    if (path.startsWith("/") || path.split("/").includes("..")) {
      return `${where} 的 path 必须是仓库相对路径（${path}）`;
    }
    if (typeof blobSha !== "string" || !/^[0-9a-f]{40,64}$/u.test(blobSha)) {
      return `${where} 的 blobSha 必须是完整小写 SHA（${path}）`;
    }
    if (!Array.isArray(findingTypes) || findingTypes.length === 0) {
      return `${where} 的 findingTypes 必须是非空数组（${path}）`;
    }
    if (!findingTypes.every((type) => SANITIZED_FINDING_TYPES.has(type))) {
      return `${where} 的 findingTypes 含未知类型（只允许 ${[...SANITIZED_FINDING_TYPES].join("/")}）：${path}`;
    }
    if (!Number.isInteger(count) || count < 1) {
      return `${where} 的 count 必须是正整数（${path}）`;
    }
    // 没有「修复提交」就无法证明这个值已经修好，一律视为无效。
    if (
      typeof sanitizedInCommit !== "string" ||
      sanitizedInCommit.trim() === ""
    ) {
      return `${where} 缺少 sanitizedInCommit（${path}）`;
    }
    return null;
  };

  const checkFixCommit = (entry, where) => {
    const { path, findingTypes, sanitizedInCommit } = entry;
    if (!isAncestorOfHead(sanitizedInCommit)) {
      return `${where} 的 sanitizedInCommit ${sanitizedInCommit} 不是 HEAD 的祖先，无法证明修复已进入当前分支（${path}）`;
    }
    const content = readBlobAtCommit(sanitizedInCommit, path);
    if (content === null) {
      return `${where} 在 ${sanitizedInCommit} 的树里找不到 ${path}`;
    }
    const stillPresent = new Set();
    for (const line of content.split(/\r?\n/u)) {
      for (const finding of analyzeLine(line)) stillPresent.add(finding.type);
    }
    const remaining = findingTypes.filter((type) => stillPresent.has(type));
    if (remaining.length > 0) {
      return `${where} 的 ${path} 在 ${sanitizedInCommit} 里仍有 ${remaining.join("/")} 命中：先真正修复，再登记抑制`;
    }
    return null;
  };

  for (const [index, entry] of entries.entries()) {
    const where = `entries[${index}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      problems.push(`${where} 必须是对象`);
      continue;
    }
    const problem = checkScalars(entry, where) ?? checkFixCommit(entry, where);
    if (problem) {
      problems.push(problem);
      continue;
    }
    const { path, blobSha, findingTypes, count, sanitizedInCommit } = entry;
    const keys = findingTypes.map((type) => `${path}\0${blobSha}\0${type}`);
    const duplicate = keys.find((key) => seen.has(key));
    if (duplicate) {
      problems.push(
        `${where} 与前面的条目重复（${path} @ ${blobSha.slice(0, 12)}）`,
      );
      continue;
    }
    for (const [position, type] of findingTypes.entries()) {
      seen.add(keys[position]);
      valid.push({ path, blobSha, type, count, commit: sanitizedInCommit });
    }
  }

  if (problems.length > 0) {
    throw new Error(
      `privacy-sanitized-history.json 配置无效，已阻止 push：\n  - ${problems.join("\n  - ")}`,
    );
  }
  return valid;
}

/** 把「路径 + blob + 类型」的三元组索引成 `path\0type` → 条目，供扫描时查表。 */
export function indexSanitizedEntries(entries) {
  return new Map(
    entries.map((entry) => [`${entry.path}\0${entry.type}`, entry]),
  );
}

/**
 * 汇总被抑制的命中：按「路径 + blob」聚合成 CI 可读的一行，并核对登记的 count。
 * 返回 { lines, actualByEntry }，既有日志输出也有对账数据。
 */
export function summarizeSuppressed(suppressedHits, sanitizedEntries) {
  const byEntry = new Map();
  for (const bucket of suppressedHits.values()) {
    const key = `${bucket.path}\0${bucket.blobSha}`;
    const entry = byEntry.get(key) ?? {
      path: bucket.path,
      blobSha: bucket.blobSha,
      commit: bucket.commit,
      types: [],
    };
    entry.types.push(`${bucket.type} ×${bucket.lines.size}`);
    byEntry.set(key, entry);
  }

  const actualByEntry = new Map();
  for (const bucket of suppressedHits.values()) {
    const key = `${bucket.path}\0${bucket.blobSha}`;
    actualByEntry.set(key, (actualByEntry.get(key) ?? 0) + bucket.lines.size);
  }

  const mismatches = [];
  const checked = new Set();
  for (const entry of sanitizedEntries) {
    const key = `${entry.path}\0${entry.blobSha}`;
    if (checked.has(key)) continue;
    checked.add(key);
    const actual = actualByEntry.get(key);
    if (actual !== undefined && entry.count !== actual) {
      mismatches.push({
        path: entry.path,
        blobSha: entry.blobSha,
        expected: entry.count,
        actual,
      });
    }
  }

  const lines = [...byEntry.values()].map(
    (entry) =>
      `[tracked-privacy] 已净化历史：${entry.path} @ ${entry.blobSha.slice(0, 12)} (${entry.types.join(", ")}, 修复于 ${entry.commit.slice(0, 8)})`,
  );
  return { lines, recordCount: byEntry.size, mismatches };
}

/** 找出登记了、范围内也确实扫到该 blob、但完全没有命中的条目（基线已过期）。 */
export function findStaleBaseline(
  sanitizedEntries,
  historyEntries,
  suppressedHits,
) {
  const historyKeys = new Set(
    historyEntries.map(({ file, sha }) => `${file}\0${sha}`),
  );
  return sanitizedEntries
    .filter((entry) => {
      const key = `${entry.path}\0${entry.blobSha}`;
      return (
        historyKeys.has(key) && !suppressedHits.has(`${key}\0${entry.type}`)
      );
    })
    .map((entry) => `${entry.path}\0${entry.blobSha}`);
}
