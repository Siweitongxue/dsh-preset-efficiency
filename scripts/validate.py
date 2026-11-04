#!/usr/bin/env python3
"""Structural validation for the dsh-preset-efficiency bundle patch.

Checks (offline, no DSH runtime required):

  1. package.json declares dsh.bundle.patch and the file exists.
  2. cordis.patch.yml is valid YAML, with the Loader's ``!!js`` scalar tag accepted.
  3. Every top-level patch is either an ``insert`` list or an ``id`` override.
  4. The preset declaration has a valid lowercase-hyphen id, name, description,
     order and a non-empty plugin list.
  5. Entry ids are unique inside every nested list, and each entry has a name.
  6. Every plugin name is a known DSH package (allowlist) or ``cordis:group``.
  7. Exactly one ``tool-presentation`` row sets ``mode: ptc``.
  8. No patch targets a shipped built-in preset row.

Requires PyYAML: ``pip install pyyaml``.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
PATCH = ROOT / "cordis.patch.yml"
PKG = ROOT / "package.json"

ID_RE = re.compile(r"^[a-z][a-z0-9-]*$")

# Packages this bundle is allowed to mount. Kept explicit on purpose: a typo or a
# renamed package should fail here, not at session activation time.
ALLOWED_PLUGINS = {
    "@deepseek-ai/dsh-persona",
    "@deepseek-ai/dsh-agent-instructions",
    "@deepseek-ai/dsh-time-context",
    "@deepseek-ai/dsh-tool-bash",
    "@deepseek-ai/dsh-tool-pwsh",
    "@deepseek-ai/dsh-tool-fs",
    "@deepseek-ai/dsh-tool-fs-search",
    "@deepseek-ai/dsh-tool-jobs",
    "@deepseek-ai/dsh-skill-filesystem",
    "@deepseek-ai/dsh-tool-skill",
    "@deepseek-ai/dsh-compaction-basic",
    "@deepseek-ai/dsh-command-compact",
    "@deepseek-ai/dsh-compaction-tool-result-pruner",
    "@deepseek-ai/dsh-tool-subagent-control",
    "@deepseek-ai/dsh-tool-subagent-control/list-agents",
    "@deepseek-ai/dsh-tool-subagent",
    "@deepseek-ai/dsh-workflow-ptc",
    "@deepseek-ai/dsh-tool-workflow",
    "@deepseek-ai/dsh-tool-ask-user",
    "@deepseek-ai/dsh-tool-todo",
    "@deepseek-ai/dsh-tool-web",
    "@deepseek-ai/dsh-agent-tool-presentation",
    "@deepseek-ai/dsh-tool-present",
}

PRESET_PLUGIN = "@deepseek-ai/dsh-agent-preset"
BUILT_IN_PRESETS = {"standard", "ptc", "minimal", "cordis"}


class TaggedLoader(yaml.SafeLoader):
    """SafeLoader that keeps ``!!js <expr>`` as its raw scalar text."""


TaggedLoader.add_multi_constructor(
    "tag:yaml.org,2002:js", lambda loader, suffix, node: loader.construct_scalar(node)
)


def load_yaml(path: Path):
    with path.open("r", encoding="utf-8") as handle:
        return yaml.load(handle, Loader=TaggedLoader)


def check_entries(entries, where: str, errors: list[str]) -> None:
    seen: set[str] = set()
    for index, entry in enumerate(entries):
        if not isinstance(entry, dict):
            errors.append(f"{where}[{index}] is not a mapping")
            continue
        entry_id = entry.get("id")
        name = entry.get("name")
        if not isinstance(entry_id, str) or not entry_id:
            errors.append(f"{where}[{index}] has no string id")
        elif entry_id in seen:
            errors.append(f"{where}: duplicate id {entry_id!r}")
        else:
            seen.add(entry_id)
        if not isinstance(name, str) or not name:
            errors.append(f"{where}[{index}] ({entry_id}) has no plugin name")
            continue
        if name != "cordis:group" and name not in ALLOWED_PLUGINS:
            errors.append(f"{where}[{index}] ({entry_id}) uses unknown plugin {name!r}")
        nested = entry.get("config")
        if entry.get("group") is True and isinstance(nested, list):
            check_entries(nested, f"{where}[{index}].config", errors)


def main() -> int:
    errors: list[str] = []

    if not PKG.is_file():
        print("FATAL: package.json missing", file=sys.stderr)
        return 1
    package = json.loads(PKG.read_text(encoding="utf-8"))
    patch_rel = package.get("dsh", {}).get("bundle", {}).get("patch")
    if not patch_rel:
        errors.append("package.json: dsh.bundle.patch is not declared")
    elif not (ROOT / patch_rel.lstrip("./")).is_file():
        errors.append(f"package.json: dsh.bundle.patch points at missing file {patch_rel!r}")
    for field in ("name", "version", "license"):
        if not package.get(field):
            errors.append(f"package.json: {field} is empty")

    if not PATCH.is_file():
        print("FATAL: cordis.patch.yml missing", file=sys.stderr)
        return 1
    patches = load_yaml(PATCH)
    if not isinstance(patches, list) or not patches:
        errors.append("cordis.patch.yml: root must be a non-empty list of patch mappings")
        patches = []

    presets: list[dict] = []
    for index, patch in enumerate(patches):
        if not isinstance(patch, dict):
            errors.append(f"patch[{index}] is not a mapping")
            continue
        inserts = patch.get("insert")
        if inserts is None:
            if not isinstance(patch.get("id"), str):
                errors.append(f"patch[{index}]: neither an insert list nor an id override")
            continue
        if not isinstance(inserts, list):
            errors.append(f"patch[{index}].insert must be a list")
            continue
        for row in inserts:
            if isinstance(row, dict) and row.get("name") == PRESET_PLUGIN:
                presets.append(row)

    if len(presets) != 1:
        errors.append(f"expected exactly 1 inserted preset declaration, found {len(presets)}")

    for row in presets:
        config = row.get("config") or {}
        preset_id = config.get("id")
        if not isinstance(preset_id, str) or not ID_RE.match(preset_id):
            errors.append(f"preset id {preset_id!r} must match {ID_RE.pattern}")
        if preset_id in BUILT_IN_PRESETS:
            errors.append(f"preset id {preset_id!r} would collide with a shipped preset")
        if row.get("id") != f"preset-{preset_id}":
            errors.append(
                f"row id {row.get('id')!r} should be 'preset-{preset_id}' by convention"
            )
        for field in ("name", "description", "order"):
            if config.get(field) in (None, ""):
                errors.append(f"preset {preset_id!r}: missing display field {field!r}")
        if not isinstance(config.get("order"), int):
            errors.append(f"preset {preset_id!r}: order must be an integer")
        plugins = config.get("plugins")
        if not isinstance(plugins, list) or not plugins:
            errors.append(f"preset {preset_id!r}: plugins must be a non-empty list")
        else:
            check_entries(plugins, f"preset[{preset_id}].plugins", errors)

    ptc_rows = [
        entry
        for row in presets
        for entry in (row.get("config") or {}).get("plugins") or []
        if isinstance(entry, dict) and entry.get("id") == "tool-presentation"
    ]
    if len(ptc_rows) != 1:
        errors.append("expected exactly one tool-presentation row")
    elif (ptc_rows[0].get("config") or {}).get("mode") != "ptc":
        errors.append("tool-presentation row must set mode: ptc")

    for row in presets:
        for entry in (row.get("config") or {}).get("plugins") or []:
            if isinstance(entry, dict) and entry.get("name") == PRESET_PLUGIN:
                errors.append("a preset must not mount another preset declaration")

    if errors:
        print(f"FAIL — {len(errors)} problem(s):", file=sys.stderr)
        for problem in errors:
            print(f"  - {problem}", file=sys.stderr)
        return 1

    preset = presets[0]["config"]
    print(
        "OK — bundle patch valid: "
        f"preset {preset['id']!r} ({preset['name']}), "
        f"{len(preset['plugins'])} top-level plugin rows, "
        f"{len(patches)} patch layer(s)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
