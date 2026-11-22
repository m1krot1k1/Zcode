# BRANCH E — Desktop / Web / UI / UX, IDE integration, multiplatform, remote/mobile

Evidence appendix for topics **(k)** IDE integration, desktop, web, mobile remote; **(o)** macOS/Windows/Linux; **(r)** UX/UI, design system, accessibility, localization, themes.

Research-only. No production code, configs, dependencies or lockfiles were modified; no commits, no package installs, no dev servers. The only file written is this appendix. All commands were read-only (`rg`, `grep`, `sed`, `find`, `git`, `node -e` scripts reading files).

---

## 0. Baseline and method

| Item | Value |
| --- | --- |
| Date (UTC) | `Wed Nov 11 06:08:04 UTC 2026` (`date -u`) |
| Branch | `dev` (`git branch --show-current`) |
| HEAD | `d10f0b69f98677091e0428a92839e4a1e01e04ca` (`git rev-parse HEAD`) |
| Recent log | `d10f0b69 Выпустить macOS Preview 3.17.102.` → `bbb756e8` → `fc70a81b` → `982e30c9` → `05bd5b31` |
| Working tree | clean (`git status --short` empty at start and at end of research) |
| CodeIndex | `ready`, not partial, generation 1440, 10 007 files / 26 791 chunks |

Skill loaded: `web-design-guidelines` (`<repo-root>/.agents/skills/web-design-guidelines/SKILL.md`), rules fetched from `https://raw.githubusercontent.com/vercel-labs/web-interface-guidelines/main/command.md` (accessibility, focus, forms, animation, typography, content, images, performance, navigation, touch, safe areas, dark mode, locale/i18n, hydration, hover, copy, anti-patterns). The skill's own output format is `file:line` findings; this appendix reuses that style but extends it with a coverage matrix and recommendations because the branch deliverable requires it.

Evidence notation used below: **F** = fact read directly in source/command output; **I** = inference from those facts; **U** = unknown / not verified in this pass. Where a count comes from a script, the script's query is described so it can be re-run.

Environment limitation: no build, no Electron launch, no browser, no `pnpm typecheck` / `pnpm lint` / `pnpm test` were run (research-only constraint). Therefore all statements about runtime rendering are **static-analysis facts about code**, not observed runtime behaviour, unless explicitly marked as a checked build artifact.

---

## 1. Surface and platform inventory

### 1.1 Repository surfaces relevant to this branch

| Surface | Location | Scale (F) |
| --- | --- | --- |
| Desktop main process | `packages/desktop/src/main/` | 179 entries in directory listing (`ls -1 \| wc -l`) |
| Desktop host (agent/Host process) | `packages/desktop/src/host/` | ~64 modules incl. `windowHostAttachmentRegistry.ts`, `windowHostControllerService.ts`, `sourceServerConnectionManager.ts` |
| Desktop preload bridge | `packages/desktop/src/preload/index.ts` | 1 049 lines, `contextBridge.exposeInMainWorld("zcode", zcodeApi)` at `preload/index.ts:934` |
| Desktop renderer | `packages/desktop/src/renderer/src/` | entry `main.tsx`, `desktopPlatform.ts` (213 lines) |
| Shared UI package | `packages/ui/src/` | ~1 060 UI test files under `packages/ui/test/`; `index.ts` 121 lines of public exports |
| Web client | `packages/web/src/` | 36 unit tests in `packages/web/test/`; remote-control domain split into `adapters/`, `app/`, `domain/`, `ui/`, `contracts/` |
| Web server | `packages/server/src/` | `entry-http.ts`, `stdio.ts`, `remote/*` (ssh/wsl/docker backends), `source-server/*` |
| Android remote shell | `packages/android/` | Kotlin/Compose WebView wrapper, `MainActivity.kt`, `RemoteControlApp.kt`, `RemoteControlUrlPolicy.kt` |
| Design docs | `DESIGN.md` 655 lines; `CONTEXT.md` 89 lines; `docs/design/*`, `docs/ui/*` (many), `docs/desktop/*` (45 docs) | 2 088 markdown files under `docs/` |
| E2E | `packages/desktop/test/e2e/` | 575 `*.test.ts`; 198 outside `manual-review/pending`, 377 inside `manual-review/pending` |
| CI | `.github/workflows/cross-platform-preview-release.yml` | only workflow; `workflow_dispatch` only |

### 1.2 Desktop architecture (F)

- `packages/desktop/src/main/desktopMainIpcPlatform.ts:1-2` documents the intent: "桌面平台 IPC 集中装配，拆散会让权限边界更难审计" — platform IPC is a deliberately centralized assembly.
- Renderer platform implementation is a thin adapter over `window.zcode`: `packages/desktop/src/renderer/src/desktopPlatform.ts:7-213`.
- Preload exposes one `zcode` object; there is no second bridge for product services (services go through RPC/MessagePort, not `window.zcode`).
- Renderer applies platform CSS classes from `navigator.userAgent`: `packages/desktop/src/renderer/src/main.tsx:105-116` (`platform-mac-desktop`, `platform-windows-desktop`, `platform-linux-desktop`).
- Window chrome differs per platform: `packages/desktop/src/main/desktopWindowChrome.ts:1-60` (custom Windows/Linux controls, macOS traffic lights, embedded `<webview>` hardening).

### 1.3 Platform abstraction: `IPlatformService` (F)

- Interface: `packages/shared/src/platform.ts:683`; 547 body lines; **137 method-ish members, 50 required, 87 optional** (script counted lines matching `^  name?[:(]` inside the interface body).
- Design rule is stated in the interface docblock: "只放'必须穿越进程边界且不适合做成 RPC service'的操作… 业务服务（文件、终端、凭据等）走 IServiceAccessor 的 RPC 通道" (`platform.ts:673-682`).
- Required members include `selectDirectory`, `selectFile`, `connectRemote`, `startWebRemoteControl`, `stopWebRemoteControl`, `getWebRemoteControlStatus`, `disposeRemoteSession`, `isDockerAvailable`, `listWSLDistros`, `listDockerContainers`, `listSSHConfigAliases`, `openExternal`, `showTaskNotification`, `syncWindowTabs`, `exportLogs`, all update methods, `getInstalledEditors`, `openInEditor`, `executeDesktopCommand`, `setApplicationLocale`, `setTitleBarTheme`, `getDeviceId`.
- Implementations: desktop `packages/desktop/src/renderer/src/desktopPlatform.ts:7`; web `packages/web/src/main.tsx:456-675`.
- Consumption: `packages/ui/src/hooks/usePlatform.tsx:10-33` (`PlatformProvider`, `usePlatform`, `useOptionalPlatform`).
- `window.zcode` direct usage inside `packages/ui/src`: 9 hits, all in comments/docblocks (`hooks/index.ts:5`, `hooks/usePlatform.tsx:5`, `logger.ts:51`, `browser-use/useDesktopZoomFactor.ts:19`, plus `gen-ui/CONTRACT.md`, `CodingPlan*` comments, `v4/ConversationShareReadonlyTimeline.tsx:3`). **No product code in `packages/ui/src` calls `window.zcode` directly** — the boundary is respected in the static sense.

**Web platform is a real second implementation, not a stub-only shim (F).** `createWebPlatform` (`packages/web/src/main.tsx:456-675`) returns `canOpenLocalFiles: false`, `canSelectFilePath: false`, `selectDirectory: () => Promise.resolve(null)`, `getPathForFile: () => null`, `connectRemote` always `{ success: false, error: "Remote connect is not supported in Web mode yet: …" }` (`main.tsx:482-505`), `startWebRemoteControl` rejects (`main.tsx:508-510`), `openInEditor` returns `{ success: false, error: "Not supported in web mode" }` (`main.tsx:656`). Several methods are proxied to the desktop host through `platformProxy.requestPlatformMethod(...)` when in mobile-remote mode (`createTempTextAttachment`, `isDockerAvailable`, `listWSLDistros`, `listDockerContainers`, `listSSHConfigAliases`, MCP directory load/save/migrate — `main.tsx:470-549`). This is a deliberate "shared-host/platform proxy" boundary consistent with `platform.ts:734-740`.

### 1.4 i18n mechanism (F)

- `Locale` union is exactly three values: `"zh-CN" | "en-US" | "ru-RU"` (`packages/shared/src/protocol.ts:77`); `LocalePreference = "system" | Locale` (`protocol.ts:90`).
- Catalogs: `packages/ui/src/i18n/locales/en-US.ts` (8 732 lines), `zh-CN.ts` (8 276), `ru-RU.json` (7 505). Selection map at `packages/ui/src/i18n/IntlProvider.tsx:24-28`.
- Runtime is a **hand-written `formatMessage` with `{key}` string replacement**, not ICU/react-intl: `IntlProvider.tsx:123-137`, `msg.replaceAll(\`{${key}}\`, String(val))` at `:131`. There is **no plural/select support** — `rg 'plural|Intl.PluralRules'` over `packages/ui/src` returns nothing (0 hits).
- Missing key behaviour is deliberate: `let msg = messages[id] ?? id;` with the comment "缺少翻译是目录缺陷，不能静默显示英文；未登记的 ID 保留原值便于定位" (`IntlProvider.tsx:127-128`).
- Key parity is **tested and passing at HEAD** by static key comparison: `packages/ui/test/intlProviderLocalePreference.test.ts:182-206` asserts no missing and no extra IDs for `ru-RU` and `zh-CN` versus `en-US`, plus identical `{arg}` sets.
- My own script found `en` = 7 501 keys, `zh` = 7 503, `ru` = 7 503, with 2 "extra" keys in zh/ru (`zcode.error.providerBusiness.3007`, `zcode.error.modelSuspiciousEmpty`). **F resolution:** those two are supplied to `en-US` through a spread `...requestSecurityMessagesEnUS` (`packages/ui/src/i18n/locales/en-US.ts:1` import, `:8729` spread), defined in `packages/ui/src/request-security-edition/messages.ts:1-6`. So the naive top-level key scan under-counts `en-US`; there is no real parity gap. This is an important example of why the index/naive scan must be checked against the source.
- Locale state owner is `ZCodeIntlProvider`; it reads `settingService`, persists `{locale, localePreference}`, resolves `system` via host (`resolveHostSystemLocale`) with navigator fallback, and broadcasts on channel `state:locale` (`IntlProvider.tsx:35-120`, `:186-320`). Deliberate loop protection exists (`ignoredLocalLocaleBroadcastPayloadRef`, `applyingBroadcastRef`).
- Locale switch UI: `packages/ui/src/SettingsPage.tsx:339`, `:1509-1524`, `:1785`, plus footer selector `packages/ui/src/settingsPageHelpers.tsx:576-577`; sidebar mirror at `packages/ui/src/project-sidebar/index.tsx:204`. `LocaleSwitcher` (`i18n/LocaleSwitcher.tsx`) is exported (`index.ts:80`) but has no in-repo consumer (grep found only definition + exports).
- Desktop native menu has its own catalog: `packages/shared/src/desktopMenu.ts:60-218` with 50 IDs per locale for all three locales (script verified 50/50/50) and `getDesktopMenuMessage` fallback (`desktopMenu.ts:220-227`).
- Locale is pushed to main for menu/tray/notifications through `PlatformChannels.SetApplicationLocale` (`packages/shared/src/channels.ts:509`), handler `packages/desktop/src/main/desktopMainIpcPlatform.ts:268-275`, called from `packages/ui/src/root/useRootPlatformEffects.ts:614`.

