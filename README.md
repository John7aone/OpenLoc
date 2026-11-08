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
- **模型目录**：16 个公开推荐模型，均为 Hugging Face 上公开的 unsloth GGUF 仓库，点开可实时查量化文件并一键下载。描述为本程序自己所写。推荐卡片会写出参数规模、量化、约略体积、落在显存还是内存，以及约估的 tok/s。
- **推荐速度**：概览和模型页上的「约 XX tok/s」来自 `src/recommend.js`，是带宽公式，不是跑分。体积按总参数和量化字节约出（Q4_K_M 为每十亿参数 0.56 GB），再加 0.8 GB 余量。整份放进显存的 85% 才标「流畅」。tok/s = 有效带宽 ÷ 每 token 要读的权重；稠密模型读全部参数，混合专家只读激活参数。显卡用公开规格里的显存带宽 × 0.35，名字对不上就按显存容量取一档并写明。没有硬件时写「待检测 / 网页预览」或「约估不可用」，不编一个精确数字。运行页的预计速度用同一套公式。已安装文件优先用真实体积。
- **聊天**：llama.cpp 的 llama-server，上下文 4K / 8K / 16K / 32K 可选。输入栏「截图」只保存框选确认后的区域：Windows 上先把屏幕冻在内存里，拖拽框选，点「确认」或按 Enter 才把选区裁成 PNG；Esc、右键或「取消」不贴图，也不会改存整屏。没有选区工具的系统同样不改成整屏。网页预览会说明做不到，不会假装已经贴图。联网开关默认关闭，没有接上检索时只说明没搜到，不编造结果。
- **画图**：stable-diffusion.cpp 的 sd-cli。
- **视频**：两种，界面上分得清清楚楚——ffmpeg 动效视频（不是扩散生成，CPU 就能跑）；sd-cli 的 vid_gen 扩散视频（Wan，需要 Wan 视频模型和足够显存）。
- **Agent**：指定一个工作文件夹后，本地模型做计划，在文件夹内读写文件、跑命令，步骤实时显示。超出文件夹、含 `..`、删除、格式化等一律拦截，不要把整个文档、桌面或系统盘交给它。
- **主题风格**：浅色 / 深色 / 跟随系统。设置里的「外观」可选这三项。侧栏底部的月亮 / 太阳会改成对应的浅色或深色。本地保存。浅色是灰白底，深色是海军蓝底、抬升卡片，按钮主色是蓝。
- **本地模型导入**：已有的 .gguf / .safetensors / .ckpt 粘个路径就能导入。

## 引擎和模型从哪来（全部免费公开）

引擎和模型不在安装包里。在「运行」页安装引擎，在「模型」页下载模型。这是 OpenLoc 自己的引擎能力，不是去连接本机另外装好的程序。

设置里的「关于」和运行页写了同样的地址，并按 MIT 致谢：

- llama.cpp：https://github.com/ggml-org/llama.cpp （聊天引擎 llama-server，MIT）
- stable-diffusion.cpp：https://github.com/leejet/stable-diffusion.cpp （画图/视频引擎 sd-cli，MIT）
- 模型：https://huggingface.co/unsloth （GGUF 量化文件）
- Wan 视频模型：https://github.com/Wan-Video/Wan2.2 ，权重在 Hugging Face 的 Wan-AI 组织下

不做付费加速，界面里没有「开通加速」，也没有单独的高速下载线路。设置「高级设置」可以选填 Hugging Face 令牌、Hugging Face 镜像和 GitHub 下载前缀，都只作用于免费公开下载；留空就走官方地址。模型目录和作品目录这一版还不能改到别的盘。第三方 API 只记在本机，对话和 Agent 仍只走本机 llama.cpp。

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

`shots/` 里是 1280×800 的走查截图。`shots/overview-recommend.png` 和 `shots/models-recommend.png` 是推荐卡片：浏览器里替硬件接口填了一份示例（RTX 3070 Ti、8 GB 显存、32 GB 内存），用来看 tok/s 和体积怎么排版，不是这台机器检测到的，也不是 Windows 实测。`shots/overview-preview-speed.png` 是不注入硬件的网页预览，速度写「待检测 / 网页预览」。更早的侧栏、运行页、对话截图仍是静态页面，硬件标着未检测。直接打开 `src/index.html` 可以走查同一套样式。

## 生成的文件放哪

程序所在目录旁的 `data/` 文件夹：`data/engines/`（引擎）、`data/models/`（模型）、`data/outputs/`（生成的图片和视频）。

## 本机聊天闭环

安装聊天引擎会把 zip 解压到 `data/engines/llama/`，找到 `llama-server` 或 `llama-server.exe` 才算装好。启动时命令行固定 `--host 127.0.0.1`，健康检查要看到 `{"status":"ok"}` 才把状态标成运行中。对话发到这个本机端口；联网开关默认关，打开后才检索，失败会说明原因。截图只保存确认过的选区，附件只留在本机，纯文本模型看不到图片内容。

