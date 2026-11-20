/**
 * shared-voice-dictation 标准调用示例：agent 靠模仿写代码，这里放的就是该模仿的那份。
 */
import type { VoiceDictationPort } from "./contract.js";

export async function exampleSharedVoiceDictation(port: VoiceDictationPort): Promise<void> {
  const models = await port.listModels("ru");
  const installed = models.find((model) => model.installed);
  if (!installed) return;
  await port.start({ model: installed.id, language: "ru" });
  await port.stop();
}
