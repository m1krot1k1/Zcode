import type { RefObject } from "react";
import type { IPlatformService } from "@zcode/shared";
import { ChevronDownIcon, ChevronRightIcon, FileKey, LinkIcon, XIcon } from "lucide-react";
import {
  TID_SSH_AUTH_PASSWORD,
  TID_SSH_AUTH_PRIVATE_KEY,
  TID_SSH_CONFIG_ALIAS_CHIP,
  TID_SSH_CONFIG_ALIAS_SELECT,
  TID_SSH_HOST_INPUT,
  TID_SSH_PASSWORD_INPUT,
  TID_SSH_PORT_INPUT,
  TID_SSH_PRIVATE_KEY_INPUT,
  TID_SSH_USERNAME_INPUT,
} from "@zcode/shared/test-ids";
import { Button } from "@/components/ui/button.js";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { parseSshPasteTarget } from "@/lib/remoteConnectionWizard.js";
import { RemoteConnectionHistoryInput } from "@/remote-connection/RemoteConnectionHistoryInput.js";
import { RemotePasswordInput } from "@/remote-connection/RemotePasswordInput.js";
import { REMOTE_KIND_PRESENTATION } from "@/remote-connection/RemoteConnectionTags.js";
import { buildSshConnectionHistorySuggestions } from "@/remote-connection/sshHistorySuggestions.js";
import { createRemoteFieldErrorHelpers } from "./fieldErrors.js";
import { FieldError, FieldHint, FieldLabel } from "./FieldPrimitives.js";
import { RemoteSegmentedControl } from "./RemoteSegmentedControl.js";
import { SshConfigAliasPicker } from "./SshConfigAliasPicker.js";
import type { RemoteConnectionFieldsProps } from "./types.js";

interface SshConnectionFieldsProps extends RemoteConnectionFieldsProps {
  fieldId: string;
  /** 主组件的焦点 effect 通过该 ref 查询首个空必填项。 */
  rootRef: RefObject<HTMLDivElement | null>;
  platform: IPlatformService;
  advancedOptionsOpen: boolean;
  onAdvancedOptionsOpenChange: (open: boolean) => void;
  pasteRecognized: string | null;
  onPasteRecognizedChange: (value: string | null) => void;
  onPasteFocusRequest: () => void;
}

