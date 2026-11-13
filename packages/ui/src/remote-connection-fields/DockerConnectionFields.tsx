import { CheckIcon, ChevronDownIcon, LoaderIcon } from "lucide-react";
import { TID_DOCKER_CONTAINER_INPUT, TID_DOCKER_CONTAINER_SELECT } from "@zcode/shared/test-ids";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command.js";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { RemoteConnectionKindTile } from "@/remote-connection/RemoteConnectionTags.js";
import { createRemoteFieldErrorHelpers } from "./fieldErrors.js";
import { FieldError, FieldHint, FieldLabel } from "./FieldPrimitives.js";
import { RemoteSegmentedControl } from "./RemoteSegmentedControl.js";
import type { RemoteConnectionFieldsProps } from "./types.js";

interface DockerConnectionFieldsProps extends RemoteConnectionFieldsProps {
  fieldId: string;
  dockerInputMode: "select" | "manual";
  onDockerInputModeChange: (mode: "select" | "manual") => void;
  dockerContainerPopoverOpen: boolean;
  onDockerContainerPopoverOpenChange: (open: boolean) => void;
}

/** Docker 连接字段：容器下拉（含刷新与空状态原因）或手动填写容器名。 */
export function DockerConnectionFields({
  fieldId,
  dockerInputMode,
  onDockerInputModeChange,
  dockerContainerPopoverOpen,
  onDockerContainerPopoverOpenChange,
  fieldErrors = [],
  runtimeOptionsError = "",
  dockerContainer,
  manualDockerContainer,
  dockerContainers,
  dockerAvailable,
  runtimeOptionsLoading,
  setDockerContainer,
  setManualDockerContainer,
}: DockerConnectionFieldsProps) {
  const { intl } = useZCodeIntl();
  const { errorOf, errorId, invalidProps } = createRemoteFieldErrorHelpers(fieldId, fieldErrors);
  // Bugfix: 空下拉列表曾固定显示「选择正在运行的容器」，下拉又盖住选择器下方的原因提示，
  // 用户看不到为什么没有候选。空列表与下方提示共用同一条原因文案。
  const dockerContainerEmptyText = runtimeOptionsError
    ? intl.formatMessage({ id: "remote.optionsLoadFailed" })
    : dockerAvailable === false
      ? intl.formatMessage({ id: "docker.unavailable" })
      : intl.formatMessage({ id: "docker.noContainers" });
  const dockerContainerTriggerLabel =
    dockerContainer.trim() ||
    (runtimeOptionsLoading
      ? intl.formatMessage({ id: "docker.loading" })
      : intl.formatMessage({ id: "docker.selectContainer" }));
  const dockerContainerTriggerIsPlaceholder = !dockerContainer.trim();
  const manualDockerContainerIsEmpty = manualDockerContainer.trim().length === 0;

  return (
    <div className="space-y-4">
      <RemoteSegmentedControl
        label="Docker"
        value={dockerInputMode}
        onChange={(mode) => {
          onDockerInputModeChange(mode);
          setDockerContainer("");
          setManualDockerContainer("");
        }}
        options={(["select", "manual"] as const).map((mode) => ({
          value: mode,
          label: intl.formatMessage({ id: `docker.inputMode.${mode}` }),
        }))}
      />
      {dockerInputMode === "select" ? (
        <div>
          <FieldLabel htmlFor={`${fieldId}-docker-select`}>
            {intl.formatMessage({ id: "docker.container" })}
          </FieldLabel>
          <Popover
            open={dockerContainerPopoverOpen}
            onOpenChange={onDockerContainerPopoverOpenChange}
          >
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="lg"
                id={`${fieldId}-docker-select`}
                data-testid={TID_DOCKER_CONTAINER_SELECT}
                {...invalidProps("docker")}
                className="h-9 w-full justify-between rounded-lg border-input-border bg-input px-3 text-ui-base font-normal hover:border-input-border-hover hover:bg-input aria-expanded:border-input-border-focused aria-expanded:bg-input-focused aria-invalid:border-destructive"
              >
                <span
                  className={cn(
                    "min-w-0 truncate text-left",
                    dockerContainerTriggerIsPlaceholder
                      ? "text-remote-foreground-muted"
                      : "text-foreground",
                  )}
                >
                  {dockerContainerTriggerLabel}
                </span>
                {runtimeOptionsLoading ? (
                  <LoaderIcon className="size-3.5 shrink-0 animate-spin text-remote-foreground-muted" />
                ) : (
                  <ChevronDownIcon className="size-3.5 shrink-0 text-remote-foreground-muted" />
                )}
              </Button>
            </PopoverTrigger>
            <PopoverContent
              align="start"
              sideOffset={6}
              className="max-w-[calc(100vw-2rem)] rounded-xl border border-border bg-menu p-1 shadow-lg"
              style={{ width: "var(--radix-popover-trigger-width)" }}
            >
              <Command className="rounded-lg bg-transparent p-0 text-foreground">
                <CommandInput
                  aria-label={intl.formatMessage({ id: "docker.selectContainer" })}
                  placeholder={intl.formatMessage({ id: "docker.selectContainer" })}
                />
                <CommandList className="max-h-56 scroll-py-1">
                  {runtimeOptionsLoading ? (
                    <div className="flex min-h-8 items-center gap-2 rounded-lg px-3 py-1.5 text-ui-base text-remote-foreground-muted">
                      <LoaderIcon className="size-3.5 shrink-0 animate-spin" />
                      <span className="truncate">
                        {intl.formatMessage({ id: "docker.loading" })}
                      </span>
                    </div>
                  ) : null}
                  {dockerContainers.length === 0 && !runtimeOptionsLoading ? (
                    <CommandEmpty className="px-3 py-5 text-ui-base text-remote-foreground-muted">
                      {dockerContainerEmptyText}
                    </CommandEmpty>
                  ) : (
                    dockerContainers.map((container) => {
                      const selected = container.name === dockerContainer;

                      return (
                        <CommandItem
                          key={container.id}
                          value={container.name}
                          className="min-h-8 cursor-pointer gap-2 rounded-lg px-2 py-1.5 text-ui-base text-foreground data-selected:bg-menu-hover data-selected:text-foreground"
                          onSelect={() => {
                            setManualDockerContainer("");
                            setDockerContainer(container.name);
                            onDockerContainerPopoverOpenChange(false);
                          }}
                        >
                          <RemoteConnectionKindTile kind="docker" />
                          <span className="min-w-0 flex-1 truncate">{container.name}</span>
                          <CheckIcon
                            className={cn(
                              "size-4 shrink-0 text-remote-foreground-muted",
                              selected ? "opacity-100" : "opacity-0",
                            )}
                          />
                        </CommandItem>
                      );
                    })
                  )}
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>
          <FieldError id={errorId("docker")} message={errorOf("docker")} />
          {/* 限制信息放到选择器下方：区分 Docker 不可用、发现失败与没有运行中的容器（RDUX-27）。 */}
          {runtimeOptionsLoading ? null : runtimeOptionsError || dockerAvailable === false ? (
            <FieldHint tone="warning">{dockerContainerEmptyText}</FieldHint>
          ) : dockerContainers.length === 0 ? (
            <FieldHint>{dockerContainerEmptyText}</FieldHint>
          ) : null}
        </div>
      ) : (
        <div>
          <FieldLabel htmlFor={`${fieldId}-docker.container`}>
            {intl.formatMessage({ id: "docker.container" })}
          </FieldLabel>
          <Input
            size="lg"
            className="h-9 text-ui-base"
            value={manualDockerContainer}
            onChange={(event) => {
              setDockerContainer("");
              setManualDockerContainer(event.target.value);
            }}
            placeholder={intl.formatMessage({
              id: "docker.containerPlaceholder",
            })}
            {...invalidProps("docker")}
            id={`${fieldId}-docker.container`}
            data-testid={TID_DOCKER_CONTAINER_INPUT}
          />
          <FieldError id={errorId("docker")} message={errorOf("docker")} />
          {manualDockerContainerIsEmpty && !errorOf("docker") ? (
            <FieldHint>{intl.formatMessage({ id: "docker.manualContainerHint" })}</FieldHint>
          ) : null}
        </div>
      )}
    </div>
  );
}
