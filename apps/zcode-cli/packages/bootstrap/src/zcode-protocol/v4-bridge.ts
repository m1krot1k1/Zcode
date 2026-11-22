// v4 网关 binder。
// 定位：ConversationV4Gateway 是域无关的通道运行时，本文件把它绑到协议服务器上下文：
// - 帧出口 = context.notify（stdio NDJSON notification，与旧 session/event 同一条管道并存）；
// - 命令执行 = V4CommandExecutor（zcode-protocol-v4/commands/，原生直驱 core）；
//   20 命令全部原生，supports() 未命中（未知命令）→ notImplemented。
// - 过渡钩子（ensureModelReady / afterLegacyStateMutation / deleteSession /
//   createSessionRecord / child record registration / resumePersistedSession）在此注入旧实现，
//   死期 = M5 波次 2（随旧协议一同删除）。
//
// 不做桥接：依赖方向只允许 旧目录 → v4 目录。
// 本文件在旧目录，import v4 executor 合法；v4 目录禁止反向 import 本目录任何模块。
//
// 拆分后的模块（依赖只向下）：v4-bridge-state（共享状态）→ queue / hydration /
// sessions / admission / fork / highspeed（域逻辑）→ core-*（coreHost 各面）→
// core-host / gateway（装配）→ 本文件（入口）。
import type { SessionId } from "@zcode/contracts";
import { V4CommandExecutor } from "../zcode-protocol-v4/commands/executor.js";
import { PersistentCommandIndex } from "../zcode-protocol-v4/persistent-command-index.js";
import { loadPersistentCommandFacts } from "../zcode-protocol-v4/persistent-command-facts.js";
import { ConversationV4Gateway } from "../zcode-protocol-v4/v4-gateway.js";
import { createProtocolLogger, type ZCodeProtocolAgentServerContext } from "./server-types.js";
import { createCoreHost } from "./v4-bridge-core-host.js";
import { createGatewayHost } from "./v4-bridge-gateway.js";
import type { BridgeState } from "./v4-bridge-state.js";

export {
  buildOpenCodeAgentRunAdmission,
  isConversationInputAdmissionCommand,
  persistOpenCodeAgentRunAdmission,
  resolveInputCommandForAdmission,
} from "./v4-bridge-admission.js";
export { registerCommittedForkBestEffort } from "./v4-bridge-fork.js";
export { persistHighspeedTimingOnTurnTerminal } from "./v4-bridge-highspeed.js";

export function createConversationV4Gateway(
  context: ZCodeProtocolAgentServerContext,
): ConversationV4Gateway {
  const log = createProtocolLogger(context.deps)?.child({
    module: "bootstrap.zcode_protocol_v4_gateway",
  });
  const persistentCommands = new PersistentCommandIndex({
    loadSession: async (sessionId) => {
      const live = context.sessions.get(sessionId);
      const stored = await context.deps.sessionStore?.getSession(sessionId as SessionId);
      if (!live && !stored) return null;
      const workspacePath = live?.workspace.workspacePath ?? stored?.directory;
      if (!workspacePath) return null;
      const workspaceIdentity = live?.workspace.workspaceIdentity ?? stored?.workspaceID;
      const facts = context.deps.sessionStore
        ? await loadPersistentCommandFacts(context.deps.sessionStore, sessionId as SessionId, {
            discardAdmittedOnLoad: !live,
          })
        : undefined;
      return {
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity: String(workspaceIdentity) } : {}),
        ...(facts ? { facts } : {}),
      };
    },
  });
  const state: BridgeState = {
    context,
    log,
    persistentCommands,
    autoDrainRetryTimers: new Map<string, ReturnType<typeof setTimeout>>(),
    // Highspeed 执行材料含临时凭据：只按 session/sourceCommandId 驻留内存，绝不进入
    // TurnSteerQueued、snapshot 或 transcript。CLI 重启后缺失时队列提升自动走原模型。
    queuedTurnExecutions: new Map(),
  };
  const coreHost = createCoreHost(state);
  state.nativeExecutor = new V4CommandExecutor(coreHost);
  return new ConversationV4Gateway(createGatewayHost(state, coreHost));
}
