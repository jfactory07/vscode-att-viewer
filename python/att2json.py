#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
import sqlite3
from pathlib import Path
from typing import Dict, List, Tuple

from att_decode_ctypes import decode_att
from objdump_map import batch_disasm_lookup


CAT_NAMES = {
    0: "NONE",
    1: "SMEM",
    2: "SALU",
    3: "VMEM",
    4: "FLAT",
    5: "LDS",
    6: "VALU",
    7: "JUMP",
    8: "NEXT",
    9: "IMMED",
    10: "CONTEXT",
    11: "MESSAGE",
    12: "BVH",
}

DEFAULT_COLORS = {
    # Keep in sync with viewer.js built-in defaults (legend screenshot palette).
    "SMEM": "#cad256",
    "SALU": "#5e31c9",
    "VMEM": "#e59138",
    "FLAT": "#d4b18c",
    "LDS": "#a87329",
    "MFMA": "#114d05",
    "VALU": "#ae74d8",
    "JUMP": "#8e7cc3",
    "NEXT": "#b4a7d6",
    "IMMED": "#7f228c",
    "CONTEXT": "#76a5af",
    "MESSAGE": "#b8c318",
    "BVH": "#8eb87a",
    "NONE": "#777777",
}


def _is_mfma_valu(asm: str) -> bool:
    """
    Heuristic: mfma/wmma are encoded as VALU category by decoder, but we want them separated.
    """
    a = (asm or "").lstrip()
    if not a:
        return False
    # common patterns from llvm-objdump:
    #   v_mfma_f32_...
    #   v_wmma_...
    return a.startswith("v_mfma") or a.startswith("v_wmma") or ("_mfma" in a)


def _read_codeobj_table(results_db: Path) -> List[Tuple[int, int, int]]:
    """
    Returns [(code_object_id, load_base, load_size), ...]
    If results_db is missing/empty or doesn't contain the table, returns [].
    """
    if not results_db or not results_db.exists() or results_db.stat().st_size == 0:
        return []
    con = sqlite3.connect(str(results_db))
    cur = con.cursor()
    cur.execute(
        "select name from sqlite_master where type='table' and name like 'rocpd_info_code_object_%' limit 1"
    )
    row = cur.fetchone()
    if not row:
        con.close()
        return []
    table = row[0]
    cur.execute(f"select id, load_base, load_size from {table} order by id")
    rows = [(int(a), int(b), int(c)) for (a, b, c) in cur.fetchall()]
    con.close()
    return rows


_CO_ID_RE = re.compile(r"code_object_id_(\d+)\.out$")


def _scan_codeobj_dir(codeobj_dir: Path) -> List[Tuple[int, int, int, Path]]:
    """
    Fallback when results.db is not available:
      - load_id from filename
      - load_base = 0
      - load_size = file_size (best-effort; decoder primarily uses marker_id+ELF vaddr)
    """
    out: List[Tuple[int, int, int, Path]] = []
    for p in sorted(codeobj_dir.glob("*code_object_id_*.out")):
        m = _CO_ID_RE.search(p.name)
        if not m:
            continue
        cid = int(m.group(1))
        out.append((cid, 0, int(p.stat().st_size), p))
    return out


def _find_codeobj_file(codeobj_dir: Path, codeobj_id: int) -> Path:
    matches = sorted(codeobj_dir.glob(f"*code_object_id_{codeobj_id}.out"))
    if not matches:
        raise FileNotFoundError(
            f"Cannot find '*code_object_id_{codeobj_id}.out' under {codeobj_dir}"
        )
    if len(matches) == 1:
        return matches[0]
    matches.sort(key=lambda p: p.stat().st_size, reverse=True)
    return matches[0]


def main() -> None:
    ap = argparse.ArgumentParser(description="Decode ATT and write trace JSON for VS Code webview")
    ap.add_argument("--att", required=True, type=Path)
    ap.add_argument("--results-db", required=False, type=Path)
    ap.add_argument("--codeobj-dir", required=True, type=Path)
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--decoder-lib-path", type=Path, default=Path("/opt/rocm/lib"))
    ap.add_argument("--rocprofiler-sdk", type=Path, default=Path("/opt/rocm/lib/librocprofiler-sdk.so"))
    ap.add_argument("--llvm-objdump", type=Path, default=Path("/opt/rocm/llvm/bin/llvm-objdump"))
    ap.add_argument("--max-events", type=int, default=0)
    args = ap.parse_args()

    codeobjs: List[Tuple[int, int, int, Path]] = []
    codeobj_rows = _read_codeobj_table(args.results_db) if args.results_db else []
    if codeobj_rows:
        for (cid, base, size) in codeobj_rows:
            path = _find_codeobj_file(args.codeobj_dir, cid)
            codeobjs.append((cid, base, size, path))
    else:
        codeobjs = _scan_codeobj_dir(args.codeobj_dir)
        if not codeobjs:
            raise RuntimeError(f"No code objects found under {args.codeobj_dir}")

    gfxip, events = decode_att(
        att_path=args.att,
        code_objects=codeobjs,
        decoder_lib_path=args.decoder_lib_path,
        rocprofiler_sdk_path=args.rocprofiler_sdk,
    )
    if args.max_events and args.max_events > 0:
        events = events[: args.max_events]

    pcs_by_id: Dict[int, List[int]] = {}
    for e in events:
        if e.marker_id <= 0:
            continue
        pcs_by_id.setdefault(e.marker_id, []).append(e.pc)

    asm_map: Dict[Tuple[int, int], str] = {}
    for (cid, _base, _size, path) in codeobjs:
        pcs = pcs_by_id.get(cid, [])
        if not pcs:
            continue
        dis = batch_disasm_lookup(codeobj_path=path, addrs=pcs, llvm_objdump=args.llvm_objdump)
        for pc, text in dis.items():
            asm_map[(cid, pc)] = text

    min_c = min(e.issue for e in events) if events else 0
    max_c = max((e.issue + max(1, e.duration) for e in events), default=0)
    lanes = max((e.lane for e in events), default=-1) + 1

    out_events = []
    for e in events:
        asm = asm_map.get((e.marker_id, e.pc), "")
        cat = CAT_NAMES.get(e.category, "NONE")
        if cat == "VALU" and _is_mfma_valu(asm):
            cat = "MFMA"
        out_events.append(
            {
                "lane": e.lane,
                "cu": e.cu,
                "simd": e.simd,
                "slot": e.slot,
                "issue": e.issue,
                "duration": e.duration,
                "stall": e.stall,
                "category": e.category,
                "cat": cat,
                "marker_id": e.marker_id,
                "pc": e.pc,
                "asm": asm,
            }
        )

    payload = {
        "min_cycle": int(min_c),
        "max_cycle": int(max_c),
        "lanes": int(lanes),
        "events": out_events,
        "colors": DEFAULT_COLORS,
        "cat_names": {str(k): v for (k, v) in CAT_NAMES.items()},
        "meta": {
            "gfxip_major": gfxip,
            "att": str(args.att),
            "results_db": str(args.results_db) if args.results_db else "",
            "codeobj_files": {str(cid): str(p) for (cid, _base, _size, p) in codeobjs},
        },
    }

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    print(f"wrote: {args.out}")


if __name__ == "__main__":
    main()

