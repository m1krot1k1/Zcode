function Find-SofficeExecutable {
    param(
        [System.Collections.IDictionary]$Environment = [System.Environment]::GetEnvironmentVariables()
    )

    $command = Get-Command -Name @("soffice.exe", "soffice") -CommandType Application -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($command) {
        if ($command.Source) { return $command.Source }
        if ($command.Definition) { return $command.Definition }
    }

    # 固定 C:\Program Files 会漏掉其他盘符和用户安装；改为用 PATH 与当前机器的目录变量发现。
    $candidates = @()
    foreach ($name in @("ProgramW6432", "ProgramFiles", "ProgramFiles(x86)")) {
        $root = [string]$Environment[$name]
        if (-not [string]::IsNullOrWhiteSpace($root)) {
            $candidates += Join-Path $root "LibreOffice\program\soffice.exe"
        }
    }

    foreach ($name in @("LOCALAPPDATA", "USERPROFILE")) {
        $root = [string]$Environment[$name]
        if (-not [string]::IsNullOrWhiteSpace($root)) {
            $candidates += Join-Path $root "Programs\LibreOffice\program\soffice.exe"
            $candidates += Join-Path $root "LibreOffice\program\soffice.exe"
        }
    }

    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            return $candidate
        }
    }
    return $null
}
