import type { ReactNode } from "react";
import { Braces, GitBranch, Moon, Network, Radio, Search, Sun, Waypoints } from "lucide-react";
import type { DocsView } from "./routing.js";

interface DocsHeaderProps {
  activeView: DocsView;
  isDark: boolean;
  onQueryChange: (query: string) => void;
  onSelectView: (view: DocsView) => void;
  onToggleDark: () => void;
  query: string;
}

function getViewDescription(view: DocsView) {
  return view === "capabilities"
    ? "产品能力群、维护边界与跨域语义关系"
    : view === "boundary"
      ? "feature-boundary-planner YAML 的节点、关系与边界"
      : view === "protocol"
        ? "trace / input / session 数据结构迁移与协议字段说明"
        : "Agent stdio 实时抓包与协议帧检查";
}

export function DocsHeader({
  activeView,
  isDark,
  onQueryChange,
  onSelectView,
  onToggleDark,
  query,
}: DocsHeaderProps) {
  return (
    <header className="sticky top-0 z-20 border-b border-border bg-header/95 backdrop-blur">
      <div className="mx-auto flex max-w-7xl flex-col gap-3 px-4 py-3 md:flex-row md:items-center md:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <div className="grid size-8 shrink-0 place-items-center rounded-lg border border-card-border bg-card">
            <Network className="size-4 text-brand" />
          </div>
          <div className="min-w-0">
            <h1 className="text-ui-lg font-medium">ZCode Developer Docs</h1>
            <p className="text-ui-sm text-foreground-subtle">{getViewDescription(activeView)}</p>
          </div>
        </div>
        <div className="flex min-w-0 flex-col gap-2 md:flex-row md:items-center">
          <nav className="grid grid-cols-4 rounded-lg border border-border bg-surface p-0.5">
            <ViewButton
              active={activeView === "stdio"}
              icon={<Radio className="size-4" />}
              label="stdio 抓包"
              mobileLabel="stdio"
              onClick={() => onSelectView("stdio")}
            />
            <ViewButton
              active={activeView === "protocol"}
              icon={<Braces className="size-4" />}
              label="协议字段"
              mobileLabel="协议"
              onClick={() => onSelectView("protocol")}
            />
            <ViewButton
              active={activeView === "capabilities"}
              icon={<Waypoints className="size-4" />}
              label="能力地图"
              mobileLabel="能力"
              onClick={() => onSelectView("capabilities")}
            />
            <ViewButton
              active={activeView === "boundary"}
              icon={<GitBranch className="size-4" />}
              label="Feature Boundary"
              mobileLabel="边界"
              onClick={() => onSelectView("boundary")}
            />
          </nav>
          {activeView === "protocol" ? (
            <label className="relative min-w-0 flex-1 md:w-80 md:flex-none">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-foreground-subtlest" />
              <input
                className="h-8 w-full rounded-lg border border-input-border bg-input pl-8 pr-3 text-ui-base text-foreground outline-none placeholder:text-foreground-subtlest focus:border-input-border-focused focus:bg-input-focused"
                value={query}
                onChange={(event) => onQueryChange(event.target.value)}
                placeholder="搜索字段、结构、概念"
              />
            </label>
          ) : null}
          <button
            className="grid size-8 shrink-0 place-items-center rounded-md border border-border bg-surface text-foreground hover:bg-surface-hover"
            type="button"
            onClick={onToggleDark}
            aria-label={isDark ? "切换浅色主题" : "切换深色主题"}
            title={isDark ? "切换浅色主题" : "切换深色主题"}
          >
            {isDark ? <Sun className="size-4" /> : <Moon className="size-4" />}
          </button>
        </div>
      </div>
    </header>
  );
}

function ViewButton({
  active,
  icon,
  label,
  mobileLabel,
  onClick,
}: {
  active: boolean;
  icon: ReactNode;
  label: string;
  mobileLabel?: string;
  onClick: () => void;
}) {
  return (
    <button
      aria-pressed={active}
      className={`inline-flex h-7 items-center justify-center gap-1.5 rounded-md px-2 text-ui-sm ${
        active
          ? "bg-card text-foreground shadow-sm"
          : "text-foreground-subtle hover:bg-surface-hover hover:text-foreground"
      }`}
      type="button"
      onClick={onClick}
    >
      {icon}
      <span className="hidden sm:inline">{label}</span>
      <span className="sm:hidden">{mobileLabel ?? label}</span>
    </button>
  );
}
