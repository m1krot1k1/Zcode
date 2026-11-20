/**
 * ui-voice-dictation 对外契约。
 *
 * 唯一 owner：`voiceDictationController` 持有当前录音会话、模型选择与 Lexical
 * 插入范围。Composer 只渲染 `VoiceDictationButton`/`VoiceDictationOverlay`，
 * 通过 `useVoiceDictation()` 发命令并读取投影；不得再建第二份录音或草稿状态。
 */
export type { VoiceDictationApi, VoiceDictationState, VoiceDictationStatus } from "./index.js";
