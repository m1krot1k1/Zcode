BeforeAll {
    . (Join-Path $PSScriptRoot "soffice_discovery.ps1")
}

Describe "PDF Find-SofficeExecutable" {
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

    It "uses ProgramW6432 on an arbitrary drive" {
        $expected = "D:\Apps\LibreOffice\program\soffice.exe"
        Mock Test-Path { return $LiteralPath -eq $expected }

        $result = Find-SofficeExecutable -Environment @{ ProgramW6432 = "D:\Apps" }

        $result | Should -Be $expected
    }

    It "uses ProgramFiles" {
        $programFiles = "E:\Apps\LibreOffice\program\soffice.exe"
        Mock Test-Path { return $LiteralPath -eq $programFiles }
        (Find-SofficeExecutable -Environment @{ ProgramFiles = "E:\Apps" }) | Should -Be $programFiles
    }

    It "uses ProgramFiles(x86)" {
        Mock Test-Path { return $LiteralPath -eq "F:\Apps32\LibreOffice\program\soffice.exe" }
        (Find-SofficeExecutable -Environment @{ "ProgramFiles(x86)" = "F:\Apps32" }) |
            Should -Be "F:\Apps32\LibreOffice\program\soffice.exe"
    }

    It "checks a per-user LOCALAPPDATA root" {
        $local = "D:\Users\alice\AppData\Local\Programs\LibreOffice\program\soffice.exe"
        Mock Test-Path { return $LiteralPath -eq $local }
        (Find-SofficeExecutable -Environment @{ LOCALAPPDATA = "D:\Users\alice\AppData\Local" }) |
            Should -Be $local
    }

    It "checks a per-user USERPROFILE root" {
        $profile = "E:\Users\bob\Programs\LibreOffice\program\soffice.exe"
        Mock Test-Path { return $LiteralPath -eq $profile }
        (Find-SofficeExecutable -Environment @{ USERPROFILE = "E:\Users\bob" }) |
            Should -Be $profile
    }

    It "returns null when no candidate exists" {
        (Find-SofficeExecutable -Environment @{}) | Should -BeNullOrEmpty
    }

    It "is wired into the PDF installer without a fixed C drive check" {
        $setup = Get-Content -Raw (Join-Path $PSScriptRoot "setup_windows.ps1")

        $setup | Should -Match 'soffice_discovery\.ps1'
        $setup | Should -Match '\$SofficePath = Find-SofficeExecutable'
        $setup | Should -Not -Match 'C:\\Program Files\\LibreOffice\\program'
    }
}
