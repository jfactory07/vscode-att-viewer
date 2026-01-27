# VS Code 扩展：ATT Trace Viewer

在 VS Code 里用 Webview 交互式查看 ROCm Advanced Thread Trace（ATT）：

- 横轴：cycle
- 颜色：指令类别（VALU/LDS/VMEM/IMMED…）
- Hover：指令反汇编文本 + issue cycle + duration/stall + PC
- 交互：滚轮缩放、拖拽平移、纵向滚动（按 wave lane）

## 安装（开发模式）

1. 打开 VS Code
2. `Run and Debug` → `Run Extension`（或命令行 `code --extensionDevelopmentPath=/mnt/att-analysis/vscode-att-viewer`）

## 使用

- 命令面板：`ATT Viewer: Open ATT Trace`
- 或资源管理器右键 `.att` 文件：`ATT Viewer: Open ATT Trace (from file)`

插件会：
1. 在 `.att` 同目录寻找 `*_results.db`
2. 用 `results.db` 的 `rocpd_info_code_object_*` 表定位 `*_code_object_id_*.out`
3. 运行内置 `python/att2json.py` 生成 trace JSON（缓存到 VS Code globalStorage）
4. 打开 Webview 渲染

## 设置项

- `attViewer.pythonPath`：默认 `python3`
- `attViewer.gpuArch`：默认 `gfx950`
- `attViewer.maxEvents`：默认 0（全量）；大 trace 建议先设例如 200000

