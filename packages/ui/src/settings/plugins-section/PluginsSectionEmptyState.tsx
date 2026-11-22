/** 设置页通用空状态块：PluginsSection 的列表与独立 capability 标签共用。 */
export function PluginsSectionEmptyState({ message }: { message: string }) {
  return (
    <div className="rounded-xl border border-dashed border-border px-4 py-8 text-center text-ui-base text-foreground-subtle">
      {message}
    </div>
  );
}
