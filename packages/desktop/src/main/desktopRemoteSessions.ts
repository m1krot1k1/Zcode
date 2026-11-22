// 公开入口保持不变：实现拆分到 desktop-remote-sessions/，外部 API 与调用顺序不变。
export { createRemoteWorkspaceSessionManager } from "./desktop-remote-sessions/index.js";
