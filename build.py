"""Build a deterministic, dependency-free Zotero install archive."""
import json
import pathlib
import zipfile
import xml.etree.ElementTree as ET

PACKAGE_FILES = ["manifest.json", "bootstrap.js", "affiliations.js", "source-pages.js", "reviewed-sources.js", "institution.svg", "locale/zh-CN/ca-pro-affiliations.ftl", "locale/en-US/ca-pro-affiliations.ftl", "groups.xhtml", "groups.js", "README.md"]

def validate_manifest(manifest):
    """Mirror required Zotero fields in Extension.sys.mjs, before creating an XPI."""
    if manifest.get("manifest_version") != 2:
        raise ValueError("Zotero requires manifest_version 2")
    for key in ("name", "version"):
        if not manifest.get(key):
            raise ValueError(f"{key} not provided")
    settings = manifest.get("applications", {}).get("zotero", {})
    for key in ("id", "update_url", "strict_max_version"):
        if not settings.get(key):
            raise ValueError(f"applications.zotero.{key} not provided")


def build(root):
    manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
    validate_manifest(manifest)
    ET.parse(root / "groups.xhtml")
    output = root / f"corresponding-author-pro-{manifest['version']}.xpi"
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        # Zotero locale discovery enumerates immediate directory entries.
        directories = set()
        for name in PACKAGE_FILES:
            for parent in pathlib.PurePosixPath(name).parents:
                if str(parent) != ".":
                    directories.add(str(parent) + "/")
        for directory in sorted(directories):
            info = zipfile.ZipInfo(directory, (2026, 11, 11, 0, 0, 0))
            info.external_attr = 0x10
            archive.writestr(info, b"")
        for name in PACKAGE_FILES:
            info = zipfile.ZipInfo(name, (2026, 11, 11, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, (root / name).read_bytes())
    return output


if __name__ == "__main__":
    print(build(pathlib.Path(__file__).resolve().parent))
