import type { BrowserGuestContext } from "./browserGuestContext.js";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { webContents } from "electron";
import type {
  BrowserGuestAttachResult,
  BrowserViewCloseTabRequest,
  BrowserGuestAttachRejectReason,
} from "@zcode/shared";
import type {
  GuestWebContents,
  BrowserGuestExecutionContext,
  InternalExecutionContext,
  ManagedTab,
  GuestRecoveryReason,
} from "./browserGuestTypes.js";
import {
  safeNumber,
  normalizeLegacyContext,
  safeBool,
  safeStr,
  scopeKey,
  sameScope,
  ownedBySession,
} from "./browserGuestUtils.js";

export function createBrowserGuestLifecycle(
  ctx: BrowserGuestContext,
): Pick<
  BrowserGuestContext,
  | "listGuestWebContentsIds"
  | "attachGuest"
  | "getTabOwner"
  | "getTabOwnerByWebContentsId"
  | "closeTabFromRenderer"
  | "endTurn"
  | "closeSession"
  | "closeSessionTabs"
  | "closeWindow"
  | "closeTabDurably"
  | "closeTab"
  | "removeTabRecovery"
  | "detachAndCloseGuest"
  | "rejectGuestAttach"
  | "requestGuestRebind"
  | "closeGuestWebContents"
  | "detach"
  | "disposeAll"
  | "hasGuest"
  | "now"
  | "warn"
