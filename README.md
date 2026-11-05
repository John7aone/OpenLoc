# OpenLoc（桌面版，原创）

这是一个 Windows 桌面程序，不是网页版。界面布局参考了常见的本地 AI 工具（左侧导航 + 概览硬件卡），但颜色、图标、代码都是自己写的：浅色是冷灰底 + 青色主色，图标是我自己画的简单线条 SVG，没有照搬任何软件的配色和图标，也没有账号、激活和付费加速。

## 它能做什么

- **硬件检测**：CPU、内存、磁盘、NVIDIA 显卡（nvidia-smi），并给模型大小建议。
- **模型目录**：16 个公开推荐模型，均为 Hugging Face 上公开的 unsloth GGUF 仓库，点开可实时查量化文件并一键下载。描述为本程序自己所写。
- **聊天**：llama.cpp 的 llama-server，上下文 4K / 8K / 16K / 32K 可选。
- **画图**：stable-diffusion.cpp 的 sd-cli。
- **视频**：两种，界面上分得清清楚楚——ffmpeg 动效视频（不是扩散生成，CPU 就能跑）；sd-cli 的 vid_gen 扩散视频（Wan，需要 Wan 视频模型和足够显存）。
- **Agent**：指定一个工作文件夹后，本地模型做计划，在文件夹内读写文件、跑命令，步骤实时显示。超出文件夹、含 `..`、删除、格式化等一律拦截，不要把整个文档、桌面或系统盘交给它。
- **截屏反馈**：侧栏底部点“截屏保存”，当前屏幕会存成 PNG 到 data/outputs/，把那张图发给 Muse 就能帮你看问题。
- **主题风格**：浅色 / 黑色，侧栏和设置页都能切换，本地保存。黑色主题是纯黑背景、深灰卡片、青色按钮。
- **本地模型导入**：已有的 .gguf / .safetensors / .ckpt 粘个路径就能导入。

## 引擎和模型从哪来（全部免费公开）

引擎和模型不在安装包里，第一次用时在程序里点下载：

- llama.cpp：https://github.com/ggml-org/llama.cpp （聊天引擎 llama-server）
- stable-diffusion.cpp：https://github.com/leejet/stable-diffusion.cpp （画图/视频引擎 sd-cli）
- 模型：https://huggingface.co/unsloth （GGUF 量化文件）
- Wan 视频模型：https://github.com/Wan-Video/Wan2.2 ，权重在 Hugging Face 的 Wan-AI 组织下

## 在 Windows 上拿到 exe 的两种方法

### 方法一：GitHub Actions 自动打包（推荐，不用自己装 Rust）

1. 把这个仓库 Fork 或直接用它，点 Actions，运行 `Build Windows`。
2. 跑完后在那次运行的 Artifacts 里下载 exe 安装包或便携包。
3. 双击运行，第一次在“模型与引擎”页下载引擎，在“模型目录”页下载一个小模型（先从 Qwen3.5 4B 或 Gemma 4 E4B 入门），再去聊天页启动服务。

### 方法二：本地打包

需要先装 Rust（https://rustup.rs）和 Node.js 18+，然后：

```bat
npm install
python src-tauri/icons/generate-icon.py
npx @tauri-apps/cli icon src-tauri/icons/icon.png
npm run tauri build
```

打包产物在 `src-tauri/target/release/bundle/` 下面。本地开发调试用 `npm run tauri dev`。

## 生成的文件放哪

程序所在目录旁的 `data/` 文件夹：`data/engines/`（引擎）、`data/models/`（模型）、`data/outputs/`（生成的图片和视频）。

## 没验证过的部分（实话）

这份桌面代码在作者的 Linux 虚拟机上还没有完整编译验证（虚拟机没有 Rust 工具链，Tauri 的 Windows 打包走 GitHub Actions）。Windows 打包如果 Actions 报错，把 Actions 日志发回来，我再修。画图出图和 Wan 扩散视频也需要你在有显卡的 Windows 电脑上验证，没有 GPU 会很慢或直接报错。