### 1.5 Theme mechanism (F)

- `Theme = "light" | "dark" | "zai-light" | "zai-dark" | "system"` (`packages/ui/src/theme.ts:1`); `normalizeThemePreference` maps legacy `light`/`dark` to `zai-light`/`zai-dark` (`theme.ts:19-23`).
- `applyTheme` toggles `dark`, `theme-zai-light`, `theme-zai-dark` classes and, in browsers, sets `color-scheme` + `theme-color` meta and `data-zcode-browser-theme-surface` (`theme.ts:35-68`).
- Token blocks: `:root` fallback (`styles.css:75`), `.dark` (161 token declarations, `styles.css:340`), `.theme-zai-light` (`styles.css:513`), `.theme-zai-dark` (`styles.css:677`). Four theme variants exist, matching DESIGN.md's "System / Light (Zai Light) / Dark (Zai Dark)" (`DESIGN.md:61-67`).
- Single owner is the Zustand store: default `zai-dark` (`store/index.ts:283-285`), `setTheme` writes localStorage + applies DOM + broadcast (`store/index.ts:286-293`); `useTheme()` is explicitly a compatibility shim that no longer owns a second state (`useTheme.ts:13-22`).
- System theme is subscribed continuously via `matchMedia` with legacy `addListener` fallback (`store/index.ts:439-472`).
- Cross-window sync: `BROADCAST_FIELDS = {theme, uiFontSizePx, interfaceMode, notificationEnabled}` with loop guard (`store/index.ts:234`, `:477-528`).
- Native title-bar theme sync is desktop-only and deferred until after startup loading (`packages/ui/src/root/useDesktopNativeThemeSync.ts:17-37`).
- Web has a pre-hydration theme bootstrap inline script to avoid a white flash (`packages/web/index.html:28-100+`), and `theme-color`/`color-scheme` meta (`packages/web/index.html:6-7`).
- UI font scaling is token-driven, never root `font-size`: `--ui-font-size: 14px` (`styles.css:76`), `--text-ui-*` formulas (`styles.css:150-162`), applied via `applyUiFontSizePx` (`packages/ui/src/lib/uiFontSize.ts:20`), invoked by store (`store/index.ts:331-332`, `:532`). This matches the DESIGN.md highest-priority constraint (`DESIGN.md:14-24`).

### 1.6 Keyboard / shortcuts (F)

- Single source of truth is `packages/shared/src/shortcutCommands.ts:62-103` with 24 command IDs, `window` vs `menu` channels and `global` vs `composer` scopes.
- Dispatcher: `packages/ui/src/hooks/useAppKeyboard.ts:22-75` — capture-phase `keydown`, skips `event.repeat` and `isComposing`, skips during shortcut recording, skips Shift-only printable bindings inside editable targets.
- Conflict/reserved policy: `packages/ui/src/shortcuts/conflicts.ts:24-56` — reserved native-edit chords, refresh/devtools, all F1–F12 variants, arrows, Enter (global only).
- Tests: `packages/ui/test/keyboardShortcuts.test.ts`, `shortcutBindings.test.ts`, `shortcutSettingsSection.test.ts`, `composerShortcuts.test.ts`, `confirmDialogKeyboard.test.ts`, `newTaskButtonGroupShortcut.test.ts`, `toolbarShortcuts.test.ts`; E2E `packages/desktop/test/e2e/settings/shortcut-settings-{realkeys,rebind,key-search}.test.ts` (all three formal, not pending).

---

## 2. Coverage matrix per topic

Status scale: **implemented** / **partial** / **weak** / **absent** / **NA**.

### (k) Desktop, web, mobile remote, IDE integration

| Sub-topic | Status | Evidence (file:line) | Tests | Docs | Conclusion |
| --- | --- | --- | --- | --- | --- |
| Desktop main/host/renderer separation | implemented | `desktop/src/main/desktopMainIpcPlatform.ts:1-2`; `host/index.ts`; `renderer/src/main.tsx:105-116` | `desktop/test/desktopMainIpcPlatform.test.ts` | `docs/architecture/r1-single-window-host-refactor.md` | Main owns windows/native/forwarding; Host owns agent/session; renderer owns UI. Boundary is explicit and enforced by module layout. |
| Platform service boundary | implemented | `shared/src/platform.ts:683`; `desktopPlatform.ts:7`; `web/main.tsx:456` | `ui/test/*Platform*` (indirect), `desktop/test/desktopMainIpcPlatform.test.ts` | AGENTS.md "UI 与平台边界" | 137 members, 87 optional; UI never touches `window.zcode` in product code. Two real implementations. |
| Web client as full workspace | partial | `web/src/main.tsx:456-675` | 36 web unit tests | `packages/web/src/web-remote-control/CONTRACT.md` | Web runs the shared `Root` with a reduced platform; remote connect, native dialogs, updates, editors are explicit no-ops. |
| Web remote control (phone) | implemented | `ui/src/WebRemoteControlMobileShell.tsx:59`; `web/src/web-remote-control/app/*`; `ui/src/web-remote-control/CONTRACT.md` | `ui/test/webRemoteControlMobileShell.test.ts`, `workspaceShellRemoteMobileLayout.test.ts`, 20+ `web/test/webRemoteControl*.test.ts` | `docs/web-remote-control/relay-v2-pairing.md`, `docs/design/r3-remote-ui-redesign.md` | Full relay V2 pairing, device list, scan, connecting/failure screens, reconnect, theme seed, version guard. |
| Native Android wrapper | partial | `android/app/src/main/java/com/example/zcode_mobile/{MainActivity,ui/RemoteControlApp,remote/*}.kt` | `ExampleInstrumentedTest.kt` only | none found | A thin Compose WebView host with QR scan, recent links, keep-alive service and `zcode://remote` deep link. Package id still `com.example.zcode_mobile` (`build.gradle.kts:16`). Not part of CI. |
| IDE extension (VS Code/JetBrains) | absent | no `extension.ts`, no `plugin.xml`, no `engines.vscode` (searches returned nothing); `apps/` = `dev-docs`, `zcode-cli` | — | — | **No IDE extension product.** Integration is one-directional: ZCode launches external editors. |
| Open-in-editor (macOS/Windows) | implemented | `desktop/src/main/editors.ts:69-146` (macOS defs), `:269-330` (Windows defs), `:332-342` (platform switch) | `desktop/test/editors.test.ts` (8 cases), `desktop/test/openInEditor.test.ts` (17 cases) | `docs/wsl-open-in-editor.md`, `docs/ui/windows-workspace-editor-menu.md` | Rich detection: VS Code/Insiders, Cursor, Trae, Zed, Sublime, CodeBuddy, Qoder, 9 JetBrains IDEs, terminals, Finder/QSpace/Explorer; Windows JetBrains discovery scans `JetBrains/*/bin` (`editors.ts:183-213`); Windows PATH shims resolved to real exe (`editors.ts:253-267`). |
| Open-in-editor (Linux) | weak | `editors.ts:341` — Linux returns **only** `getFileApplicationDefs()`; no IDE list | no Linux-specific test found | `fileApplications.ts:241-253` (document/media viewers) | On Linux the "Open in Editor" menu exposes document/media viewers (Evince, Okular, LibreOffice, VLC, mpv) but **not** VS Code/Cursor/JetBrains. File comment at `editors.ts:5` says "当前支持 macOS / Windows。Linux 后续再补" — confirmed by code. |
| Remote editor targets (SSH/WSL/Docker) | implemented | `openInEditor.ts:100-136` (VS Code Remote-SSH/Remote-WSL URIs), `:370-400` (dispatch), `:89-98` (WSL UNC) | `desktop/test/openInEditor.test.ts:156-515` (SSH folder/file URI, authority encoding, WSL folder/file, missing distro, UNC fallback, dual UNC failure) | `docs/wsl-open-in-editor.md` | Remote paths are never passed as local paths; Docker has no host path mapping and fails closed (UI shows no local editor entry). |
| Embedded browser | implemented | `desktop/src/main/browserView/*` (28 modules), `desktop/src/main/desktopWindowChrome.ts:43-58`; `ui/src/browser-use/*` | `ui/test/UnifiedBrowserView.test.ts`, `browser-use` browser fixtures, desktop `browser-*` E2E (many) | `docs/browser-use`, `docs/ui/*` | `<webview>` + CDP-on-guest, permission prompts, screenshot surface, residency, tab restore. |

### (o) macOS / Windows / Linux

| Sub-topic | Status | Evidence | Tests | Docs | Conclusion |
| --- | --- | --- | --- | --- | --- |
| Window chrome per OS | implemented | `desktopWindowChrome.ts:1-60`; `ui/src/DesktopTopOverlay.tsx:81-126`; `ui/src/DesktopWindowControls.tsx`; `ui/src/DesktopOverlayWindowControls.tsx:6` | `ui/test/desktopLogoStyle.test.ts`; E2E SPT-E2E-000/007 referenced in docs | `docs/design/workspace-independent-panels.md:11-104` | macOS native traffic lights; Windows/Linux custom 28px buttons; overlay safe areas via `env(titlebar-area-*)`; platform CSS variants in `styles.css:32-41`. |
| Packaging config | implemented | `packages/desktop/electron-builder.config.js` (1 000+ lines), `build/entitlements.*.plist`, `build/installer.nsh`, `build/icon*` | `desktop/scripts/test-installer-nsh-smoke.mjs`, `auto-update-install-reentry-smoke.mjs` | `docs/desktop/windows-installer-overhaul-spec.md`, `windows-installer-preserve-files.md`, `macos-dmg-signing-notarization.md`, `linux-appimage-deep-link.md`, `linux-pacman-package.md` | Six platform/arch targets; NSIS ownership manifest; DMG signing/notarization/staple/`spctl` gates; AppImage deep-link `Exec` preservation; pacman package. |
| Cross-platform CI build matrix | partial | `.github/workflows/cross-platform-preview-release.yml:24-45` (macOS arm64, Windows x64, Linux x64) | `scripts/test/cross-platform-preview-release.test.mjs` | `docs/ci-build-platform-selection.md` | Only `workflow_dispatch`; comment at `:3-6` says macOS Preview releases are built/published locally while GitHub Actions billing is unavailable. CI covers 3 of 6 documented targets. |
| Auto-update | implemented | `desktop/src/main/autoUpdater.ts` (2 148 lines), `manifestUpdateProvider.ts`; `ui/src/UpdateStatusButton.tsx`, `UpdateStatusDialog*`, `useDesktopUpdateMenu.ts` | `desktop/test/autoUpdaterReadyState.test.ts`; `ui/test/useDesktopUpdateMenu.test.ts`; smoke scripts | 8 docs in `docs/desktop/auto-update-*`, `post-update-release-notes.md`, `windows-update-install-handoff.md` | Poll 15 min / 2 min visible (`autoUpdater.ts:26-27`), stable/preview channels, download cancel, skip version, post-update release notes, release-channel-aware menu state. |
| Notifications | implemented | `desktop/src/main/desktopNotifications.ts:1-130` | `desktop/test/*notification*`? (no dedicated file found; behavior asserted in UI/E2E) | `docs/desktop/release-notification-card.md`, `docs/desktop/unread-badge.md`, `windows-taskbar-unread-badge.md` | Native `Notification`; suppressed when any window focused (`:108-110`); 3 s dedupe with `requestId` for permission/elicitation (`:17-44`); max 100 retained (`:46-57`); macOS focus restore sequence (`:72-90`); **localized copy required from renderer, missing copy rejected** (`:115-121`). |
| Linux tray / close-to-tray | implemented | `desktop/src/main/desktopTray.ts`, `desktopTraySupport.ts`, `desktopLinuxXdg.ts`, `desktopLinuxDeepLinkRegistration.ts` | `getCloseToTrayCapability` bridge with supported default (`desktopPlatform.ts:110-112`) | `docs/desktop/linux-close-to-tray.md` | GNOME-without-tray capability flag is surfaced to UI rather than assumed. |
| Path/process behavior | implemented | `openInEditor.ts:58-98` (path normalization, UNC); `editors.ts:158-181` (Program Files roots, LOCALAPPDATA fallback); `platform.ts:118-131` (`zcode-media://` URL) | `openInEditor.test.ts`, `editors.test.ts` | `docs/wsl-open-in-editor.md` | Windows/Linux path handling is explicit and unit-tested. |

