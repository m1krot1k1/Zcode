import type {
  ConnectionProfile,
  SourceServerRecord,
  SourceServerWorkspaceHistoryEntry,
} from "@zcode/shared";
import { ArrowUpRight, Folder } from "lucide-react";
import { resolveWorkspaceKey } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { getPathLeaf } from "@/lib/path.js";
import { usePanelRuntime } from "./panelContext.js";
import {
  COLLAPSED_PROJECT_COUNT,
  formatRelativeTimestamp,
  toggleSetItem,
} from "./panelModel.js";

export function DeviceProjects({
  server,
  projects,
  projectsExpanded,
  openedProjectPaths,
  displayedProfile,
  deviceBusy,
}: {
  server: SourceServerRecord;
  projects: SourceServerWorkspaceHistoryEntry[];
  projectsExpanded: boolean;
  openedProjectPaths: Set<string>;
  displayedProfile?: ConnectionProfile;
  deviceBusy: boolean;
}) {
  const { intl, locale } = useZCodeIntl();
  const { run, onOpenProject, setExpandedProjectSources } = usePanelRuntime();
  const visibleProjects = projectsExpanded
    ? projects
    : projects.slice(0, COLLAPSED_PROJECT_COUNT);

  return (
    <div className="order-3 basis-full min-w-0" data-device-projects>
      {projects.length === 0 ? (
        <p className="text-ui-sm text-remote-foreground-muted">
          {intl.formatMessage({ id: "settings.source.projectCount" }, { count: 0 })}
        </p>
      ) : (
        <>
          <div className="flex min-w-0 items-center justify-between gap-2">
            <p className="text-ui-xs font-medium text-remote-foreground-muted">
              {intl.formatMessage({ id: "settings.source.recentProjects" })}
            </p>
            {/* Bug 原因：旧实现超出三个只显示不可点击的 +N，其余项目在此处无法打开。 */}
            {projects.length > COLLAPSED_PROJECT_COUNT ? (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                className="text-remote-foreground-muted"
                aria-expanded={projectsExpanded}
                onClick={() =>
                  setExpandedProjectSources((current) =>
                    toggleSetItem(current, server.sourceServerId),
                  )
                }
              >
                {intl.formatMessage(
                  {
                    id: projectsExpanded
                      ? "settings.source.showLessProjects"
                      : "settings.source.showAllProjects",
                  },
                  { count: projects.length },
                )}
              </Button>
            ) : null}
          </div>
          <div className="mt-1 min-w-0">
            {visibleProjects.map((project) => {
              const projectName =
                server.declaredWorkspaces?.find(
                  (item) => item.workspacePath === project.workspacePath,
                )?.label ?? getPathLeaf(project.workspacePath);
              return (
                <Button
                  key={resolveWorkspaceKey(project)}
                  data-device-project
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="group/project -mx-2 h-auto w-[calc(100%+1rem)] min-w-0 justify-start gap-2 px-2 py-1.5"
                  aria-label={projectName}
                  title={project.workspacePath}
                  disabled={!onOpenProject || deviceBusy}
                  onClick={() =>
                    void run(
                      `open:${resolveWorkspaceKey(project)}`,
                      () =>
                        onOpenProject?.(
                          server.sourceServerId,
                          project.workspacePath,
                          displayedProfile?.profileId,
                        ) ?? Promise.resolve(),
                      [`source:${server.sourceServerId}`],
                    )
                  }
                >
                  <Folder className="size-3.5 text-remote-foreground-muted" />
                  <span className="max-w-48 shrink-0 truncate text-ui-sm font-medium">
                    {projectName}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-left font-mono text-ui-xs text-remote-foreground-muted">
                    {project.workspacePath}
                  </span>
                  {openedProjectPaths.has(project.workspacePath) ? (
                    <span className="shrink-0 rounded-md bg-tag px-1.5 py-0.5 text-ui-xs text-remote-foreground-muted">
                      {intl.formatMessage({ id: "settings.source.projectOpened" })}
                    </span>
                  ) : null}
                  <span className="shrink-0 text-ui-xs text-remote-foreground-muted">
                    {formatRelativeTimestamp(
                      project.lastOpenedAt,
                      locale,
                      intl.formatMessage,
                    )}
                  </span>
                  <ArrowUpRight className="size-3.5 text-remote-foreground-muted opacity-0 group-hover/project:opacity-100 group-focus-visible/project:opacity-100" />
                </Button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
