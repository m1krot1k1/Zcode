// 命令中心的 scope 切换区：单个 tab 按钮与整行 tablist。
// 从 CommandCenterDialog.tsx 拆出，字号语义与可访问性标注保持不变。

import { FileIcon, ListIcon, MessagesSquareIcon, RocketIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/components/lib/utils.js";
import type { CommandCenterSearchScope } from "@/command-center/commandCenterSearchHistory.js";
import type { IntlInstance } from "@/i18n/index.js";

export function CommandCenterScopeButton({
  active,
  label,
  onClick,
  children,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        // scope tabs 是可交互的范围切换按钮，按 DESIGN.md 语义角色属于
        // common buttons，应使用 text-ui-base；不能用 text-ui-xs（10px，badge/
        // counter 专用），否则字号过小。同时与上方搜索输入框 (text-ui-base) 保持一致。
        "inline-flex h-6 shrink-0 items-center gap-1 rounded-full border px-2 text-ui-base font-medium leading-none transition-colors",
        active
          ? "border-border bg-selected text-foreground"
          : "border-transparent text-foreground-subtle hover:bg-surface-hover hover:text-foreground",
      )}
    >
      {children}
      <span>{label}</span>
    </button>
  );
}

export function CommandCenterScopeTabs({
  activeScope,
  onSelectScope,
  intl,
}: {
  activeScope: CommandCenterSearchScope;
  onSelectScope: (scope: CommandCenterSearchScope) => void;
  intl: IntlInstance;
}) {
  return (
    <div
      role="tablist"
      aria-label={intl.formatMessage({ id: "commandCenter.scopeTabs" })}
      className="-mx-1 mt-1.5 flex gap-1 overflow-x-auto px-1 pb-0.5 scrollbar-hide"
    >
      <CommandCenterScopeButton
        active={activeScope === "all"}
        label={intl.formatMessage({ id: "commandCenter.scope.all" })}
        onClick={() => onSelectScope("all")}
      >
        <ListIcon className="size-3" />
      </CommandCenterScopeButton>
      <CommandCenterScopeButton
        active={activeScope === "commands"}
        label={intl.formatMessage({ id: "commandCenter.scope.commands" })}
        onClick={() => onSelectScope("commands")}
      >
        <RocketIcon className="size-3" />
      </CommandCenterScopeButton>
      <CommandCenterScopeButton
        active={activeScope === "conversations"}
        label={intl.formatMessage({ id: "commandCenter.scope.conversations" })}
        onClick={() => onSelectScope("conversations")}
      >
        <MessagesSquareIcon className="size-3" />
      </CommandCenterScopeButton>
      <CommandCenterScopeButton
        active={activeScope === "files"}
        label={intl.formatMessage({ id: "commandCenter.scope.files" })}
        onClick={() => onSelectScope("files")}
      >
        <FileIcon className="size-3" />
      </CommandCenterScopeButton>
    </div>
  );
}
