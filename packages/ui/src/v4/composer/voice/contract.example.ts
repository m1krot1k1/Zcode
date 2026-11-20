/**
 * ui-voice-dictation 标准调用示例：agent 靠模仿写代码，这里放的就是该模仿的那份。
 */
import type { VoiceDictationApi } from "./contract.js";

export function exampleUiVoiceDictation(api: VoiceDictationApi): void {
  void api.start();
  api.setSettingsOpen(true);
}