### (r) UX/UI, design system, accessibility, localization, themes

| Sub-topic | Status | Evidence | Tests | Docs | Conclusion |
| --- | --- | --- | --- | --- | --- |
| Design system token layer | implemented | `packages/ui/src/styles.css:75-2312`; `DESIGN.md:1-655` | `ui/test/semanticSurfaceContrast.test.ts`, `remoteUiDesignTokenConformance.test.ts`, `commandCenterTypography.test.ts` | `DESIGN.md`, `docs/design/*` | Comprehensive semantic token system with 4 theme blocks, dedicated `text-ui-*` scale, radius/elevation/motion rules. |
| `text-ui-*` typography enforcement | partial | `DESIGN.md:14-24`; 40 remaining `text-{base,sm,xs}` usages outside `text-ui-*` in `packages/ui/src` (12 in `v4/ConversationRowView.tsx`, 12 in `ToolCallBlocks/renderers/cuaDetails.tsx`, 6 in `cuaListDetails.tsx`, rest scattered); 8 arbitrary `text-[Npx]` (`agent-workbench/CodeGraphNodes.tsx:84`, `onboarding/OccupationOnboardingVisual.tsx:69`, `settings/saved-workflows/AutomationsPageTitleSwitch.tsx:30,85`) | Only remote-UI subset is gated (`remoteUiDesignTokenConformance.test.ts:35-46`), not repo-wide | `DESIGN.md` | The rule is documented as a "design-system defect" but **only enforced by a targeted test over 22 remote-UI files**. 40 + 8 violations remain repo-wide, so the constraint is not mechanically enforced. |
| Light/dark/Zai themes | implemented | `theme.ts:1-77`; `styles.css:340-676`, `:677-...` | `ui/test/useTheme.test.ts`, `terminalTheme.test.ts`, `genUiTheme.test.ts`; 33 E2E specs reference both `zai-light` and `zai-dark`, of which **11 are formal and 22 are `manual-review/pending`** (script split), e.g. formal `coding-plan-team-usage.test.ts:176,269,348,613` and `ui-shell/side-pane-full-view.test.ts:453` | `docs/ui/default-theme.md`, DESIGN.md | System/light/dark resolved to Zai Light/Zai Dark; system change subscribed live; native title bar synced. Theme parity E2E evidence is mostly still pending review. |
| Contrast guarantees | partial | DESIGN.md requires ≥4.5:1 (`DESIGN.md:150` for `*-surface-foreground`, `DESIGN.md:615` for theme-wide safety); `semanticSurfaceContrast.test.ts:219-321` asserts 96 combinations + remote tags + continuity panel + timestamps | 5 `it` blocks | DESIGN.md | Contrast is machine-checked for **semantic surfaces and remote tokens**, not for the entire palette or all component combinations. |
| Keyboard-first navigation | implemented | `shortcutCommands.ts:62-103`; `useAppKeyboard.ts:22-75`; `shortcuts/conflicts.ts` | 7 unit test files; 3 formal shortcut E2E; 13 E2E specs press `Tab` | `docs/desktop/shortcut-settings-spec.md`, `docs/ui/platform-primary-keyboard-shortcuts.md` | 24 configurable commands, platform-correct primary modifier, conflict detection, recording UI, reserved-key blacklist. |
| Focus visibility | **weak (high-risk)** | Global reset `*:focus, *:focus-visible { outline: none !important; box-shadow: none !important; }` at `styles.css:126-131` (and forced-colors `:133-139`). Confirmed in the built renderer CSS: `:focus,:focus-visible{box-shadow:none!important;-webkit-box-shadow:none!important;outline:none!important}` at byte offset 429 017 of `packages/desktop/out/renderer/assets/styles-BO4pVIch.css`, while `focus-visible:ring-2` compiles to `box-shadow: … var(--tw-ring-shadow) …` at byte offset 262 255. | No test asserts focus indicators repo-wide; `command-center-focus.test.ts` is **pending** and only asserts `outlineWidth === "0px"` plus a parent `boxShadow !== "none"` for one composite input | DESIGN.md:614 says "Preserve the repo's established component focus styling… Composite inputs use their existing outer border or ring" | **The reset cancels Tailwind `ring-*` (box-shadow based) for every element that relies on ring only.** Components with ring-only focus: `components/ui/checkbox.tsx:15`, `switch.tsx:18`, `radio-group.tsx:22`. Button base has **no** focus style for `default/outline/secondary/ghost/link` variants (`button.tsx:10-25`); 751 `<Button>` JSX tags in `packages/ui/src`, only 10 carry an inline `focus-visible` class. Surviving focus affordances are border/bg changes (`focus-visible:border-input-border-focused` ×24, `focus-visible:bg-input-focused` ×23, `focus-visible:bg-hover` ×5) and `focus-visible:outline-1` used only by `tabs.tsx`. See §4.1 for the full risk analysis. |
| `prefers-reduced-motion` | implemented | `styles.css` has 16 `prefers-reduced-motion` occurrences: 13 `reduce` blocks (`:975,1011,1048,1076,1140,1238,1272,1321,1365,1904,1956,2203,2303`) and 3 `no-preference` blocks (`:1420,1480,1875`); JS guards in `chat-input-toolbar/RollingToolbarLabel.tsx:18`, `agent-workbench/CodeGraphExplorer.tsx:76`, `v4/ConversationTurnNavigator.tsx:38`; `motion-reduce:` utility in `TaskInteractionBadge.tsx:144-152` | No dedicated reduced-motion test found | — | Covered in CSS and in JS-driven animations. |
| `transition-all` anti-pattern | partial | 22 occurrences; some deliberate/legacy (`UpdateStatusButton.tsx:136,152`, `TerminalTabTrigger.tsx:26`, `side-pane-full-view/ConversationTab.tsx:25`, `test-results.tsx:160-161`). Button base deliberately moved to `transition-colors` (`button.tsx:7-10`). | — | — | Mostly addressed in the most performance-sensitive surface (base Button), but ~20 remain. |
| Skip link / landmarks | weak | No skip link (`rg 'skip.to.content|skip-link|SkipTo'` → 0). `<main>` is used in 11 places, some conditionally rendered per view (`WorkspaceShellLayout.tsx:2094,2141,2531,2586`), so the app shell may render **zero or multiple** `main` landmarks depending on view. `<h1>` present in 10+ screens but the main chat workspace has no `<h1>`. | — | — | Standard web-app pattern rather than a document pattern; acceptable for a desktop app shell, weaker for mobile Web/remote and screen-reader navigation. |
| `aria-live` on async updates | partial | 18 `aria-live` usages (e.g. `UpdateStatusDialog.tsx:132`, `WebRemoteControlMobileShell.tsx:252,264`, `ConversationDraftSuggestedPrompts.tsx:128`, `WorkspaceShellLayout.tsx:2774`, `BrowserViewportSurface.tsx:89`). Chat streaming itself has no live region by design (streaming text would flood AT). | `remoteAccessibility.test.ts:35-50` asserts `role="status"` + accessible name | — | Used where a discrete status changes; not systemic. |
| Icon-only buttons `aria-label` | implemented | 691 `aria-label` occurrences in `packages/ui/src`; e.g. `WebRemoteControlThemeMenu.tsx:28`, `WebRemoteControlMobileShell.tsx:181`, `webRemoteControlDeviceListPage.tsx:263`. | — | Web Interface Guidelines | Broadly followed; `lucide` icons inside labelled buttons are decorative. |
| `html lang` updates | **weak** | `<html lang="en">` is static in `packages/web/index.html:2` and `packages/desktop/src/renderer/index.html:2`. `document.documentElement.lang` is only set for share pages (`web/src/main.tsx:328`), web-remote screens (`:2035`), auth helper read (`web/src/auth/webAuthLocale.ts:48`) and the CUA panel (`desktop/src/renderer/cuaPermissionPanel.ts:50`). **`ZCodeIntlProvider` never writes `document.documentElement.lang`.** | No test | — | When the user switches to zh-CN or ru-RU, the document language attribute stays `en`. Affects screen-reader pronunciation, spell-check, font fallback and hyphenation. Directly contradicts the Web Interface Guidelines "locale" rule set. |
| RTL support | absent | `rg 'dir="rtl"'` → 0; no logical-property usage | — | — | Not shipped; current locales (zh/en/ru) are all LTR, so this is NA for the current locale set but blocks Arabic/Hebrew. |
| Date/number formatting | partial | 117 `Intl.*Format`/`toLocale*` usages. Some pass `locale` (`GitActionMenu.tsx:213,605`, `DeveloperToolsPane.tsx:18-41`, `SourceServerManagementPanel.tsx:112`, `remote-connection-flow/index.ts:362`), **some pass `undefined`** (`ModelTrajectoryFormat.ts:4`, `hooks/useRemoteConnectionLogs.ts:148`, `feedback/feedbackUserView.ts:74`, `WorkflowRunSidePaneHooks`… `WorkflowRunSidePaneSections.tsx:241`, `web-preview.tsx:236`, `WorkflowRunHoleParts.tsx:92`, `WorkflowTimelineFills.tsx:193`). `undefined` means OS/browser locale, not the app locale. | — | Web Interface Guidelines: dates/numbers must use `Intl.*` (they do) | Formatting is via `Intl`, but a subset ignores the app locale, so a user running the app in English on a Chinese OS sees Chinese-formatted timestamps. |
| Mobile/narrow layouts | partial | Mobile detection is pointer+width, not width alone: `MOBILE_TEXT_INPUT_QUERY = "(max-width: 767px) and (hover: none) and (pointer: coarse)"` (`ui/src/lib/mobileTextInput.ts:3`); mobile shell `WebRemoteControlMobileShell.tsx:59-282`; responsive layout test `workspaceShellRemoteMobileLayout.test.ts`, `workspaceSidebarWebRemoteMobileLayout.test.ts`; 390px checks in `settings-ui-polish.test.ts` and browser manual-review fixtures. | Unit + manual-review browser fixtures | DESIGN.md:582-609, `docs/design/workspace-independent-panels.md:54` | The mobile shell is single-column with drawer; iOS focus-zoom floor uses `text-mobile-input-safe` (`styles.css:166`, `lib/mobileTextInput.ts:103-106`). |
| Safe areas | partial | Only 4 `env(safe-area-inset-*)` usages: `webRemoteControlDeviceListPage.tsx:254`, `webRemoteControlConnectingScreen.tsx:96`, `components/ui/toast.tsx:48`, `components/mobile-ui/bottom-sheet.tsx:34`. **`viewport-fit=cover` is absent** from both `packages/web/index.html:5` and `packages/desktop/src/renderer/index.html:5`, and the main mobile shell `WebRemoteControlMobileShell.tsx` has no safe-area padding (verified by `rg safe-area` → no hits in that file). | — | Web Interface Guidelines: full-bleed layouts need `env(safe-area-inset-*)` | Two entry screens handle the notch; the main chat shell and composer do not, and without `viewport-fit=cover` the env vars resolve to 0 on iOS. |
| Touch interaction rules | absent | `rg 'touch-action'` → 0; `rg 'tap-highlight'` → 0; `overscroll` only on scroll containers (8 hits) | — | Web Interface Guidelines | No `touch-action: manipulation`, no intentional tap highlight, no `overscroll-behavior: none` on `<html>` for fine pointers. Double-tap zoom delay and 300 ms tap behaviour are unaddressed on mobile Web. |
| Component primitives | implemented | `packages/ui/src/components/ui/` (49 files: button, dialog, alert-dialog, select, dropdown-menu, context-menu, tabs, switch, checkbox, radio-group, tooltip, popover, toast, scroll-area, resizable, command, code-viewer, diff-viewer, pdf-viewer, pptx-*, …) | Component-level tests throughout `packages/ui/test` | `packages/ui/src/components/ui/README.md` says "不要检查这个目录，因为这是三方库，不需要修改" | shadcn/radix-based primitives. Note: README forbids editing them, which conflicts with fixing the focus-indicator issue in primitives — see §5 R-1. |
| Mobile UI subpackage | implemented | `packages/ui/src/components/mobile-ui/` with `CONTRACT.md`, `bottom-sheet.tsx` built on Radix Dialog (focus trap/Esc/accessible name), `DevicePlatformIcon.tsx`, `ZCodeAppLogo.tsx` | `contract.test.ts` | `packages/ui/src/components/mobile-ui/CONTRACT.md` | Props-only, no services/identity; Radix supplies focus containment. |
| Desktop window chrome UX | implemented | `DesktopTopOverlay.tsx:52-222`; `DesktopWindowControls.tsx`; `WindowsCaptionMenuButton.tsx`; `WindowsTopLeftLogo.tsx` | E2E SPT-E2E-000/007 (docs record Windows passes, other platforms not re-run) | `docs/design/workspace-independent-panels.md:11-104`, DESIGN.md:50-59 | Login/Coding-Plan/Rewards full-page overlays keep min/max/close reachable on Win/Linux; macOS keeps traffic lights; Web/mobile hide desktop controls. |
| Remote connection UX (5-state) | implemented | Single resolver `ui/src/lib/remoteConnectionPresentation.ts:110-200+`; tones `:49-80`; status tag `remote-connection/RemoteConnectionTags.tsx:79-118` with `role="status" aria-atomic="true"` | `ui/test/remoteConnectionPresentation.test.ts` (1 `describe` + a 29-case `it.each` table, script-counted), `remoteConnectionPresentationComponents.test.ts`, `remoteAccessibility.test.ts`, `remoteUiDesignTokenConformance.test.ts` | `docs/architecture/remote-device-connection-ux-spec.md:88-149` | Exactly 5 visible states (connected/connecting/disconnected/needs-attention/failed) with mandated tone mapping, priority rules ("needs attention" > "failed"; user disconnect → neutral), and text always present. |
| Reconnect / offline UX (desktop) | implemented | Budget `ONLINE_RETRY_DELAYS_MS = [2s,4s,8s]` (`host/sourceServerConnectionManager.ts:202`), attempts surfaced as `recoveryAttempt`/`recoveryLimit` (`:1238-1332`), rendered as "авто-восстановление n/3" via `remoteConnectionPresentation.ts` recovery block, `presentation.recovery` in `RemoteConnectionTags.tsx:103-112` | `remoteConnectionPresentation.test.ts` retrying row; `reconnectingRemoteWorkspaceLogs.test.ts`; `remoteReconnectLogRetention.test.ts` | UX spec `:143-149` | Bounded 3-attempt recovery with visible attempt counter; exhaustion → `failed` with `REMOTE_RECOVERY_BUDGET_EXHAUSTED_ERROR_CODE` (`remoteConnectionPresentationErrors.ts`). |
| Reconnect / offline UX (mobile relay) | implemented | Relay retries `[1s,2s,5s]` (`web/src/web-remote-control/app/webRemoteControlBridgeRecovery.ts:1-4`); serialized recovery runner (`:8-28`); lifecycle suspend/recover on `visibilitychange`/`freeze`/`pageshow`/`pagehide`/`online`/`resume` with "must have been suspended" guard (`webRemoteControlLifecycle.ts:17-67`); transport state machine `adapters/webRemoteControlTransport.ts:228-522`; UI banner `WebRemoteControlMobileShell.tsx:261-275` (`aria-live="polite" aria-busy="true"`) | `web/test/webRemoteControlBridgeRecovery.test.ts`, `webRemoteControlLifecycle.test.ts`, `webRemoteControlTransport.test.ts`; `ui/test/webRemoteControlMobileShell.test.ts:189-199` | `docs/web-remote-control/relay-v2-pairing.md`, `docs/web-remote-control/*` | Explicit `reconnecting` transport state with a non-blocking toast-style notice; recovery is idempotent and serialized to avoid duplicate terminal sockets (bugfix comment at `webRemoteControlLifecycle.ts:29-33`). |
| Host/session ownership UX | implemented | `host/windowHostAttachmentRegistry.ts:35-80` (attachment registry, rejects Desktop-only source-settings scope for `web-remote-replayable` at `:64-66`); `host/windowHostControllerService.ts:36-60` (source scoping key includes `kind`, `sourceServerId`/`remoteSessionId`, and `workspaceIdentity ?? workspacePath`); `ui/src/web-remote-control/domain/presentation.ts:5-54` (strict target match on workspaceKey + remoteSessionId) | `remoteWorkspaceIdentityRoundtrip.test.ts`, `remoteWorkspaceProjection.test.ts`, `useGlobalTaskListRemoteConnectionGeneration.test.ts`, `webRemoteControlWorkspaceSync.test.ts` | AGENTS.md "Workspace Identity", UX spec `:101` | Ownership is explicit and identity-first. The `workspaceIdentity?.trim() \|\| workspacePath` key is used consistently in the Host controller and web-remote presentation. |
| Web remote device discovery UX | implemented | `web/src/web-remote-control/ui/webRemoteControlDeviceListPage.tsx:240-300` (online/offline sections, multi-connection bottom sheet, `role="alert"` error, `aria-busy`); `ui/…/webRemoteControlConnectionSheet.tsx` | `web/test/webRemoteControlDeviceListPage.test.ts` | `docs/web-remote-control/relay-v2-pairing.md` | Online devices expand to a bottom sheet when multiple connections exist; offline devices shown separately; refresh labelled. |
| Mobile Web auth screens | partial | `web/src/auth/{WebLoginPage,WebCallbackPage}.tsx`, `webAuthLocale.ts:18-43` | `web/test/webLoginPage.test.ts`, `webOAuthCallbackEntry.test.ts` | — | Copy exists only in `zh-CN`/`en-US` (`webAuthLocale.ts:3`), so a `ru-RU` user gets English on the web login/callback screens. Same for web-remote failure copy (`webRemoteControlScreenCopy.ts:3`, 315 lines, `satisfies Record<WebRemoteControlScreenLocale, …>` with two locales). |
| Design docs vs code drift | partial | `DESIGN.md:248` says Linux uses 16px outer shell radius; `docs/design/workspace-independent-panels.md:7` says Linux/Web use `xl` (12px) and `:68-72` supersedes older Linux rules. `DESIGN.md:247` says macOS `bg-background-alt`; Windows/Linux/Web `bg-background-win-alt`. | — | Both docs | Two authoritative-sounding sources disagree on Linux radius (16 vs 12 px). DESIGN.md is declared the single source of truth (`DESIGN.md:5`), so the design doc is stale — or DESIGN.md is. Needs a decision, not a code change. |