服务没启动、模型不在 `data/models`、端口被占用、请求失败，都会用中文写明原因和下一步，不会把状态标成已经在跑。生成过程中可以停止，已经收到的文字会留下。

## 在这台开发环境里实际跑过的

命令和结果分开记。mock 不代表真的推理。

```bash
node --test test/chat-flow.test.mjs
cargo test --manifest-path src-tauri/Cargo.toml
```

在准备这次提交的 Linux 环境里，`npm test` 为 22 通过（`test/chat-flow.test.mjs` 8 项，`test/recommend.test.mjs` 14 项）。`cargo test --manifest-path src-tauri/Cargo.toml` 为 22 通过（原有 18 项，加上推荐落点 4 项）。这台环境自带的 Cargo 1.83 读不了现有 lockfile 里的 edition 2024，所以 Rust 测试用的是 Rust 1.99。其中 2 项真实模型测试在没有 `OPENLOC_LIVE_PORT` 时直接返回，不访问网络。另一次 `OPENLOC_LIVE_PORT=18080 cargo test --manifest-path src-tauri/Cargo.toml live_model` 走了下面的真模型。Rust 侧用本机假 HTTP 服务覆盖：健康检查只有 `status=ok` 才算就绪、端口占用、非流式回复、思考字段被拒绝后重试、流式中途取消。解压测试按 Windows CPU 包的布局放了根目录上的 `llama-server.exe`，并拒绝路径穿越。推荐速度的数字由 `test/recommend.test.mjs` 锁住，例如 4B Q4 在标称 608 GB/s 的 8 GB 显卡上约为 95 tok/s。这是公式结果，不是那块显卡的实测。

另一次真实推理（不是 mock）：llama.cpp `b12110` 的 Ubuntu x64 CPU 包，模型 `stories15M-q4_0.gguf`（约 19MB，公开小模型）。命令行测试里 `llama-server` 监听 `127.0.0.1:18080`，`/health` 返回 ok。经 OpenLoc 的请求函数拿到非空回复，非流式开头是 “Suddenled the ground…”，流式开头是 “Sisss are very icy windows…”。同一套引擎和模型也在 Linux 桌面窗口里走过：运行页显示“健康检查已通过”和 `127.0.0.1:8080`，联网开关保持关闭，对话页收到以 “Suddenled her feet…” 开头的回复。限制：这是 TinyStories 小模型，不会按指令回答；训练上下文只有 128，引擎把更长的上下文截断了；跑在 Linux CPU 上，不能当成 Windows 或显卡结果。没有下载更大的模型，也没有调用收费 API。

## 没在 Windows 真机上验证

这个环境不能打出 Windows 安装包，也没有在 Windows 电脑上双击运行过。下面的步骤是给 Windows 用户自己验证的，不是“已经通过”的记录。公开仓库上的 `Build Windows` 使用 GitHub 托管的标准 `windows-latest`，没有加大权限，也没有开付费 runner。安装包如果打出来了，在该次 Actions 运行的 Artifacts 里，名字是 `openloc-windows`。过期或运行失败就没有可下载的包。

Windows 上建议这样试：

1. 安装 Rust（https://rustup.rs）和 Node.js 18+，或者等上面的 Actions 产物。本地打包：

```bat
npm install
python src-tauri/icons/generate-icon.py
npx @tauri-apps/cli icon src-tauri/icons/icon.png
npm run tauri build
```

产物在 `src-tauri/target/release/bundle/`。
2. 打开程序，停在概览。到「运行」页点「安装聊天引擎」。默认地址是 llama.cpp `b12110` 的 Windows CPU zip。装好后应看到“找到 llama-server”。
3. 到「模型」页下载一个小的 GGUF，或在「已安装」里按完整路径导入。先不要下特别大的仓库。
4. 回到「运行」页选中这个文件，点「启动模型」。只有健康检查通过才显示运行中，地址是 `http://127.0.0.1:端口/v1`。
5. 到「对话」页发一句话。联网开关保持关闭。回复应来自本机。点停止应留下已经收到的文字。
6. 故意试一次：不启动就发送、选一个不存在的名字、把端口改成正在占用的端口。页面上应有中文原因和下一步，不能变成“运行中”。

画图、视频和 Agent 这一轮没有加新能力。没有 GPU 时画图会很慢或直接报错。没有做付费加速。

推荐卡片上的 tok/s 也没有在 Windows 真机上对过秒表。显卡带宽用的是公开规格表，检测不到型号时按显存容量取一档。网页预览或硬件检测失败时，界面应写「待检测 / 网页预览」或「约估不可用」，不应该出现一个看起来像实测的 tok/s。Windows 上可以在概览看推荐卡片：有 NVIDIA 显卡时应出现「约 XX tok/s」和「全部放进显卡」或「放不进显存」；把量化从 Q4 改成 Q8，体积应变大、速度应变慢。这只说明公式跟着硬件和量化在走，不代表数字已经用 llama-bench 核对过。