/** SSH 连接字段：主机/端口、用户名、认证方式与高级选项。 */
export function SshConnectionFields({
  fieldId,
  rootRef,
  platform,
  advancedOptionsOpen,
  onAdvancedOptionsOpenChange,
  pasteRecognized,
  onPasteRecognizedChange,
  onPasteFocusRequest,
  autoFocusHost = false,
  sshConfigAliasMode = "advanced",
  fieldErrors = [],
  focusField,
  passwordPlaceholder,
  privateKeyPassphrasePlaceholder,
  focusCredentials,
  host,
  port,
  username,
  sshAuthMethod,
  assetInstallMode,
  password,
  privateKeyPath,
  privateKeyPassphrase,
  sshConfigAliases,
  sshConfigAliasesLoading,
  sshConfigAliasesError,
  selectedSshConfigAlias,
  remoteWorkspaceSessions = [],
  applySshConfigAlias,
  clearSelectedSshConfigAlias,
  setHost,
  setPort,
  setUsername,
  setSshAuthMethod,
  setAssetInstallMode,
  setPassword,
  setPrivateKeyPath,
  setPrivateKeyPassphrase,
}: SshConnectionFieldsProps) {
  const { intl } = useZCodeIntl();
  const { errorOf, errorId, invalidProps } = createRemoteFieldErrorHelpers(fieldId, fieldErrors);
  const sshHistorySuggestions = buildSshConnectionHistorySuggestions(remoteWorkspaceSessions);
  const selectedSshAliasOption =
    selectedSshConfigAlias == null
      ? null
      : (sshConfigAliases.find((option) => option.alias === selectedSshConfigAlias) ?? null);
  const sshAliasTriggerLabel = sshConfigAliasesLoading
    ? intl.formatMessage({ id: "common.loading" })
    : (selectedSshAliasOption?.alias ??
      selectedSshConfigAlias ??
      (sshConfigAliases.length === 0
        ? intl.formatMessage({ id: "ssh.configAliasEmpty" })
        : intl.formatMessage({ id: "ssh.configAliasPlaceholder" })));

  const sshAliasField = (
    <div className="space-y-1">
      <FieldLabel htmlFor={`${fieldId}-ssh-alias`}>
        {intl.formatMessage({ id: "ssh.configAlias" })}
      </FieldLabel>
      <SshConfigAliasPicker
        aliases={sshConfigAliases}
        selectedAlias={selectedSshConfigAlias}
        includeNoneOption
        onApply={applySshConfigAlias}
        onClear={clearSelectedSshConfigAlias}
      >
        <Button
          type="button"
          variant="outline"
          size="lg"
          disabled={
            sshConfigAliasesLoading || (sshConfigAliases.length === 0 && !selectedSshConfigAlias)
          }
          id={`${fieldId}-ssh-alias`}
          data-testid={TID_SSH_CONFIG_ALIAS_SELECT}
          className="h-9 w-full max-w-80 justify-between rounded-lg border-input-border bg-input px-3 text-ui-base font-normal hover:border-input-border-hover hover:bg-input aria-expanded:border-input-border-focused aria-expanded:bg-input-focused"
        >
          <span className="min-w-0 truncate text-left">{sshAliasTriggerLabel}</span>
          <ChevronDownIcon className="size-3.5 text-remote-foreground-muted" />
        </Button>
      </SshConfigAliasPicker>
      {sshConfigAliasesError ? (
        <p className="text-pretty text-ui-sm text-remote-foreground-muted">
          {intl.formatMessage({
            id: "ssh.configAliasLoadFailed",
          })}
        </p>
      ) : null}
    </div>
  );

  return (
    <div ref={rootRef} className="space-y-4">
      {selectedSshConfigAlias && sshConfigAliasMode === "linked" ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span
            data-testid={TID_SSH_CONFIG_ALIAS_CHIP}
            className={cn(
              "inline-flex h-7 items-center gap-1.5 rounded-md border pr-0.5 pl-2 text-ui-sm",
              REMOTE_KIND_PRESENTATION.ssh.className,
            )}
          >
            <LinkIcon className="size-3.5 shrink-0" />
            <span className="truncate">
              {intl.formatMessage(
                { id: "ssh.configAliasLinked" },
                { alias: selectedSshConfigAlias },
              )}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={intl.formatMessage({ id: "ssh.configAliasUnlink" })}
              title={intl.formatMessage({ id: "ssh.configAliasUnlink" })}
              onClick={clearSelectedSshConfigAlias}
            >
              <XIcon />
            </Button>
          </span>
          <span className="text-ui-sm text-remote-foreground-muted">
            {intl.formatMessage({ id: "ssh.configAliasLinkedHint" })}
          </span>
        </div>
      ) : null}
      {selectedSshConfigAlias && sshConfigAliasMode === "advanced" ? (
        <p className="text-pretty text-ui-sm text-remote-foreground-muted">
          {selectedSshConfigAlias} · {intl.formatMessage({ id: "ssh.configAliasDescription" })}
        </p>
      ) : null}
      {/* Bugfix: Electron / Chromium 的原生 autocomplete 在 SSH 向导里不稳定，
          而且默认值（如 localhost / 22）会把历史候选提前过滤掉。
          这里改成用应用自身持久化的远程连接历史做显式候选，focus 时先展示完整历史；密码仍然不参与历史回填。 */}
      {/* Bugfix: 建议列表之前直接跟着全宽输入框展开，在大对话框里会变成长条。
          这里把宽度限制在字段语义范围内，只收窄建议列表，不改变原输入框布局。 */}
      {/* Bugfix: 示例值直接作为 placeholder 会被误认为已有默认值。
          这里改成“输入提示 + 示例”，让用户知道仍需手动填写必填字段。 */}
      {/* 主机与端口同属连接目标，放在同一行；端口固定 6rem，窄屏同样并排（RDUX-27）。 */}
      <div>
        <div className="grid grid-cols-[minmax(0,1fr)_6rem] gap-3">
          <div className="min-w-0">
            <RemoteConnectionHistoryInput
              className="h-9 font-mono placeholder:font-sans text-ui-base"
              label={intl.formatMessage({ id: "ssh.host" })}
              autoFocus={autoFocusHost || focusField === "host"}
              {...invalidProps("host", focusField === "host")}
              value={host}
              onChange={(value) => {
                onPasteRecognizedChange(null);
                setHost(value);
              }}
              onBlur={() => setHost(host.trim())}
              onPaste={(event) => {
                const parsed = parseSshPasteTarget(event.clipboardData.getData("text"));
                if (!parsed) return;
                // 粘贴 user@host:port 或 ssh 命令时一次填好三个字段；setter 走表单原有语义，
                // 视为手动修改并解除别名关联（RDUX-27）。
                event.preventDefault();
                setHost(parsed.host);
                if (parsed.username) setUsername(parsed.username);
                if (parsed.port) setPort(parsed.port);
                onPasteRecognizedChange(
                  `${parsed.username ? `${parsed.username}@` : ""}${parsed.host}${
                    parsed.port ? `:${parsed.port}` : ""
                  }`,
                );
                onPasteFocusRequest();
              }}
              placeholder={intl.formatMessage({ id: "ssh.hostPlaceholder" })}
              suggestions={sshHistorySuggestions.hosts}
              emptyText={intl.formatMessage({ id: "remote.history.empty" })}
              suggestionWidth="min(30ch, calc(100vw - 2rem))"
              autoCapitalize="none"
              spellCheck={false}
              data-testid={TID_SSH_HOST_INPUT}
            />
          </div>
          <RemoteConnectionHistoryInput
            className="h-9 font-mono placeholder:font-sans text-ui-base"
            label={intl.formatMessage({ id: "ssh.port" })}
            value={port}
            onChange={setPort}
            placeholder="22"
            suggestions={sshHistorySuggestions.ports}
            emptyText={intl.formatMessage({ id: "remote.history.empty" })}
            suggestionWidth="min(8ch, calc(100vw - 2rem))"
            inputMode="numeric"
            {...invalidProps("port")}
            data-testid={TID_SSH_PORT_INPUT}
          />
        </div>
        <FieldError id={errorId("host")} message={errorOf("host")} />
        {/* 端口错误文案较长，放在整行下方，避免挤进 6rem 列。 */}
        <FieldError id={errorId("port")} message={errorOf("port")} />
        {pasteRecognized && !errorOf("host") ? (
          <FieldHint tone="success">
            {intl.formatMessage({ id: "ssh.pasteRecognized" }, { target: pasteRecognized })}
          </FieldHint>
        ) : null}
      </div>

      <div>
        <RemoteConnectionHistoryInput
          className="h-9 font-mono placeholder:font-sans text-ui-base"
          label={intl.formatMessage({ id: "ssh.username" })}
          value={username}
          onChange={setUsername}
          onBlur={() => setUsername(username.trim())}
          placeholder={intl.formatMessage({
            id: "ssh.usernamePlaceholder",
          })}
          suggestions={sshHistorySuggestions.usernames}
          emptyText={intl.formatMessage({ id: "remote.history.empty" })}
          suggestionWidth="min(30ch, calc(100vw - 2rem))"
          autoCapitalize="none"
          spellCheck={false}
          {...invalidProps("username")}
          data-testid={TID_SSH_USERNAME_INPUT}
        />
        <FieldError id={errorId("username")} message={errorOf("username")} />
      </div>

      <div className="space-y-2">
        {/* 认证方式标签与分段同行，分段已说明凭据类型，凭据输入不再重复可见标签。 */}
        <div className="flex flex-wrap items-center gap-3">
          <span
            id={`${fieldId}-ssh.authMethod`}
            className="text-ui-sm text-remote-foreground-muted"
          >
            {intl.formatMessage({ id: "ssh.authMethod" })}
          </span>
          <RemoteSegmentedControl
            labelledBy={`${fieldId}-ssh.authMethod`}
            value={sshAuthMethod}
            onChange={setSshAuthMethod}
            options={[
              {
                value: "password",
                label: intl.formatMessage({ id: "ssh.auth.password" }),
                testId: TID_SSH_AUTH_PASSWORD,
              },
              {
                value: "privateKey",
                label: intl.formatMessage({ id: "ssh.auth.privateKey" }),
                testId: TID_SSH_AUTH_PRIVATE_KEY,
              },
            ]}
          />
        </div>
        {sshAuthMethod === "password" ? (
          <div>
            <RemotePasswordInput
              size="lg"
              className="h-9 pr-10 text-ui-base"
              autoFocus={focusCredentials || focusField === "auth"}
              {...invalidProps("password", focusField === "auth")}
              aria-label={intl.formatMessage({ id: "ssh.password" })}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={
                passwordPlaceholder ?? intl.formatMessage({ id: "ssh.passwordPlaceholder" })
              }
              id={`${fieldId}-ssh.password`}
              name="remote-ssh-password"
              autoComplete="off"
              data-testid={TID_SSH_PASSWORD_INPUT}
            />
            <FieldError id={errorId("password")} message={errorOf("password")} />
          </div>
        ) : (
          <div className="space-y-3">
            <div>
              <div className="relative">
                <RemoteConnectionHistoryInput
                  className="h-9 pr-10 font-mono placeholder:font-sans text-ui-base"
                  value={privateKeyPath}
                  onChange={setPrivateKeyPath}
                  placeholder={intl.formatMessage({
                    id: "ssh.privateKeyPlaceholder",
                  })}
                  suggestions={sshHistorySuggestions.privateKeyPaths}
                  emptyText={intl.formatMessage({
                    id: "remote.history.empty",
                  })}
                  autoCapitalize="none"
                  spellCheck={false}
                  id={`${fieldId}-ssh.privateKey`}
                  aria-label={intl.formatMessage({ id: "ssh.privateKey" })}
                  autoFocus={focusField === "auth"}
                  {...invalidProps("privateKey", focusField === "auth")}
                  data-testid={TID_SSH_PRIVATE_KEY_INPUT}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-lg"
                  className="absolute top-1/2 right-0.5 -translate-y-1/2"
                  aria-label={intl.formatMessage({
                    id: "ssh.privateKeySelect",
                  })}
                  title={intl.formatMessage({ id: "ssh.privateKeySelect" })}
                  onClick={() => {
                    void (async () => {
                      const selectedPath = await platform.selectFile();
                      if (selectedPath) {
                        setPrivateKeyPath(selectedPath);
                      }
                    })();
                  }}
                >
                  <FileKey className="size-4" />
                </Button>
              </div>
              <FieldError id={errorId("privateKey")} message={errorOf("privateKey")} />
            </div>
            <div>
              <FieldLabel htmlFor={`${fieldId}-ssh.privateKeyPassphrase`}>
                {intl.formatMessage({ id: "ssh.privateKeyPassphrase" })}
              </FieldLabel>
              <RemotePasswordInput
                size="lg"
                className="h-9 text-ui-base"
                autoFocus={focusCredentials}
                value={privateKeyPassphrase}
                onChange={(e) => setPrivateKeyPassphrase(e.target.value)}
                placeholder={
                  privateKeyPassphrasePlaceholder ??
                  intl.formatMessage({ id: "ssh.privateKeyPassphrasePlaceholder" })
                }
                id={`${fieldId}-ssh.privateKeyPassphrase`}
                name="remote-ssh-private-key-passphrase"
                autoComplete="off"
              />
            </div>
          </div>
        )}
      </div>

      {/* 高级选项默认收起，紧凑文字触发，不再加虚线分隔（RDUX-27）。 */}
      <Collapsible open={advancedOptionsOpen} onOpenChange={onAdvancedOptionsOpenChange}>
        <CollapsibleTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="-ml-1 px-1 text-remote-foreground-muted hover:text-foreground"
          >
            <ChevronRightIcon
              className={cn("size-3.5 transition-transform", advancedOptionsOpen && "rotate-90")}
            />
            {intl.formatMessage({ id: "ssh.advancedOptions" })}
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="space-y-3 pt-2">
          {sshConfigAliasMode === "advanced" ? sshAliasField : null}

          <div>
            <FieldLabel id={`${fieldId}-ssh.assetInstallMode`}>
              {intl.formatMessage({ id: "ssh.assetInstallMode" })}
            </FieldLabel>
            <RemoteSegmentedControl
              labelledBy={`${fieldId}-ssh.assetInstallMode`}
              value={assetInstallMode}
              onChange={setAssetInstallMode}
              wrap
              options={(["local-download-upload", "remote-download"] as const).map((value) => ({
                value,
                label: intl.formatMessage({ id: `ssh.assetInstallMode.${value}` }),
              }))}
            />
            <FieldHint>{intl.formatMessage({ id: "ssh.assetInstallModeDescription" })}</FieldHint>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
