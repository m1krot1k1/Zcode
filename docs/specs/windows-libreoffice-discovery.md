# Windows LibreOffice discovery across bundled office skills

## Product contract

Bundled PDF, DOCX, PPTX, and XLSX skills must find the current machine's LibreOffice executable before reporting it missing or asking the user to install it. Windows discovery checks executable lookup (`PATH`) first, then roots supplied by `ProgramW6432`, `ProgramFiles`, `ProgramFiles(x86)`, `LOCALAPPDATA`, and `USERPROFILE`. It constructs candidates from those roots and never assumes drive C. This supports installations on arbitrary drives when the corresponding Windows root variable points there.

For a system root, the candidate is `<root>\\LibreOffice\\program\\soffice.exe`. Per-user roots check `<root>\\Programs\\LibreOffice\\program\\soffice.exe` and `<root>\\LibreOffice\\program\\soffice.exe`. A missing or empty root is skipped. Discovery returns the first existing file and does not launch LibreOffice, install packages, modify PATH, or persist state.

Each independently installable skill owns a self-contained resolver appropriate to its execution language. Within a skill there is one authoritative resolver: setup and runtime probes consume its result rather than maintaining competing candidate lists. Python runtime discovery remains separate per plugin package so installing PDF does not depend on the XLSX plugin (or vice versa). PowerShell setup helpers remain inside their owning skill packages for the same reason.

## Ownership and event order

```text
current process PATH + Windows environment roots
  -> the owning skill's resolver
  -> first existing soffice.exe or missing
  -> setup reports installed/missing, or runtime conversion uses that exact path
```

The resolver is read-only. Existing skill settings and MCP/plugin lifecycle are unaffected. When no candidate is found, setup prints install guidance without claiming a fixed absolute path; runtime returns the existing missing-dependency result.

## Accepted cases

| ID        | Scenario                                                       | Expected result                                                         |
| --------- | -------------------------------------------------------------- | ----------------------------------------------------------------------- |
| LO-WIN-01 | `soffice.exe` is resolved from `PATH`                          | Return that path before filesystem candidates are checked.              |
| LO-WIN-02 | `ProgramW6432` points to a non-C drive                         | Find `<root>\\LibreOffice\\program\\soffice.exe`.                       |
| LO-WIN-03 | Only `ProgramFiles` or `ProgramFiles(x86)` is present          | Find the executable beneath that configured root.                       |
| LO-WIN-04 | Installation is per-user under `LOCALAPPDATA`                  | Find its `Programs\\LibreOffice` or `LibreOffice` layout.               |
| LO-WIN-05 | Installation is per-user under `USERPROFILE`                   | Find its `Programs\\LibreOffice` or `LibreOffice` layout.               |
| LO-WIN-06 | Several variables point at the same installation or are absent | Skip empty roots and return the first existing candidate without error. |
| LO-WIN-07 | No candidate exists                                            | Return missing; do not launch, install, or change environment state.    |
| LO-WIN-08 | PDF runtime reports availability and converts Office files     | Its probe and conversion use the same resolved executable.              |
| LO-WIN-09 | XLSX runtime needs recalculation                               | It uses the same discovery result for version checking and execution.   |

## Verification evidence

Python `unittest` cases inject platform, environment, PATH lookup, and file-existence functions to cover candidate order and arbitrary drives without requiring Windows or installing LibreOffice. Pester tests cover the PowerShell resolver and verify each installer consumes it. These tests prove discovery logic and wiring only. A native Windows run is still needed to prove actual registry/environment layouts and process launch; no test claims LibreOffice conversion correctness.

PDF, DOCX, PPTX, and XLSX setup instructions must explain how discovery works and show a variable-derived path when one is needed. No installation recipe may present `C:\\Program Files` as the only probe or verification location.
