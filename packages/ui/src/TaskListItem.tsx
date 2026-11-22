// 任务行实现拆分到 task-list-item/ 子目录：默认列表行与 timeline 行共享同一套
// memo 比较键、交互 hook 与行内节点，避免单文件继续堆叠两套布局后越过 max-lines。
// 此文件保留原有公开入口，调用方与测试继续从 @/TaskListItem.js 导入。
export { shouldShowRemoteConnectionOverlay } from "@/task-list-item/connectionOverlay.js";
export { MemoTaskItem } from "@/task-list-item/TaskListItem.js";
export { TaskListItemContextMenuContent } from "@/task-list-item/TaskListItemContextMenuContent.js";
