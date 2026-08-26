# Changelog

All notable changes to this extension will be documented in this file.

## Unreleased

- Disassembly hover help now uses **architecture-aware** indexes built from AMD's official
  machine-readable ISA XML (GPUOpen). The gfx target is inferred from the code object
  (`gfx950` in the file name or `readelf -n` notes) and only definitions from the matching
  CDNA/RDNA generation are shown, with arch name, functional group, operands, and XML source cited
- Disassembly: hover an instruction row to see a short ISA definition, operand syntax, and notes
  (replaces the earlier hand-written mnemonic cheat sheet)
- HIP source pane: C++ syntax highlighting (keywords, types, functions, macros, literals,
  comments, preprocessor, HIP attributes). Lines that compiled to nothing stay dimmer but keep
  token colors
- Keep the call stack strip visible in the HIP pane with a `Call stack` label, placeholder text
  before an instruction is selected, and an error line when inline-stack lookup fails
- Fix source-location parsing when DWARF carries a column (`file:line:col`): the old greedy
  match treated `kernel.h:525` as the file name, so outer call-stack frames could not load their
  captured snapshot even when `source_*_kernel.h` existed
- HIP source pane: show the selected instruction's full inline call stack (via `llvm-symbolizer
  --inlining`) between the file picker and the source text; click a frame to jump to that file and
  line. Frame `#0` is the innermost site (what `--line-numbers` showed before); higher numbers walk
  outward through callers
- Read the HIP source from the copies rocprof saved with the trace, never from the working tree.
  rocprofv3 writes every source file it could read at capture time into the dispatch's UI output
  directory as `source_<i>_<name>`, and that copy is the text the code object's line numbers refer
  to; the tree drifts away from it with the next edit. It already had: a kernel header captured at
  1113 lines is 1194 in the tree, first insertion at line 219, so every instruction attributed
  below that pointed at the wrong statement — and a `-gline-tables-only` line table carries no file
  checksum, so nothing could notice. The host resolves the directory from the trace name
  (`zrow_16742_shader_engine_0_338.att` → `ui_output_agent_16742_dispatch_338`) and serves the copy
  whose file name the DWARF path ends in, refusing rather than guessing when a capture saved two
  files under one name. The pane labels the text `snapshot` and names the copy in the tooltip. The
  `HIP` button now needs both halves — a line table and a capture that saved sources — and its
  tooltip says which one is missing, so a trace taken before line tables were enabled explains
  itself instead of silently showing today's text. The file dropdown's tooltip used to name the
  compile-time path alone, which is also where the working tree keeps the file and so read as a
  claim about which copy was on screen; it now names the path the code object was built from and
  the captured copy the text came from, by exact file once the host has read it
- Name the code object by file name in the disasm header instead of spelling out its path. The
  capture directory is the same for every marker in a trace and long enough to crowd out the find
  bar, and it is not what you read the header for. The full path is on the header's tooltip and on
  the new `copy path` button next to the name, which puts it on the clipboard when you need it for
  a shell — `llvm-objdump`, `readelf` — outside the viewer
- Keep the wait-dependency link off the addresses it points between. The elbow was folded at
  x=10 and run out to x=66, both inside the addr column, so the vertical segment sat on the
  leading digits of every address it passed and the two horizontal segments covered the
  addresses of the wait and its target outright — the two you look up when reading the link.
  The addr column now reserves a 16 px channel on its left, indented past by the addresses and
  widened into rather than taken out of the column, so the addresses keep exactly the width they
  had. The link is drawn inside the channel and its arrow stops 3 px short of the text
- Show the HIP source the instructions came from, in a pane to the right of the listing, opened
  with the `HIP` button. Clicking an instruction scrolls the pane to its source line, whether or
  not the traced dispatch ran it; clicking a source line tints every instruction that line
  compiled to and takes the listing to the first of them. That is how a single line of a kernel
  header shows up as the four `ds_store_b128` whose execution windows overlap on the timeline —
  on the trace at hand, the staging write at `kernel.h:539` compiles to 32 `ds_store_b128` over
  the code object, four of them the ones on the timeline. Line numbers that produced instructions
  are marked with the count in their tooltip, and lines that compiled to nothing stay dim. The
  dropdown lists every file the code object was compiled from with its instruction count, so
  inlined headers are reachable, and following an instruction into another file switches the pane
  over to it. Positions come from the code object's DWARF line table (`llvm-objdump
  --line-numbers`), so the button stays disabled, with a tooltip saying why, for a code object
  built without `-gline-tables-only`. The host only reads files that a parsed line table names.
  Pane visibility, width, file and line selection survive a webview reload
- Stack overlapping execution windows into sub-rows within a slot's row. A bar covers an
  instruction's execution, and on gfx10+ `duration` is `stall + execution time`, so windows
  overlap whenever a wave issues into a multi-cycle pipe faster than it drains: four
  `ds_store_b128` issued one per cycle each run 3 cycles, and an 8-cycle
  `v_wmma_f32_16x16x32_f16` runs while scalar ops keep issuing behind it. Those bars used to
  paint over each other and read as one blob. Sub-rows are assigned first fit in issue order, so
  a row reads top-down in issue order and a stack of *n* bars means *n* instructions in flight;
  measured over the traces at hand, slots need two or three sub-rows and 85–95% of records stay
  on the top one. A slot with no overlap keeps its original height, and a slot that stacks splits
  the same height instead of making the timeline taller. Hover and click resolve to the sub-row
  under the pointer, and the tooltip reports it as `sub-row=2/3`
- Fix the disassembly highlight going stale when a timeline click lands in the same virtualized
  window as the previous one (a neighbouring instruction, or another sub-row of the same stack):
  the row repaint did not track the selection
- Clip the timeline to the plot area, so panning right no longer slides event bars, markers,
  the measure band and the selection outline over the wave-slot labels in the left gutter
- Fix `gpuArch is not defined` aborting the open of any trace whose decoded JSON exceeds the
  webview soft limit. The first decode succeeds and the event-capped second one then throws a
  `ReferenceError`, because it still passed a variable that went away with the
  `attViewer.gpuArch` setting. That call also dropped `rocprofilerSdkPath` and
  `llvmObjdumpPath`, so the re-decode ignored both configured paths
- Search the disassembly from the panel header or with Ctrl/Cmd+F. The query matches the
  instruction text and the `addr` column, matching substrings are highlighted in place and
  every matching line is tinted; Enter/Shift+Enter (or ↑/↓) step through the matches and wrap,
  `Aa` matches case and `.*` switches to a regular expression. Matches are collected as line
  indices and the highlight ranges are computed for visible rows only, so a query that hits
  most of a large listing stays cheap. Searching does not filter rows or move the selection,
  so the timeline, wait arrows and copy selection are unaffected
- Restrict the disassembly search to instructions the trace actually sampled. The listing is
  the whole code object, so a query like `tensorcnt` otherwise mostly lands in code the
  dispatch never entered; the `all` toggle brings those lines back, and the match counter
  turns yellow with a tooltip when it hid something
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

