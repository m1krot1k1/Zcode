import { useEffect, useId, useRef, useState } from "react";
import {
  TID_SSH_HOST_INPUT,
  TID_SSH_PASSWORD_INPUT,
  TID_SSH_PRIVATE_KEY_INPUT,
  TID_SSH_USERNAME_INPUT,
} from "@zcode/shared/test-ids";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { DockerConnectionFields } from "./DockerConnectionFields.js";
import { ServerConnectionFields } from "./ServerConnectionFields.js";
import { SshConnectionFields } from "./SshConnectionFields.js";
import type { RemoteConnectionFieldsProps } from "./types.js";
import { WslConnectionFields } from "./WslConnectionFields.js";

/**
 * 远程连接字段的编排组件：持有跨分支共享的交互状态（焦点请求、Docker 输入模式、
 * 高级选项与粘贴识别），按连接类型渲染对应字段组。各分支状态仍在同一 owner 内，
 * 子组件只负责展示与回传事件。
 */
export function RemoteConnectionFields(props: RemoteConnectionFieldsProps) {
  // 保留拆分前的 intl 订阅位置，确保 hook 顺序与旧实现一致。
  useZCodeIntl();
  const fieldId = useId();
  const { kind, focusFirstEmptyToken = 0, host, username, sshAuthMethod, privateKeyPath } = props;
  const [dockerInputMode, setDockerInputMode] = useState<"select" | "manual">(
    props.manualDockerContainer || !props.dockerContainer ? "manual" : "select",
  );
  const platform = usePlatform();
  const [dockerContainerPopoverOpen, setDockerContainerPopoverOpen] = useState(false);
  const [advancedOptionsOpen, setAdvancedOptionsOpen] = useState(false);
  // 粘贴识别结果只属于本次粘贴；主机再被手动修改时清除。
  const [pasteRecognized, setPasteRecognized] = useState<string | null>(null);
  const [pasteFocusRequest, setPasteFocusRequest] = useState(0);
  const sshRootRef = useRef<HTMLDivElement | null>(null);

  const handleDockerContainerPopoverOpenChange = (nextOpen: boolean) => {
    setDockerContainerPopoverOpen(nextOpen);
    if (nextOpen) {
      props.refreshDockerContainers?.();
    }
  };

  useEffect(() => {
    if (kind !== "docker" && dockerContainerPopoverOpen) {
      setDockerContainerPopoverOpen(false);
    }
  }, [dockerContainerPopoverOpen, kind]);

  // 导入 Host 或粘贴拆分后，按提交后的最新字段值把焦点移到第一个空必填项（RDUX-27）。
  // 放在 effect 里而不是事件回调里，保证读取到已经提交到 DOM 的值。
  const focusRequestKey = `${focusFirstEmptyToken}:${pasteFocusRequest}`;
  const lastFocusRequestKeyRef = useRef(focusRequestKey);
  useEffect(() => {
    if (lastFocusRequestKeyRef.current === focusRequestKey) return;
    lastFocusRequestKeyRef.current = focusRequestKey;
    const root = sshRootRef.current;
    if (!root) return;
    const firstEmptyTestId = !host.trim()
      ? TID_SSH_HOST_INPUT
      : !username.trim()
        ? TID_SSH_USERNAME_INPUT
        : sshAuthMethod === "password"
          ? TID_SSH_PASSWORD_INPUT
          : !privateKeyPath.trim()
            ? TID_SSH_PRIVATE_KEY_INPUT
            : null;
    const target = firstEmptyTestId
      ? root.querySelector<HTMLElement>(`[data-testid="${firstEmptyTestId}"]`)
      : root.closest("form")?.querySelector<HTMLElement>('button[type="submit"]');
    target?.focus();
  }, [focusRequestKey]);

  switch (kind) {
    case "ssh":
      return (
        <SshConnectionFields
          {...props}
          fieldId={fieldId}
          rootRef={sshRootRef}
          platform={platform}
          advancedOptionsOpen={advancedOptionsOpen}
          onAdvancedOptionsOpenChange={setAdvancedOptionsOpen}
          pasteRecognized={pasteRecognized}
          onPasteRecognizedChange={setPasteRecognized}
          onPasteFocusRequest={() => setPasteFocusRequest((request) => request + 1)}
        />
      );
    case "server":
      return <ServerConnectionFields {...props} fieldId={fieldId} />;
    case "wsl":
      return <WslConnectionFields {...props} fieldId={fieldId} />;
    case "docker":
      return (
        <DockerConnectionFields
          {...props}
          fieldId={fieldId}
          dockerInputMode={dockerInputMode}
          onDockerInputModeChange={setDockerInputMode}
          dockerContainerPopoverOpen={dockerContainerPopoverOpen}
          onDockerContainerPopoverOpenChange={handleDockerContainerPopoverOpenChange}
        />
      );
  }
}
