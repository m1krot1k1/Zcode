BeforeAll {
    . (Join-Path $PSScriptRoot "soffice_discovery.ps1")
}

Describe "Find-SofficeExecutable" {
    BeforeEach {
        Mock Get-Command { return $null }
        Mock Test-Path { return $false }
    }

    It "prefers the executable resolved from PATH" {
        Mock Get-Command { return [pscustomobject]@{ Source = "E:\Tools\LibreOffice\soffice.exe" } }

        $result = Find-SofficeExecutable -Environment @{}

        $result | Should -Be "E:\Tools\LibreOffice\soffice.exe"
        Should -Invoke Test-Path -Times 0
    }

    It "uses the machine's configured ProgramFiles root rather than assuming drive C" {
        $expected = "D:\Apps\LibreOffice\program\soffice.exe"
        Mock Test-Path { return $LiteralPath -eq $expected }

        $result = Find-SofficeExecutable -Environment @{ ProgramFiles = "D:\Apps" }

        $result | Should -Be $expected
    }

    It "checks the 32-bit application root" {
        $expected = "E:\Apps32\LibreOffice\program\soffice.exe"
        Mock Test-Path { return $LiteralPath -eq $expected }

        $result = Find-SofficeExecutable -Environment @{ "ProgramFiles(x86)" = "E:\Apps32" }

        $result | Should -Be $expected
    }

    It "checks per-user installation roots" {
        $expected = "D:\Users\alice\AppData\Local\Programs\LibreOffice\program\soffice.exe"
        Mock Test-Path { return $LiteralPath -eq $expected }

        $result = Find-SofficeExecutable -Environment @{ LOCALAPPDATA = "D:\Users\alice\AppData\Local" }

        $result | Should -Be $expected
    }

    It "returns null when no candidate exists" {
        $result = Find-SofficeExecutable -Environment @{}

        $null | Should -Be $result
    }
}