---

## 3. Detailed findings with file:line

### 3.1 Strengths worth preserving

1. **One-owner platform contract with a real second implementation.** `IPlatformService` (`shared/src/platform.ts:683`) is 137 members with 87 optional, and both desktop (`desktopPlatform.ts:7`) and web (`web/main.tsx:456`) implement it, with explicit fail-closed no-ops rather than silent fallbacks. The docblock (`platform.ts:673-682`) states the boundary rule and it holds in code: zero `window.zcode` product calls in `packages/ui/src`.
2. **Single owner for theme, locale and font-size, with loop-protected cross-window broadcast.** `store/index.ts:283-293`, `:439-472`, `:477-528`; `IntlProvider.tsx:186-320`; `useTheme.ts:13-22` explicitly documents that it is a shim. This is the pattern the AGENTS.md "one owner" rule asks for.
3. **Deliberate, documented fixes with root-cause comments.** e.g. `editors.ts:77-79` (VS Code Insiders not detected because the whitelist only had stable VS Code), `theme.ts:44-45` (browser toolbar/overscroll stays in old theme if only the React `dark` class toggles), `WebRemoteControlMobileShell.tsx:47-48` (refresh on chat page loses React state but browser keeps `history.state`), `webRemoteControlLifecycle.ts:29-33` (duplicate terminal socket → relay KICKED), `desktopNotifications.ts:30-33` (dedupe by requestId for permission/elicitation), `styles.css:43-52` (shadcn data-variants were silently not compiling). These comments encode real product history and should survive refactors.
4. **Remote connection presentation is a pure, single-source 5-state resolver.** `ui/src/lib/remoteConnectionPresentation.ts:110` with tones at `:49-80`. The UX spec (`docs/architecture/remote-device-connection-ux-spec.md:88-149`) explicitly forbids any surface computing its own state; the code matches. It is unit-tested with a 29-case table (`remoteConnectionPresentation.test.ts`).
5. **Accessibility is present where it is hard to retrofit.** `RemoteConnectionStatusTag` uses `role="status" aria-atomic="true"` with a visually hidden dot (`RemoteConnectionTags.tsx:79-118`); dialogs are Radix-based and get focus trap/Esc/accessible name (`components/ui/dialog.tsx:14-93`); mobile bottom sheet explicitly reuses Radix semantics (`components/mobile-ui/bottom-sheet.tsx:7-12`); `aria-live` appears on 18 discrete status surfaces; 691 `aria-label`s; contrast is machine-checked for 96 theme/background combinations (`semanticSurfaceContrast.test.ts:219`).
6. **Keyboard architecture with a single data source and real conflict policy.** `shared/src/shortcutCommands.ts:62-103` + `ui/src/shortcuts/conflicts.ts:24-56` + `hooks/useAppKeyboard.ts:22-75`. Platform primary-modifier correctness is specified (`docs/ui/platform-primary-keyboard-shortcuts.md`) and 13 E2E specs press real `Tab` keys.
7. **Remote path safety.** `openInEditor.ts:100-136` builds proper `vscode-remote://ssh-remote+…` / `vscode-remote://wsl+…` URIs; `:89-98` builds dual UNC candidates with fallback; `:370-400` gates by remote kind. 17 unit tests cover SSH/WSL/macOS/Windows branches (`desktop/test/openInEditor.test.ts:108-517`).
8. **Bounded, visible recovery.** Desktop: 3 attempts at 2/4/8 s (`sourceServerConnectionManager.ts:202`) surfaced as a counter. Mobile: 3 attempts at 1/2/5 s (`webRemoteControlBridgeRecovery.ts:1`) plus lifecycle-driven reconnection. Both are bounded and user-visible, not infinite retries.
9. **Release engineering depth.** DMG signing+notarization+staple+`spctl` gates (`docs/desktop/macos-dmg-signing-notarization.md`), NSIS ownership manifest to avoid deleting user files (`docs/desktop/windows-installer-overhaul-spec.md`), AppImage `.desktop Exec` argument preservation (`docs/desktop/linux-appimage-deep-link.md`), six platform/arch build targets with token-boundary matching (`docs/ci-build-platform-selection.md:32`).

