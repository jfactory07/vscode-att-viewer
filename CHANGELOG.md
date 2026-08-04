# Changelog

All notable changes to this extension will be documented in this file.

## Unreleased

- Label timeline rows by wave *slot* instead of `wave N`. A row is a wave slot on the single
  traced (CU/WGP, SIMD) and a slot hosts a new wave whenever the previous one retires, so the
  old label was wrong whenever a slot was reused. Row order is now sorted by
  `(cu, simd, slot)` rather than by whichever wave the decoder emitted first, so row N really
  is slot N. Disassembly count columns, the Occurrences slot filter and the TSV copy header
  follow the same naming, and the header line reports `wgp=/cu=` and `simd=` for the traced
  scope
- Fix `gfxip_major` always decoding as 0: the decoder passes it by value in the payload slot
  with `n == 0`, so the old code both skipped it and would have segfaulted had it not
- Fix a crash in the Occurrences pane when the lane filter selects a wave on which the
  instruction never issued (`Cannot read properties of undefined (reading 'asm')`); the pane
  now keeps the instruction header and explains that the lane has no occurrences
- Select and copy assembly out of the disassembly panel: click/drag rows or Shift+click to
  extend a line range, Ctrl/Cmd+A to take all lines, Ctrl/Cmd+C or the new `Copy` button to
  copy, and a right-click menu for instruction-only text or TSV with per-wave counts. The
  text is rebuilt from the decoded listing, so rows scrolled out of the virtualized grid are
  copied correctly.
- Draw wait-like instructions (`s_wait_*`, `s_barrier_wait`) as a full-width bar over their
  whole stall span instead of a 1-pixel sliver plus a stall line
- Fix long events starting left of the viewport being culled from the timeline
- Resolve wait target arrows on gfx12+, where `s_waitcnt` was split into per-counter waits
  (`s_wait_dscnt`, `s_wait_loadcnt`, `s_wait_storecnt`, `s_wait_kmcnt`, `s_wait_tensorcnt`,
  `s_wait_asynccnt`, `s_wait_xcnt` and the combined `s_wait_{load,store}cnt_dscnt`), and
  match the renamed DS ops (`ds_load`/`ds_store`) as well as `global_`/`flat_`/`scratch_`
  and `tensor_` producers

## 0.0.33

- Timeline viewer with category coloring and tooltips
- Disassembly + Occurrences split pane (virtualized disasm rendering)
- Configurable category colors (persisted)
- MFMA vs VALU color split
- Stall line rendering improvements
- Register token highlighting in disasm (click a register to highlight matching regs)
- `s_waitcnt` dependency visualization (polyline arrow to target memory op)
- Perfetto-like WASD navigation
- Ctrl+left-drag cycle range measurement overlay
- Alt+click cycle markers (persisted per trace)
- Occurrences lane filter and Δt0 column

