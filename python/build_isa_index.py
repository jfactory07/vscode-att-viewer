#!/usr/bin/env python3
"""Build compact ISA hover indexes from AMD machine-readable XML specs.

Official XML: https://gpuopen.com/machine-readable-isa/
Local copies are read from --isa-dir (default: ../../../amdgpu-isa-vscode/src/isa).

Output: media/isa/<isa_key>.json with llvm-lowercase mnemonics -> definition.
"""

from __future__ import annotations

import argparse
import json
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Dict, List, Optional

DEFAULT_ISA_DIR = Path(__file__).resolve().parents[3] / "amdgpu-isa-vscode" / "src" / "isa"
OUT_DIR = Path(__file__).resolve().parents[1] / "media" / "isa"

SPEC_FILES = [
    "amdgpu_isa_cdna1.xml",
    "amdgpu_isa_cdna2.xml",
    "amdgpu_isa_cdna3.xml",
    "amdgpu_isa_cdna4.xml",
    "amdgpu_isa_rdna1.xml",
    "amdgpu_isa_rdna2.xml",
    "amdgpu_isa_rdna3.xml",
    "amdgpu_isa_rdna3_5.xml",
    "amdgpu_isa_rdna4.xml",
]


def text(el) -> str:
    return (el.text or "").strip() if el is not None else ""


def operand_summary(instr) -> str:
    encodings = instr.find("InstructionEncodings")
    if encodings is None:
        return ""
    encoding = encodings.find("InstructionEncoding")
    if encoding is None:
        return ""
    ops = encoding.findall("Operands/Operand")
    parts: List[str] = []
    for op in ops:
        if op.get("IsImplicit") == "true":
            continue
        field = text(op.find("FieldName"))
        if not field:
            continue
        typ = text(op.find("OperandType")).removeprefix("OPR_")
        parts.append(f"{field} ({typ})" if typ else field)
    return ", ".join(parts)


def functional_group(instr) -> str:
    fg = instr.find("FunctionalGroup")
    if fg is None:
        return ""
    name = text(fg.find("Name"))
    subs = [text(s) for s in fg.findall("FunctionalSubgroups/Subgroup")]
    if subs:
        return f"{name} / {', '.join(subs)}" if name else ", ".join(subs)
    return name


def llvm_name(raw: str) -> str:
    return raw.strip().lower()


def parse_spec(xml_path: Path) -> Optional[dict]:
    root = ET.parse(xml_path).getroot()
    isa = root.find("ISA")
    if isa is None:
        return None
    arch_name = text(isa.find("Architecture/ArchitectureName"))
    isa_key = xml_path.stem.removeprefix("amdgpu_isa_")
    instructions: Dict[str, dict] = {}

    def add_entry(name: str, instr) -> None:
        key = llvm_name(name)
        if not key:
            return
        desc = text(instr.find("Description"))
        if not desc:
            return
        usage = operand_summary(instr)
        group = functional_group(instr)
        entry = {
            "official": name.strip(),
            "def": desc,
        }
        if group:
            entry["group"] = group
        if usage:
            entry["usage"] = usage
        instructions[key] = entry

    for instr in isa.find("Instructions").findall("Instruction"):
        primary = text(instr.find("InstructionName"))
        if primary:
            add_entry(primary, instr)
        aliases = instr.find("AliasedInstructionNames")
        if aliases is not None:
            for alias in aliases.findall("InstructionName"):
                add_entry(text(alias), instr)

    return {
        "isaKey": isa_key,
        "archName": arch_name,
        "source": xml_path.name,
        "count": len(instructions),
        "instructions": instructions,
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--isa-dir", type=Path, default=DEFAULT_ISA_DIR)
    ap.add_argument("--out-dir", type=Path, default=OUT_DIR)
    args = ap.parse_args()

    args.out_dir.mkdir(parents=True, exist_ok=True)
    merged: Dict[str, List[str]] = {}

    for spec in SPEC_FILES:
        xml_path = args.isa_dir / spec
        if not xml_path.is_file():
            print(f"skip missing {xml_path}")
            continue
        data = parse_spec(xml_path)
        if not data:
            print(f"skip empty {xml_path}")
            continue
        out = args.out_dir / f"{data['isaKey']}.json"
        out.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        print(f"wrote {out} ({data['count']} instructions, {out.stat().st_size // 1024} KiB)")
        for mnem in data["instructions"]:
            merged.setdefault(mnem, []).append(data["isaKey"])

    # Cross-arch manifest: which ISA generations define each mnemonic.
    manifest = {
        "gfxToIsa": {
            "gfx908": "cdna1",
            "gfx90a": "cdna2",
            "gfx942": "cdna3",
            "gfx950": "cdna4",
            "gfx1010": "rdna1",
            "gfx1011": "rdna1",
            "gfx1012": "rdna1",
            "gfx1030": "rdna2",
            "gfx1031": "rdna2",
            "gfx1032": "rdna2",
            "gfx1100": "rdna3",
            "gfx1101": "rdna3",
            "gfx1102": "rdna3",
            "gfx1150": "rdna3_5",
            "gfx1151": "rdna3_5",
            "gfx1200": "rdna4",
            "gfx1201": "rdna4",
        },
        "isaKeys": sorted({s.removesuffix(".xml").removeprefix("amdgpu_isa_") for s in SPEC_FILES}),
    }
    (args.out_dir / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"wrote {args.out_dir / 'manifest.json'}")


if __name__ == "__main__":
    main()
