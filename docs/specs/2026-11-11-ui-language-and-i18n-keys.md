# UI language semantics and missing i18n keys (QW8)

| 字段     | 值                                                                                                                                     |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 状态     | 已实施                                                                                                                                 |
| 日期     | 2026-11-11                                                                                                                             |
| 来源     | `docs/research/2026-11-11-zcode-wide-competitive-research.md` R23 / QW8                                                                |
| 适用范围 | `packages/ui/src/i18n/**`、`packages/ui/src/DeleteAllArchivedTasksButton.tsx`、`packages/ui/src/project-sidebar/RemoteProjectMenu.tsx` |
| 主要对象 | `ZCodeIntlProvider`、`en-US` / `zh-CN` / `ru-RU` 目录                                                                                  |

## 1. 问题与现状证据

**FACT（修改前）.** `ZCodeIntlProvider` 只把 locale 存入 React context 和 localStorage，
没有同步 `document.documentElement.lang`（`packages/ui/src/i18n/IntlProvider.tsx` 全文）。
屏幕阅读器因此可能按宿主系统语言而不是当前 UI 语言朗读。

**FACT（修改前）.** 两个用户可见 key 在三个 locale 目录中都不存在，运行时会直接显示 raw id：

- `packages/ui/src/DeleteAllArchivedTasksButton.tsx:61` → `taskList.noArchivedTasks`；
- `packages/ui/src/project-sidebar/RemoteProjectMenu.tsx:42` → `workspaceSidebar.addProject`。

目录只支持 `zh-CN` / `en-US` / `ru-RU`（`IntlProvider.tsx:24-28`），缺失 key 会在
`createIntl().formatMessage` 中原样返回 id（`IntlProvider.tsx:126-128`）。

## 2. 目标与非目标

### 2.1 目标

1. locale 变化时把解析后的 `locale` 同步到 `document.documentElement.lang`
   （包括显式切换、system 解析完成、跨窗口广播）。
2. 在 `en-US`、`zh-CN`、`ru-RU` 三个目录补齐 `taskList.noArchivedTasks` 与
   `workspaceSidebar.addProject`，保持 key 和占位符一致。
3. 为新增的插件安装取消文案在三个目录补齐 key（见 QW10 spec）。
4. 插件安装取消相关 key：`settings.plugins.store.cancelInstall`、
   `settings.plugins.store.cancelling`、`settings.plugins.store.cancelInstallFailed`。

### 2.2 非目标

- 不引入新的 locale 或消息编译方案；不把 `formatMessage` 改为编译期 key union
  （目录仍是 `Record<string, string>`，类型安全仍依赖现有目录一致性测试）。
- 不改 i18n 持久化、广播与 system 解析语义。

## 3. 行为与所有权

- **唯一所有者**：`ZCodeIntlProvider` 拥有当前 `locale`；只有它写
  `document.documentElement.lang`。
- 写入时机：`locale` 变化后的 effect；不写入 `localePreference`（`system` 不是 BCP-47 语言标签）。
- SSR / 无 DOM 环境：`typeof document === "undefined"` 时不执行。
- 回环：`lang` 是派生投影，不参与广播、不持久化，不触发新的 locale 更新。

事件顺序：

```text
setLocalePreference / system resolve / broadcast
  → locale state
  → React render
  → effect: document.documentElement.lang = locale
```

## 4. 验收场景

1. 初始 `ru-RU` 渲染后 `document.documentElement.lang === "ru-RU"`。
2. 切到 `en-US` 后 `lang === "en-US"`；切到 system 且系统解析为 `zh-CN` 后 `lang === "zh-CN"`。
3. `taskList.noArchivedTasks`、`workspaceSidebar.addProject` 在三个目录存在且非空。
4. 既有 locale key/占位符一致性测试继续通过。

## 5. 验证

- `vitest`：`packages/ui/test/intlProviderLocalePreference.test.ts`（lang 同步 + key 存在）。
- `pnpm typecheck`（受环境限制时如实标注）。