### 3.2 Gaps and weaknesses

#### G-1. Global focus reset cancels ring-based focus indicators (high severity)

Facts:
- `packages/ui/src/styles.css:126-131` applies `outline: none !important; box-shadow: none !important;` to `*:focus, *:focus-visible`, plus the same inside `@media (forced-colors: active)` at `:133-139`.
- The built renderer CSS confirms it ships: `:focus,:focus-visible{box-shadow:none!important;-webkit-box-shadow:none!important;outline:none!important}` at byte 429 017 of `packages/desktop/out/renderer/assets/styles-BO4pVIch.css`.
- Tailwind v4 `ring-*` compiles to a `box-shadow` chain: `focus-visible:ring-2` → `box-shadow: var(--tw-inset-shadow), … var(--tw-ring-shadow), var(--tw-shadow)` (byte 262 255 in the same file; also `node_modules/tailwindcss/dist/lib.js` defines `--tw-ring-shadow` + `box-shadow` for the `ring` utility).
- Because the reset is `!important` and comes later in the file, it wins over any non-`!important` ring declaration regardless of specificity.
- Components that rely **only** on ring: `components/ui/checkbox.tsx:15` (`focus-visible:ring-2 focus-visible:ring-input-border-focused/30`), `switch.tsx:18` (same), `radio-group.tsx:22` (`focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2`).
- Base `Button` has **no** focus style for `default`, `outline`, `secondary`, `ghost`, `link` (`button.tsx:10-25`); only `destructive` and `warning` add `focus-visible:border-*` + `focus-visible:ring-*` (and the ring part is cancelled).
- 751 `<Button>` JSX tags in `packages/ui/src`; only 10 include a `focus-visible` class inline.
- Surviving focus affordances are border/background changes: `focus-visible:border-input-border-focused` ×24, `focus-visible:bg-input-focused` ×23, `focus-visible:bg-hover` ×5, `focus-visible:outline-1` only in `tabs.tsx`.

I (inference): keyboard users tabbing through checkboxes, switches, radio groups and most buttons get no visible focus indicator. That is a WCAG 2.4.7 (Focus Visible) failure and a direct contradiction of the Web Interface Guidelines "never remove outlines without a replacement" rule and of DESIGN.md:614 ("Preserve the repo's established component focus styling").

Counter-evidence / nuance:
- The comment at `styles.css:120-125` says the reset exists because some browsers/Electron add a system yellow focus ring, and an earlier attempt to force `outline` caused double rings on composite inputs. So the reset was a deliberate fix for a real defect, not an oversight.
- `focus-visible:outline-1` in `tabs.tsx` and border/bg changes in inputs survive, so *some* controls are still visible.
- `command-center-focus.test.ts` (pending) asserts `outlineWidth === "0px"` and a parent `boxShadow !== "none"` for the composite project-name input — meaning the product's accepted contract is "no inner outline, outer ring/border only". The problem is that for many controls there is **no outer ring either**.

U: I did not run the app, so I cannot state which specific controls currently show no focus ring at runtime; the CSS cascade argument is static. This should be verified in an Electron E2E that tabs through a representative form (checkbox, switch, radio, primary button, ghost icon button) and reads computed `outline`/`box-shadow`.

#### G-2. `document.documentElement.lang` never follows the app locale (medium severity)

- `<html lang="en">` is static: `packages/web/index.html:2`, `packages/desktop/src/renderer/index.html:2`.
- `ZCodeIntlProvider` sets locale state, persists it, broadcasts it, but never writes `document.documentElement.lang` (grep over `packages/ui/src/i18n/IntlProvider.tsx` shows no `documentElement`).
- `documentElement.lang` is only written for: conversation share (`web/src/main.tsx:328`), web-remote screen (`:2035`), CUA panel (`desktop/src/renderer/cuaPermissionPanel.ts:50`).
- Consequence (I): in zh-CN and ru-RU the document still declares English. Screen readers use `lang` to choose pronunciation, spell-check and hyphenation; Chromium also uses it for font fallback. This is a concrete, low-cost fix.
- Also affects the `lang`-derived fallback in `web/src/auth/webAuthLocale.ts:48` (`document.documentElement.lang ?? navigator.language`), which will therefore always resolve `en-US` for the web auth page even when the app is in Chinese — unless `navigator.language` is Chinese.

#### G-3. Web/mobile entry screens are bilingual only, while the app supports three locales (medium severity)

- `Locale` includes `ru-RU` (`shared/src/protocol.ts:77`), and the main UI has full ru coverage (parity test at `intlProviderLocalePreference.test.ts:182-206`).
- But `web/src/auth/webAuthLocale.ts:3` is `type WebAuthLocale = "zh-CN" | "en-US"` and `WEB_AUTH_COPY` has only those two (`:18-43`).
- `web/src/web-remote-control/domain/webRemoteControlScreenCopy.ts:3` is `type WebRemoteControlScreenLocale = "zh-CN" | "en-US"` with a 315-line copy table and `satisfies Record<WebRemoteControlScreenLocale, …>` (`:297-298`).
- `toLegacyBilingualLocale` (`shared/src/protocol.ts:85-87`) deliberately collapses `ru-RU` → `en-US`, used for share pages (`web/src/main.tsx:326`).
- Consequence (I): a Russian user on the phone remote-control entry sees English auth/device-list/connecting/failure screens, then switches to Russian once inside the app (where `ZCodeIntlProvider` takes over). Inconsistent language within one flow.
- This may be intentional (the phone entry is often used before the desktop locale is known). But the mobile shell *inside* the app does use the full provider, so the inconsistency is only on pre-attachment screens.

#### G-4. Linux has no IDE "Open in Editor" list (medium severity, cross-platform parity)

- `editors.ts:332-342`: `darwin` → `MAC_EDITOR_DEFS + fileApps`; `win32` → `WINDOWS_EDITOR_DEFS + WINDOWS_ADDITIONAL_EDITOR_DEFS + fileApps`; **everything else → `getFileApplicationDefs()` only** (`:341`).
- File header says "当前支持 macOS / Windows。Linux 后续再补" (`editors.ts:5`).
- `fileApplications.ts:241-253` provides Linux document/media viewers (Evince, Okular, Firefox, WPS, LibreOffice, VLC, mpv) — so Linux users can open PDFs/DOCX/PPTX/XLSX/media, but cannot open a folder in VS Code/Cursor/JetBrains from the workspace header.
- Tests: `editors.test.ts` covers macOS and Windows only; no Linux IDE case.
- U: whether Linux users can work around this via the file tree "open with" or shell is not established.

#### G-5. Safe-area handling is incomplete and `viewport-fit=cover` is missing (medium severity, mobile Web)

- Only 4 `env(safe-area-inset-*)` usages (see matrix). The main mobile chat shell (`WebRemoteControlMobileShell.tsx:59-282`) has none.
- `viewport-fit=cover` is absent from both HTML shells (`web/index.html:5`, `desktop/src/renderer/index.html:5`). Without it, `env(safe-area-inset-*)` resolves to `0` on iOS Safari.
- Consequence (I): on notched iPhones the composer/header can sit under the home indicator or the status bar; the two entry screens that do use `safe-area-inset-top` get `0` anyway because of the missing `viewport-fit`.
- This is consistent with the Web Interface Guidelines "Full-bleed layouts need `env(safe-area-inset-*)`".

#### G-6. Touch interaction rules are entirely absent (medium severity, mobile Web)

- `touch-action`: 0 occurrences. `tap-highlight`: 0. `overscroll-behavior: none` on `<html>` for fine pointers: 0.
- Consequence (I): 300 ms double-tap-zoom delay on tappable controls in mobile Web, default grey/blue tap highlight that may clash with Zai themes, and rubber-band scroll on the document in desktop Electron (the latter is mitigated by `overflow: hidden` on `#root`, `styles.css:113-118`).
- The app is desktop-first (`DESIGN.md:28`), and mobile is the remote-control surface, so this is a real but bounded gap.

#### G-7. Design-system typography rule is documented but not mechanically enforced (medium severity, drift risk)

- DESIGN.md:14-24 declares `text-ui-*` mandatory and "Treat violations of this section as design-system defects".
- 40 `text-{base,sm,xs}` usages outside `text-ui-*` remain in `packages/ui/src`, concentrated in `v4/ConversationRowView.tsx` (12), `ToolCallBlocks/renderers/cuaDetails.tsx` (12), `cuaListDetails.tsx` (6), plus 8 arbitrary `text-[Npx]` (including `AutomationsPageTitleSwitch.tsx:30,85` using `text-[30px]`, and `onboarding/OccupationOnboardingVisual.tsx:69` using `text-[16px]`).
- The only automated gate is `remoteUiDesignTokenConformance.test.ts:35-46`, which scans 22 explicitly listed remote-UI files. It does not cover the whole package.
- Consequence (I): the font-size setting (`--ui-font-size`) does not scale those 40 places, so "Appearance → font size" produces an inconsistent UI. That is a user-visible defect, not just lint debt.

#### G-8. Contrast is guaranteed only for a subset of tokens (low–medium severity)

- `semanticSurfaceContrast.test.ts:219` asserts "all 96 theme/background/semantic combinations"; `:253` remote tags/sidebar/settings nav; `:287` remote descriptor triplets; `:305` continuity panel; `:321` device log timestamps.
- DESIGN.md:150 and `:615` require ≥4.5:1 for `*-surface-foreground` across shipped themes.
- Not covered: generic foreground/subtle/subtlest pairs on every surface, chart/trajectory colors, diff colors, disabled states, and hover/active combinations.
- U: no axe/pa11y/color-contrast tooling in dependencies (`node -e` over package.json → no `axe`, `jest-axe`, `pa11y`). So contrast coverage is a hand-written token math test, which is good but narrow.

