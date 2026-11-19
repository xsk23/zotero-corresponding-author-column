import copy
import json
import pathlib
import tempfile
import unittest
import zipfile

from build import PACKAGE_FILES, build, validate_manifest

ROOT = pathlib.Path(__file__).resolve().parents[1]


class ManifestTests(unittest.TestCase):
    def setUp(self):
        self.manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))

    def test_current_manifest(self):
        validate_manifest(self.manifest)

    def test_all_zotero_required_fields(self):
        for key in ("id", "update_url", "strict_max_version"):
            with self.subTest(key=key):
                manifest = copy.deepcopy(self.manifest)
                del manifest["applications"]["zotero"][key]
                with self.assertRaisesRegex(ValueError, f"applications.zotero.{key} not provided"):
                    validate_manifest(manifest)

    def test_browser_settings_cannot_replace_applications(self):
        del self.manifest["applications"]
        with self.assertRaisesRegex(ValueError, "applications.zotero.id not provided"):
            validate_manifest(self.manifest)

    def test_built_archive_contains_valid_root_manifest_and_window(self):
        with tempfile.TemporaryDirectory() as folder:
            root = pathlib.Path(folder)
            for name in PACKAGE_FILES:
                (root / name).parent.mkdir(parents=True, exist_ok=True)
                (root / name).write_bytes((ROOT / name).read_bytes())
            with zipfile.ZipFile(build(root)) as archive:
                validate_manifest(json.loads(archive.read("manifest.json")))
                self.assertIsNone(archive.testzip())
                self.assertIn("groups.xhtml", archive.namelist())
                self.assertIn("locale/zh-CN/", archive.namelist())
                self.assertIn("affiliations.js", archive.namelist())

    def test_bad_manifest_prevents_build(self):
        del self.manifest["applications"]["zotero"]["update_url"]
        with tempfile.TemporaryDirectory() as folder:
            root = pathlib.Path(folder)
            (root / "manifest.json").write_text(json.dumps(self.manifest), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "update_url not provided"):
                build(root)
            self.assertEqual(list(root.glob("*.xpi")), [])
