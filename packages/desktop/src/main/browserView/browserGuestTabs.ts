import type { BrowserGuestContext } from "./browserGuestContext.js";
import { randomUUID } from "node:crypto";
import type {
  BrowserTabSummary,
  BrowserViewportSize,
  BrowserUserTabInfo,
  BrowserCommandResult,
  BrowserResponseMeta,
  BrowserViewCloseTabRequest,
  BrowserViewResidencyReportPayload,
} from "@zcode/shared";
import { DEFAULT_AGENT_BROWSER_VIEWPORT } from "@zcode/shared";
import type {
  BrowserTabPageStateRecord,
  BrowserTabShellRecord,
} from "./browserTabRecoveryStore.js";
import type {
  InternalExecutionContext,
  ManagedTab,
  GuestWebContents,
  RunningRequest,
  PendingWaiter,
} from "./browserGuestTypes.js";
import {
  DEFAULT_BACKGROUND_BROWSER_VIEWPORT,
  TAB_CONTEXT_RECOVERY_HINT,
} from "./browserGuestTypes.js";
import {
  sameScope,
  scopeKey,
  waitForPromiseWithSignal,
  safeBool,
  ownedBySession,
  safeStr,
  isBrowserViewportSize,
  normalizeBackgroundViewport,
  sanitizeBrowserMetaUrl,
} from "./browserGuestUtils.js";

export function createBrowserGuestTabs(
  ctx: BrowserGuestContext,
): Pick<
  BrowserGuestContext,
  | "resolveTab"
  | "createTab"
  | "ensureGuest"
  | "waitForGuestRecovery"
  | "runGuestAttachFlight"
  | "ownedTabs"
  | "canClaimUserTab"
  | "openUserTabs"
  | "hasDiscoverableUserPage"
  | "claimTab"
  | "selectTab"
  | "releaseToUser"
  | "finalizeTabs"
  | "effectiveActiveTabId"
  | "summary"
  | "readTabViewport"
  | "userTabInfo"
  | "withMeta"
  | "cancelledOrUnavailable"
  | "unavailableTabResult"
  | "cancelledResult"
  | "abortRequest"
  | "requireRendererOwnedTab"
  | "persistShell"
  | "persistRecoverySnapshot"
  | "waitForGuest"
  | "removeWaiter"
  | "resolveWaiters"
