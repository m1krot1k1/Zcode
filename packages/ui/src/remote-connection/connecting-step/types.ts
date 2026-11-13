import type {
  RemoteTarget,
  SourceServerInstallPreview,
  SourceServerRunningTask,
} from "@zcode/shared";

/** 安装确认面板的数据源；只承载确认所需字段，不复制连接状态。 */
export interface RemoteConnectionInstallConfirmation {
  target: RemoteTarget;
  preview?: SourceServerInstallPreview;
  onConfirm: () => void;
  onCancel: () => void;
}

/** 强制更新确认面板的数据源。 */
export interface RemoteConnectionForceUpdate {
  tasks?: SourceServerRunningTask[];
  onConfirm: () => void;
  onCancel: () => void;
}

/** 凭据等待表单的受控字段；值由连接流程持有。 */
export interface RemoteConnectionCredentialsForm {
  passphrase: boolean;
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
}
