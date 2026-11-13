import { useCallback, useState } from "react";

export type DocsView = "capabilities" | "boundary" | "protocol" | "stdio";

function getInitialDocsView(): DocsView {
  const view = new URLSearchParams(window.location.search).get("view");
  return view === "capabilities" || view === "boundary" || view === "protocol" || view === "stdio"
    ? view
    : "stdio";
}

export function useDocsView() {
  const [activeView, setActiveView] = useState<DocsView>(getInitialDocsView);

  const selectView = useCallback((view: DocsView) => {
    setActiveView(view);
    const url = new URL(window.location.href);
    url.searchParams.set("view", view);
    window.history.replaceState(null, "", url);
  }, []);

  return { activeView, selectView };
}
