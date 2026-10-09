# Changelog

All notable changes to this extension will be documented in this file.

## Unreleased

- A shift+drag on the timeline names a slot as well as an interval, and the `Add to chat`
  button that appears beside it attaches what that slot ran in those cycles. The measurement
  was a pair of cycle numbers and nothing else, so a reader who had just measured 757 cycles
  of one wave slot went to the listing to find the instructions behind them by hand — the one
  question the panel can answer and the reader cannot. The drag already starts on a row, so
  the row is the slot: the shaded window covers that row and no other, since the rows it says
  nothing about would be claiming cycles they were not measured for, and the label names the
  slot next to the delta. Ctrl+drag is left as it was, spanning every row and measuring the
  interval and nothing else;
  the two write the same region, so the later drag replaces the earlier one. An instruction
  is in the window when its span touches it rather than when
  it issues inside it, since the wave stalled across the whole measurement issued before the
  measurement began and is the one holding the cycles being asked about. What is attached is
  one line per address, in address order, not the execution sequence: a loop revisiting an
  address a hundred times would bury the body it iterates under its own repeats. The cycles
  are what the sequence would have carried, and they are in the header instead, as the
  interval and the latency it covers
- The listing follows a shift+drag. Measuring a stretch of one slot's work and then hunting
  for the instructions behind it by hand was the gap the window was meant to close, and it was
  still open in the pane next to it. Two marks land there, because one cannot do both jobs: the
  rows spanning the window are selected, which is what `Copy` and the listing's own `Add to
  chat` act on and is necessarily contiguous, and the addresses the slot actually ran are
  tinted inside that span — a loop holding 757 cycles touches a handful of addresses scattered
  through a body whose branches it never took, and a plain range would claim all of them. The
  first marked line is scrolled to, the pane switches to the listing to show it, and a window
  from another code object disassembles it first and marks it when it arrives. Selecting lines
  by hand afterwards drops the marks: a hand-made selection is a new subject, and leaving them
  underneath it would explain nothing
- `att_current` renders a measured window as one. The executions column belongs to lines
  picked out of the listing, which are a piece of the program; an interval on one row is a
  piece of time, and how often an address was reached over the whole dispatch says nothing
  about the 757 cycles in front of the reader. It is dropped there, and the heading leads with
  the latency and the slot rather than with a count of instructions
- "Add to chat" attaches from the output view and from nowhere else. The two paths kept behind
  it are gone: `editor.action.clipboardPasteAction` is a Monaco command and the chat input is
  not a Monaco editor, so the paste resolved without throwing and without pasting, and the
  panel reported a success it had not observed. With the fallbacks went
  `attViewer.addToChatViaOutput`, `attViewer.addToChatAttachAsReference` and
  `attViewer.addToChatSubmit` — the output path is not a setting any more, it is the path
- The channel is rebuilt on each attach rather than cleared, and the selection is handed over
  only once the output document is seen to hold the listing. `clear()` and `append()` land out
  of order, so the first click attached an empty view and the second one the click before it;
  where the attach cannot be made the toast says so and points at `att_current`, which reaches
  the same selection whatever the button did
- The attached listing names every analysis tool rather than `att_current` and `att_disasm`
  alone: `att_summary`, `att_phases`, `att_issues`, `att_issue`, `att_hot` and `att_source`,
  each with what it answers. The header is the only place the model is told the rest exist
- `att_current` resolves the dispatch the panel has open. A capture directory holds many
  dispatches under one directory, and `resolve` fell through to the directory before trying
  the `.att` file that names the dispatch, so it returned whichever came first — on a capture
  of 32 it read #129 while the panel showed #369
- `attViewer.addToChatViaOutput` attaches the selection from an output view, and nothing opens
  in the editor area. An output view is a code editor like any other, only it lives in the
  panel, so the selection can be made in it and handed to the same command — where opening the
  selection file meant a tab flashing past and the trace panel coming back on every click. The
  channel is cleared before each attach and is not the one the log goes to, since whatever else
  it held would be attached along with the selection. The editor path stays behind it as the
  fallback
- The selection is attached by the command the keybinding runs, `aichat.newchataction`, called
  with no arguments so that Cursor states the focused editor's selection itself. The payload
  cannot be built here: `composer.addsymbolstocomposer` takes `codeSelections` and draws the
  chip, and the chat then cannot be sent at all — it fails to serialize, and reports it as a
  server error with nothing in it to point back at the chip. That held for every shape tried,
  Monaco's `IRange` as much as a `vscode.Range`, the selection file inside the workspace as
  much as outside it, the tab left open behind the chip as much as closed; the same file
  attached by hand with Ctrl+L sends. `editor.action.addSymbolToChat`, which is what the id
  suggests the keybinding runs, is accepted from an extension and does nothing. Two smaller
  things came out of it: the editor selection now runs to the end of the last line rather than
  stopping at its start, since Cursor reads the attached range from it, and the question is
  pasted where the attach command left the focus instead of calling `composer.focusComposer`
  first, which would have reached for whichever chat was focused before and asked the wrong
  conversation
- With the selection attached, the chat input is left holding the question alone. What to call
  for the cycles, and which trace and address range to call it for, moved into the header of
  the attached file: the chip is the whole file, so it arrives with the selection anyway, and
  repeating it in the input put three lines of instructions next to a one-line question. The
  text fallback still says all of it, since there is no file in the conversation to say it
- Attaching the selection as a reference stops at the first command that takes it, and closes
  the tab it opened rather than whichever one is active. Cursor 1.128 accepts the Uri/Range
  payload `composer.addsymbolstocomposer` rejected before, so with
  `attViewer.addToChatAttachAsReference` on the chip does appear — but every attempt was being
  made in turn, and the last of them, `editor.action.addSymbolToChat`, routes into a *new* chat
  with the listing pasted in, so one click produced both the chip and the wall of text it was
  meant to replace; that command is gone. `closeActiveEditor` was the other half: the attach
  takes focus into the chat, and the tab it closed a moment later could be the trace panel the
  selection was made in. When no command accepts the payload the click now falls back to
  writing the question as text, instead of ending with nothing but the clipboard
- `Add to chat` writes the question, not the listing, and no longer opens anything. It used to
  paste up to forty instructions as text into the chat input, which is what the reader was
  looking at instead of a collapsed reference: attaching one needs a command that acts on the
  focused editor's selection, so the selection file was opened, selected and closed on every
  click, and Cursor 3.20 has no command that accepts it — `editor.action.addSymbolToChat` is
  registered but does nothing, and `composer.addsymbolstocomposer` rejects the payload it is
  handed. The listing was redundant anyway: `att_current` already returns the selection with
  the stall cycles measured against each instruction, which is the part worth asking about and
  the part a pasted listing cannot carry. What lands in the input is the question, the address
  range and the path to the file, so a chat with no MCP server can still read it. The reference
  path is kept behind `attViewer.addToChatAttachAsReference`, off, for the day there is an API
  for it. Because none of these commands reports whether it did anything, what was tried and
  what came back is appended to `add-to-chat.log` beside the state file, and the outcome is
  reported in a window notification rather than only in a toast in the corner of the panel —
  the button's effect is in the chat, where a panel toast cannot be seen
- The timeline is drawn at the display's pixel density. Its canvas was sized in CSS pixels
  and stretched to fit by the compositor, so on a HiDPI screen the lane labels, the cycle
  ruler and every event edge arrived through a 2x upscale — the one panel in the window that
  did not read sharp, next to a disassembly listing that did. Drawing and hit testing still
  work in CSS pixels; only the backing store and the canvas transform scale, so none of the
  geometry the mouse is measured against moves
- `Phases` in the timeline's toolbar marks the same split on the trace with one labelled
  white line per region. The split is by address and the timeline's axis is time, so no
  single moment divides them: a lane hosts several waves in turn and each reaches the loop
  on its own schedule. Each line is drawn at the median entry across that launch's waves,
  which places it among them rather than ahead of or behind all of them — enough to see
  where the dispatch leaves setup and enters steady state, which is what the marks are read
  for. A capture can hold the same kernel dispatched more than once, and a median taken
  across every wave lands in the gap between the launches, describing neither; the waves are
  grouped by how far apart they start relative to how long one lives, since a launch fills
  the machine at once and the next cannot begin until the slots drain. Overlap is no use as
  a signal — consecutive dispatches do overlap, one still finishing on a slot the next has
  not reached. The analysis runs on first use and is shared with the MCP tools' cache
- `att_phases`, which marks where the traced code stops setting up, starts iterating and
  starts draining, and prices each region. The cut is made at the hot loop's edges rather
  than at anything the symbol table or the source says, because after inlining and
  scheduling neither describes the code that ran; the loop the trace spun in is the one
  boundary the hardware agrees on. Each region reports its address span, how many distinct
  instructions ran and how often, its cycles as a share of the dispatch, what it stalled on,
  and its costliest instructions — which separates a kernel that is slow in steady state
  from one paying for a prologue it enters once. The two dividers name the instruction the
  region begins on and the one that falls through into it
- `Add to chat`, beside `Copy` in the disassembly toolbar, and `att_current`, the MCP tool that
  reads what it wrote. Moving the analysis into a chat cost the analysis its subject: the panel
  knows which of the 200-odd captures on disk is open and which instructions the reader has
  highlighted, and the chat knew neither, so every question had to re-identify a run by name
  before it could be asked. The panel now records the trace it opens, and the button attaches
  the selected instructions to it with their addresses and execution counts; `att_current`
  hands the model both, which is what makes "why is this stalling?" about the rows on screen.
  The button also writes the question into the chat input, so the selection arrives as a
  prompt rather than only as something the model could go looking for. The instructions
  arrive as one collapsed chip rather than a wall of text, which is what Cursor's own
  `add to chat` produces because it attaches a file range instead of pasting: so the
  selection is written to a file and that range is handed to the same command, leaving only
  the question in the input. Cursor exposes no API for attaching context, and none of these
  commands reports whether it did anything, so the panel says which path it took rather than
  claiming success — falling back to a focus-and-paste of the whole listing, and then to
  leaving it on the clipboard, naming the reason either way.
  The listing is capped in the prompt and complete in the state file, so a long selection
  costs the chat input nothing. The selection survives a refocus of the same trace and is
  dropped when a different one is opened, since a range of addresses only means anything in
  the trace it was selected in
- `Code review` tab: static checks on the traced kernel's machine code, each priced by what the
  trace measured. A disassembly listing says what the compiler emitted and a trace says what it
  cost; neither alone identifies a problem worth fixing, so no check reports a code pattern it
  cannot attach cycles to. What it looks for: occupancy and which of VGPRs or LDS bounds it,
  checked against the concurrency the trace actually reached; register spills to scratch;
  `s_waitcnt vmcnt(0)` immediately followed by `s_barrier`, which stops the workgroup on the
  slowest load of the slowest wave with nothing issued in between; how many instructions sit
  between each costly wait and the load it blocks on, since that gap is the kernel's whole
  opportunity to hide the latency; and how long the matrix pipe runs without a memory
  instruction beside it. The hot loop is found from the backward branch the trace took most
  often — the loop the hardware ran, whatever the source loop looked like — and reported with
  its instruction mix, iteration count and cycles per iteration, followed by its disassembly
  annotated per instruction with hits, stall and execution cycles
- The in-panel analysis view is gone, along with the `Analyze` button that opened it. Every tab
  it had is answered by the MCP tools below, and the two that were not — the stacked stall chart
  and the wave lifetimes — were not worth keeping a second view, a stylesheet and 1,200 lines of
  webview code alive for. The panel is a timeline viewer again. Removed with it:
  `media/analysis.js`, `media/analysis.css`, the report builder in the host, and the
  `attViewer.analysisSingleFile` setting; `att_analyze.py` and `att_asm_checks.py` stay, since
  the server runs them
- `python/att_mcp.py`, an MCP server over the same analysis, replacing the `Ask AI` button. The
  button flattened one dispatch into a ~40 KB document and the conversation ended there: a model
  could not ask for the disassembly outside the hot loop, or for a second dispatch to compare
  against, and the parts it did not need crowded out the parts it did. The server indexes every
  capture on disk instead and answers one question at a time — `att_summary`, `att_issues`,
  `att_issue`, `att_disasm`, `att_hot`, and `att_source`, which reads the source rocprofv3
  copied at capture time rather than the drifted working tree. Indexing only stats
  directories; a report is built on first query and cached against the trace's mtime, so
  nothing is analyzed until something asks about it
- Kernel facts are read from the code object's own metadata note (`llvm-readelf --notes`):
  VGPR/AGPR/SGPR counts, LDS per workgroup, workgroup size, and the compiler's spill counts
- Fix waves-in-flight being overcounted. Every wave whose lifetime touched a bucket was counted
  in it, so waves that ran one after another inside one ~1200-cycle bucket both counted and the
  peak came out at 16 waves per CU — twice what the register file can host. Sweeping begin/end
  events gives the real concurrency; on the trace at hand the peak is now 8 waves per CU, which
  is exactly the 2 waves/SIMD that 244 VGPRs and 128 KB of LDS allow

- Bottleneck analysis, as a second view of the trace panel: the `Analyze` button in the
  timeline's toolbar switches to it and `Timeline` switches back, so it is read in the same tab
  as the trace it belongs to rather than in an editor of its own. The report is built on the
  first open and kept for the life of the panel, and which tab was open survives the
  switch. The timeline
  answers what a wave did at cycle N; nothing answered where the dispatch spent its cycles, and
  a single shader engine's 16 waves is too thin a sample to answer it from, so the panel decodes
  **every `.att` of the dispatch** and sums them. Each stall is charged to the reason behind it
  rather than to the decoder's instruction category: ATT records a wave's stall against the
  instruction it was about to issue, so an `s_waitcnt vmcnt(0)` holding 400 cycles is
  global-memory latency, the same 400 on a `ds_read` is LDS issue pressure, and an `s_barrier` is
  one wave in the workgroup arriving late — three very different fixes that the category alone
  reports as `IMMED`, `LDS` and `IMMED`. Six tabs: ranked findings with the measurement behind
  each one and the exec/stall/unattributed cycle budget; stall reasons stacked over the dispatch
  against waves in flight, which separates a ramp or a tail from a uniformly bound kernel; hot
  source lines and hot instruction addresses, both sortable and filterable, clicking a row opens
  the line in the source the capture saved; per-shader-engine and per-wave tables for imbalance;
  and rocprof's own `stats_ui_output_*.csv` as a cross-check. `Copy report` writes a markdown
  summary to the clipboard. `attViewer.analysisSingleFile` restricts it to the selected trace
- Decoder: `decode_att_waves` keeps each wave record separate instead of flattening every
  instruction into one list, so wave lifetimes and occupancy over time are available. The
  existing timeline decode is unchanged
- Size the view below the toolbar by what is left rather than by `100%` minus a figure for the
  toolbar. The figure was 44px and the toolbar is as tall as its buttons, 48px, so the page
  overflowed by 4px — enough for a second scrollbar to appear beside the analysis view's own,
  and for the timeline to lose 15px of width to a bar that scrolled nothing

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

