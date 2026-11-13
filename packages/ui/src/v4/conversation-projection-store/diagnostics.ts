import { uiMemoryDiagnosticsRegistry } from "@/lib/memoryDiagnostics.js";

/**
 * 内存诊断只依赖行数访问器，避免 diagnostics 模块反向依赖 store 类而制造循环。
 * 计数器统计存活 store 数与其 rows.window 行数之和，用于观察窗口数据的内存增长。
 * 构造时加入、close() 时移除。
 */
interface ProjectionRowsSource {
  countProjectionRows(): number;
}

const liveProjectionStores = new Set<ProjectionRowsSource>();

uiMemoryDiagnosticsRegistry.register("projection", () => {
  let rows = 0;
  for (const store of liveProjectionStores) {
    rows += store.countProjectionRows();
  }
  return { stores: liveProjectionStores.size, rows };
});

export function trackProjectionStore(store: ProjectionRowsSource): void {
  liveProjectionStores.add(store);
}

export function untrackProjectionStore(store: ProjectionRowsSource): void {
  liveProjectionStores.delete(store);
}
