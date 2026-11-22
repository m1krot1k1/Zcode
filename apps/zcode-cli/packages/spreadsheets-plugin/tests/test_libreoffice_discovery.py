import ast
import sys
import unittest
from pathlib import Path
from typing import Optional


SKILL_ROOT = Path(__file__).resolve().parents[1] / "skills" / "xlsx"
sys.path.insert(0, str(SKILL_ROOT))

from libreoffice_discovery import find_soffice


def load_source_function(source_path, name, namespace):
    tree = ast.parse(source_path.read_text(encoding="utf-8"), filename=str(source_path))
    function = next(
        node for node in tree.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == name
    )
    module = ast.fix_missing_locations(ast.Module(body=[function], type_ignores=[]))
    exec(compile(module, str(source_path), "exec"), namespace)
    return namespace[name]


class LibreOfficeDiscoveryTests(unittest.TestCase):
    def setUp(self):
        self.checked = []

    def find(self, environment, existing=(), which=None):
        existing_paths = set(existing)
        return find_soffice(
            system="Windows",
            environ=environment,
            which=which or (lambda _name: None),
            is_file=lambda path: self.checked.append(path) is None and path in existing_paths,
        )

    def test_path_precedes_environment_roots(self):
        result = self.find(
            {"ProgramW6432": "D:\\Apps"},
            which=lambda name: "E:\\Custom\\soffice.exe" if name == "soffice.exe" else None,
        )
        self.assertEqual(result, "E:\\Custom\\soffice.exe")
        self.assertEqual(self.checked, [])

    def test_program_w6432_supports_non_c_drive(self):
        expected = "D:\\Apps\\LibreOffice\\program\\soffice.exe"
        self.assertEqual(self.find({"ProgramW6432": "D:\\Apps"}, [expected]), expected)

    def test_program_files_and_x86_roots_are_respected(self):
        for key, root in (
            ("ProgramFiles", "E:\\Apps"),
            ("ProgramFiles(x86)", "F:\\Apps32"),
        ):
            with self.subTest(key=key):
                expected = root + "\\LibreOffice\\program\\soffice.exe"
                self.assertEqual(self.find({key: root}, [expected]), expected)

    def test_local_app_data_and_user_profile_roots_are_respected(self):
        cases = (
            (
                {"LOCALAPPDATA": "D:\\Users\\alice\\AppData\\Local"},
                "D:\\Users\\alice\\AppData\\Local\\Programs\\LibreOffice\\program\\soffice.exe",
            ),
            (
                {"USERPROFILE": "E:\\Users\\bob"},
                "E:\\Users\\bob\\Programs\\LibreOffice\\program\\soffice.exe",
            ),
        )
        for environment, expected in cases:
            with self.subTest(environment=environment):
                self.assertEqual(self.find(environment, [expected]), expected)

    def test_missing_or_empty_roots_return_none_without_launching(self):
        self.assertIsNone(self.find({"ProgramW6432": "", "LOCALAPPDATA": "  "}))

    def test_duplicate_roots_are_checked_once(self):
        self.assertIsNone(
            self.find({"ProgramW6432": "D:\\Apps", "ProgramFiles": "D:\\Apps"})
        )
        self.assertEqual(
            self.checked,
            ["D:\\Apps\\LibreOffice\\program\\soffice.exe"],
        )

    def test_xlsx_runtime_uses_the_windows_discovery_result(self):
        expected = "D:\\Apps\\LibreOffice\\program\\soffice.exe"
        resolver = lambda: find_soffice(
            system="Windows",
            environ={"ProgramW6432": "D:\\Apps"},
            which=lambda _name: None,
            is_file=lambda path: path == expected,
        )
        find_runtime_path = load_source_function(
            SKILL_ROOT / "xlsx.py",
            "_find_soffice",
            {"find_soffice": resolver, "Optional": Optional},
        )

        self.assertEqual(find_runtime_path(), expected)


if __name__ == "__main__":
    unittest.main()
