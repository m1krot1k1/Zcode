import {
  TID_SERVER_NAME_INPUT,
  TID_SERVER_TOKEN_INPUT,
  TID_SERVER_URL_INPUT,
  TID_SERVER_WORKSPACE_PATH_INPUT,
} from "@zcode/shared/test-ids";
import { Input } from "@/components/ui/input.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { RemotePasswordInput } from "@/remote-connection/RemotePasswordInput.js";
import { createRemoteFieldErrorHelpers } from "./fieldErrors.js";
import { FieldError } from "./FieldPrimitives.js";
import type { RemoteConnectionFieldsProps } from "./types.js";

interface ServerConnectionFieldsProps extends RemoteConnectionFieldsProps {
  fieldId: string;
}

/** Server 连接字段：服务地址、展示名、令牌与工作区路径。 */
export function ServerConnectionFields({
  fieldId,
  fieldErrors = [],
  focusCredentials,
  serverUrl,
  serverName,
  serverToken,
  serverWorkspacePath,
  setServerUrl,
  setServerName,
  setServerToken,
  setServerWorkspacePath,
}: ServerConnectionFieldsProps) {
  const { intl } = useZCodeIntl();
  const { errorOf, errorId, invalidProps } = createRemoteFieldErrorHelpers(fieldId, fieldErrors);

  return (
    <div className="space-y-3">
      <p className="text-pretty text-ui-base text-remote-foreground-muted">
        {intl.formatMessage({ id: "server.description" })}
      </p>
      <div>
        <label
          htmlFor={`${fieldId}-server.url`}
          className="mb-1.5 block text-ui-sm text-remote-foreground-muted"
        >
          {intl.formatMessage({ id: "server.url" })}
        </label>
        <Input
          size="lg"
          className="h-9 text-ui-base"
          value={serverUrl}
          onChange={(event) => setServerUrl(event.target.value)}
          placeholder={intl.formatMessage({ id: "server.urlPlaceholder" })}
          autoCapitalize="none"
          spellCheck={false}
          id={`${fieldId}-server.url`}
          {...invalidProps("serverUrl")}
          data-testid={TID_SERVER_URL_INPUT}
        />
        <FieldError id={errorId("serverUrl")} message={errorOf("serverUrl")} />
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <div>
          <label
            htmlFor={`${fieldId}-server.name`}
            className="mb-1.5 block text-ui-sm text-remote-foreground-muted"
          >
            {intl.formatMessage({ id: "server.name" })}
          </label>
          <Input
            size="lg"
            className="h-9 text-ui-base"
            value={serverName}
            onChange={(event) => setServerName(event.target.value)}
            placeholder={intl.formatMessage({
              id: "server.namePlaceholder",
            })}
            id={`${fieldId}-server.name`}
            data-testid={TID_SERVER_NAME_INPUT}
          />
        </div>
        <div>
          <label
            htmlFor={`${fieldId}-server.token`}
            className="mb-1.5 block text-ui-sm text-remote-foreground-muted"
          >
            {intl.formatMessage({ id: "server.token" })}
          </label>
          <RemotePasswordInput
            size="lg"
            className="h-9 text-ui-base"
            autoFocus={focusCredentials}
            value={serverToken}
            onChange={(event) => setServerToken(event.target.value)}
            placeholder={intl.formatMessage({
              id: "server.tokenPlaceholder",
            })}
            autoComplete="off"
            id={`${fieldId}-server.token`}
            data-testid={TID_SERVER_TOKEN_INPUT}
          />
        </div>
      </div>
      <div>
        <label
          htmlFor={`${fieldId}-server.workspacePath`}
          className="mb-1.5 block text-ui-sm text-remote-foreground-muted"
        >
          {intl.formatMessage({ id: "server.workspacePath" })}
        </label>
        <Input
          size="lg"
          className="h-9 text-ui-base"
          value={serverWorkspacePath}
          onChange={(event) => setServerWorkspacePath(event.target.value)}
          placeholder={intl.formatMessage({
            id: "server.workspacePathPlaceholder",
          })}
          autoCapitalize="none"
          spellCheck={false}
          id={`${fieldId}-server.workspacePath`}
          data-testid={TID_SERVER_WORKSPACE_PATH_INPUT}
        />
        <p className="mt-1 text-pretty text-ui-base text-remote-foreground-muted">
          {intl.formatMessage({ id: "server.workspacePathDescription" })}
        </p>
      </div>
    </div>
  );
}