#### G-9. No automated accessibility audit tooling; no repo-wide focus/aria gate (low–medium)

- No `axe-core`/`jest-axe`/`pa11y` dependency. `@testing-library/react` is used but no `toHaveAccessibleName`-style suite beyond targeted tests.
- `.oxlintrc.json` has `settings["jsx-a11y"]` at `:79-83` but **no `jsx-a11y/*` rules are enabled anywhere** (`rg 'jsx-a11y/'` over the repo → 0 hits; `plugins: null` at `.oxlintrc.json:3`). So `alt-text`, `aria-props`, `role-has-required-aria-props`, `no-noninteractive-tabindex` etc. are not linted.
- Consequence (I): accessibility regressions are caught only by the handful of hand-written tests, not by CI.

#### G-10. Mobile/narrow layout detection mixes pointer type with width (low–medium)

- `MOBILE_TEXT_INPUT_QUERY = "(max-width: 767px) and (hover: none) and (pointer: coarse)"` (`ui/src/lib/mobileTextInput.ts:3`).
- Consequence (I): a narrow desktop window (or a touch-enabled laptop in "coarse" mode) gets different Enter/newline and 16px-input behavior than a narrow mouse window. This is arguably correct for the iOS-zoom purpose (`shouldAvoidIosInputFocusZoom`, `:103-106`) but means "mobile layout" and "mobile input behavior" are two different predicates. `WebRemoteControlMobileShell` uses its own `isMobileViewport` prop (default `true`) rather than the media query (`WebRemoteControlMobileShell.tsx:61`), so the shell and the input behavior can disagree.

#### G-11. CI covers 3 of 6 documented release targets and is manual-only (low–medium, release risk)

- `.github/workflows/cross-platform-preview-release.yml:7` is `workflow_dispatch` only; `:24-45` matrix has macOS arm64, Windows x64, Linux x64.
- `docs/ci-build-platform-selection.md:9-16` documents six: `macos-arm64`, `macos-x64`, `windows-x64`, `windows-arm64`, `linux-x64`, `linux-arm64`.
- `:3-6` explains that macOS Preview releases are built locally "while GitHub Actions billing is unavailable".
- Consequence (I): arm64 Linux/Windows and x64 macOS artifacts are not produced by the only checked-in workflow. Combined with the "local release" note, release provenance for those targets is not reproducible from CI.

#### G-12. Cross-platform visual verification is explicitly incomplete in the project's own docs (medium, evidence gap)

- `docs/design/workspace-independent-panels.md:56`: "Linux/macOS 真机、手机实际浏览器及插件/Automations 页面逐页视觉待补" — Windows E2E passed, other platforms pending.
- `:72`: "Windows 环境不能代替真实 Linux 窗口管理器验证".
- `:114-120`: multiple runs note "其他平台未实机复测".
- U: I did not run E2E, so I cannot add evidence; this is the project's own recorded gap.

#### G-13. Android wrapper is a demo-grade shell (low, NA for current product)

- `packages/android/app/build.gradle.kts:7,16`: namespace and applicationId are `com.example.zcode_mobile`.
- Only two locales: `res/values` and `res/values-zh-rCN` (no `ru`).
- One instrumented test (`ExampleInstrumentedTest.kt`), not in CI.
- U: whether this is a shipped product surface or a prototype is not stated in repo docs.

#### G-14. `ru-RU` catalog is JSON while `zh-CN`/`en-US` are TS; `zh-CN` has one missing security key (low)

- `ru-RU.json` imported with `with { type: "json" }` (`IntlProvider.tsx:21`).
- `request-security-edition/messages.ts:8-10`: `requestSecurityMessagesZhCN` contains only `zcode.error.providerBusiness.3007`, **not** `zcode.error.modelSuspiciousEmpty`; `zh-CN.ts:7432` supplies that key directly. The `en` side has both in `requestSecurityMessagesEnUS` (`:1-6`).
- The parity test passes because it compares the merged `zh-CN.ts` object. So this is not a runtime gap, but the asymmetry (zh has one key in the shared security module, en has two) is a maintenance trap: adding a new security error to the shared module will silently leave zh without it unless `zh-CN.ts` is edited.

#### G-15. A few date/time formatters ignore the app locale (low)

- Listed in §2. `new Date(x).toLocaleTimeString()` with no locale uses the OS locale. For a user with app locale ru-RU on an en-US OS, remote logs and workflow timelines show en-US times while the rest of the UI is Russian.

#### G-16. `LocaleSwitcher` is dead code (low)

- Exported at `ui/src/index.ts:80` and `i18n/index.ts:3`, defined at `i18n/LocaleSwitcher.tsx:17`, but no consumer in `packages/ui/src`, `packages/web/src`, `packages/desktop/src` (grep found only definition + exports). It also cycles locales rather than opening a menu, which conflicts with the Settings page selector (`SettingsPage.tsx:1509-1524`). Either wire it or remove it to avoid a second, inconsistent locale entry point.

#### G-17. Design docs disagree on Linux workspace radius (low, doc drift)

- `DESIGN.md:248`: "Linux desktop uses a `16px` outer window-shell radius around the `12px` workspace panels and their `4px` outer inset."
- `docs/design/workspace-independent-panels.md:7`: "Linux 和 Web 为 `xl`（12px）"; `:68-72` supersedes older Linux rules with Windows-aligned 4px outer padding and "四角 5px 完整边框".
- I: the 16px shell in DESIGN.md refers to the outer window shell (compositor clip path), while 12px is the panel radius — these may be compatible. But `:7` says Linux workspace panels are 12px and DESIGN.md says 12px panels inside 16px shell; the design doc's `:68` says 5px border. The three numbers (5 / 12 / 16) are not reconciled in one place.

---

## 4. Checked areas with no significant gap

These were examined and found consistent; they are recorded so the reader knows what was **not** skipped:

- `packages/shared/src/platform.ts` type surface vs both implementations: all 50 required members are present in `desktopPlatform.ts` and `web/main.tsx` (method-name presence check: `showTaskNotification`, `getInstalledEditors`, `openInEditor`, `setTitleBarTheme`, `exportLogs`, `openInFileManager`, `executeDesktopCommand`, `setApplicationLocale`, `getDeviceId` all present in both).
- i18n key parity across `en-US`/`zh-CN`/`ru-RU` — verified by test at HEAD and by independent script (after resolving the `...requestSecurityMessagesEnUS` spread).
- Desktop menu locale catalogs — 50/50/50 keys per locale (`desktopMenu.ts`).
- Theme resolution and legacy normalization — `theme.ts:11-23`; store default `zai-dark`; four theme CSS blocks present.
- Cross-window broadcast loop protection — `store/index.ts:262-263`, `:477-528`; locale equivalent in `IntlProvider.tsx:103-121`, `:298-317`.
- Shortcut reserved-key policy — `conflicts.ts:24-56`; command table completeness (`shortcutCommands.ts:62-103`).
- Remote editor URI construction — SSH authority encoding (`openInEditor.ts:114-122`), WSL distro resolution with default fallback (`:70-87`), dual UNC fallback (`:89-98`).
- Notification dedupe/focus/limit behaviour — `desktopNotifications.ts:6-9`, `:17-57`, `:72-90`, `:108-121`.
- Update state machine breadth — `autoUpdater.ts` 2 148 lines with stable/preview channels, cancel token, skip version, release notes ack; `ui/src/updateStatusModel.ts` derives the button view model.
- Remote 5-state mapping — all rows of the UX spec table (`:135-141`) have a branch in `resolveRemoteConnectionPresentation` (`:110-200`), including the priority rules.
- Workspace identity key — `windowHostControllerService.ts:44` and `ui/src/web-remote-control/domain/presentation.ts:23-30` both use `workspaceIdentity?.trim() || workspacePath`.
- Desktop-only scope rejection for mobile attachments — `windowHostAttachmentRegistry.ts:64-66`.
- `aria-label` coverage on icon-only buttons — 691 occurrences; spot-checked mobile/remote surfaces all labelled.
- `prefers-reduced-motion` — 14 CSS blocks + 3 JS guards + `motion-reduce:` utilities.
- Base Button performance fix (`transition-colors` instead of `transition-all`) — `button.tsx:7-10`.
- Hidden-document animation pause — `styles.css:88-96` + `lib/documentHiddenMotionPause.ts` + `docs/performance/hidden-document-motion-pause.md` with measured memory evidence.

---

## 5. Candidate recommendations

Each: **problem** → **ZCode evidence** → **solution + boundaries** → **effect** → **risk / size** → **tentative priority** → **acceptance** → **verification**. Competitor evidence is marked as needed; **no competitor claim is invented here**.

### R-1. Restore a visible focus indicator without re-introducing double rings

- **Problem:** global `!important` reset cancels Tailwind ring (box-shadow) focus styles; base Button variants and ring-only primitives have no visible focus.
- **ZCode evidence:** `styles.css:126-131`, `:133-139`; built CSS proof at `packages/desktop/out/renderer/assets/styles-BO4pVIch.css` (reset at byte 429 017, `ring-2` at 262 255); `components/ui/button.tsx:10-25`; `checkbox.tsx:15`; `switch.tsx:18`; `radio-group.tsx:22`; DESIGN.md:614.
- **Solution + boundaries:** narrow the reset to only the cases it was meant to fix (system-level outline on composite inputs) instead of `*`. Concretely: remove the global `box-shadow: none !important`, keep a scoped rule for elements that opt in via a data attribute, and give `Button` a single shared focus treatment (e.g. `focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-ring` or a border/background change) so it does not depend on `ring`. Keep the "no inner outline on composite inputs" contract asserted by `command-center-focus.test.ts`. Do not change `packages/ui/src/components/ui/README.md` policy silently — this requires an explicit decision because the README says the primitives are third-party and must not be edited.
- **Effect:** restores WCAG 2.4.7 for checkboxes/switches/radios/most buttons; removes a repo-wide a11y failure.
- **Risk / size:** medium risk (touches global CSS and a shared primitive; can reintroduce the yellow system ring or double rings). Size **S–M** (CSS + button primitive + a few component classes + one E2E).
- **Tentative priority:** P0 for accessibility, because it is repo-wide and cheap relative to impact.
- **Acceptance:** Tab through a settings form with checkbox, switch, radio group, primary button, ghost icon button, and a composite text input in Zai Light and Zai Dark; each focused control shows exactly one visible indicator; composite input still shows zero inner outline and a non-`none` outer ring/border; forced-colors mode shows a visible indicator.
- **Verification:** extend `command-center-focus.test.ts` (currently pending) into a formal E2E `focus-visibility.test.ts` that reads computed `outlineWidth`, `outlineColor` and `boxShadow` per control; add a unit test that asserts the compiled/declared CSS does not contain an unconditional `*:focus { box-shadow: none !important }`.
- **Competitor evidence needed:** yes — compare how Cursor/Windsurf/VS Code handle focus rings in a dense IDE-like shell (only if the parent wants competitive framing).

