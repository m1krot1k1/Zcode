"""Service layer used to exercise cross-file edges in the benchmark fixture."""

from app.models import CodeIndexError, resolve_identity


class CodeIntelligenceService:
    """Owns the index lifecycle for one workspace identity."""

    def __init__(self, workspace_path: str) -> None:
        self.workspace_path = workspace_path
        self.identity = resolve_identity(None, workspace_path)

    def index_workspace(self, force: bool = False) -> int:
        if not self.workspace_path:
            raise CodeIndexError("workspace path is required")
        return 1 if force else 0

    def search(self, query: str, limit: int = 12) -> list[str]:
        if not query.strip():
            return []
        return [f"{self.identity}:{query}"][:limit]


def build_service(workspace_path: str) -> CodeIntelligenceService:
    return CodeIntelligenceService(workspace_path)
