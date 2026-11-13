import type { SourceServerTransportAdapter } from "@zcode/server/source-server";
import type { ManagerContext } from "./types.js";

/** 每种 transport 只保留一个 adapter 实例；重连和更新必须命中同一份运行时。 */
export function getAdapter(
  ctx: ManagerContext,
  kind: "ssh" | "wsl" | "docker",
): SourceServerTransportAdapter {
  let adapter = ctx.adapters.get(kind);
  if (!adapter) {
    adapter = ctx.createAdapter(kind);
    ctx.adapters.set(kind, adapter);
  }
  return adapter;
}
