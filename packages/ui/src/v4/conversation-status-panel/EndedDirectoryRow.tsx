import { type ReactNode } from "react";
import { CheckCircle2Icon, ChevronRightIcon } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { OpenSubagentDirectorySideTabRequest } from "@/lib/workspaceSidePane.js";

/**
 * 「已结束的 X · N ›」页脚行：分区里那条通往目录页的入口。
 *
 * Agents 与 Workflows **共用这一个** affordance（图标/文案/计数/回调由调用方给）。抽出来的
 * 理由不是省行数，而是不出现第二套画法：两个分区的页脚行若各写一遍，两者会随时间长出不同的
 * 间距、不同的 hover、不同的计数位置，而它们在读者眼里本来是同一个动作。
 *
 * `count <= 0` 或缺回调即整行缺席：一个点了没反应的入口比没有入口更糟。
 */
export function EndedDirectoryRow({
  count,
  icon,
  label,
  onOpen,
  separated,
  testId,
}: {
  count: number;
  icon: ReactNode;
  label: string;
  onOpen?: () => void;
  separated: boolean;
  testId?: string;
}) {
  if (count <= 0 || !onOpen) return null;
  return (
    <div className={cn(separated && "border-t border-[var(--color-border)] pt-2")}>
      <button
        type="button"
        data-testid={testId}
        className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-ui-base text-[var(--color-foreground)] hover:bg-[var(--color-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-input-border-focused)]"
        onClick={onOpen}
      >
        {icon}
        <span>{label}</span>
        <span className="ml-auto text-[var(--color-foreground-subtle)]">{count}</span>
        <ChevronRightIcon className="size-4 text-[var(--color-foreground-subtle)]" />
      </button>
    </div>
  );
}

export function EndedSubagentDirectoryRow({
  count,
  onOpen,
  parentSessionId,
  rootSessionId,
  separated,
}: {
  count: number;
  onOpen?: (request: OpenSubagentDirectorySideTabRequest) => void;
  parentSessionId?: string;
  rootSessionId?: string;
  separated: boolean;
}) {
  const { intl } = useZCodeIntl();
  return (
    <EndedDirectoryRow
      count={count}
      icon={<CheckCircle2Icon className="size-4 shrink-0 text-[var(--color-foreground-subtle)]" />}
      label={intl.formatMessage({ id: "chat.statusPanel.endedAgents" })}
      separated={separated}
      onOpen={
        parentSessionId && onOpen
          ? () =>
              onOpen({
                rootSessionId: rootSessionId ?? parentSessionId,
                parentSessionId,
              })
          : undefined
      }
    />
  );
}
