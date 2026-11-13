/** 启动重连/恢复共享的并发闸门；释放是幂等的，重复调用不会多放一个等待者。 */
export function createConcurrencyGate(limit: number): {
  acquire(): Promise<() => void>;
} {
  let active = 0;
  const waiting: Array<() => void> = [];
  return {
    acquire: async () =>
      await new Promise<() => void>((resolve) => {
        const grant = () => {
          active += 1;
          let released = false;
          resolve(() => {
            if (released) return;
            released = true;
            active -= 1;
            waiting.shift()?.();
          });
        };
        if (active < limit) grant();
        else waiting.push(grant);
      }),
  };
}
