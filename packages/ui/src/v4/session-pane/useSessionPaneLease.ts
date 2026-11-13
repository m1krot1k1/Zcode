// SessionPane 拆分：pane 与 SessionDataLayer lease 的绑定（原始 binding 留在独立 hook 作用域）。
import { useState } from "react";
import type { SessionLease } from "@/v4/sessionDataLayer.js";

export interface SessionPaneLeaseBinding {
  sessionId: string | null;
  layer: object;
  lease: SessionLease | null;
}

// 原始 binding 留在独立 hook 作用域，不能让 SessionPane 的事件闭包捕获失效 owner。
export function useSessionPaneLease(sessionId: string | null, layer: object) {
  const [binding, setBinding] = useState<SessionPaneLeaseBinding>({
    sessionId,
    layer,
    lease: null,
  });
  if (binding.sessionId !== sessionId || binding.layer !== layer) {
    // Bug 根因：新 session 的首帧若读取旧 lease，稳定回调会捕获旧 snapshot/store，
    // 不同代的共享 render 闭包便会串成保留链。先收紧 owner，再让 acquire effect 接管。
    // 草稿晋升仍复用同一预热 lease；不重挂 Composer，也不提前释放原 effect 的资源。
    const promoted =
      binding.layer === layer &&
      binding.sessionId === null &&
      binding.lease?.sessionId === sessionId;
    const lease = promoted ? binding.lease : null;
    setBinding({ sessionId, layer, lease });
    return [lease, setBinding] as const;
  }
  return [binding.lease, setBinding] as const;
}
