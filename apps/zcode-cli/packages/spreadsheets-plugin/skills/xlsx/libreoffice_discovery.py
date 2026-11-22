"""Read-only LibreOffice executable discovery for the standalone XLSX skill."""

from __future__ import annotations

import ntpath
import os
import platform
import shutil
from collections.abc import Callable, Mapping


def _windows_candidates(environment: Mapping[str, str]) -> list[str]:
    candidates: list[str] = []
    for name in ("ProgramW6432", "ProgramFiles", "ProgramFiles(x86)"):
        root = environment.get(name, "").strip()
        if root:
            candidates.append(ntpath.join(root, "LibreOffice", "program", "soffice.exe"))

    for name in ("LOCALAPPDATA", "USERPROFILE"):
        root = environment.get(name, "").strip()
        if root:
            candidates.extend(
                (
                    ntpath.join(root, "Programs", "LibreOffice", "program", "soffice.exe"),
                    ntpath.join(root, "LibreOffice", "program", "soffice.exe"),
                )
            )
    return candidates


def find_soffice(
    *,
    system: str | None = None,
    environ: Mapping[str, str] | None = None,
    which: Callable[[str], str | None] | None = None,
    is_file: Callable[[str], bool] | None = None,
) -> str | None:
    """Find LibreOffice on PATH, then in platform locations derived from this machine.

    Discovery is read-only. The injectable inputs let tests cover Windows layouts on any host.
    """
    system = system or platform.system()
    environment = environ if environ is not None else os.environ
    resolve_command = which or shutil.which
    exists = is_file or os.path.isfile

    names = ("soffice.exe", "soffice", "libreoffice.exe", "libreoffice") if system == "Windows" else (
        "soffice",
        "libreoffice",
    )
    for name in names:
        found = resolve_command(name)
        if found:
            return found

    if system == "Windows":
        candidates = _windows_candidates(environment)
    elif system == "Darwin":
        candidates = [
            "/Applications/LibreOffice.app/Contents/MacOS/soffice",
            os.path.expanduser("~/Applications/LibreOffice.app/Contents/MacOS/soffice"),
        ]
    elif system == "Linux":
        candidates = [
            "/usr/bin/soffice",
            "/usr/local/bin/soffice",
            "/usr/lib/libreoffice/program/soffice",
            "/opt/libreoffice/program/soffice",
            "/snap/bin/libreoffice.soffice",
            "/var/lib/flatpak/exports/bin/org.libreoffice.LibreOffice",
        ]
    else:
        candidates = []

    seen: set[str] = set()
    for candidate in candidates:
        key = candidate.casefold() if system == "Windows" else candidate
        if key in seen:
            continue
        seen.add(key)
        if exists(candidate):
            return candidate
    return None
