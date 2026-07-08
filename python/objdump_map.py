from __future__ import annotations

import re
import subprocess
from pathlib import Path
from typing import Dict, Iterable, Optional

_ADDR_RE = re.compile(r"//\s+([0-9A-Fa-f]+):")


def disassemble_to_map(
    codeobj_path: Path,
    llvm_objdump: Path = Path("/opt/rocm/llvm/bin/llvm-objdump"),
    start: Optional[int] = None,
    stop: Optional[int] = None,
) -> Dict[int, str]:
    cmd = [str(llvm_objdump), "-d"]
    if start is not None:
        cmd += [f"--start-address=0x{start:x}"]
    if stop is not None:
        cmd += [f"--stop-address=0x{stop:x}"]
    cmd += [str(codeobj_path)]

    out = subprocess.check_output(cmd, text=True, stderr=subprocess.STDOUT)
    m: Dict[int, str] = {}
    for line in out.splitlines():
        if "//" not in line:
            continue
        mm = _ADDR_RE.search(line)
        if not mm:
            continue
        addr = int(mm.group(1), 16)
        text = line.split("//", 1)[0].strip()
        if not text or text.endswith(":"):
            continue
        m[addr] = text
    return m


def batch_disasm_lookup(
    codeobj_path: Path,
    addrs: Iterable[int],
    llvm_objdump: Path = Path("/opt/rocm/llvm/bin/llvm-objdump"),
) -> Dict[int, str]:
    addrs = sorted(set(int(a) for a in addrs))
    if not addrs:
        return {}
    start = max(0, addrs[0] - 0x200)
    stop = addrs[-1] + 0x400
    m = disassemble_to_map(
        codeobj_path=codeobj_path,
        llvm_objdump=llvm_objdump,
        start=start,
        stop=stop,
    )
    return {a: m.get(a, "") for a in addrs}

