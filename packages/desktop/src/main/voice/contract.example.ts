/**
 * desktop-voice-dictation 标准调用示例：agent 靠模仿写代码，这里放的就是该模仿的那份。
 */
import type { HexVoiceService } from "./contract.js";

export async function exampleDesktopVoiceDictation(service: HexVoiceService): Promise<void> {
  const status = await service.getStatus();
  if (!status.available) return;
  await service.listModels("ru");
}
