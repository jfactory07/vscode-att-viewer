from __future__ import annotations

import ctypes as C
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Tuple


class Pc(C.Structure):
    _fields_ = [
        ("addr", C.c_size_t),
        ("marker_id", C.c_size_t),
    ]


class Inst(C.Structure):
    _fields_ = [
        ("_catstall", C.c_uint32),
        ("duration", C.c_int32),
        ("time", C.c_int64),
        ("pc", Pc),
    ]

    @property
    def category(self) -> int:
        return int(self._catstall & 0xFF)

    @property
    def stall(self) -> int:
        return int((self._catstall >> 8) & 0xFFFFFF)


class Wave(C.Structure):
    _fields_ = [
        ("cu", C.c_uint8),
        ("simd", C.c_uint8),
        ("wave_id", C.c_uint8),
        ("contexts", C.c_uint8),
        ("_rsvd1", C.c_uint32),
        ("_rsvd2", C.c_uint32),
        ("_rsvd3", C.c_uint32),
        ("begin_time", C.c_int64),
        ("end_time", C.c_int64),
        ("timeline_size", C.c_size_t),
        ("instructions_size", C.c_size_t),
        ("timeline_array", C.c_void_p),
        ("instructions_array", C.POINTER(Inst)),
    ]


class DecoderHandle(C.Structure):
    _fields_ = [("handle", C.c_uint64)]


ROCPROF_STATUS_SUCCESS = 0

RECORD_GFXIP = 0
RECORD_WAVE = 3
RECORD_INFO = 4

_CB = C.CFUNCTYPE(None, C.c_int, C.c_void_p, C.c_uint64, C.c_void_p)


@dataclass(frozen=True)
class DecodedInst:
    lane: int
    cu: int
    simd: int
    slot: int
    issue: int
    duration: int
    stall: int
    category: int
    marker_id: int
    pc: int


def decode_att(
    att_path: Path,
    code_objects: List[Tuple[int, int, int, Path]],
    decoder_lib_path: Path = Path("/opt/rocm/lib"),
    rocprofiler_sdk_path: Path = Path("/opt/rocm/lib/librocprofiler-sdk.so"),
) -> Tuple[int, List[DecodedInst]]:
    sdk = C.CDLL(str(rocprofiler_sdk_path), mode=C.RTLD_GLOBAL)

    create = sdk.rocprofiler_thread_trace_decoder_create
    create.argtypes = [C.POINTER(DecoderHandle), C.c_char_p]
    create.restype = C.c_int

    destroy = sdk.rocprofiler_thread_trace_decoder_destroy
    destroy.argtypes = [DecoderHandle]
    destroy.restype = None

    codeobj_load = sdk.rocprofiler_thread_trace_decoder_codeobj_load
    codeobj_load.argtypes = [
        DecoderHandle,
        C.c_uint64,
        C.c_uint64,
        C.c_uint64,
        C.c_void_p,
        C.c_uint64,
    ]
    codeobj_load.restype = C.c_int

    trace_decode = sdk.rocprofiler_trace_decode
    trace_decode.argtypes = [DecoderHandle, _CB, C.c_void_p, C.c_uint64, C.c_void_p]
    trace_decode.restype = C.c_int

    info_string = sdk.rocprofiler_thread_trace_decoder_info_string
    info_string.argtypes = [DecoderHandle, C.c_int]
    info_string.restype = C.c_char_p

    handle = DecoderHandle()
    st = create(C.byref(handle), str(decoder_lib_path).encode("utf-8"))
    if st != ROCPROF_STATUS_SUCCESS:
        raise RuntimeError(f"decoder_create failed status={st}")

    buffers: List[C.Array] = []
    for (load_id, load_base, load_size, elf_path) in code_objects:
        data = elf_path.read_bytes()
        buf = (C.c_ubyte * len(data)).from_buffer_copy(data)
        buffers.append(buf)
        st = codeobj_load(
            handle,
            C.c_uint64(load_id),
            C.c_uint64(load_base),
            C.c_uint64(load_size),
            C.cast(buf, C.c_void_p),
            C.c_uint64(len(data)),
        )
        if st != ROCPROF_STATUS_SUCCESS:
            raise RuntimeError(f"codeobj_load failed id={load_id} status={st}")

    lane_map: Dict[int, int] = {}
    next_lane = 0
    gfxip_major = 0
    out: List[DecodedInst] = []

    def get_lane(cu: int, simd: int, slot: int) -> int:
        nonlocal next_lane
        key = (cu << 16) | (simd << 8) | slot
        if key in lane_map:
            return lane_map[key]
        lane_map[key] = next_lane
        next_lane += 1
        return lane_map[key]

    @_CB
    def cb(record_type: int, events_ptr: int, n: int, _user: int) -> None:
        nonlocal gfxip_major
        if record_type == RECORD_GFXIP and events_ptr and n:
            val = C.cast(events_ptr, C.POINTER(C.c_size_t))[0]
            gfxip_major = int(val)
            return
        if record_type == RECORD_INFO and events_ptr and n:
            infos = C.cast(events_ptr, C.POINTER(C.c_int))
            for i in range(int(n)):
                msg = info_string(handle, int(infos[i]))
                if msg:
                    import sys

                    sys.stderr.write("ATT info: " + msg.decode("utf-8", "replace") + "\n")
            return
        if record_type != RECORD_WAVE or not events_ptr or not n:
            return
        waves = C.cast(events_ptr, C.POINTER(Wave))
        for wi in range(int(n)):
            w = waves[wi]
            lane = get_lane(int(w.cu), int(w.simd), int(w.wave_id))
            insts = w.instructions_array
            for ii in range(int(w.instructions_size)):
                inst = insts[ii]
                out.append(
                    DecodedInst(
                        lane=lane,
                        cu=int(w.cu),
                        simd=int(w.simd),
                        slot=int(w.wave_id),
                        issue=int(inst.time),
                        duration=int(inst.duration),
                        stall=int(inst.stall),
                        category=int(inst.category),
                        marker_id=int(inst.pc.marker_id),
                        pc=int(inst.pc.addr),
                    )
                )

    att_bytes = att_path.read_bytes()
    att_buf = (C.c_ubyte * len(att_bytes)).from_buffer_copy(att_bytes)
    st = trace_decode(handle, cb, C.cast(att_buf, C.c_void_p), C.c_uint64(len(att_bytes)), None)
    destroy(handle)
    if st != ROCPROF_STATUS_SUCCESS:
        raise RuntimeError(f"trace_decode failed status={st}")

    return gfxip_major, out

