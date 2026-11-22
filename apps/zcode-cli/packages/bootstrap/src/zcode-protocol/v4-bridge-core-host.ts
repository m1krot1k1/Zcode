// coreHost 装配：把各域的部分实现合并成 v4 命令层唯一的能力面。
// 属性级无重叠（每个方法只由一个域提供），因此装配顺序不影响行为。
import type { V4CommandCoreHost } from "../zcode-protocol-v4/commands/types.js";
import { createAdmissionCoreHost } from "./v4-bridge-core-admission.js";
import { createFactsCoreHost } from "./v4-bridge-core-facts.js";
import { createForksCoreHost } from "./v4-bridge-core-forks.js";
import { createRowsCoreHost } from "./v4-bridge-core-rows.js";
import { createRuntimeCoreHost } from "./v4-bridge-core-runtime.js";
import { createSessionsCoreHost } from "./v4-bridge-core-sessions.js";
import type { BridgeState } from "./v4-bridge-state.js";

export function createCoreHost(state: BridgeState): V4CommandCoreHost {
  return {
    ...createRuntimeCoreHost(state),
    ...createAdmissionCoreHost(state),
    ...createFactsCoreHost(state),
    ...createRowsCoreHost(state),
    ...createSessionsCoreHost(state),
    ...createForksCoreHost(state),
  };
}
