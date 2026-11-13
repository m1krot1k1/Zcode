import type { ReactNode } from "react";
import { FileJson, GitCompareArrows } from "lucide-react";
import type { StdioTrafficFrame } from "@/data/protocolDocs.js";
import { directionClassName, directionLabel, formatRawLine } from "./stdio-traffic-model.js";

export function TrafficStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-surface p-3">
      <div className="text-ui-sm text-foreground-subtle">{label}</div>
      <div className="mt-1 truncate font-mono text-ui-base text-foreground" title={value}>
        {value}
      </div>
    </div>
  );
}

export function DirectionButton({
  active,
  icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      aria-pressed={active}
      className={`inline-flex h-7 items-center gap-1 rounded-md px-2 text-ui-sm whitespace-nowrap ${
        active
          ? "bg-card text-foreground shadow-sm"
          : "text-foreground-subtle hover:bg-surface-hover hover:text-foreground"
      }`}
      type="button"
      onClick={onClick}
    >
      {icon}
      {label}
    </button>
  );
}

export function TrafficFrameRow({
  active,
  frame,
  onSelect,
}: {
  active: boolean;
  frame: StdioTrafficFrame;
  onSelect: () => void;
}) {
  return (
    <button
      className={`grid w-full grid-cols-[84px_120px_minmax(0,1fr)_88px] items-start gap-0 border-b border-border px-3 py-2 text-left hover:bg-surface-hover ${
        active ? "bg-selected" : ""
      }`}
      type="button"
      onClick={onSelect}
    >
      <span className="font-mono text-ui-sm text-foreground-subtle">{frame.timestamp}</span>
      <span
        className={`mr-2 inline-flex w-fit rounded-full border px-2 py-0.5 font-mono text-ui-xs ${directionClassName[frame.direction]}`}
      >
        {directionLabel[frame.direction]}
      </span>
      <span className="min-w-0">
        <span className="block truncate font-mono text-ui-sm text-foreground">
          {frame.method ?? frame.kind}
          {frame.messageId ? (
            <span className="text-foreground-subtlest"> #{frame.messageId}</span>
          ) : null}
        </span>
        <span className="mt-1 block truncate text-ui-sm text-foreground-subtle">
          {frame.summary}
        </span>
      </span>
      <span className="text-right font-mono text-ui-sm text-foreground-subtle">{frame.bytes}b</span>
    </button>
  );
}

export function TrafficFrameDetail({
  frame,
  linkedFrame,
}: {
  frame: StdioTrafficFrame | undefined;
  linkedFrame: StdioTrafficFrame | undefined;
}) {
  if (!frame) {
    return (
      <div className="p-4 text-ui-base text-foreground-subtle">请选择一条 traffic frame。</div>
    );
  }

  return (
    <aside className="min-w-0 p-3">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="mb-1 flex items-center gap-2">
            <span
              className={`inline-flex rounded-full border px-2 py-0.5 font-mono text-ui-xs ${directionClassName[frame.direction]}`}
            >
              {directionLabel[frame.direction]}
            </span>
            <span className="font-mono text-ui-sm text-foreground-subtle">{frame.timestamp}</span>
          </div>
          <h3 className="truncate text-ui-base font-medium">{frame.method ?? frame.kind}</h3>
          <p className="mt-1 text-ui-sm leading-5 text-foreground-subtle">{frame.summary}</p>
        </div>
      </div>

      <div className="grid gap-2 text-ui-sm">
        <DetailPill label="kind" value={frame.kind} />
        {frame.messageId ? <DetailPill label="id" value={frame.messageId} /> : null}
        {frame.sessionId ? <DetailPill label="session" value={frame.sessionId} /> : null}
        {frame.inputId ? <DetailPill label="input" value={frame.inputId} /> : null}
        {typeof frame.latencyMs === "number" ? (
          <DetailPill label="latency" value={`${frame.latencyMs}ms`} />
        ) : null}
      </div>

      {linkedFrame ? (
        <div className="mt-3 rounded-lg border border-border bg-surface p-3">
          <div className="mb-1 flex items-center gap-2 text-ui-sm font-medium text-foreground">
            <GitCompareArrows className="size-4 text-brand" />
            配对帧
          </div>
          <p className="font-mono text-ui-sm text-foreground-subtle">
            {linkedFrame.timestamp} · {linkedFrame.method ?? linkedFrame.kind}
            {linkedFrame.messageId ? ` #${linkedFrame.messageId}` : ""}
          </p>
          <p className="mt-1 text-ui-sm leading-5 text-foreground-subtle">{linkedFrame.summary}</p>
        </div>
      ) : null}

      <div className="mt-3">
        <div className="mb-2 flex items-center gap-2 text-ui-sm font-medium text-foreground-subtle">
          <FileJson className="size-4" />
          raw line
        </div>
        <code className="block max-h-[calc(100dvh-420px)] min-h-[420px] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-surface p-3 font-mono text-ui-sm leading-5 text-foreground">
          {formatRawLine(frame.raw)}
        </code>
      </div>
    </aside>
  );
}

function DetailPill({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-surface px-2 py-1.5">
      <span className="text-foreground-subtle">{label}</span>
      <span className="min-w-0 truncate font-mono text-foreground" title={value}>
        {value}
      </span>
    </div>
  );
}

export function InspectorAction({
  active = false,
  icon,
  label,
  onClick,
}: {
  active?: boolean;
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      className={`inline-flex h-8 items-center gap-2 rounded-md border px-2 text-left text-ui-sm text-foreground hover:bg-surface-hover ${
        active ? "border-brand/35 bg-selected" : "border-border bg-surface"
      }`}
      type="button"
      onClick={onClick}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}
