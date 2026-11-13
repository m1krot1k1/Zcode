import { Suspense, lazy, useState } from "react";
import { DocsHeader } from "./navigation.js";
import { ProtocolView } from "./protocol-page.js";
import { useDocsView } from "./routing.js";
import { StdioTrafficView } from "./stdio-traffic-page.js";

const CapabilityMapView = lazy(() => import("@/capability-map/CapabilityMapView.js"));
const FeatureBoundaryGraphView = lazy(
  () => import("@/feature-boundary-graph/FeatureBoundaryGraphView.js"),
);

export function App() {
  const { activeView, selectView } = useDocsView();
  const [query, setQuery] = useState("");
  const [activeConceptId, setActiveConceptId] = useState("inputId");
  const [isDark, setIsDark] = useState(false);

  return (
    <div className={isDark ? "dark min-h-dvh" : "min-h-dvh"}>
      <div className="min-h-dvh bg-background text-foreground">
        <DocsHeader
          activeView={activeView}
          isDark={isDark}
          onQueryChange={setQuery}
          onSelectView={selectView}
          onToggleDark={() => setIsDark((value) => !value)}
          query={query}
        />

        {activeView === "stdio" ? (
          <StdioTrafficView />
        ) : activeView === "boundary" ? (
          <Suspense
            fallback={
              <main className="grid min-h-[680px] place-items-center p-4 text-ui-base text-foreground-subtle">
                正在加载 Feature Boundary 图谱…
              </main>
            }
          >
            <FeatureBoundaryGraphView />
          </Suspense>
        ) : activeView === "capabilities" ? (
          <Suspense
            fallback={
              <main className="grid min-h-[680px] place-items-center p-4 text-ui-base text-foreground-subtle">
                正在加载能力地图…
              </main>
            }
          >
            <CapabilityMapView />
          </Suspense>
        ) : (
          <ProtocolView
            activeConceptId={activeConceptId}
            onSelectConcept={setActiveConceptId}
            query={query}
          />
        )}
      </div>
    </div>
  );
}
