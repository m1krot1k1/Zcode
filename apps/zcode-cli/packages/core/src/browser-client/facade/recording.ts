import type {
  BrowserCommand,
  BrowserCommandResult,
  BrowserRecordingJob,
  BrowserRecordingOptions,
} from "@zcode/contracts/browser-control";
import { expectPayload } from "../result.js";

export class BrowserRecordingAPI {
  constructor(private readonly run: (command: BrowserCommand) => Promise<BrowserCommandResult>) {}

  async start(options: BrowserRecordingOptions = {}): Promise<BrowserRecordingJob> {
    const command: BrowserCommand = { method: "recordingStart", options };
    const result = await this.run(command);
    return expectPayload(command, result, result.recording, "recording");
  }

  async status(
    recordingId: string,
    options: { outputPath?: string } = {},
  ): Promise<BrowserRecordingJob> {
    if (!recordingId) throw new TypeError("recording.status requires a recording id");
    const command: BrowserCommand = {
      method: "recordingStatus",
      recordingId,
      ...options,
    };
    const result = await this.run(command);
    return expectPayload(command, result, result.recording, "recording");
  }

  async cancel(recordingId: string): Promise<BrowserRecordingJob> {
    if (!recordingId) throw new TypeError("recording.cancel requires a recording id");
    const command: BrowserCommand = { method: "recordingCancel", recordingId };
    const result = await this.run(command);
    return expectPayload(command, result, result.recording, "recording");
  }
}
