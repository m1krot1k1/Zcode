import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  ArrowDown,
  ArrowUp,
  Database,
  FileJson,
  Filter,
  HardDrive,
  ListFilter,
  Pause,
  Play,
  Radio,
  Search,
  Terminal,
} from "lucide-react";
import {
  stdioTrafficFrames,
  stdioTrafficLogFields,
  type StdioTrafficFrame,
} from "@/data/protocolDocs.js";
import { normalizeText } from "./docs-model.js";
import {
  DirectionButton,
  InspectorAction,
  TrafficFrameDetail,
  TrafficFrameRow,
  TrafficStat,
} from "./stdio-traffic-panels.js";
import {
  createLiveStdioTrafficFrame,
  directionLabel,
  formatIsoTrafficTimestamp,
  formatTrafficTimestamp,
  mapRealTrafficFrames,
  sortTrafficFramesByNewest,
  type DirectionFilter,
  type RealTrafficState,
  type StdioTrafficApiResponse,
  type TrafficSourceMode,
} from "./stdio-traffic-model.js";

export function StdioTrafficView() {
  const initialFrames = useMemo(() => sortTrafficFramesByNewest(stdioTrafficFrames), []);
  const [trafficFrames, setTrafficFrames] = useState<StdioTrafficFrame[]>([]);
  const [trafficQuery, setTrafficQuery] = useState("");
  const [directionFilter, setDirectionFilter] = useState<DirectionFilter>("all");
  const [trafficSourceMode, setTrafficSourceMode] = useState<TrafficSourceMode>("real");
  const [isFollowingLatest, setIsFollowingLatest] = useState(true);
  const [selectedFrameId, setSelectedFrameId] = useState("");
  const [lastUpdatedAt, setLastUpdatedAt] = useState("--:--:--.---");
  const [realTraffic, setRealTraffic] = useState<RealTrafficState>({
    status: "loading",
    logDir: "~/.zcode/v2/dev/stdio-traffic",
    records: [],
  });
  const liveSequenceRef = useRef(0);
  const normalizedTrafficQuery = normalizeText(trafficQuery);
  const latestFrame = trafficFrames[0];
  const isMockReplayEnabled = trafficSourceMode === "mock";

  const fetchRealTraffic = useCallback(async () => {
    try {
      const response = await fetch("/api/dev/stdio-traffic?limit=400", { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const data = (await response.json()) as StdioTrafficApiResponse;
      setRealTraffic({
        status: data.status,
        logDir: data.logDir,
        records: Array.isArray(data.records) ? data.records : [],
        error: data.error,
        filePath: data.filePath,
        updatedAt: data.updatedAt,
        workspaceHash: data.workspaceHash,
      });
    } catch (error) {
      setRealTraffic((current) => ({
        ...current,
        status: "error",
        error: error instanceof Error ? error.message : String(error),
        records: [],
      }));
    }
  }, []);

  useEffect(() => {
    if (trafficSourceMode !== "real") {
      return;
    }

    void fetchRealTraffic();
    const timer = window.setInterval(() => {
      void fetchRealTraffic();
    }, 1000);

    return () => window.clearInterval(timer);
  }, [fetchRealTraffic, trafficSourceMode]);

  useEffect(() => {
    if (trafficSourceMode !== "real") {
      return;
    }

    const realFrames = sortTrafficFramesByNewest(mapRealTrafficFrames(realTraffic));
    setTrafficFrames(realFrames);
    setLastUpdatedAt(
      realTraffic.updatedAt
        ? formatIsoTrafficTimestamp(realTraffic.updatedAt)
        : (realFrames[0]?.timestamp ?? "--:--:--.---"),
    );
    setSelectedFrameId((currentFrameId) =>
      isFollowingLatest || !realFrames.some((frame) => frame.id === currentFrameId)
        ? (realFrames[0]?.id ?? "")
        : currentFrameId,
    );
  }, [isFollowingLatest, realTraffic, trafficSourceMode]);

  useEffect(() => {
    if (!isMockReplayEnabled) {
      return;
    }

    // mock replay 只用于演示；真实调试默认走 Vite 本地 API 读取 tap proxy 的 NDJSON。
    const timer = window.setInterval(() => {
      liveSequenceRef.current += 1;
      const nextFrame = createLiveStdioTrafficFrame(
        liveSequenceRef.current,
        formatTrafficTimestamp(new Date()),
      );

      setTrafficFrames((currentFrames) =>
        sortTrafficFramesByNewest([nextFrame, ...currentFrames]).slice(0, 48),
      );
      setLastUpdatedAt(nextFrame.timestamp);

      if (isFollowingLatest) {
        setSelectedFrameId(nextFrame.id);
      }
    }, 1800);

    return () => window.clearInterval(timer);
  }, [isFollowingLatest, isMockReplayEnabled]);

  const followLatest = () => {
    setIsFollowingLatest(true);
    setSelectedFrameId(trafficFrames[0]?.id ?? "");
  };

  const startMockReplay = () => {
    liveSequenceRef.current = 0;
    setTrafficFrames(initialFrames);
    setLastUpdatedAt(initialFrames[0]?.timestamp ?? "--:--:--.---");
    setIsFollowingLatest(true);
    setTrafficSourceMode("mock");
    setSelectedFrameId(initialFrames[0]?.id ?? "");
  };

  const stopMockReplay = () => {
    liveSequenceRef.current = 0;
    setTrafficSourceMode("real");
    void fetchRealTraffic();
  };

  const refreshTrafficSource = () => {
    if (trafficSourceMode === "mock") {
      startMockReplay();
      return;
    }

    void fetchRealTraffic();
  };

  const filteredFrames = useMemo(
    () =>
      sortTrafficFramesByNewest(
        trafficFrames.filter((frame) => {
          const directionMatches = directionFilter === "all" || frame.direction === directionFilter;
          if (!directionMatches) {
            return false;
          }
          if (!normalizedTrafficQuery) {
            return true;
          }
          const haystack = [
            frame.id,
            frame.timestamp,
            frame.direction,
            frame.kind,
            frame.method ?? "",
            frame.messageId ?? "",
            frame.sessionId ?? "",
            frame.inputId ?? "",
            frame.summary,
            frame.raw,
          ]
            .join(" ")
            .toLowerCase();
          return haystack.includes(normalizedTrafficQuery);
        }),
      ),
    [directionFilter, normalizedTrafficQuery, trafficFrames],
  );

  const selectedFrame =
    filteredFrames.find((frame) => frame.id === selectedFrameId) ??
    trafficFrames.find((frame) => frame.id === selectedFrameId) ??
    filteredFrames[0] ??
    trafficFrames[0];

  const linkedFrame = selectedFrame?.linkedId
    ? trafficFrames.find((frame) => frame.id === selectedFrame.linkedId)
    : undefined;
  const trafficStatusLabel =
    trafficSourceMode === "mock"
      ? "mock replay"
      : realTraffic.status === "ready"
        ? "real tail"
        : realTraffic.status;
  const trafficStatusClassName =
    trafficSourceMode === "mock"
      ? "border-warning/35 bg-warning/12 text-foreground"
      : realTraffic.status === "ready"
        ? "border-success/35 bg-success/12 text-foreground"
        : "border-border bg-surface text-foreground-subtle";
  const sourcePath =
    trafficSourceMode === "mock"
      ? "mock replay"
      : (realTraffic.filePath ?? realTraffic.logDir ?? "~/.zcode/v2/dev/stdio-traffic");
  const emptyTrafficMessage =
    trafficSourceMode === "mock"
      ? "mock replay 暂无 frame。"
      : realTraffic.status === "missing"
        ? "没有找到 stdio tap 文件。先在开发环境 Help 里打开抓取开关并启动一个 agent。"
        : realTraffic.status === "error"
          ? `读取 stdio tap 失败：${realTraffic.error ?? "unknown error"}`
          : "等待真实 stdio traffic。";

  return (
    <main className="grid w-full gap-4 px-4 py-4 xl:grid-cols-[minmax(0,1fr)_320px]">
      <div className="min-w-0">
        <section className="rounded-lg border border-card-border bg-card">
          <div className="border-b border-border p-3">
            <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
              <div className="flex items-center gap-2">
                <Activity className="size-4 text-brand" />
                <h2 className="whitespace-nowrap text-ui-lg font-medium">Traffic Inspector</h2>
                <span
                  className={`rounded-full border px-2 py-0.5 font-mono text-ui-xs ${trafficStatusClassName}`}
                >
                  {trafficStatusLabel}
                </span>
                <span className="font-mono text-ui-sm text-foreground-subtle">
                  latest {lastUpdatedAt}
                </span>
              </div>
              <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center">
                <label className="relative min-w-0 sm:w-72">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-foreground-subtlest" />
                  <input
                    className="h-8 w-full rounded-lg border border-input-border bg-input pl-8 pr-3 text-ui-base text-foreground outline-none placeholder:text-foreground-subtlest focus:border-input-border-focused focus:bg-input-focused"
                    value={trafficQuery}
                    onChange={(event) => setTrafficQuery(event.target.value)}
                    placeholder="搜索 method、id、inputId、raw"
                  />
                </label>
                <div className="flex rounded-lg border border-border bg-surface p-0.5">
                  <DirectionButton
                    active={directionFilter === "all"}
                    icon={<ListFilter className="size-3.5" />}
                    label="全部"
                    onClick={() => setDirectionFilter("all")}
                  />
                  <DirectionButton
                    active={directionFilter === "app-to-agent"}
                    icon={<ArrowUp className="size-3.5" />}
                    label="上行"
                    onClick={() => setDirectionFilter("app-to-agent")}
                  />
                  <DirectionButton
                    active={directionFilter === "agent-to-app"}
                    icon={<ArrowDown className="size-3.5" />}
                    label="下行"
                    onClick={() => setDirectionFilter("agent-to-app")}
                  />
                  <DirectionButton
                    active={directionFilter === "agent-stderr"}
                    icon={<Terminal className="size-3.5" />}
                    label="stderr"
                    onClick={() => setDirectionFilter("agent-stderr")}
                  />
                </div>
              </div>
            </div>
          </div>

          <div className="grid min-h-[calc(100dvh-160px)] lg:grid-cols-[minmax(0,0.9fr)_minmax(520px,1.1fr)]">
            <div className="min-w-0 border-b border-border lg:border-b-0 lg:border-r">
              <div className="grid grid-cols-[84px_120px_minmax(0,1fr)_88px] border-b border-border bg-surface px-3 py-2 text-ui-sm font-medium text-foreground-subtle">
                <span>时间</span>
                <span>方向</span>
                <span>方法 / 摘要</span>
                <span className="text-right">大小</span>
              </div>
              <div className="max-h-[520px] overflow-y-auto">
                {filteredFrames.map((frame) => (
                  <TrafficFrameRow
                    active={frame.id === selectedFrame?.id}
                    frame={frame}
                    key={frame.id}
                    onSelect={() => {
                      setSelectedFrameId(frame.id);
                      setIsFollowingLatest(frame.id === trafficFrames[0]?.id);
                    }}
                  />
                ))}
                {filteredFrames.length === 0 ? (
                  <div className="p-4 text-ui-base text-foreground-subtle">
                    {emptyTrafficMessage}
                  </div>
                ) : null}
              </div>
            </div>

            <TrafficFrameDetail frame={selectedFrame} linkedFrame={linkedFrame} />
          </div>
        </section>
      </div>

      <aside className="space-y-4 xl:sticky xl:top-20 xl:self-start">
        <section className="rounded-lg border border-card-border bg-card p-3">
          <div className="mb-3 flex items-center gap-2 text-ui-sm font-medium text-brand">
            <HardDrive className="size-4" />
            Tail Source
          </div>
          <div className="grid gap-2">
            <TrafficStat label="状态" value={trafficStatusLabel} />
            <TrafficStat label="跟随" value={isFollowingLatest ? "latest" : "selected"} />
            <TrafficStat label="帧数" value={String(trafficFrames.length)} />
            <TrafficStat
              label="最新方向"
              value={latestFrame ? directionLabel[latestFrame.direction] : "-"}
            />
            <TrafficStat label="workspaceHash" value={realTraffic.workspaceHash ?? "-"} />
          </div>
          <div className="mt-3 rounded-lg border border-border bg-surface p-2">
            <div className="mb-1 flex items-center gap-2 text-ui-sm font-medium text-foreground-subtle">
              <Terminal className="size-4" />
              source
            </div>
            <code className="block break-words font-mono text-ui-xs leading-5 text-foreground">
              {sourcePath}
            </code>
          </div>
        </section>

        <section className="rounded-lg border border-card-border bg-card p-3">
          <div className="mb-3 flex items-center gap-2 text-ui-sm font-medium text-brand">
            <Filter className="size-4" />
            Controls
          </div>
          <div className="grid gap-2">
            <InspectorAction
              active={isFollowingLatest}
              icon={<Radio className="size-4" />}
              label="Follow latest"
              onClick={followLatest}
            />
            <InspectorAction
              active={isMockReplayEnabled}
              icon={
                isMockReplayEnabled ? <Pause className="size-4" /> : <Play className="size-4" />
              }
              label={isMockReplayEnabled ? "Stop mock replay" : "Start mock replay"}
              onClick={isMockReplayEnabled ? stopMockReplay : startMockReplay}
            />
            <InspectorAction
              icon={<FileJson className="size-4" />}
              label={trafficSourceMode === "mock" ? "Reset mock" : "Reload real source"}
              onClick={refreshTrafficSource}
            />
          </div>
        </section>

        <section className="rounded-lg border border-card-border bg-card p-3">
          <div className="mb-3 flex items-center gap-2 text-ui-sm font-medium text-brand">
            <Database className="size-4" />
            record 字段
          </div>
          <div className="space-y-2">
            {stdioTrafficLogFields.map((field) => (
              <div className="rounded-lg border border-border bg-surface p-2" key={field.name}>
                <div className="flex items-center justify-between gap-2">
                  <code className="font-mono text-ui-sm text-foreground">{field.name}</code>
                  <span className="font-mono text-ui-xs text-foreground-subtlest">
                    {field.type}
                  </span>
                </div>
                <p className="mt-1 text-ui-sm leading-5 text-foreground-subtle">{field.meaning}</p>
              </div>
            ))}
          </div>
        </section>
      </aside>
    </main>
  );
}