### R-2. Set `document.documentElement.lang` from the resolved locale

- **Problem:** `<html lang="en">` never updates; screen readers and `webAuthLocale` fallback use the wrong language.
- **ZCode evidence:** `web/index.html:2`; `desktop/src/renderer/index.html:2`; `IntlProvider.tsx` has no `documentElement` write; `webAuthLocale.ts:48`.
- **Solution + boundaries:** in `ZCodeIntlProvider`, add an effect that writes `document.documentElement.lang = locale` whenever the resolved locale changes, and set `document.documentElement.dir = "ltr"` explicitly (so a future RTL locale is a one-line change). Keep it inside the provider (single owner), not in each entry point. Do not touch the static HTML `lang` (it remains the pre-hydration default).
- **Effect:** correct pronunciation/hyphenation/spell-check; fixes the web auth fallback; makes `lang`-based CSS/font rules work.
- **Risk / size:** very low risk. Size **XS**.
- **Tentative priority:** P1.
- **Acceptance:** switching to zh-CN/ru-RU updates `document.documentElement.lang` and survives a reload (preference persisted); share page and web-remote screen still set their own `lang` for their isolated documents.
- **Verification:** unit test in `intlProviderLocalePreference.test.ts` asserting `document.documentElement.lang` after `setLocalePreference` for all three locales + `system`; E2E assertion in `settings-language-system-default.test.ts`.
- **Competitor evidence needed:** no.

### R-3. Extend the pre-attachment web/mobile screens to `ru-RU` (or make the downgrade explicit in the UI)

- **Problem:** web auth and web-remote device/connecting/failure screens are bilingual; Russian users see English until the app attaches.
- **ZCode evidence:** `webAuthLocale.ts:3,18-43`; `webRemoteControlScreenCopy.ts:3,297-298`; `shared/src/protocol.ts:85-87`.
- **Solution + boundaries:** add a `ru-RU` entry to both copy tables (they are small, typed `Record<…, …>`, so TypeScript will enforce completeness). Alternative if product wants to keep these screens bilingual: document the downgrade and show the desktop locale explicitly on the connecting screen. Do not change `toLegacyBilingualLocale` for share pages in the same change (share page locale is a separate contract).
- **Effect:** consistent language through the whole mobile flow.
- **Risk / size:** low risk (copy only). Size **S**.
- **Tentative priority:** P2.
- **Acceptance:** with `navigator.language = "ru-RU"`, device list, connecting, failure and auth screens render Russian; no `{placeholder}` literals remain.
- **Verification:** `web/test/webRemoteControlFailureScreen.test.ts`, `webRemoteControlDeviceListPage.test.ts`, `webLoginPage.test.ts` extended with a `ru-RU` case; add a test that iterates `WebRemoteControlScreenLocale` keys so a new locale cannot be forgotten.
- **Competitor evidence needed:** no.

### R-4. Add a Linux IDE definition list (or explicitly scope the feature)

- **Problem:** Linux "Open in Editor" exposes only document/media viewers, no code editors.
- **ZCode evidence:** `editors.ts:5`, `:332-342` (`:341` returns file apps only); `fileApplications.ts:241-253`.
- **Solution + boundaries:** add a `LINUX_EDITOR_DEFS` (VS Code `code`, Cursor, JetBrains via `*/bin/<product>.sh` discovery, Zed, Sublime) resolved through the existing `resolveEditorDefAppPath` path; keep `getFileApplicationDefs()` appended. Do not change the WSL/SSH remote-target gating (`openInEditor.ts:370-400`). If product decides Linux IDE launch is out of scope, record that decision in a spec instead of leaving the code comment as the only statement.
- **Effect:** cross-platform parity for the workspace header's primary integration action.
- **Risk / size:** low–medium (needs Linux path/command discovery and tests; no remote semantics change). Size **M**.
- **Tentative priority:** P2.
- **Acceptance:** on Linux with VS Code installed, `getInstalledEditors()` returns it with an icon; `openInEditor("vscode", dir)` launches `code <dir>`; missing binary returns `{ success: false, error }` and the UI hides the entry.
- **Verification:** extend `desktop/test/editors.test.ts` with Linux cases (mock `process.platform` and PATH); `openInEditor.test.ts` Linux branch; a manual Linux smoke is required because CI has no Linux desktop E2E for this.
- **Competitor evidence needed:** yes — verify whether Cursor/Windsurf/Codex CLI offer Linux "open in editor" from their desktop/web clients (only if competitive parity is the goal).

### R-5. Complete safe-area handling and add `viewport-fit=cover`

- **Problem:** notched devices can clip the composer/header; the existing safe-area rules are inert without `viewport-fit`.
- **ZCode evidence:** `web/index.html:5`; `desktop/src/renderer/index.html:5`; 4 `env(safe-area-inset-*)` usages; `WebRemoteControlMobileShell.tsx` has none.
- **Solution + boundaries:** add `viewport-fit=cover` to the web viewport meta (the Electron renderer does not need it unless the window is frameless on mobile-style devices — verify before changing). Add `padding-bottom: calc(env(safe-area-inset-bottom) + <existing>)` to the mobile composer container and `padding-top` to the mobile chat header. Reuse `text-mobile-input-safe` only for inputs (`styles.css:166`), not for layout padding.
- **Effect:** correct layout on iPhone notch/home indicator and Android gesture bar.
- **Risk / size:** low risk; verify it does not shift desktop Web layout (safe areas are 0 there). Size **S**.
- **Tentative priority:** P2.
- **Acceptance:** at 390×844 with a simulated safe-area inset, composer and header remain fully visible; no horizontal scroll; desktop Web layout unchanged.
- **Verification:** browser manual-review fixture at 390px with `env()` emulation; unit test asserting the viewport meta contains `viewport-fit=cover` and the mobile shell includes the safe-area class.
- **Competitor evidence needed:** no.

### R-6. Add `touch-action` / tap-highlight / overscroll policy for mobile Web

- **Problem:** no touch-interaction rules; 300 ms tap delay and default tap highlight.
- **ZCode evidence:** `rg 'touch-action'` → 0; `rg 'tap-highlight'` → 0; `overscroll` only on 8 scroll containers.
- **Solution + boundaries:** add `touch-action: manipulation` to interactive controls (or globally on `button, a, [role="button"]`), set `-webkit-tap-highlight-color: transparent` on the app shell with an explicit replacement (e.g. `:active` background), and `overscroll-behavior: none` on `<html>` only inside `@media (pointer: fine)` as the guidelines specify. Do not disable pinch-zoom (`user-scalable=no` is an explicit anti-pattern).
- **Effect:** snappier taps, theme-consistent pressed state, no rubber-banding in Electron.
- **Risk / size:** low risk; must be checked against the terminal (xterm) and embedded browser surfaces where custom gestures exist. Size **S**.
- **Tentative priority:** P3.
- **Acceptance:** mobile Web tap on a button shows the themed active state with no grey highlight; no double-tap zoom delay on buttons; terminal and browser panes still respond to their own gestures.
- **Verification:** browser manual-review fixture on 390px coarse-pointer emulation; visual check in both themes.
- **Competitor evidence needed:** no.

### R-7. Mechanically enforce the `text-ui-*` typography rule

