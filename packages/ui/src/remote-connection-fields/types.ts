import type {
  DockerContainerInfo,
  RemoteAssetInstallMode,
  RemoteTarget,
  RemoteWorkspaceSessionEntry,
  SSHConfigAliasOption,
  WSLDistro,
} from "@zcode/shared";
import type { SSHAuthMethod } from "@/hooks/useRemoteConnectionForm.js";
import type { RemoteFormFieldError } from "@/lib/remoteConnectionWizard.js";

/**
 * linked：新建连接表单，别名由外部「从 SSH config 导入」选择，这里只显示关联标签；
 * advanced：编辑连接弹窗，别名下拉保留在高级选项内。
 */
export type SshConfigAliasMode = "advanced" | "linked";

/** 远程连接字段表单的完整输入契约；各连接类型组件按需取用。 */
export interface RemoteConnectionFieldsProps {
  focusCredentials?: boolean;
  /** 新建连接表单打开时把焦点放在主机（RDUX-27）。 */
  autoFocusHost?: boolean;
  /** 每次递增时把焦点移到第一个为空的必填 SSH 字段；全部已填时移到表单主操作。 */
  focusFirstEmptyToken?: number;
  sshConfigAliasMode?: SshConfigAliasMode;
  /** 提交后显示的内联错误，来自 collectRemoteFormFieldErrors。 */
  fieldErrors?: RemoteFormFieldError[];
  runtimeOptionsError?: string;
  focusField?: "host" | "auth";
  passwordPlaceholder?: string;
  privateKeyPassphrasePlaceholder?: string;
  kind: RemoteTarget["kind"];
  host: string;
  port: string;
  username: string;
  sshAuthMethod: SSHAuthMethod;
  assetInstallMode: RemoteAssetInstallMode;
  password: string;
  privateKeyPath: string;
  privateKeyPassphrase: string;
  wslDistro: string;
  wslUser?: string;
  wslDistros: WSLDistro[];
  dockerContainer: string;
  manualDockerContainer: string;
  serverUrl: string;
  serverName: string;
  serverToken: string;
  serverWorkspacePath: string;
  dockerContainers: DockerContainerInfo[];
  dockerAvailable: boolean | null;
  sshConfigAliases: SSHConfigAliasOption[];
  sshConfigAliasesLoading: boolean;
  sshConfigAliasesError: string;
  selectedSshConfigAlias: string | null;
  runtimeOptionsLoading: boolean;
  remoteWorkspaceSessions?: RemoteWorkspaceSessionEntry[];
  refreshDockerContainers?: () => void;
  applySshConfigAlias: (value: SSHConfigAliasOption) => void;
  clearSelectedSshConfigAlias: () => void;
  setHost: (value: string) => void;
  setPort: (value: string) => void;
  setUsername: (value: string) => void;
  setSshAuthMethod: (value: SSHAuthMethod) => void;
  setAssetInstallMode: (value: RemoteAssetInstallMode) => void;
  setPassword: (value: string) => void;
  setPrivateKeyPath: (value: string) => void;
  setPrivateKeyPassphrase: (value: string) => void;
  setWslDistro: (value: string) => void;
  setWslUser?: (value: string) => void;
  setDockerContainer: (value: string) => void;
  setManualDockerContainer: (value: string) => void;
  setServerUrl: (value: string) => void;
  setServerName: (value: string) => void;
  setServerToken: (value: string) => void;
  setServerWorkspacePath: (value: string) => void;
}
