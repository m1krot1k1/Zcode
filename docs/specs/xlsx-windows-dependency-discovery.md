# XLSX skill Windows dependency discovery

## Product contract

The bundled XLSX skill setup helper must detect LibreOffice (`soffice.exe`) wherever it is installed on the current Windows machine before it recommends an install. It must prefer an executable resolved from `PATH`, then check installation roots derived from Windows environment variables, including `ProgramW6432`, `ProgramFiles`, `ProgramFiles(x86)`, `LOCALAPPDATA`, and `USERPROFILE`. It must not assume that Windows is installed on drive C or that LibreOffice uses its default directory.

When LibreOffice is found, the helper reports the resolved executable path and treats the dependency as present. When it is not found, it reports the install options and explains how to add the installed `program` directory to the user's `PATH` without prescribing a machine-specific absolute path.

## Discovery order and owner

`Find-SofficeExecutable` in the XLSX skill's Windows environment setup owns discovery. It reads the current process environment and executable lookup result. The setup script consumes its returned path and does not maintain a second path check.

```text
Windows process environment + PATH
  → Find-SofficeExecutable
  → resolved soffice.exe or missing
  → setup helper reports present or installation instructions
```

Discovery checks `PATH` first, then standard Windows application roots and user-local application roots. It returns the first existing file and never runs LibreOffice during setup.

## Acceptance cases

| ID          | Scenario                                                             | Expected result                                                                                                  |
| ----------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| XLSX-WIN-01 | `soffice.exe` is on `PATH`                                           | Return the command's resolved application path.                                                                  |
| XLSX-WIN-02 | Installed below a non-C `ProgramFiles` or `ProgramW6432` root        | Find `<root>\\LibreOffice\\program\\soffice.exe`.                                                                |
| XLSX-WIN-03 | Installed below `ProgramFiles(x86)`                                  | Find the executable from that environment root.                                                                  |
| XLSX-WIN-04 | Installed for the current user below `LOCALAPPDATA` or `USERPROFILE` | Find a supported `Programs\\LibreOffice\\program\\soffice.exe` or `LibreOffice\\program\\soffice.exe` candidate. |
| XLSX-WIN-05 | No candidate exists                                                  | Return missing and show install instructions without claiming a default absolute install path.                   |

## Evidence

PowerShell unit tests cover the path lookup order and each installation root using mocked command and file discovery. A Windows smoke run remains necessary to prove behavior against real Windows environment variables and filesystem paths.
