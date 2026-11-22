"""Domain models for the benchmark fixture workspace."""

from dataclasses import dataclass


@dataclass
class WorkspaceIdentity:
    """Stable identity used for index isolation."""

    raw: str

    def normalized(self) -> str:
        return self.raw.strip()


class CodeIndexError(RuntimeError):
    """Raised when the local code index cannot be built."""


def resolve_identity(value: str | None, fallback: str) -> str:
    """Resolve the identity key: trimmed identity wins over the workspace path."""
    candidate = (value or "").strip()
    if candidate:
        return candidate
    return fallback.strip()
