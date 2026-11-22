// v4 竖切（protocol-v4）conversation e2e helper 的公共入口。
// 与旧 conversation-session.ts 的区别：所有定位走 TID_V4_* 常量（testid contract v2，
// 带 paneId 维度），状态断言读 v4 pane 的 data-* 投影属性，不再依赖旧 ChatView DOM。
// 旧 helper 的登录/工作区/provider 部分继续复用（desktop-app.ts / upstream-provider.ts）。
//
// 实现按关注点拆到 v4-conversation/ 子目录（pane/composer/queue/timeline/split/权限等），
// 本文件只维护稳定的导出面：spec 继续从 "./helpers/v4-conversation.js" 导入。
export * from "./v4-conversation/background.js";
export * from "./v4-conversation/composer.js";
export * from "./v4-conversation/composer-content.js";
export * from "./v4-conversation/composer-model.js";
export * from "./v4-conversation/constants.js";
export * from "./v4-conversation/pane.js";
export * from "./v4-conversation/permission.js";
export * from "./v4-conversation/prepare.js";
export * from "./v4-conversation/queue.js";
export * from "./v4-conversation/row-actions.js";
export * from "./v4-conversation/session.js";
export * from "./v4-conversation/split.js";
export * from "./v4-conversation/timeline.js";
export * from "./v4-conversation/turn-navigator.js";
export * from "./v4-conversation/types.js";
