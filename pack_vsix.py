#!/usr/bin/env python3
"""Build a .vsix for this extension without npm/vsce.

A .vsix is just a zip of extension/<files> plus the two OPC metadata parts, and
this extension has no build step, so the whole package can be produced from the
standard library. Exists because the profiling boxes have ROCm but no node.

Usage: python3 pack_vsix.py [outdir]   # defaults to this directory
"""

import fnmatch
import html
import json
import os
import sys
import zipfile

ROOT = os.path.dirname(os.path.abspath(__file__))
PRUNE_DIRS = {".git", "__pycache__", "node_modules"}
CONTENT_TYPES = {
    "json": "application/json",
    "js": "application/javascript",
    "css": "text/css",
    "md": "text/markdown",
    "py": "text/plain",
    "png": "image/png",
    "txt": "text/plain",
    "html": "text/html",
    "map": "application/json",
}


def load_ignore():
    path = os.path.join(ROOT, ".vscodeignore")
    if not os.path.exists(path):
        return []
    with open(path) as fh:
        return [l.strip() for l in fh if l.strip() and not l.startswith("#")]


def ignored(rel, patterns):
    if any(part in PRUNE_DIRS for part in rel.split("/")):
        return True
    for pat in patterns:
        bare = pat[3:] if pat.startswith("**/") else pat
        bare = bare[:-3] if bare.endswith("/**") else bare
        if fnmatch.fnmatch(rel, pat) or fnmatch.fnmatch(rel, bare) or rel.startswith(bare + "/"):
            return True
    return False


def collect(patterns):
    files = []
    for dirpath, dirnames, filenames in os.walk(ROOT):
        dirnames[:] = [d for d in dirnames if d not in PRUNE_DIRS]
        for name in filenames:
            full = os.path.join(dirpath, name)
            rel = os.path.relpath(full, ROOT).replace(os.sep, "/")
            if rel.endswith(".vsix") or rel == "pack_vsix.py" or ignored(rel, patterns):
                continue
            files.append((full, rel))
    return sorted(files, key=lambda t: t[1])


def vsixmanifest(pkg):
    return f'''<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="{pkg["name"]}" Version="{pkg["version"]}" Publisher="{pkg["publisher"]}" />
    <DisplayName>{html.escape(pkg["displayName"])}</DisplayName>
    <Description xml:space="preserve">{html.escape(pkg["description"])}</Description>
    <Tags>{html.escape(",".join(pkg.get("keywords", [])))}</Tags>
    <Categories>{",".join(pkg.get("categories", []))}</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="{pkg["engines"]["vscode"]}" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value="" />
      <Property Id="Microsoft.VisualStudio.Services.Links.Source" Value="{pkg["repository"]["url"]}" />
    </Properties>
    <License>extension/LICENSE.md</License>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" />
  </Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE.md" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Changelog" Path="extension/CHANGELOG.md" Addressable="true" />
  </Assets>
</PackageManifest>
'''


def content_types(files):
    exts = sorted({os.path.splitext(rel)[1][1:].lower() for _, rel in files if os.path.splitext(rel)[1]})
    body = "".join(
        f'  <Default Extension=".{e}" ContentType="{CONTENT_TYPES.get(e, "application/octet-stream")}"/>\n'
        for e in exts
    )
    return (
        '<?xml version="1.0" encoding="utf-8"?>\n'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n'
        + body
        + '  <Default Extension=".vsixmanifest" ContentType="text/xml"/>\n'
          '  <Default Extension=".xml" ContentType="text/xml"/>\n'
          '</Types>\n'
    )


def main():
    outdir = sys.argv[1] if len(sys.argv) > 1 else ROOT
    with open(os.path.join(ROOT, "package.json")) as fh:
        pkg = json.load(fh)
    files = collect(load_ignore())
    out = os.path.join(outdir, f'{pkg["name"]}-{pkg["version"]}.vsix')
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("extension.vsixmanifest", vsixmanifest(pkg))
        z.writestr("[Content_Types].xml", content_types(files))
        for full, rel in files:
            z.write(full, "extension/" + rel)
    print(f"{out}  ({os.path.getsize(out) / 1024:.0f} KB, {len(files)} files)")


if __name__ == "__main__":
    main()
