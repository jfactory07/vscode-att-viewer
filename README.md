# ATT Trace Viewer (VS Code extension)

Interactive timeline viewer for ROCm Advanced Thread Trace (ATT) inside VS Code, implemented as a Webview.

## Key features

- Interactive timeline (x-axis = cycles), per-wave lanes, hover tooltips
- Instruction category coloring + configurable palette (persisted)
- MFMA vs VALU split coloring
- Disassembly pane with:
  - Clickable register tokens (highlight matching/overlapping registers in nearby lines)
  - `s_waitcnt` dependency hints (polyline arrow to the corresponding memory op)
- Occurrences pane:
  - Lane filter dropdown
  - Δt0 column (delta vs previous occurrence)
- Navigation:
  - Mouse wheel zoom
  - Drag to pan
  - WASD shortcuts (Perfetto-like)
  - Ctrl + left-drag to measure a cycle interval
  - Alt + click to add/remove vertical cycle markers (persisted per trace)

## Screenshot

![ATT Trace Viewer screenshot](images/screenshot.png)

## Install (Marketplace)

Install from the VS Code Marketplace:

- VS Code UI: Extensions -> search for **ATT Trace Viewer**
- CLI: `code --install-extension jfactory07.att-trace-viewer`

## Install (development)

Open this folder in VS Code and run the extension host:

- VS Code: `Run and Debug` -> `Run Extension`
- CLI: `code --extensionDevelopmentPath=/path/to/vscode-att-viewer`

## Usage

- Command palette: `ATT Viewer: Open ATT Trace`
- Explorer context menu on an `.att` file: `ATT Viewer: Open ATT Trace (from file)`

The extension will:

1. Look for `*_results.db` in the same directory as the `.att` file
2. Use `results.db` tables `rocpd_info_code_object_*` to locate `*_code_object_id_*.out` files
3. Run the bundled `python/att2json.py` to decode the trace to JSON (cached under VS Code `globalStorage`)
4. Open a Webview panel to render the timeline

## Requirements

- ROCm installed, with:
  - `librocprofiler-sdk.so` (thread-trace decoder entry points)
  - `llvm-objdump` at `/opt/rocm/llvm/bin/llvm-objdump`
- Python 3 available (configurable via `attViewer.pythonPath`)
- Trace directory should contain:
  - the `.att` file
  - `*_results.db` (recommended)
  - `*_code_object_id_*.out` (code objects)

If `*_results.db` is missing, the extension falls back to scanning `*_code_object_id_*.out` files.

## Settings

- `attViewer.pythonPath` (default: `python3`)
- `attViewer.gpuArch` (default: `gfx950`)
- `attViewer.maxEvents` (default: 0 = all; for large traces, start with e.g. 200000)

## Keyboard and mouse shortcuts

Timeline:

- Mouse wheel: zoom (cursor-anchored)
- Drag: pan
- WASD: pan/zoom (Perfetto-like)
- Shift + WASD: faster pan/zoom
- Ctrl + left-drag: measure cycle interval (shows Δcycles)
- Alt + click: add/remove a vertical cycle marker

Disassembly:

- Click a register token (e.g. `v78`, `v[98:101]`, `s61`) to highlight matching registers in nearby lines
- Select `s_waitcnt lgkmcnt(N)` / `vmcnt(N)` to show a polyline arrow to the corresponding previous memory op

## Troubleshooting

- **Decode fails / missing ROCm libs**: ensure ROCm is installed and `/opt/rocm/lib` exists. The extension sets `LD_LIBRARY_PATH=/opt/rocm/lib`.
- **No disassembly**: verify `llvm-objdump` exists at `/opt/rocm/llvm/bin/llvm-objdump` and `attViewer.gpuArch` matches your code object architecture.
- **Large traces are slow**: set `attViewer.maxEvents` to a smaller value for faster iteration.

## Changelog

See [`CHANGELOG.md`](CHANGELOG.md).

