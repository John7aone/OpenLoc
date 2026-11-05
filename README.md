# OpenLoc（Tauri 桌面版）

当前产品是 Tauri 桌面程序：Rust 打开窗口，窗口里跑 `src/` 这份界面。配色沿用最初的 OpenLoc 界面：浅色是灰白底，深色是海军蓝底，主色是蓝（#2563eb），图标是简单线条 SVG。没有账号、激活，也不做付费加速。

侧栏固定八项，第一次打开落在「概览」：概览、模型、运行、对话、Agent、画图、视频、设置。当前这一项会高亮。

概览上的主路径：

1. 看本机硬件（读到了才标已检测；网页预览或检测失败会写「未检测」，不假装已经配好）。
2. 装 / 启引擎 →「去运行」。安装和启动都在运行页。
3. 下载模型 →「去模型」。权重在 Hugging Face。
4. 开始用 →「去对话」「去画图」「去视频」。

模型还没下载、运行还没选模型、对话还没启动服务、Agent 还没填文件夹、画图或视频缺引擎或模型时，每一页有一句说明和一个下一步按钮。硬件条和推荐模型仍在概览上。

## 它能做什么

- **硬件检测**：CPU、内存、磁盘、NVIDIA 显卡（nvidia-smi），并给模型大小建议。
- **模型目录**：16 个公开推荐模型，均为 Hugging Face 上公开的 unsloth GGUF 仓库，点开可实时查量化文件并一键下载。描述为本程序自己所写。
- **聊天**：llama.cpp 的 llama-server，上下文 4K / 8K / 16K / 32K 可选。
- **画图**：stable-diffusion.cpp 的 sd-cli。
- **视频**：两种，界面上分得清清楚楚——ffmpeg 动效视频（不是扩散生成，CPU 就能跑）；sd-cli 的 vid_gen 扩散视频（Wan，需要 Wan 视频模型和足够显存）。
- **Agent**：指定一个工作文件夹后，本地模型做计划，在文件夹内读写文件、跑命令，步骤实时显示。超出文件夹、含 `..`、删除、格式化等一律拦截，不要把整个文档、桌面或系统盘交给它。
- **截屏反馈**：侧栏底部点“截屏保存”，当前屏幕会存成 PNG 到 data/outputs/，把那张图发给 Muse 就能帮你看问题。
- **主题风格**：浅色 / 深色，侧栏和设置页都能切换，本地保存。浅色是灰白底，深色是海军蓝底、抬升卡片，按钮主色是蓝。
- **本地模型导入**：已有的 .gguf / .safetensors / .ckpt 粘个路径就能导入。

## 引擎和模型从哪来（全部免费公开）

引擎和模型不在安装包里。在「运行」页安装引擎，在「模型」页下载模型。这是 OpenLoc 自己的引擎能力，不是去连接本机另外装好的程序。

设置里的「关于」和运行页写了同样的地址，并按 MIT 致谢：

- llama.cpp：https://github.com/ggml-org/llama.cpp （聊天引擎 llama-server，MIT）
- stable-diffusion.cpp：https://github.com/leejet/stable-diffusion.cpp （画图/视频引擎 sd-cli，MIT）
- 模型：https://huggingface.co/unsloth （GGUF 量化文件）
- Wan 视频模型：https://github.com/Wan-Video/Wan2.2 ，权重在 Hugging Face 的 Wan-AI 组织下

不做付费加速，界面里没有「开通加速」。设置「关于加速」写明：下载速度只取决于你的网络。

## 在 Windows 上拿到 exe 的两种方法

### 方法一：GitHub Actions 自动打包（推荐，不用自己装 Rust）

1. 把这个仓库 Fork 或直接用它，点 Actions，运行 `Build Windows`。
2. 跑完后在那次运行的 Artifacts 里下载 exe 安装包或便携包。
3. 双击运行。第一次打开是概览：到「运行」页安装引擎，到「模型」页下载一个小模型（先从 Qwen3.5 4B 或 Gemma 4 E4B 入门），回到「运行」页启动，再去「对话」。

### 方法二：本地打包

需要先装 Rust（https://rustup.rs）和 Node.js 18+，然后：

```bat
npm install
python src-tauri/icons/generate-icon.py
npx @tauri-apps/cli icon src-tauri/icons/icon.png
npm run tauri build
```

打包产物在 `src-tauri/target/release/bundle/` 下面。

本地开发：

```bash
npm install
npm run tauri dev
```

需要 Node.js 18+ 和 Rust（https://rustup.rs）。窗口默认大约 1280×800。Linux 上还要有 Tauri 的系统库（WebKitGTK）；缺这些库时 `npm run tauri dev` 编不过。

编不过时，可以用浏览器走查同一份界面，这只是界面预览，不是桌面程序：

```bash
python3 -m http.server 8753
```

然后打开 http://127.0.0.1:8753/src/index.html 。直接双击 `src/index.html` 也可以。限制：没有本机硬件检测，不能下载，不能启动引擎，对话、画图、视频和 Agent 都不会真的跑。页面会标「网页预览」或「未检测」。

`shots/` 里是 1280×800 的走查截图，文件名注明主题：侧栏和概览（深色、浅色）、运行页（浅色）、对话空态（深色）。静态页面截的，所以硬件标着未检测。直接打开 `src/index.html` 可以走查同一套样式。

## 生成的文件放哪

程序所在目录旁的 `data/` 文件夹：`data/engines/`（引擎）、`data/models/`（模型）、`data/outputs/`（生成的图片和视频）。

## 没验证过的部分（实话）

这次收的是界面路径。1280×800 的走查用浏览器打开 `src/index.html`，因为当前环境没有 WebKitGTK，`npm run tauri dev` 没有编出桌面窗口。Windows 安装包仍走 GitHub Actions。画图出图和 Wan 扩散视频需要有显卡的 Windows 电脑验证，没有 GPU 会很慢或直接报错。没有做付费加速，也没有改 Agent 的安全边界。
