// 实现已拆分到 elicitation-dialog/：表单状态与回答编排在 useElicitationDialogController，
// 纯函数与倒计时在独立模块，视图拆成 header/option list/footer。此文件保留原有公开入口，
// 调用方与测试继续从 @/ElicitationDialog.js 导入同一组 API。
export { ElicitationDialog } from "./elicitation-dialog/ElicitationDialog.js";
export {
  buildElicitationResponseContent,
  createInitialElicitationDrafts,
  getElicitationQuestionAdvanceKind,
  normalizeElicitationQuestions,
  updateElicitationDraftsForOption,
} from "./elicitation-dialog/answers.js";
export { getElicitationCountdownSeconds } from "./elicitation-dialog/countdown.js";
export { resolveElicitationCustomInputKeyAction } from "./elicitation-dialog/customInputKeyAction.js";
