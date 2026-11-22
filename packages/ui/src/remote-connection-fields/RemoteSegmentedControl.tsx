import type { LucideIcon } from "lucide-react";
import { cn } from "@/components/lib/utils.js";

export interface RemoteSegmentedOption<T extends string> {
  value: T;
  label: string;
  icon?: LucideIcon;
  /** 只有连接类型切换传入类型色；其余分段保持中性选中态（DESIGN.md Tabs）。 */
  selectedClassName?: string;
  testId?: string;
}

/** 远程连接表单统一的分段控件：外框方框、竖线分隔、选中项 aria-pressed。 */
export function RemoteSegmentedControl<T extends string>({
  label,
  labelledBy,
  value,
  options,
  onChange,
  disabled,
  wrap = false,
}: {
  label?: string;
  labelledBy?: string;
  value: T;
  options: RemoteSegmentedOption<T>[];
  onChange: (value: T) => void;
  disabled?: boolean;
  /** 长文案（如下载方式）允许换行；短标签保持单行。 */
  wrap?: boolean;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      aria-labelledby={labelledBy}
      className="flex w-fit max-w-full overflow-hidden rounded-lg border border-input-border"
    >
      {options.map((option, index) => {
        const selected = option.value === value;
        const Icon = option.icon;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={selected}
            disabled={disabled}
            data-testid={option.testId}
            onClick={() => onChange(option.value)}
            className={cn(
              "inline-flex min-h-8 min-w-0 items-center justify-center gap-1.5 px-3 text-ui-base transition-colors disabled:opacity-50",
              wrap ? "py-1 text-center" : "whitespace-nowrap",
              index > 0 && "border-l border-input-border",
              selected
                ? cn("font-medium", option.selectedClassName ?? "bg-selected text-foreground")
                : // 全局样式禁用了 focus outline / box-shadow，键盘焦点改用背景提示。
                  "text-remote-foreground-muted hover:text-foreground focus-visible:bg-hover focus-visible:text-foreground",
            )}
          >
            {Icon ? <Icon className="size-3.5 shrink-0" /> : null}
            <span className={cn("min-w-0", wrap && "break-words")}>{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}
