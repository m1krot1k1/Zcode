// 反馈 HTTP 客户端实现拆分到 ./http-client/：
// - client.ts 负责请求编排、工单调用与上传流程；
// - ticketMapping.ts 负责请求/响应归一化；
// - requestLogging.ts / requestRetry.ts 负责脱敏日志与建连重试；
// - ossUpload.ts 负责 OSS 表单直传；
// - types.ts 维护后端协议与请求选项类型。
// 这里保留原模块路径作为公开 barrel，调用方无需调整导入。
export { FeedbackHttpClient, FeedbackUploadCanceledError } from "./http-client/index.js";
