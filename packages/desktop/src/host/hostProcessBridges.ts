import type { IRemoteBackend } from "@zcode/server/remote";
import { createBrowserControlMainBridge } from "./browserControlMainBridge.js";
import { materializeBrowserRecordingArtifact } from "./browserRecordingArtifactMaterializer.js";
import { createHostNetworkCapture } from "./hostNetworkCapture.js";
import { remoteRegistry } from "./hostState.js";
import { createPluginSandboxRegistrationBridge } from "./pluginSandbox/index.js";

const { parentPort } = process;

export const hostNetworkCapture = createHostNetworkCapture(parentPort);

export const pluginSandboxRegistrationBridge = createPluginSandboxRegistrationBridge({
  send: (message) => {
    if (!parentPort) throw new Error("parentPort unavailable");
    parentPort.postMessage(message);
  },
});

// browser-use host↔main 桥：把 agent 的 browser 命令经 parentPort 转给 main（WebContentsView+CDP）。
// parentPort 为空（不应发生于 host 进程）时 postToMain 抛错，bridge 自身返回 backend_unavailable。
export const browserControlMainBridge: ReturnType<typeof createBrowserControlMainBridge> =
  createBrowserControlMainBridge({
    postToMain: (message) => {
      if (!parentPort) {
        throw new Error("parentPort unavailable");
      }
      parentPort.postMessage(message);
    },
    materializeRecording: (input) => {
      let remoteBackend: Pick<IRemoteBackend, "upload"> | undefined;
      if (input.remoteSessionId) {
        const workspaceIdentity = input.workspaceIdentity;
        if (!workspaceIdentity?.trim()) {
          throw new Error("remote Browser recording materialization requires workspaceIdentity");
        }
        // Window Host 重构后同一进程可同时持有多个远端连接，旧的进程级
        // remoteConnection 会串 session。必须用完整 scope 从 registry 的权威 entry 取 uploader。
        remoteBackend = remoteRegistry().resolveScopedCapabilities({
          kind: "remote",
          remoteSessionId: input.remoteSessionId,
          workspacePath: input.workspacePath,
          workspaceIdentity,
        })?.browserRecordingUploader;
        if (!remoteBackend) {
          throw new Error(
            "Source Server browser recording transfer requires the remote resource transaction path",
          );
        }
      }
      return materializeBrowserRecordingArtifact({
        ...input,
        ...(remoteBackend ? { remoteBackend } : {}),
      });
    },
  });