> {
  return {
    resolveTab(context: InternalExecutionContext, explicitTabId?: string): ManagedTab | undefined {
      if (explicitTabId) {
        const explicit = ctx.tabs.get(explicitTabId);
        if (!explicit || explicit.lifecycle === "closed" || !sameScope(explicit.owner, context)) {
          return undefined;
        }
        return explicit;
      }
      const key = scopeKey(context);
      const activeId = ctx.activeTabByScope.get(key);
      const active = activeId ? ctx.tabs.get(activeId) : undefined;
      if (active && active.lifecycle !== "closed" && sameScope(active.owner, context))
        return active;
      const defaultId = ctx.defaultTabByScope.get(key);
      const existingDefault = defaultId ? ctx.tabs.get(defaultId) : undefined;
      if (
        existingDefault &&
        existingDefault.lifecycle !== "closed" &&
        sameScope(existingDefault.owner, context)
      ) {
        return existingDefault;
      }
      // 后台会话（renderer 只上报 active:false）且 tab 由显式 newTab 创建时，activeTabByScope 与
      // defaultTabByScope 都是空的。这里必须复用该 scope 最近存活的 tab，否则不带 tabId 的命令会
      // 凭空再开一个空 tab，也会让 tabs.list() 报的 active 与实际落点不一致。
      const recent = ctx.ownedTabs(context).at(-1);
      if (recent) return recent;
      return ctx.createTab(context, context.legacy ? context.sessionId : undefined, true);
    },

    createTab(
      context: InternalExecutionContext,
      preferredTabId?: string,
      makeDefault = false,
    ): ManagedTab {
      const tabId = preferredTabId ?? `iab-tab:${randomUUID()}`;
      const existing = ctx.tabs.get(tabId);
      if (existing && existing.lifecycle !== "closed" && sameScope(existing.owner, context)) {
        return existing;
      }
      const tab: ManagedTab = {
        tabId,
        owner: { ...context },
        cdpAttached: false,
        guestLifecycle: "detached",
        pendingCdpCommands: 0,
        guestGeneration: 0,
        hasAttachedGuest: false,
        rebindRequested: false,
        lifecycle: "active",
        origin: "agent",
        claimable: false,
        active: false,
        loading: false,
        mediaActive: false,
        cachedUrl: "",
        cachedTitle: "",
        cachedFaviconUrl: null,
        openedAt: ctx.now(),
        // 模型创建路径（显式 newTab 与无 tab 时的隐式创建）默认使用桌面自由尺寸。
        // viewport 属于 tab 创建事实；claim、activate、navigate 只复用已有 tab，不能再次套默认值。
        viewportOverride: { ...DEFAULT_AGENT_BROWSER_VIEWPORT },
      };
      ctx.tabs.set(tabId, tab);
      ctx.registerTabResidency(tab, false);
      void ctx.persistShell(tab);
      if (makeDefault) ctx.defaultTabByScope.set(scopeKey(context), tabId);
      return tab;
    },

    async ensureGuest(tab: ManagedTab, signal: AbortSignal): Promise<GuestWebContents | null> {
      if (signal.aborted) return null;
      const suspendFlight = ctx.suspendFlights.get(tab.tabId);
      if (suspendFlight) {
        // 保护状态只能取消 coordinator generation，不能立刻证明 renderer 未卸载。
        // Browser command 必须等待 snapshot/ack/必要恢复收敛，不能复用即将销毁的旧 guest。
        const settled = await waitForPromiseWithSignal(suspendFlight, signal);
        if (!settled.completed) return null;
      }
      const residency = ctx.residencyCoordinator.get(tab.tabId);
      if (residency?.residency === "suspended" || residency?.residency === "restoring") {
        return await ctx.restoreSuspendedGuest(tab, signal);
      }
      if (tab.guest && !safeBool(() => tab.guest!.isDestroyed(), true)) {
        return await ctx.waitForGuestRecovery(tab, tab.guest, signal);
      }
      if (tab.guest) {
        ctx.detachGuest(tab);
      }

      const existingFlight = ctx.guestAttachFlights.get(tab.tabId);
      let flight = existingFlight;
      if (!flight) {
        flight = ctx.runGuestAttachFlight(tab);
        ctx.guestAttachFlights.set(tab.tabId, flight);
        const clearFlight = () => {
          if (ctx.guestAttachFlights.get(tab.tabId) === flight) {
            ctx.guestAttachFlights.delete(tab.tabId);
          }
        };
        void flight.then(clearFlight, clearFlight);
      }
      const settled = await waitForPromiseWithSignal(flight, signal);
      if (!settled.completed || !settled.value) return null;
      return await ctx.waitForGuestRecovery(tab, settled.value, signal);
    },

    async waitForGuestRecovery(
      tab: ManagedTab,
      guest: GuestWebContents,
      signal: AbortSignal,
    ): Promise<GuestWebContents | null> {
      const flight = ctx.guestRecoveryFlights.get(tab.tabId);
      if (!flight) return guest;
      const settled = await waitForPromiseWithSignal(flight, signal);
      return settled.completed && settled.value === guest ? guest : null;
    },

    async runGuestAttachFlight(tab: ManagedTab): Promise<GuestWebContents | null> {
      // 新 tab 的首次 ready 仍只等待一次；已有 guest 或已明确收到拒绝时允许一次有界重放。
      for (let attempt = 0; attempt < 2; attempt += 1) {
        if (tab.lifecycle === "closed") return null;
        // create/ready 是可重放状态；事件丢失或 guest 崩溃后发起一次有界重放。
        // 如果 destroyed/mismatch 已经发起过重绑，沿用该请求，避免同一 tab 重复创建 webview。
        if (!tab.rebindRequested) ctx.onOpenTabRequested?.(tab.tabId, tab.owner);
        // 某些测试/旧 renderer 会在 Ready 回调内同步 attach；不能在 attach 已成功后再注册 waiter。
        // Bug 原因：guest 是可变字段，进入回调后 TypeScript 会撤销属性收窄；固定本轮引用，
        // 同时保证销毁检查与返回的是同一个 guest。
        const attachedGuest = tab.guest;
        if (attachedGuest && !safeBool(() => attachedGuest.isDestroyed(), true)) {
          return attachedGuest;
        }
        const guest = await ctx.waitForGuest(tab.tabId);
        if (guest && !safeBool(() => guest.isDestroyed(), true)) return guest;
        if (attempt === 0 && !tab.hasAttachedGuest && !tab.attachFailure) return null;
        if (attempt === 1) return null;
        ctx.requestGuestRebind(tab, tab.attachFailure ?? "attach-timeout");
      }
      return null;
    },

    ownedTabs(context: InternalExecutionContext): ManagedTab[] {
      return [...ctx.tabs.values()].filter(
        (tab) => tab.lifecycle !== "closed" && sameScope(tab.owner, context),
      );
    },

    canClaimUserTab(tab: ManagedTab, context: InternalExecutionContext): boolean {
      return (
        tab.origin === "user" &&
        tab.claimable &&
        tab.lifecycle !== "closed" &&
        ownedBySession(tab.owner, context)
      );
    },

    openUserTabs(context: InternalExecutionContext): ManagedTab[] {
      return [...ctx.tabs.values()]
        .filter((tab) => ctx.canClaimUserTab(tab, context) && ctx.hasDiscoverableUserPage(tab))
        .sort((left, right) => Number(right.active) - Number(left.active));
    },

    hasDiscoverableUserPage(tab: ManagedTab): boolean {
      const url = tab.guest
        ? safeStr(() => tab.guest!.getURL(), tab.cachedUrl).trim()
        : tab.cachedUrl.trim();
      // 已 mount 的 human webview 在首次导航前会以 about:blank/空 URL ready。
      // 这只是 UI 占位态，不是可供 agent 认领的用户页面；受控 tabs.list() 不受此过滤影响。
      return url.length > 0 && url !== "about:blank";
    },

    claimTab(tab: ManagedTab, context: InternalExecutionContext): ManagedTab {
      if (!ctx.canClaimUserTab(tab, context)) return tab;
      tab.owner = { ...context };
      tab.claimable = false;
      // claim 只接管所有权，不改激活态；未激活的
      // human tab webview 不产帧，被 claim 后截图的 prepare 握手 3s 超时（renderer ready
      // 永不到来）。claim 即激活：与 activateTab 相同的 selectTab(tab, true) 语义——前台
      // scope 展开对应 view，后台 scope 只记录激活态，不抢用户当前会话焦点。
      ctx.selectTab(tab, true);
      ctx.log?.(
        `[browser-use] claim human tab tabId=${tab.tabId} windowId=${context.windowId} sessionId=${context.sessionId}`,
      );
      return tab;
    },

    selectTab(tab: ManagedTab, notifyRenderer: boolean): void {
      const key = scopeKey(tab.owner);
      // 同一 browser scope 最多只能有一个 active tab；旧 attach 路径只把新 tab 设为 active，
      // 没有清掉旧 tab.active，导致 tabs.list() 可能同时返回多个 active=true。
      for (const candidate of ctx.tabs.values()) {
        if (!sameScope(candidate.owner, tab.owner)) continue;
        candidate.active = candidate.tabId === tab.tabId;
        ctx.residencyCoordinator.report(candidate.tabId, {
          selected: candidate.tabId === tab.tabId,
        });
      }
      ctx.activeTabByScope.set(key, tab.tabId);
      if (!notifyRenderer) return;
      ctx.visibilityByScope.set(key, true);
      ctx.onVisibilityChanged?.(true, tab.owner, tab.tabId);
      // activateTab / claim 都以 selectTab(tab, true) 收口；attach 路径走 notifyRenderer=false
      // 且已自行调用恢复，不会重复。
      ctx.maybeRestoreBackgroundViewport(tab);
    },

    releaseToUser(tab: ManagedTab): void {
      if (tab.claimable) return;
      if (!tab.userOwner) {
        tab.userOwner = {
          ...tab.owner,
          requestId: `unclaimed:${randomUUID()}`,
          // 释放后必须脱离原 controlled browser scope，否则同 session 的 tabs.list() 仍会把
          // user tab 当作受控 tab；sessionId/workspaceKey 保留，供 owner session 显式重新 claim。
          browserId: "unclaimed-iab",
          browserGeneration: 0,
          turnId: undefined,
        };
      }
      const claimedScope = scopeKey(tab.owner);
      if (ctx.activeTabByScope.get(claimedScope) === tab.tabId) {
        ctx.activeTabByScope.delete(claimedScope);
      }
      if (ctx.defaultTabByScope.get(claimedScope) === tab.tabId) {
        ctx.defaultTabByScope.delete(claimedScope);
      }
      tab.owner = { ...tab.userOwner };
      tab.origin = "user";
      tab.claimable = true;
      tab.lifecycle = "active";
    },

    finalizeTabs(
      context: InternalExecutionContext,
      keep: Map<string, "handoff" | "deliverable">,
    ): void {
      // 产品语义：IAB tab 在当前 ZCode 进程内默认持久。keep 是状态标记集合，不是清理白名单；
      // 遗漏的 tab 不能当成临时页关闭：模型未显式 close 时用户页面会在 turn end 消失。
      for (const tab of ctx.tabs.values()) {
        if (!sameScope(tab.owner, context)) continue;
        const status = keep.get(tab.tabId);
        if (status === "handoff") tab.lifecycle = status;
        else if (status === "deliverable") {
          tab.lifecycle = status;
          ctx.releaseToUser(tab);
        }
      }
    },

    /**
     * tabs.list() 里 active 的唯一判定。语义是「不带 tabId 的命令会落到哪个 tab」，与 resolveTab
     * 对齐，而不是「UI 当前是否可见」——可见性有独立的 browserVisibilitySet/Get 通道。
     *
     * 必须带回退：会话在后台跑时 renderer 的 isVisible 恒为 false，只会上报
     * attachGuest({active:false})，scope 内没有任何 tab 自报 active，activeTabByScope 也是空的。
     * CLI 的 turn-end 自动截图用 tabs.find(t => t.active === true) 寻址且没有回退，于是静默跳过，
     * 用户侧表现为后台会话结束时没有截图。回退到该 scope 最近存活的 tab（与 browserVisibilitySet
     * 和 CLI 侧 tabs.selected() 的 at(-1) 回退一致）后，list 报的 active 与命令落点重新一致。
     */
    effectiveActiveTabId(owner: InternalExecutionContext): string | undefined {
      const key = scopeKey(owner);
      const activeId = ctx.activeTabByScope.get(key);
      const activeTab = activeId ? ctx.tabs.get(activeId) : undefined;
      if (activeTab && activeTab.lifecycle !== "closed") return activeId;
      // human tab 在 claim 前只置 tab.active、不进 activeTabByScope；这种自报 active 优先于回退，
      // 且一旦命中就不再往下走，保证同 scope 只有一个 active=true。
      for (const tab of ctx.tabs.values()) {
        if (tab.active && tab.lifecycle !== "closed" && sameScope(tab.owner, owner))
          return tab.tabId;
      }
      return ctx.ownedTabs(owner).at(-1)?.tabId;
    },

    async summary(tab: ManagedTab): Promise<BrowserTabSummary> {
      // guest 重绑恢复尚未完成时，替代 guest 仍可能报告 about:blank；各状态读取点
      // 都必须保留 logical cache，不能让临时 guest URL 覆盖后续恢复事实。
      if (tab.guest && !ctx.guestRecoveryFlights.has(tab.tabId)) {
        tab.cachedUrl = safeStr(() => tab.guest!.getURL(), tab.cachedUrl);
        tab.cachedTitle = safeStr(() => tab.guest!.getTitle(), tab.cachedTitle);
      }
      return {
        tabId: tab.tabId,
        url: tab.cachedUrl,
        title: tab.cachedTitle,
        viewport: await ctx.readTabViewport(tab),
        ...(ctx.effectiveActiveTabId(tab.owner) === tab.tabId ? { active: true } : {}),
        ...(tab.lifecycle === "deliverable" || tab.lifecycle === "handoff"
          ? { lifecycle: tab.lifecycle }
          : {}),
      };
    },

    async readTabViewport(tab: ManagedTab): Promise<BrowserViewportSize> {
      if (tab.viewportOverride) return { ...tab.viewportOverride };
      if (tab.backgroundViewportFallback) {
        // 前台 tab 不应停留在外台 fallback 尺寸：readTabViewport 的「fallback 存在即短路」
        // 会让残留自我强化（页面钉死在后台尺寸，窗口 resize/全屏
        // 都不跟随）。即使两个前台信号（selectTab / reportResidency）都丢失，前台 tab 的
        // 下一次 viewport 读取也必须自愈；本次仍返回 fallback，恢复在 mutation 队列中随后完成。
        if (tab.active) {
          ctx.maybeRestoreBackgroundViewport(tab);
        }
        return { ...tab.backgroundViewportFallback };
      }
      if (!tab.guest || safeBool(() => tab.guest!.isDestroyed(), true)) {
        return { ...DEFAULT_BACKGROUND_BROWSER_VIEWPORT };
      }
      const value = await tab.guest.executeJavaScript(
        "({ width: window.innerWidth, height: window.innerHeight })",
      );
      if (isBrowserViewportSize(value)) {
        ctx.naturalViewportByWindow.set(tab.owner.windowId, { ...value });
        return value;
      }

      // 后台 session 的 Browser pane 会保留 guest 但通过 display:none 隐藏，首次
      // tabs.new() 仍能 dom-ready/attach，却只得到 0×0 viewport。隐藏是展示状态，不能阻断
      // 后台 Browser 执行；临时复用同窗口最近自然尺寸，重新前台后再清除 CDP override。
      const fallback = normalizeBackgroundViewport(
        ctx.naturalViewportByWindow.get(tab.owner.windowId) ?? DEFAULT_BACKGROUND_BROWSER_VIEWPORT,
      );
      await ctx.applyBackgroundViewportFallback(tab, fallback);
      ctx.log?.(
        `[browser-use] applied background viewport fallback tabId=${tab.tabId} width=${fallback.width} height=${fallback.height}`,
      );
      return { ...fallback };
    },

    userTabInfo(tab: ManagedTab): BrowserUserTabInfo {
      if (tab.guest && !ctx.guestRecoveryFlights.has(tab.tabId)) {
        tab.cachedUrl = safeStr(() => tab.guest!.getURL(), tab.cachedUrl);
        tab.cachedTitle = safeStr(() => tab.guest!.getTitle(), tab.cachedTitle);
      }
      return {
        id: tab.tabId,
        ...(tab.cachedUrl ? { url: tab.cachedUrl } : {}),
        ...(tab.cachedTitle ? { title: tab.cachedTitle } : {}),
      };
    },

    withMeta(
      result: BrowserCommandResult,
      context: InternalExecutionContext,
      tab?: ManagedTab,
      lifecycleOverride?: BrowserResponseMeta["lifecycle"],
    ): BrowserCommandResult {
      const openTabs = ctx.ownedTabs(context);
      const currentUrl = tab
        ? sanitizeBrowserMetaUrl(
            tab.guest ? safeStr(() => tab.guest!.getURL(), tab.cachedUrl) : tab.cachedUrl,
          )
        : undefined;
      const meta: BrowserResponseMeta = {
        browserUse: true,
        backendType: "iab",
        browserId: context.browserId,
        browserGeneration: context.browserGeneration,
        openTabIds: openTabs.map((candidate) => candidate.tabId),
        ...(tab ? { tabId: tab.tabId } : {}),
        ...(currentUrl ? { currentUrl } : {}),
        ...(lifecycleOverride
          ? { lifecycle: lifecycleOverride }
          : tab
            ? { lifecycle: tab.lifecycle }
            : {}),
      };
      return { ...result, meta };
    },

    cancelledOrUnavailable(
      context: InternalExecutionContext,
      running: RunningRequest,
      startedAt: number,
      tab: ManagedTab,
    ): BrowserCommandResult {
      if (running.controller.signal.aborted) {
        return ctx.withMeta(
          ctx.cancelledResult(context, running.dispatched, startedAt),
          context,
          tab,
        );
      }
      return ctx.withMeta(
        {
          ok: false,
          error: {
            code: "backend_unavailable",
            message: "browser guest not attached (webview not ready)",
          },
          elapsedMs: Date.now() - startedAt,
        },
        context,
        tab,
      );
    },

    unavailableTabResult(
      context: InternalExecutionContext,
      tabId: string | undefined,
      startedAt: number,
    ): BrowserCommandResult {
      return ctx.withMeta(
        {
          ok: false,
          error: {
            code: "backend_unavailable",
            message: tabId
              ? `browser tab '${tabId}' is not visible in the current context. ${TAB_CONTEXT_RECOVERY_HINT}`
              : "browser tab is unavailable",
          },
          elapsedMs: Date.now() - startedAt,
        },
        context,
      );
    },

    cancelledResult(
      _context: InternalExecutionContext,
      dispatched: boolean,
      startedAt: number,
    ): BrowserCommandResult {
      return {
        ok: false,
        error: {
          code: "cancelled",
          message: dispatched
            ? "browser request cancelled after backend dispatch; side effects may have occurred"
            : "browser request cancelled before backend dispatch",
          sideEffect: dispatched ? "uncertain" : "none",
        },
        elapsedMs: Date.now() - startedAt,
      };
    },

    abortRequest(requestId: string, context: InternalExecutionContext): boolean {
      const request = ctx.runningRequests.get(requestId);
      // requestId 是 correlation id，不是授权凭证；取消也必须服从完整 IAB scope。
      if (!request || !sameScope(request.context, context)) return false;
      request.controller.abort(new DOMException("aborted", "AbortError"));
      return true;
    },

    async persistRecoverySnapshot(tab: ManagedTab, guest: GuestWebContents): Promise<void> {
      tab.cachedUrl = safeStr(() => guest.getURL(), tab.cachedUrl);
      tab.cachedTitle = safeStr(() => guest.getTitle(), tab.cachedTitle);
      await ctx.persistShell(tab);
      try {
        const entries = guest.navigationHistory.getAllEntries().map((entry) => ({ ...entry }));
        if (entries.length === 0) return;
        const pageState: BrowserTabPageStateRecord = {
          schemaVersion: 1,
          tabId: tab.tabId,
          entries,
          activeIndex: guest.navigationHistory.getActiveIndex(),
          updatedAt: ctx.now(),
        };
        await ctx.residencyOptions.recoveryStore?.upsertPageState(pageState);
      } catch (error) {
        // 快照失败不能让资源预算永久突破；shell 的 restoreUrl 已先保存。
        ctx.warn(`browser tab page-state snapshot failed tabId=${tab.tabId}`, error);
      }
    },

    async persistShell(tab: ManagedTab): Promise<void> {
      const store = ctx.residencyOptions.recoveryStore;
      if (!store || tab.lifecycle === "closed") return;
      const residency = ctx.residencyCoordinator.get(tab.tabId);
      const record: BrowserTabShellRecord = {
        schemaVersion: 1,
        tabId: tab.tabId,
        windowBindingId: null,
        workspaceKey: tab.owner.workspaceKey,
        ...(tab.owner.remoteSessionId ? { remoteSessionId: tab.owner.remoteSessionId } : {}),
        sessionId: tab.owner.sessionId,
        browserId: tab.owner.browserId,
        browserGeneration: tab.owner.browserGeneration,
        origin: tab.origin,
        lifecycle: tab.lifecycle,
        restoreUrl: tab.cachedUrl || null,
        title: tab.cachedTitle || null,
        faviconUrl: tab.cachedFaviconUrl,
        viewport: tab.viewportOverride ? { ...tab.viewportOverride } : null,
        openedAt: tab.openedAt,
        lastSelectedAt: residency?.lastSelectedAt ?? null,
        updatedAt: ctx.now(),
      };
      try {
        await store.upsert(record);
      } catch (error) {
        ctx.warn(`browser tab shell persist failed tabId=${tab.tabId}`, error);
      }
    },

    requireRendererOwnedTab(
      payload:
        | (BrowserViewCloseTabRequest & { windowId: number })
        | (BrowserViewResidencyReportPayload & { windowId: number }),
      options?: { skipRemoteSession?: boolean },
    ): ManagedTab {
      const tab = ctx.tabs.get(payload.tabId);
      if (
        !tab ||
        tab.lifecycle === "closed" ||
        tab.owner.windowId !== payload.windowId ||
        tab.owner.workspaceKey !== payload.workspaceKey ||
        tab.owner.sessionId !== payload.sessionId ||
        (!options?.skipRemoteSession &&
          (tab.owner.remoteSessionId ?? "") !== (payload.remoteSessionId ?? ""))
      ) {
        throw new Error(`browser tab '${payload.tabId}' is unavailable for renderer scope`);
      }
      return tab;
    },

    waitForGuest(tabId: string, signal?: AbortSignal): Promise<GuestWebContents | null> {
      if (signal?.aborted) return Promise.resolve(null);
      return new Promise<GuestWebContents | null>((resolve) => {
        const waiter: PendingWaiter = {
          resolve,
          timer: setTimeout(() => {
            ctx.removeWaiter(tabId, waiter);
            ctx.log?.(`[browser-use] waitForGuest timeout tabId=${tabId}`);
            resolve(null);
          }, ctx.attachTimeoutMs),
          signal,
        };
        waiter.onAbort = () => {
          ctx.removeWaiter(tabId, waiter);
          resolve(null);
        };
        signal?.addEventListener("abort", waiter.onAbort, { once: true });
        const list = ctx.waiters.get(tabId) ?? [];
        list.push(waiter);
        ctx.waiters.set(tabId, list);
      });
    },

    removeWaiter(tabId: string, waiter: PendingWaiter): void {
      clearTimeout(waiter.timer);
      if (waiter.onAbort) waiter.signal?.removeEventListener("abort", waiter.onAbort);
      const list = ctx.waiters.get(tabId);
      if (!list) return;
      const index = list.indexOf(waiter);
      if (index >= 0) list.splice(index, 1);
      if (list.length === 0) ctx.waiters.delete(tabId);
    },

    resolveWaiters(tabId: string, guest: GuestWebContents | null): void {
      const list = ctx.waiters.get(tabId);
      if (!list) return;
      ctx.waiters.delete(tabId);
      for (const waiter of list) {
        clearTimeout(waiter.timer);
        if (waiter.onAbort) waiter.signal?.removeEventListener("abort", waiter.onAbort);
        waiter.resolve(guest);
      }
    },
  };
}