- **Problem:** 40 + 8 violations remain; the Appearance font-size setting does not scale them.
- **ZCode evidence:** DESIGN.md:14-24; counts in §2; `remoteUiDesignTokenConformance.test.ts:35-46` covers only 22 files.
- **Solution + boundaries:** generalize the existing forbidden-pattern scan into a repo-wide `packages/ui` test (reuse `remoteUiDesignTokenConformance.test.ts`'s regex list, excluding `packages/ui/src/components/ui/**` per its README and the documented code/diff/terminal exceptions). Fix the 40 + 8 sites in the same change or add them to an explicit allowlist with a comment. Do not change `--ui-font-size` mechanics.
- **Effect:** makes the "highest-priority UI constraint" true; font-size setting becomes consistent.
- **Risk / size:** medium (40 edits, some in large files). Size **M**.
- **Tentative priority:** P2.
- **Acceptance:** repo-wide test fails if a new `text-sm`/`text-[13px]` appears outside the allowlist; UI font size 14→18 px scales every listed site; code/diff/terminal keep their independent sizes.
- **Verification:** the new test itself, plus a visual check at two font sizes in both themes.
- **Competitor evidence needed:** no.

### R-8. Add a real accessibility gate (lint rules + axe smoke)

- **Problem:** `jsx-a11y` settings exist but no rules are enabled; no axe/pa11y; accessibility regressions are caught only by hand-written tests.
- **ZCode evidence:** `.oxlintrc.json:3` (`plugins: null`), `:79-83` (settings only); `rg 'jsx-a11y/'` → 0; no axe dependency.
- **Solution + boundaries:** enable a conservative `jsx-a11y` rule set in oxlint (`alt-text`, `aria-props`, `aria-role`, `role-has-required-aria-props`, `no-redundant-roles`, `anchor-is-valid`) and fix the resulting findings in `packages/ui` (not in `components/ui` primitives without a decision). Add an axe smoke to the browser manual-review fixtures for the mobile shell and settings page. Do not add a rule that requires rewriting radix primitives.
- **Effect:** catches icon-button-without-label, invalid aria, and invalid role regressions in CI.
- **Risk / size:** medium (unknown finding count; may be large). Size **M–L**.
- **Tentative priority:** P2 (after R-1, which is the concrete user-facing defect).
- **Acceptance:** `pnpm lint` enables the rules with zero errors (or an explicit, commented allowlist); axe smoke reports no serious/critical violations on mobile shell + settings.
- **Verification:** `pnpm lint`; the axe smoke in CI.
- **Competitor evidence needed:** no.

### R-9. Localize remaining `toLocale*` calls with the app locale

- **Problem:** some timestamps use the OS locale, not the app locale.
- **ZCode evidence:** list in §2 (`ModelTrajectoryFormat.ts:4`, `useRemoteConnectionLogs.ts:148`, `feedbackUserView.ts:74`, `WorkflowRunSidePaneSections.tsx:241`, `web-preview.tsx:236`, `WorkflowRunHoleParts.tsx:92`, `WorkflowTimelineFills.tsx:193`).
- **Solution + boundaries:** pass `locale` from `useZCodeIntl()` into these formatters (the pattern already exists at `SourceServerManagementPanel.tsx:112` and `remote-connection-flow/index.ts:362`). Do not centralize into a new module unless three or more call sites share the same options.
- **Effect:** consistent dates in Russian/Chinese UI.
- **Risk / size:** very low. Size **S**.
- **Tentative priority:** P3.
- **Acceptance:** with app locale ru-RU on an en-US OS, remote logs and workflow timelines show ru-RU formatted times.
- **Verification:** unit tests asserting formatted output for a fixed timestamp in each locale.
- **Competitor evidence needed:** no.

### R-10. Reconcile Linux radius documentation

- **Problem:** DESIGN.md (16px shell / 12px panels) and `workspace-independent-panels.md` (12px panels, 5px border, 4px outer) disagree.
- **ZCode evidence:** DESIGN.md:247-248; `docs/design/workspace-independent-panels.md:7,11-16,68-72`.
- **Solution + boundaries:** documentation-only: state one authoritative geometry table in DESIGN.md and make the design doc reference it. Do not change code until the geometry is measured on real Linux.
- **Effect:** removes a source of future regressions.
- **Risk / size:** none. Size **XS**.
- **Tentative priority:** P3.
- **Acceptance:** one table, no conflicting numbers.
- **Verification:** doc review.
- **Competitor evidence needed:** no.

---

## 6. Open questions, unverified items, and commands that could not be run

### 6.1 Unverified (U) — require runtime evidence

1. **Actual focus visibility at runtime.** The cascade analysis (G-1) is static. No Electron/browser was launched. Whether a specific control shows no ring depends on computed styles and on whether a parent contributes a border/background change. Needs a Tab-through E2E.
2. **Safe-area behaviour on real iOS.** `env()` values depend on `viewport-fit` and the device. Not emulated here.
3. **Linux IDE detection.** Not run on Linux; no Linux desktop available in this environment.
4. **Cross-platform visual parity** (macOS/Linux/mobile browser). The project's own docs record this as pending (`workspace-independent-panels.md:56,72,114-120`); no new evidence added.
5. **Whether `packages/android` is a shipped surface.** No docs; package id is `com.example`.
6. **Whether the `styles.css` global reset was re-verified after the Tailwind v4 upgrade.** The comment describes the original intent; the built CSS confirms the rule still ships, but not whether anyone checked ring-based focus after the v4 migration.
7. **Real phone remote transport** for the language/reconnect flows. Unit tests cover the state machines; no device was used.

### 6.2 Commands intentionally not run (research-only constraint)

- `pnpm typecheck`, `pnpm lint`, `pnpm fmt:check`, `pnpm architecture:check`, `pnpm knip`, `pnpm test` / `pnpm test:unit`, `pnpm test:e2e`, `pnpm dev:desktop`, `pnpm dev:web` — all excluded by the "research-only, no dev servers, no long processes" constraint. Therefore **no statement in this appendix claims a passing build or test suite**; it claims that tests exist and what they assert (read from source).
- `pnpm dep:refs`, `pnpm architecture:context` — not needed; CodeIndex was `ready` and used for orientation.

### 6.3 Baseline checks that were run

| Command | Result |
| --- | --- |
| `date -u` | `Wed Nov 11 06:08:04 UTC 2026` |
| `git branch --show-current` | `dev` |
| `git rev-parse HEAD` | `d10f0b69f98677091e0428a92839e4a1e01e04ca` |
| `git log --oneline -5` | 5 commits as listed in §0 |
| `git status --short` | empty (clean) before and after research |
| `CodeIndex status` | ready, partial=false, generation 1440 |
| i18n key-parity script (`node` reading the three catalogs) | en 7 501 / zh 7 503 / ru 7 503; 2 keys resolved via `...requestSecurityMessagesEnUS` spread |
| desktop menu locale script | zh-CN 50 / en-US 50 / ru-RU 50 |
| typography violation scan (`rg` counts) | 40 `text-{base,sm,xs}` outside `text-ui-*`; 8 `text-[Npx]` |
| focus reset verification in built CSS | rule present at byte 429 017; `ring-2` compiles to box-shadow at byte 262 255 |
| `IPlatformService` member count script | 137 total, 50 required, 87 optional |
| Button JSX scan | 751 `<Button>` tags, 10 with inline `focus-visible` |
| E2E counts | 575 specs total, 198 formal, 377 `manual-review/pending` |
| `jsx-a11y` rule scan | 0 enabled rules; settings block only |
| axe/pa11y dependency scan | none |

### 6.4 Failed / limited commands

- `cat .oxlintrc.json | node -e require(...)` failed because `.oxlintrc.json` contains `//` comments (JSONC). Read with `sed`/`nl` instead — the file is JSONC, not strict JSON. This is a fact worth knowing for any tooling that parses it.
- An early `rg -rn` invocation accidentally used `-r n` (replace flag) and produced garbage (`n` substituted for matches). Those results were discarded and the greps were re-run without `-r`; the numbers reported in this appendix come from the corrected runs.
- `grep -c 'prefers-reduced-motion' packages/web/src/styles.css` returned 0 because the web stylesheet only imports `@zcode/ui/styles.css` (`web/src/styles.css:1`); the media queries live in the UI package and therefore apply to Web. This was verified by following the import chain, not by assuming a gap.

---

## 7. Handoff summary

- **What this appendix establishes:** a per-topic coverage matrix (k/o/r) with file:line evidence, a surface/platform/i18n/theme inventory, 9 strengths, 17 named gaps (one P0-class accessibility defect), 10 recommendations with acceptance/verification, and an explicit list of what remains unverified.
- **Most important finding:** the global `*:focus` `!important` reset (`packages/ui/src/styles.css:126-139`) cancels Tailwind v4 ring (box-shadow) focus indicators, and the base `Button` has no focus style for most variants. This is repo-wide and affects keyboard users (WCAG 2.4.7). It is cheap to fix but needs a decision because `packages/ui/src/components/ui/README.md` forbids editing primitives.
- **Second most important:** `document.documentElement.lang` never follows the app locale (`IntlProvider.tsx` has no write), so zh/ru users have an English document language.
- **Third:** Linux has no IDE "Open in Editor" list (`editors.ts:341`), and pre-attachment web/mobile screens are bilingual only (`webAuthLocale.ts:3`, `webRemoteControlScreenCopy.ts:3`).
- **Do not re-do:** the i18n parity question (already tested and passing at HEAD), the 5-state remote resolver (single source, tested), the SSH/WSL editor URI construction (17 unit tests), the bounded reconnect budgets, and the packaging/signing/NSIS/AppImage documentation depth — these are strengths to preserve.
- **Suggested next owner/action:** `frontend-coder` (or `implementer`) for R-1 + R-2 as a single focused accessibility change with a new formal `focus-visibility` E2E; `infra-coder` for R-4 Linux editor detection; docs owner for R-10. All competitor comparisons (R-1, R-4) still need external evidence and must not be asserted without it.

---

### Appendix A. File index of everything cited

Absolute paths (all under `<repo-root>/`):

- `DESIGN.md`, `CONTEXT.md`, `AGENTS.md`
- `packages/shared/src/platform.ts`, `protocol.ts`, `channels.ts`, `shortcutCommands.ts`, `desktopMenu.ts`
- `packages/ui/src/theme.ts`, `useTheme.ts`, `store/index.ts`, `styles.css`, `index.ts`
- `packages/ui/src/i18n/IntlProvider.tsx`, `LocaleSwitcher.tsx`, `locales/{en-US.ts,zh-CN.ts,ru-RU.json}`
- `packages/ui/src/request-security-edition/messages.ts`
- `packages/ui/src/hooks/usePlatform.tsx`, `useAppKeyboard.ts`
- `packages/ui/src/shortcuts/{bindings.ts,conflicts.ts,composerShortcuts.ts}`
- `packages/ui/src/components/ui/{button.tsx,dialog.tsx,alert-dialog.tsx,input.tsx,select.tsx,checkbox.tsx,switch.tsx,radio-group.tsx,tabs.tsx,README.md}`
- `packages/ui/src/components/mobile-ui/{bottom-sheet.tsx,CONTRACT.md}`
- `packages/ui/src/lib/{remoteConnectionPresentation.ts,remoteConnectionPresentationErrors.ts,mobileTextInput.ts,uiFontSize.ts,openWithEditors.ts}`
- `packages/ui/src/remote-connection/RemoteConnectionTags.tsx`
- `packages/ui/src/WebRemoteControlMobileShell.tsx`, `WebRemoteControlThemeMenu.tsx`
- `packages/ui/src/web-remote-control/domain/presentation.ts`, `CONTRACT.md`
- `packages/ui/src/root/useDesktopNativeThemeSync.ts`, `useRootPlatformEffects.ts`
- `packages/ui/src/app-shell/WorkspaceShellLayout.tsx`
- `packages/ui/src/v4/{draftSuggestedPromptItems.ts,featureSuggestedPrompts.ts,officeSuggestedPrompts.ts,SessionPane.tsx,ConversationRowView.tsx}`
- `packages/ui/src/ToolCallBlocks/renderers/{cuaDetails.tsx,cuaListDetails.tsx,CuaScreenshotSection.tsx}`
- `packages/desktop/src/main/{editors.ts,openInEditor.ts,fileApplications.ts,desktopNotifications.ts,autoUpdater.ts,desktopMainIpcPlatform.ts,desktopWindowChrome.ts}`
- `packages/desktop/src/host/{windowHostAttachmentRegistry.ts,windowHostControllerService.ts,sourceServerConnectionManager.ts}`
- `packages/desktop/src/preload/index.ts`
- `packages/desktop/src/renderer/src/{main.tsx,desktopPlatform.ts}`
- `packages/desktop/src/renderer/{index.html,cuaPermissionPanel.ts}`
- `packages/desktop/electron-builder.config.js`, `packages/desktop/build/*`
- `packages/web/src/main.tsx`, `styles.css`, `index.html`
- `packages/web/src/auth/{webAuthLocale.ts,WebLoginPage.tsx,WebCallbackPage.tsx}`
- `packages/web/src/web-remote-control/{views.ts,domain/webRemoteControlScreenCopy.ts,app/webRemoteControlLifecycle.ts,app/webRemoteControlBridgeRecovery.ts,adapters/webRemoteControlTransport.ts,ui/webRemoteControlDeviceListPage.tsx,ui/webRemoteControlConnectingScreen.tsx}`
- `packages/server/src/{entry-http.ts,stdio.ts,remote/*,source-server/*}`
- `packages/android/app/src/main/java/com/example/zcode_mobile/*`, `packages/android/app/build.gradle.kts`, `packages/android/app/src/main/res/values*/strings.xml`
- `docs/architecture/remote-device-connection-ux-spec.md`, `docs/design/{workspace-independent-panels.md,r3-remote-ui-redesign.md}`, `docs/desktop/*`, `docs/ui/default-theme.md`, `docs/ui/platform-primary-keyboard-shortcuts.md`, `docs/testing/*`, `docs/wsl-open-in-editor.md`, `docs/performance/hidden-document-motion-pause.md`, `docs/web-remote-control/*`
- Tests: `packages/ui/test/{intlProviderLocalePreference,remoteConnectionPresentation,remoteConnectionPresentationComponents,remoteAccessibility,remoteUiDesignTokenConformance,semanticSurfaceContrast,useTheme,terminalTheme,genUiTheme,keyboardShortcuts,shortcutBindings,shortcutSettingsSection,composerShortcuts,confirmDialogKeyboard,mobileInputZoom,webRemoteControlMobileShell,workspaceShellRemoteMobileLayout,workspaceSidebarWebRemoteMobileLayout,openWithEditors,commandCenterTypography}.test.ts`, `packages/desktop/test/{editors,openInEditor,desktopMainIpcPlatform,autoUpdaterReadyState}.test.ts`, `packages/desktop/test/e2e/**`, `packages/web/test/**`
- CI: `.github/workflows/cross-platform-preview-release.yml`, `.oxlintrc.json`
