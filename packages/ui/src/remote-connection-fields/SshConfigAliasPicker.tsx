import { useCallback, useEffect, useRef, useState, type ReactNode, type WheelEvent } from "react";
import type { SSHConfigAliasOption } from "@zcode/shared";
import { RemoteConnectionKindTile } from "@/remote-connection/RemoteConnectionTags.js";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command.js";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

const NO_SSH_CONFIG_ALIAS_VALUE = "__ssh_config_alias_none__";

function formatSshConfigAliasSummary(aliasOption: SSHConfigAliasOption): string {
  const host = aliasOption.host?.trim() || aliasOption.alias;
  const username = aliasOption.username?.trim();
  const withUser = username ? `${username}@${host}` : host;
  return aliasOption.port != null ? `${withUser}:${aliasOption.port}` : withUser;
}

/**
 * SSH config Host 的可搜索弹层。新建连接的「从 SSH config 导入」与编辑连接高级选项里的
 * 别名下拉共用同一列表，触发按钮由调用方提供。
 */
export function SshConfigAliasPicker({
  aliases,
  selectedAlias,
  includeNoneOption = false,
  align = "start",
  onApply,
  onClear,
  children,
}: {
  aliases: SSHConfigAliasOption[];
  selectedAlias: string | null;
  /** 编辑连接的下拉保留「不使用别名」；新建表单用关联标签的 × 解除。 */
  includeNoneOption?: boolean;
  align?: "start" | "end";
  onApply: (option: SSHConfigAliasOption) => void;
  onClear?: () => void;
  children: ReactNode;
}) {
  const { intl } = useZCodeIntl();
  const [open, setOpen] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);
  const handleListWheel = useCallback((event: WheelEvent<HTMLDivElement>) => {
    const listElement = event.currentTarget;
    if (listElement.scrollHeight <= listElement.clientHeight) {
      return;
    }

    // Popover 嵌在 Dialog 中时，外层滚动锁会吞掉默认滚轮行为，
    // 导致 alias CommandList 只能拖滚动条、不能直接滚轮滚动。
    // 这里显式驱动列表自身 scrollTop，确保鼠标滚轮和触控板都能滚动候选项。
    listElement.scrollTop += event.deltaY;
    event.preventDefault();
    event.stopPropagation();
  }, []);

  useEffect(() => {
    if (!open) {
      return;
    }

    const frameId = window.requestAnimationFrame(() => {
      listRef.current
        ?.querySelector<HTMLElement>('[data-ssh-config-alias-selected="true"]')
        ?.scrollIntoView({ block: "nearest" });
    });

    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [open, selectedAlias, aliases.length]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent align={align} sideOffset={6} className="w-80 gap-0 bg-menu p-0">
        <Command className="bg-transparent p-0 text-foreground">
          <CommandInput
            placeholder={intl.formatMessage({
              id: "ssh.configAliasSearchPlaceholder",
            })}
            className="h-8"
          />
          <CommandList
            ref={listRef}
            className="max-h-60 overscroll-contain"
            onWheel={handleListWheel}
          >
            <CommandEmpty className="px-4 py-5 text-remote-foreground-muted">
              {intl.formatMessage({ id: "ssh.configAliasEmpty" })}
            </CommandEmpty>
            <CommandGroup className="p-1">
              {includeNoneOption ? (
                <CommandItem
                  value={NO_SSH_CONFIG_ALIAS_VALUE}
                  data-checked={selectedAlias == null ? "true" : undefined}
                  data-ssh-config-alias-selected={selectedAlias == null ? "true" : undefined}
                  className="min-h-8 cursor-pointer px-2 text-ui-base"
                  onSelect={() => {
                    onClear?.();
                    setOpen(false);
                  }}
                >
                  <span className="truncate">
                    {intl.formatMessage({
                      id: "ssh.configAliasPlaceholder",
                    })}
                  </span>
                </CommandItem>
              ) : null}
              {aliases.map((aliasOption) => {
                const selected = selectedAlias === aliasOption.alias;
                return (
                  <CommandItem
                    key={aliasOption.alias}
                    value={`${aliasOption.alias} ${formatSshConfigAliasSummary(aliasOption)}`}
                    data-checked={selected ? "true" : undefined}
                    data-ssh-config-alias-selected={selected ? "true" : undefined}
                    className="min-h-8 cursor-pointer gap-2 px-2 text-ui-base"
                    onSelect={() => {
                      onApply(aliasOption);
                      setOpen(false);
                    }}
                  >
                    <RemoteConnectionKindTile kind="ssh" />
                    <span className="flex min-w-0 flex-1 flex-col text-left">
                      <span className="truncate">{aliasOption.alias}</span>
                      <span className="truncate font-mono text-ui-sm text-remote-foreground-muted">
                        {formatSshConfigAliasSummary(aliasOption)}
                      </span>
                    </span>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
