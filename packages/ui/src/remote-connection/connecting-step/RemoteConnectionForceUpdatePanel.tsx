import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { RemoteConnectionForceUpdate } from "@/remote-connection/connecting-step/types.js";

/** 强制更新确认占据部署阶段：列出会被中断的任务，确认与取消都走连接流程回调。 */
export function RemoteConnectionForceUpdatePanel({
  forceUpdate,
}: {
  forceUpdate: RemoteConnectionForceUpdate;
}) {
  const { intl } = useZCodeIntl();
  return (
    <div className="mt-2 space-y-2 rounded-sm bg-warning-surface p-3 text-warning-surface-foreground">
      <p className="font-medium">
        {intl.formatMessage({ id: "settings.source.forceUpdateTitle" })}
      </p>
      <p>
        {intl.formatMessage({
          id: "settings.source.forceUpdateDescription",
        })}
      </p>
      {forceUpdate.tasks?.length ? (
        <ul className="space-y-1">
          {forceUpdate.tasks.map((task) => (
            <li
              key={`${task.workspaceIdentity ?? task.workspacePath}:${task.sessionId}`}
              className="break-all text-ui-sm"
            >
              <span>{task.sessionId}</span>
              <span className="ml-2 font-mono">{task.workspacePath}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p>
          {intl.formatMessage({
            id: "remote.runningTasksUnavailable",
          })}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="button" size="sm" variant="destructive" onClick={forceUpdate.onConfirm}>
          {intl.formatMessage({ id: "settings.source.forceUpdate" })}
        </Button>
        <Button type="button" size="sm" variant="secondary" onClick={forceUpdate.onCancel}>
          {intl.formatMessage({ id: "remote.cancelConnection" })}
        </Button>
      </div>
    </div>
  );
}
