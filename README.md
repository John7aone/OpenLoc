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
- **聊天**：llama.cpp 的 llama-server，上下文 4K / 8K / 16K / 32K 可选。输入栏的「截图」是区域选择：框选后确认才作为附件加入当前对话，取消则不贴图。没有选区工具时不会改成整屏。网页预览会说明做不到，不会假装已经贴图。联网开关默认关闭，没有接上检索时只说明没搜到，不编造结果。
- **画图**：stable-diffusion.cpp 的 sd-cli。
- **视频**：两种，界面上分得清清楚楚——ffmpeg 动效视频（不是扩散生成，CPU 就能跑）；sd-cli 的 vid_gen 扩散视频（Wan，需要 Wan 视频模型和足够显存）。
- **Agent**：指定一个工作文件夹后，本地模型做计划，在文件夹内读写文件、跑命令，步骤实时显示。超出文件夹、含 `..`、删除、格式化等一律拦截，不要把整个文档、桌面或系统盘交给它。
- **应用图标**：窗口、任务栏、托盘和安装包用同一张图，蓝底（#2563eb / #1d4ed8）上是一个清晰的大写字母 O。侧栏左上角仍是原来的 OL 品牌块。打包前由 `src-tauri/icons/generate-icon.py` 生成。
- **托盘**：右键保留「显示 OpenLoc」「隐藏窗口」，并有「退出」。点「退出」会结束程序；不会被「点 X 只隐藏到托盘」拦住。设置里关掉后台常驻时，点窗口 X 仍然直接退出。
- **主题风格**：浅色 / 深色，侧栏底部用月亮 / 太阳线框图标切换（设置里是同一个图标），本地保存。浅色是灰白底，深色是海军蓝底、抬升卡片，按钮主色是蓝。侧栏底部不再放「截屏保存」。
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

`shots/` 里是更早的 1280×800 走查截图（侧栏当时还有「截屏保存」）。当前界面以仓库里的页面为准：侧栏底部只留日月主题开关，对话输入区仍有「截图」。静态页面截的，所以硬件标着未检测。直接打开 `src/index.html` 可以走查同一套样式。

## 生成的文件放哪

程序所在目录旁的 `data/` 文件夹：`data/engines/`（引擎）、`data/models/`（模型）、`data/outputs/`（生成的图片和视频）。

## 本机聊天闭环

安装聊天引擎会把 zip 解压到 `data/engines/llama/`，找到 `llama-server` 或 `llama-server.exe` 才算装好。启动时命令行固定 `--host 127.0.0.1`，健康检查要看到 `{"status":"ok"}` 才把状态标成运行中。对话发到这个本机端口；联网开关默认关，打开后才检索，失败会说明原因。截图和附件只留在本机，纯文本模型看不到图片内容。

服务没启动、模型不在 `data/models`、端口被占用、请求失败，都会用中文写明原因和下一步，不会把状态标成已经在跑。生成过程中可以停止，已经收到的文字会留下。

## 在这台开发环境里实际跑过的

命令和结果分开记。mock 不代表真的推理。

```bash
node --test test/chat-flow.test.mjs
cargo test --manifest-path src-tauri/Cargo.toml
```

在准备上一轮提交的 Linux 环境里，`node --test test/chat-flow.test.mjs` 为 8 通过，`cargo test --manifest-path src-tauri/Cargo.toml` 为 18 通过。这一轮同样的两条命令是 8 通过和 22 通过（新增的是选区取消不算成功、托盘「退出」不会被隐藏逻辑拦住、选区工具参数里没有整屏）。其中 2 项真实模型测试在没有 `OPENLOC_LIVE_PORT` 时直接返回，不访问网络。另一次 `OPENLOC_LIVE_PORT=18080 cargo test --manifest-path src-tauri/Cargo.toml live_model` 走了下面的真模型。Rust 侧用本机假 HTTP 服务覆盖：健康检查只有 `status=ok` 才算就绪、端口占用、非流式回复、思考字段被拒绝后重试、流式中途取消。解压测试按 Windows CPU 包的布局放了根目录上的 `llama-server.exe`，并拒绝路径穿越。

另一次真实推理（不是 mock）：llama.cpp `b12110` 的 Ubuntu x64 CPU 包，模型 `stories15M-q4_0.gguf`（约 19MB，公开小模型）。命令行测试里 `llama-server` 监听 `127.0.0.1:18080`，`/health` 返回 ok。经 OpenLoc 的请求函数拿到非空回复，非流式开头是 “Suddenled the ground…”，流式开头是 “Sisss are very icy windows…”。同一套引擎和模型也在 Linux 桌面窗口里走过：运行页显示“健康检查已通过”和 `127.0.0.1:8080`，联网开关保持关闭，对话页收到以 “Suddenled her feet…” 开头的回复。限制：这是 TinyStories 小模型，不会按指令回答；训练上下文只有 128，引擎把更长的上下文截断了；跑在 Linux CPU 上，不能当成 Windows 或显卡结果。没有下载更大的模型，也没有调用收费 API。

## 没在 Windows 真机上验证

这个环境不能打出 Windows 安装包，也没有在 Windows 电脑上双击运行过，看不到任务栏托盘，也不能把 Windows 选区遮罩真正弹出来点一次。下面的步骤是给 Windows 用户自己验证的，不是“已经通过”的记录。网页预览里点「截图」只会说明不能框选，不会出现附件。公开仓库上的 `Build Windows` 使用 GitHub 托管的标准 `windows-latest`，没有加大权限，也没有开付费 runner。安装包如果打出来了，在该次 Actions 运行的 Artifacts 里，名字是 `openloc-windows`。过期或运行失败就没有可下载的包。

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
6. 对话里点「截图」，应进入选区：框一块，点确认后附件里出现这张图；点取消或按 Esc 则不贴图。不应再直接存一整屏。
7. 看窗口图标、任务栏图标、托盘图标和安装包图标，应是蓝底上的大写 O。侧栏左上角仍是 OL。
8. 托盘隐藏图标上右键，应有「退出」。点下去进程结束，而不是只把窗口藏起来。
9. 故意试一次：不启动就发送、选一个不存在的名字、把端口改成正在占用的端口。页面上应有中文原因和下一步，不能变成“运行中”。

画图、视频和 Agent 这一轮没有加新能力。没有 GPU 时画图会很慢或直接报错。没有做付费加速。
