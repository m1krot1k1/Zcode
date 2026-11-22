import type { RefObject } from "react";
import { AlertTriangleIcon, LoaderIcon } from "lucide-react";
import { TID_SSH_ERROR } from "@zcode/shared/test-ids";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  classifyRemoteConnectionError,
  resolveRemoteConnectionPresentation,
} from "@/lib/remoteConnectionPresentation.js";
import { RemotePasswordInput } from "@/remote-connection/RemotePasswordInput.js";
import type { RemoteConnectionCredentialsForm } from "@/remote-connection/connecting-step/types.js";

/** 错误和凭据等待嵌入所属阶段；详细日志只在失败后展开。 */
export function RemoteConnectionErrorPanel({
  errorMessage,
  credentials,
  credentialInputId,
  rawError,
  loading,
  upgradeLoading,
  presentation,
  errorPresentation,
  errorDetailsRef,
  onPrimaryAction,
  onBack,
  onUseRemoteDownload,
  onOpenFeedback,
}: {
  errorMessage: string;
  credentials?: RemoteConnectionCredentialsForm;
  credentialInputId: string;
  rawError?: string;
  loading: boolean;
  upgradeLoading: boolean;
  presentation: ReturnType<typeof resolveRemoteConnectionPresentation>;
  errorPresentation: ReturnType<typeof classifyRemoteConnectionError>;
  errorDetailsRef: RefObject<HTMLDetailsElement | null>;
  onPrimaryAction: () => void;
  onBack: () => void;
  onUseRemoteDownload?: () => void;
  onOpenFeedback: () => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <div
      data-testid={TID_SSH_ERROR}
      className={cn(
        "space-y-2 rounded-sm border px-3.5 py-3",
        presentation.border,
        presentation.surface,
      )}
    >
      <p className={cn("flex items-center gap-2 text-ui-sm font-medium", presentation.foreground)}>
        {upgradeLoading ? (
          <LoaderIcon className="size-4 shrink-0 animate-spin" />
        ) : (
          <AlertTriangleIcon className="size-4 shrink-0" />
        )}
        {intl.formatMessage({
          id: upgradeLoading
            ? presentation.shortMessageId
            : credentials && !errorMessage
              ? "remote.error.credentialsRequired"
              : errorPresentation.titleId,
        })}
      </p>
      {!upgradeLoading && errorMessage ? (
        <>
          <p className="text-ui-xs text-remote-foreground-muted">
            {intl.formatMessage({ id: errorPresentation.reasonId })}
          </p>
          <details ref={errorDetailsRef} className="text-ui-xs text-remote-foreground-muted">
            <summary className="cursor-pointer">
              {intl.formatMessage({ id: "remote.error.details" })}
            </summary>
            <pre className="whitespace-pre-wrap break-words">{rawError ?? errorMessage}</pre>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                void navigator.clipboard.writeText(rawError ?? errorMessage);
              }}
            >
              {intl.formatMessage({ id: "chat.toolCall.copyError" })}
            </Button>
          </details>
        </>
      ) : null}
      {credentials ? (
        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            credentials.onSubmit();
          }}
        >
          <label htmlFor={credentialInputId} className="block text-ui-sm">
            {intl.formatMessage({
              id: credentials.passphrase ? "ssh.privateKeyPassphrase" : "ssh.password",
            })}
          </label>
          <RemotePasswordInput
            id={credentialInputId}
            autoFocus
            required
            className="mt-1"
            data-testid={
              credentials.passphrase ? "ssh-private-key-passphrase-input" : "ssh-password-input"
            }
            value={credentials.value}
            onChange={(event) => credentials.onChange(event.target.value)}
          />
          <Button type="submit" size="sm" disabled={loading || !credentials.value}>
            {intl.formatMessage({ id: "remote.startConnection" })}
          </Button>
        </form>
      ) : null}
      <div className="flex flex-wrap gap-2 pt-1">
        {!credentials ? (
          <Button
            type="button"
            size="sm"
            onClick={onPrimaryAction}
            disabled={loading || upgradeLoading}
          >
            {upgradeLoading ? (
              <LoaderIcon className="size-3.5 animate-spin" aria-hidden="true" />
            ) : null}
            {intl.formatMessage({
              id: presentation.actionMessageId,
            })}
          </Button>
        ) : null}
        {onUseRemoteDownload && errorPresentation.allowRemoteDownload ? (
          <Button type="button" variant="secondary" size="sm" onClick={onUseRemoteDownload}>
            {intl.formatMessage({ id: "remote.useRemoteDownload" })}
          </Button>
        ) : null}
        <Button type="button" variant="secondary" size="sm" onClick={onBack}>
          {intl.formatMessage({ id: "remote.backToConnection" })}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            onOpenFeedback();
          }}
        >
          {intl.formatMessage({ id: "remoteConnection.feedback" })}
        </Button>
      </div>
    </div>
  );
}