> {
  return {
    /** 资源管理器：当前仍活着的浏览器 guest webContents id，用于把其 renderer 归到内置插件 browser-use */
    listGuestWebContentsIds(): number[] {
      const ids: number[] = [];
      for (const tab of ctx.tabs.values()) {
        if (tab.lifecycle === "closed" || !tab.guest) continue;
        const id = safeNumber(() => tab.guest?.id);
        if (id !== undefined) ids.push(id);
      }
      return ids;
    },

    attachGuest(
      tabId: string,
      webContentsId: number,
      options?: {
        active?: boolean;
        windowId?: number;
        workspaceKey?: string;
        remoteSessionId?: string;
        sessionId?: string;
        residencyGeneration?: number;
      },
    ): BrowserGuestAttachResult {
      let tab = ctx.tabs.get(tabId);
      const guest = webContents.fromId(webContentsId) as GuestWebContents | undefined;
      if (!guest || guest.isDestroyed()) {
        const recoveryRequested =
          tab && tab.lifecycle !== "closed"
            ? ctx.requestGuestRebind(tab, guest ? "destroyed" : "not-found")
            : false;
        ctx.log?.(
          `[browser-use] attachGuest skip tabId=${tabId} id=${webContentsId} reason=${guest ? "destroyed" : "not-found"}`,
        );
        return {
          ok: false,
          reason: guest ? "destroyed" : "not-found",
          recoveryRequested,
        };
      }
      if (guest.getType() !== "webview") {
        // fromId 接受进程内任意 WebContents id；若 renderer 误传主窗口 id，后续
        // CDP/Runtime 输入会直接操作 ZCode composer。IAB 只允许真实 <webview> guest fail closed。
        ctx.log?.(
          `[browser-use] attachGuest rejected tabId=${tabId} id=${webContentsId} reason=not-webview type=${guest.getType()}`,
        );
        return { ok: false, reason: "not-webview", recoveryRequested: false };
      }

      if (ctx.closedTabIds.has(tabId)) {
        ctx.log?.(`[browser-use] attachGuest rejected tabId=${tabId} reason=closed`);
        return { ok: false, reason: "closed", recoveryRequested: false };
      }
      // 兼容旧 renderer：未经历 create request 的 key 只进入 legacy scope。
      if (!tab) {
        const owner = options?.workspaceKey
          ? {
              requestId: `unclaimed:${randomUUID()}`,
              browserId: "unclaimed-iab",
              browserGeneration: 0,
              windowId: options.windowId ?? 0,
              workspaceKey: options.workspaceKey,
              // human tab 原来只按 workspace 登记为全局 unclaimed，任意新对话都能
              // 从 user.openTabs() 枚举并接管。ownerTaskId 现在随 attach 冻结；旧 renderer
              // 未传 sessionId 时保留不可认领哨兵，宁可隐藏也不能跨对话泄漏。
              sessionId: options.sessionId?.trim() || "unscoped",
              ...(options.remoteSessionId ? { remoteSessionId: options.remoteSessionId } : {}),
              clientMode: "desktop-continuous" as const,
            }
          : normalizeLegacyContext(tabId);
        if (options?.windowId !== undefined) owner.windowId = options.windowId;
        tab = {
          tabId,
          owner,
          cdpAttached: false,
          guestLifecycle: "detached",
          pendingCdpCommands: 0,
          guestGeneration: 0,
          hasAttachedGuest: false,
          rebindRequested: false,
          lifecycle: "active",
          origin: options?.workspaceKey ? "user" : "agent",
          claimable: Boolean(options?.workspaceKey && options.sessionId?.trim()),
          ...(options?.workspaceKey ? { userOwner: { ...owner } } : {}),
          active: false,
          loading: false,
          mediaActive: false,
          cachedUrl: "",
          cachedTitle: "",
          cachedFaviconUrl: null,
          openedAt: ctx.now(),
        };
        ctx.tabs.set(tabId, tab);
        ctx.registerTabResidency(tab, options?.active === true);
      }
      if (tab.lifecycle === "closed") {
        ctx.log?.(`[browser-use] attachGuest rejected tabId=${tabId} reason=closed`);
        return { ok: false, reason: "closed", recoveryRequested: false };
      }
      if (options?.windowId !== undefined && tab.owner.windowId !== options.windowId) {
        ctx.log?.(
          `[browser-use] attachGuest rejected tabId=${tabId} reason=window-mismatch expected=${tab.owner.windowId} actual=${options.windowId}`,
        );
        return { ok: false, reason: "window-mismatch", recoveryRequested: false };
      }
      if (options?.workspaceKey && tab.owner.workspaceKey !== options.workspaceKey) {
        ctx.log?.(`[browser-use] attachGuest rejected tabId=${tabId} reason=workspace-mismatch`);
        return ctx.rejectGuestAttach(tab, guest, "workspace-mismatch");
      }
      if (options?.sessionId && tab.owner.sessionId !== options.sessionId) {
        // renderer 的迟到 dom-ready 不能用另一个对话的 ownership 复用既有 tabId。
        // window/workspace 相同也必须拒绝，避免 guest 被跨对话替换后绕过 openTabs 隔离。
        ctx.log?.(`[browser-use] attachGuest rejected tabId=${tabId} reason=session-mismatch`);
        return ctx.rejectGuestAttach(tab, guest, "session-mismatch");
      }
      if ((tab.owner.remoteSessionId ?? "") !== (options?.remoteSessionId ?? "")) {
        // remote owner 过去只在 renderer 主动提供 remoteSessionId 时校验，缺失值会
        // fail-open；远程重连后的旧 tab 因而可能被新 runtime attach。
        ctx.log?.(
          `[browser-use] attachGuest rejected tabId=${tabId} reason=remote-session-mismatch`,
        );
        return ctx.rejectGuestAttach(tab, guest, "remote-session-mismatch");
      }

      const residency = ctx.residencyCoordinator.get(tabId);
      const rejectsNewGuest =
        tab.guest !== guest &&
        (residency?.residency === "suspended" || residency?.residency === "suspend-pending");
      if (rejectsNewGuest) {
        // 恢复 timeout 已回滚后，旧 generation 的迟到 guest 原来仍会绕过 restoring
        // 校验并重新占用 tab。suspended/pending 只允许当前旧 guest 重复上报，不接受新 attach。
        ctx.log?.(
          `[browser-use] attachGuest rejected tabId=${tabId} reason=residency-${residency.residency}`,
        );
        ctx.closeGuestWebContents(tab, guest);
        return {
          ok: false,
          reason: "residency-suspended",
          recoveryRequested: false,
        };
      }
      if (
        residency?.residency === "restoring" &&
        !ctx.residencyCoordinator.markAttached(
          tabId,
          options?.active === true,
          options?.residencyGeneration,
        )
      ) {
        ctx.log?.(
          `[browser-use] attachGuest rejected tabId=${tabId} reason=residency-generation-mismatch expected=${residency.generation} actual=${options?.residencyGeneration ?? "missing"}`,
        );
        ctx.closeGuestWebContents(tab, guest);
        return {
          ok: false,
          reason: "residency-generation-mismatch",
          recoveryRequested: false,
        };
      }
      const isSameGuest = tab.guest === guest;
      if (residency?.residency === "restoring") {
        // 恢复态 src 使用不会提交 document 的延迟 protocol；scope/generation 校验通过后
        // 终止 provisional request，确保 restoreGuestState 创建唯一首次有效导航。
        try {
          guest.stop();
        } catch (error) {
          ctx.warn(`browser tab provisional navigation stop failed tabId=${tabId}`, error);
        }
      }
      if (tab.guest && !isSameGuest) ctx.detachGuest(tab);
      if (!isSameGuest) ctx.guestRecoveryFlights.delete(tab.tabId);

      // detachGuest 会从仍存活的旧 guest 读取最后 URL；恢复判定必须放在它之后，避免 renderer
      // 尚未来得及上报 residency 时，把刚刚发生过的导航误判成没有可恢复事实。
      const rebindReason = tab.attachFailure;
      const shouldRestoreAfterRebind =
        tab.hasAttachedGuest &&
        !isSameGuest &&
        rebindReason !== undefined &&
        rebindReason !== "residency-suspended" &&
        rebindReason !== "residency-generation-mismatch" &&
        tab.cachedUrl.trim() !== "" &&
        tab.cachedUrl !== "about:blank";

      let cdpAttached = false;
      try {
        if (!guest.debugger.isAttached()) guest.debugger.attach("1.3");
        cdpAttached = guest.debugger.isAttached();
      } catch {
        cdpAttached = safeBool(() => guest.debugger.isAttached(), false);
      }
      tab.guest = guest;
      tab.cdpAttached = cdpAttached;
      tab.guestLifecycle = "attached";
      tab.guestTeardownFlight = undefined;
      if (!isSameGuest) tab.guestGeneration += 1;
      tab.hasAttachedGuest = true;
      tab.attachFailure = undefined;
      tab.rebindRequested = false;
      if (cdpAttached) ctx.scheduleGuestCdpIdleRelease(tab);
      // 恢复期新 guest 的初始 URL 是 about:blank。若在 pageState/restoreUrl 消费前
      // 覆盖 logical cache，损坏快照会错误降级到空白页，三类事实全缺失的 orphan 也无法识别。
      if (residency?.residency !== "restoring" && !shouldRestoreAfterRebind) {
        tab.cachedUrl = safeStr(() => guest.getURL(), tab.cachedUrl);
        tab.cachedTitle = safeStr(() => guest.getTitle(), tab.cachedTitle);
      }
      if (options?.active === true) {
        tab.active = true;
        if (!tab.claimable) ctx.selectTab(tab, false);
        ctx.restoreNaturalViewportAfterBackground(tab);
      } else if (options?.active === false) {
        tab.active = false;
        ctx.residencyCoordinator.report(tab.tabId, {
          selected: false,
          visible: false,
        });
        if (ctx.activeTabByScope.get(scopeKey(tab.owner)) === tabId) {
          ctx.activeTabByScope.delete(scopeKey(tab.owner));
        }
      }
      ctx.log?.(
        `[browser-use] attachGuest tabId=${tabId} windowId=${tab.owner.windowId} cdp=${cdpAttached}`,
      );

      guest.once("destroyed", () => {
        const current = ctx.tabs.get(tabId);
        if (current?.guest === guest) {
          ctx.detachGuest(current);
          ctx.requestGuestRebind(current, "guest-destroyed");
        }
      });
      // 放在其余接线之前：后面几个 setup 在 guest 已销毁时可能同步抛错并跳过剩余接线，
      // 而这是唯一能关闭 UAF 窗口的监听，不该被别的接线牵连。
      if (!isSameGuest) ctx.setupCdpCrashGuard(tab, guest);
      if (!isSameGuest) ctx.setupDialogTracking(tab, guest);
      if (!isSameGuest) ctx.setupDownloadTracking(tab, guest);
      if (!isSameGuest) ctx.setupActivityTracking(tab, guest);
      if (!isSameGuest) ctx.applyViewportOverride(tab);
      if (tab.viewportOverride) {
        // Agent 可能在 renderer 完成自动打开前就发出 viewport 事件；guest attach 后重放一次，
        // 保证刚挂载的自由尺寸 UI 不会漏掉 main → renderer 的一次性同步。
        ctx.onViewportChanged?.({ ...tab.viewportOverride }, tab.owner, tab.tabId);
      }
      if (options?.active !== false && ctx.visibilityByScope.get(scopeKey(tab.owner)) === true) {
        // visibilityByScope 表示整个 browser scope 可见，不表示本次 attach 的 tab
        // 被选中。把 inactive guest 也回放为 visible=true 会让 renderer 在用户切换后
        // 又激活旧 tab；关闭后迟到的同类事件还会复活 tab shell。只有非 inactive attach 才能
        // 沿用 scope 可见性，显式选中仍由 selectTab/browserVisibilitySet 通知。
        ctx.onVisibilityChanged?.(true, tab.owner, tab.tabId);
      }
      if (shouldRestoreAfterRebind) {
        // guest-destroyed 只重放 Ready 时，新 guest 的初始 URL 是 about:blank；若直接
        // 将它标记为可用，renderer 又不会重新消费已应用过的 initialUrl，右侧面板就永久停在空白页。
        // 这里沿用已有 pageState → restoreUrl 恢复逻辑，并以 tab 级 flight 串住后续命令。
        const recoveryFlight = ctx.restoreReboundGuest(tab, guest);
        ctx.guestRecoveryFlights.set(tab.tabId, recoveryFlight);
        const clearRecoveryFlight = () => {
          if (ctx.guestRecoveryFlights.get(tab.tabId) === recoveryFlight) {
            ctx.guestRecoveryFlights.delete(tab.tabId);
          }
        };
        void recoveryFlight.then(clearRecoveryFlight, clearRecoveryFlight);
      }
      ctx.resolveWaiters(tabId, guest);
      if (residency?.residency !== "restoring") {
        ctx.residencyCoordinator.markAttached(tabId, options?.active === true);
      }
      void ctx.persistShell(tab);
      return { ok: true, guestGeneration: tab.guestGeneration };
    },

    getTabOwner(tabId: string): BrowserGuestExecutionContext | null {
      const owner = ctx.tabs.get(tabId)?.owner;
      return owner ? { ...owner } : null;
    },

    /** 根据 guest WebContents 反查受控 tab，供 webview popup 事件保留原始 session scope。 */
    getTabOwnerByWebContentsId(
      webContentsId: number,
    ): (BrowserGuestExecutionContext & { tabId: string }) | null {
      for (const tab of ctx.tabs.values()) {
        if (tab.guest?.id === webContentsId && tab.lifecycle !== "closed") {
          return { ...tab.owner, tabId: tab.tabId };
        }
      }
      return null;
    },

    async closeTabFromRenderer(
      payload: BrowserViewCloseTabRequest & { windowId: number },
    ): Promise<void> {
      // Agent close 已把 logical tab 从 main 删除，而 BrowserViewCloseTab 通知可能落在
      // 非当前 workspace 被 renderer 丢弃，UI 侧仍留着壳。此时用户点 × 走到这里，直接抛
      // "unavailable for renderer scope"，renderer 拿不到授权就永不移除 UI —— tab 永远关不掉。
      // main 已经没有这个 logical tab，renderer 想收敛自己的壳是安全且必要的：幂等放行，
      // 同时补上 tombstone，阻止迟到 attach 把它复活。scope 校验只对仍存活的 tab 生效，
      // 跨 window/workspace 越权关闭他人 tab 仍然被拒绝。
      const existing = ctx.tabs.get(payload.tabId);
      if (!existing || existing.lifecycle === "closed") {
        ctx.closedTabIds.add(payload.tabId);
        return;
      }
      // close 是收敛意图：remoteSessionId 的防重连语义只属于 attach（见 attachGuest 的
      // remote-session-mismatch）。attach 侧 renderer 对该字段有 workspaceRemoteSessionId 兜底、
      // close 侧没有，严格比对会让远程 human tab 永远关不掉。renderer 关闭自己看得见的 tab 不构成
      // 越权，window/workspace/session 三项仍严格校验，跨作用域越权关闭照旧拒绝。
      const tab = ctx.requireRendererOwnedTab(payload, { skipRemoteSession: true });
      await ctx.closeTabDurably(tab, false);
    },

    endTurn(context: InternalExecutionContext, turnId?: string): void {
      ctx.abortRecordings(
        (entry) =>
          sameScope(entry.context, context) &&
          (turnId === undefined || entry.context.turnId === turnId),
        "turn ended",
      );
      for (const request of ctx.runningRequests.values()) {
        if (
          sameScope(request.context, context) &&
          (turnId === undefined || request.context.turnId === turnId)
        ) {
          request.controller.abort(new DOMException("turn ended", "AbortError"));
        }
      }
      // turn end 只结束请求，不结束 tab。旧的“只保留最终活动页”兜底会在已有 handoff 时
      // 自动关闭后续新 tab，使页面存活依赖模型记得写 finalize JS。active/handoff tab 现在原样保留；
      // deliverable 和 claimed user tab 仍按显式生命周期约定释放控制权，但 view 不关闭。
      for (const tab of ctx.tabs.values()) {
        if (!sameScope(tab.owner, context)) continue;
        if (tab.lifecycle === "handoff") continue;
        if (tab.lifecycle === "deliverable" || tab.origin === "user") ctx.releaseToUser(tab);
      }
      // guest WebContents 在 CDP 仍 attached 时被销毁（destroyed 直达，
      // 触发路径不可枚举：React 卸载 webview / 系统行为均可达）会让 DevToolsSession 隐式析构后在途
      // 通知 UAF 掉主进程。turn 结束即 agent 不再操作，此刻主动 detach 把 CDP 暴露窗口从「tab 整个
      // 生命周期」收窄到「turn 内命令在途」；下次命令经 sendGuestCdpCommand lazy re-attach。
      for (const tab of ctx.tabs.values()) {
        if (!sameScope(tab.owner, context)) continue;
        ctx.releaseGuestCdpAfterIdle(tab, "turn ended");
      }
    },

    closeSession(context: InternalExecutionContext): void {
      ctx.abortRecordings((entry) => sameScope(entry.context, context), "session closed");
      for (const request of ctx.runningRequests.values()) {
        if (sameScope(request.context, context)) {
          request.controller.abort(new DOMException("session closed", "AbortError"));
        }
      }
      for (const tab of ctx.tabs.values()) {
        if (!sameScope(tab.owner, context)) continue;
        // session 是控制权边界，不是可见 tab 的生命边界。view 继续保留，但释放后仍绑定
        // 原 session；不能再写成全局 unclaimed，否则其它对话会通过 user.openTabs() 看到并接管。
        ctx.releaseToUser(tab);
        // 同 endTurn：会话结束释放 CDP，消除 guest 后续任意销毁路径上的主进程 UAF 窗口。
        ctx.releaseGuestCdpAfterIdle(tab, "session closed");
      }
      ctx.activeTabByScope.delete(scopeKey(context));
      ctx.defaultTabByScope.delete(scopeKey(context));
      ctx.sessionNames.delete(scopeKey(context));
      ctx.visibilityByScope.delete(scopeKey(context));
    },

    /**
     * `closeSession({ closeTabs: true })`：真正关闭该 session 名下的全部 tab。按 session 归属而非完整
     * browser scope 匹配——finalize / deliverable 已释放回该 session 的 tab 换到了 `unclaimed-iab` scope，
     * 仍归它。只给永不回来认领的 session 用（dwf 子代理，
     * docs/browser-use/2026-07-14-browser-tab-conversation-isolation-spec.md §2.3）：它的 sessionId 不是任何
     * 对话，closeSession 保留的 view 无人可见、无人可认领，只会一直挂着 guest。
     */
    async closeSessionTabs(context: InternalExecutionContext): Promise<void> {
      const owned = [...ctx.tabs.values()].filter(
        (tab) => tab.lifecycle !== "closed" && ownedBySession(tab.owner, context),
      );
      for (const tab of owned) await ctx.closeTabDurably(tab);
    },

    closeWindow(windowId: number): void {
      ctx.abortRecordings((entry) => entry.context.windowId === windowId, "window closed");
      for (const request of ctx.runningRequests.values()) {
        if (request.context.windowId === windowId) {
          request.controller.abort(new DOMException("window closed", "AbortError"));
        }
      }
      for (const tab of ctx.tabs.values()) {
        if (tab.owner.windowId !== windowId) continue;
        ctx.detachAndCloseGuest(tab);
        ctx.residencyCoordinator.remove(tab.tabId);
        ctx.restoredTabClaims.delete(tab.tabId);
        // closeWindow 走快速路径不经过 closeTab；per-tab 截图状态若不在此清理，
        // 迟到 settle 的回调会按 tabId 污染恢复流程可能复用的新 tab 计数。decrement 对
        // 已删除的 key 是 no-op，前提是条目先在这里删干净。
        ctx.inFlightScreenshots.delete(tab.tabId);
        ctx.abandonedScreenshotCaptures.delete(tab.tabId);
        ctx.tabs.delete(tab.tabId);
      }
      ctx.naturalViewportByWindow.delete(windowId);
    },

    async removeTabRecovery(tab: ManagedTab): Promise<void> {
      await ctx.residencyOptions.recoveryStore?.remove(tab.tabId);
    },

    async closeTabDurably(tab: ManagedTab, notifyRenderer = true): Promise<void> {
      if (tab.lifecycle === "closed") return;
      // 旧 close 先回命令/通知 renderer，再 fire-and-forget 删除恢复仓库；紧接着退出时
      // 已关闭 tab 会从旧 shell 复活。先完成持久删除，失败时保留当前 logical tab 供调用方重试。
      await ctx.removeTabRecovery(tab);
      ctx.closeTab(tab, notifyRenderer);
    },

    closeTab(tab: ManagedTab, notifyRenderer = true): void {
      if (tab.lifecycle === "closed") return;
      ctx.abortRecordings((entry) => entry.tabId === tab.tabId, "tab closed");
      tab.lifecycle = "closed";
      ctx.closedTabIds.add(tab.tabId);
      // tab 已不可再执行命令；不必为一个可能永久不回包的旧 CDP capture 保留 manager 引用。
      ctx.inFlightScreenshots.delete(tab.tabId);
      ctx.abandonedScreenshotCaptures.delete(tab.tabId);
      ctx.resolveWaiters(tab.tabId, null);
      ctx.detachAndCloseGuest(tab);
      for (const [downloadId, record] of ctx.downloads) {
        if (record.tabId === tab.tabId) ctx.downloads.delete(downloadId);
      }
      ctx.queuedDownloads.delete(tab.tabId);
      let waiter = ctx.downloadWaiters.get(tab.tabId)?.[0];
      while (waiter) {
        ctx.finishDownloadWaiter(tab.tabId, waiter, null);
        waiter = ctx.downloadWaiters.get(tab.tabId)?.[0];
      }
      const key = scopeKey(tab.owner);
      if (ctx.activeTabByScope.get(key) === tab.tabId) ctx.activeTabByScope.delete(key);
      if (ctx.defaultTabByScope.get(key) === tab.tabId) ctx.defaultTabByScope.delete(key);
      if (notifyRenderer) ctx.onCloseTabRequested?.(tab.tabId, tab.owner);
      ctx.residencyCoordinator.remove(tab.tabId);
      ctx.restoredTabClaims.delete(tab.tabId);
      ctx.tabs.delete(tab.tabId);
    },

    detachAndCloseGuest(tab: ManagedTab): void {
      const guest = tab.guest;
      // 先 close 会让 destroyed 事件与后续 listener cleanup 都落在已销毁对象上，
      // Electron 会持续打印 "Object has been destroyed"。先拆 CDP/session/listener，再关闭保存的
      // WebContents 引用，既释放真实 renderer，也不会改变 logical tab 的生命周期。
      ctx.detachGuest(tab);
      ctx.closeGuestWebContents(tab, guest);
    },

    rejectGuestAttach(
      tab: ManagedTab,
      guest: GuestWebContents,
      reason: BrowserGuestAttachRejectReason,
    ): BrowserGuestAttachResult {
      // scope/session 不匹配过去只 return，renderer 不知道拒绝原因，waitForGuest
      // 只能等满 timeout；同时被拒绝的 incoming guest 没有统一清理，可能留下 orphan WebContents。
      const recoveryRequested = ctx.requestGuestRebind(tab, reason);
      if (tab.guest !== guest) ctx.closeGuestWebContents(tab, guest);
      return { ok: false, reason, recoveryRequested };
    },

    requestGuestRebind(tab: ManagedTab, reason: GuestRecoveryReason): boolean {
      tab.attachFailure = reason;
      if (tab.lifecycle === "closed" || tab.rebindRequested || !ctx.onOpenTabRequested)
        return false;
      tab.rebindRequested = true;
      ctx.log?.(`[browser-use] request guest rebind tabId=${tab.tabId} reason=${reason}`);
      ctx.onOpenTabRequested?.(tab.tabId, tab.owner);
      return true;
    },

    closeGuestWebContents(tab: ManagedTab, guest = tab.guest): void {
      if (!guest || safeBool(() => guest.isDestroyed(), true)) return;
      try {
        guest.close({ waitForBeforeUnload: false });
      } catch (error) {
        ctx.warn(`browser guest close failed tabId=${tab.tabId}`, error);
      }
    },

    now(): number {
      return ctx.residencyOptions.now?.() ?? Date.now();
    },

    warn(message: string, error?: unknown): void {
      const suffix =
        error === undefined
          ? ""
          : ` error=${error instanceof Error ? error.message : String(error)}`;
      ctx.residencyOptions.warn?.(`${message}${suffix}`);
      ctx.log?.(`[browser-use] ${message}${suffix}`);
    },

    detach(key: string): void {
      const tab = ctx.tabs.get(key);
      if (tab) ctx.detachGuest(tab);
    },

    hasGuest(key: string): boolean {
      const tab = ctx.tabs.get(key);
      return Boolean(tab?.guest && tab.lifecycle !== "closed");
    },

    disposeAll(): void {
      for (const request of ctx.runningRequests.values()) {
        request.controller.abort(new DOMException("browser manager disposed", "AbortError"));
      }
      for (const tab of ctx.tabs.values()) ctx.closeTab(tab, false);
      for (const key of ctx.waiters.keys()) ctx.resolveWaiters(key, null);
      ctx.tabs.clear();
      ctx.closedTabIds.clear();
      ctx.activeTabByScope.clear();
      ctx.defaultTabByScope.clear();
      ctx.sessionNames.clear();
      ctx.naturalViewportByWindow.clear();
      for (const [tabId, waiters] of ctx.downloadWaiters) {
        let waiter = waiters[0];
        while (waiter) {
          ctx.finishDownloadWaiter(tabId, waiter, null);
          waiter = waiters[0];
        }
      }
      ctx.downloads.clear();
      ctx.queuedDownloads.clear();
      ctx.inFlightScreenshots.clear();
      ctx.abandonedScreenshotCaptures.clear();
      for (const entry of ctx.recordings.values()) {
        entry.controller.abort(new DOMException("browser manager disposed", "AbortError"));
        if (entry.cleanupTimer) clearTimeout(entry.cleanupTimer);
        if (entry.artifact?.path)
          void rm(entry.artifact.path, { force: true }).catch(() => undefined);
      }
      ctx.recordings.clear();
      ctx.residencyCoordinator.dispose();
      ctx.restoredTabClaims.clear();
      for (const resolve of ctx.suspendAckWaiters.values()) resolve();
      ctx.suspendAckWaiters.clear();
      ctx.suspendFlights.clear();
      ctx.restoreFlights.clear();
      ctx.guestRecoveryFlights.clear();
      ctx.guestAttachFlights.clear();
    },
  };
}
