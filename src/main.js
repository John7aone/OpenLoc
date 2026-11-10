// Tauri 2 withGlobalTauri: use the injected global API, no bundler needed.
const invoke = (...args) => window.__TAURI__.core.invoke(...args);
let catalogCache = [];
let shownModels = [];
let hwSnapshot = null;
let catFilter = 'fit';
let runCtx = 'auto';
let webOn = false;
let chatAttachments = [];
let chatTurns = [];
let chatSessions = [];
let chatSessionId = "";
let sending = false;
let sendGen = 0;
let activeReply = null;
let startInFlight = false;
let knownModels = [];
function hasTauri() {
  return !!(window.__TAURI__ && window.__TAURI__.core && typeof window.__TAURI__.core.invoke === "function");
}
function escHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function setComposerNote(text) {
  const el = document.getElementById("composer-note");
  if (!el) return;
  el.textContent = text || "";
  el.hidden = !text;
}
function setActionNote(text) {
  const el = document.getElementById("action-note");
  if (!el) return;
  el.textContent = text || "";
  el.hidden = !text;
}
function setAgentNote(text) {
  const el = document.getElementById("agent-note");
  if (!el) return;
  el.textContent = text || "";
  el.hidden = !text;
}
let agentAttachments = [];
let agentTasks = [];
const LOCAL_CATALOG = [
  ["Qwen3.8 Flash Next", "unsloth/Qwen3.8-Flash-Next-GGUF", "180B 总量 / 约 6B 激活", "旗舰级混合专家模型，激活参数不大，适合想试大模型上限的用户。", "推理"],
  ["Qwen3.8 27B", "unsloth/Qwen3.8-27B-GGUF", "27B", "大参数量通用模型，显存和内存要求都比较高。", "对话"],
  ["Muse Glimmer 30B", "unsloth/Muse-Glimmer-30B-GGUF", "30B", "30B 级通用对话模型，适合长对话和写作。", "对话"],
  ["Qwen3.6 35B A3B", "unsloth/Qwen3.6-35B-A3B-GGUF", "35B 总量 / 约 3B 激活", "混合专家结构，实际激活参数小，推理成本相对低。", "推理"],
  ["Qwen3.6 27B", "unsloth/Qwen3.6-27B-GGUF", "27B", "27B 级通用模型，中文表现较好。", "对话"],
  ["Gemma 4 26B A4B", "unsloth/gemma-4-26B-A4B-it-GGUF", "26B 总量 / 约 4B 激活", "谷歌 Gemma 系列的混合专家版本，指令跟随较稳。", "看图"],
  ["Gemma 4 31B", "unsloth/gemma-4-31B-it-GGUF", "31B", "31B 级指令模型，适合问答和摘要。", "看图"],
  ["Gemma 4 12B", "unsloth/gemma-4-12b-it-GGUF", "12B", "12B 中等规模，普通家用显卡比较现实的选择。", "看图"],
  ["Gemma 4 E4B", "unsloth/gemma-4-E4B-it-GGUF", "E4B（高效小模型）", "高效小模型，内存小的电脑也可以先从它入门。", "看图"],
  ["Qwen3.5 122B A10B", "unsloth/Qwen3.5-122B-A10B-GGUF", "122B 总量 / 约 10B 激活", "超大总量模型，只建议大显存或大内存机器尝试。", "推理"],
  ["Qwen3.5 9B", "unsloth/Qwen3.5-9B-GGUF", "9B", "9B 级，速度和效果比较均衡的日常选择。", "对话"],
  ["Qwen3.5 4B", "unsloth/Qwen3.5-4B-GGUF", "4B", "4B 小模型，普通笔记本 CPU 也能跑起来。", "对话"],
  ["GLM-4.7 Flash", "unsloth/GLM-4.7-Flash-GGUF", "见仓库（Flash 系列）", "智谱 Flash 系列，速度快，适合高频对话。", "对话"],
  ["Devstral Small 2 24B", "unsloth/Devstral-Small-2-24B-Instruct-2512-GGUF", "24B", "偏编程和工具调用的 24B 模型，适合 Agent 任务。", "编程"],
  ["GPT-OSS 20B", "unsloth/gpt-oss-20b-GGUF", "20B", "开源权重的大模型，适合想试非中系模型的。", "对话"],
  ["GPT-OSS 120B", "unsloth/gpt-oss-120b-GGUF", "120B", "120B 级，只建议大显存机器尝试。", "推理"]
];
function localModels() {
  return LOCAL_CATALOG.map(([name, repo, params, desc, cat]) => ({ name, repo, params, desc, cat, fit: "待检测" }));
}
function hardwareView() {
  if (hwSnapshot) return hwSnapshot;
  return OpenLocRecommend.emptyHardware(!hasTauri());
}
function hardwareFrom(h) {
  return {
    detected: true,
    preview: false,
    gpu: (h && h.gpu) || "",
    vramGb: Number(h && h.gpu_vram_gb) || 0,
    memoryTotalGb: Number(h && h.memory_total_gb) || 0,
    memoryAvailGb: Number(h && h.memory_gb) || 0,
    cpuCount: Number(h && h.cpu_count) || 0,
  };
}
function rememberModels(list) {
  (list || []).forEach((m) => {
    const raw = { name: m.name, repo: m.repo, params: m.params, desc: m.desc, cat: m.cat };
    const i = shownModels.findIndex((x) => x.repo === raw.repo);
    if (i >= 0) shownModels[i] = raw;
    else shownModels.push(raw);
  });
}
function withView(models) {
  const hw = hardwareView();
  return (models || []).map((m) => {
    const view = OpenLocRecommend.assess(m, hw, "Q4_K_M");
    return Object.assign({}, m, { fit: view.fit, view: view });
  });
}
function renderAttachments() {
  const el = document.getElementById("chat-attach");
  if (!el) return;
  el.replaceChildren();
  if (!chatAttachments.length) { el.hidden = true; return; }
  el.hidden = false;
  chatAttachments.forEach((a, i) => {
    const chip = document.createElement("span");
    chip.className = "attach-chip";
    if (a.url) {
      const img = document.createElement("img");
      img.src = a.url;
      img.alt = "";
      chip.appendChild(img);
    } else {
      const badge = document.createElement("span");
      badge.className = "attach-badge";
      badge.textContent = a.kind === "image" ? "图" : "件";
      chip.appendChild(badge);
    }
    const name = document.createElement("span");
    name.className = "attach-name";
    name.textContent = a.name;
    name.title = a.path || a.name;
    chip.appendChild(name);
    if (a.mode === "region") {
      const mode = document.createElement("span");
      mode.className = "attach-mode";
      mode.textContent = "选区";
      chip.appendChild(mode);
    }
    const x = document.createElement("button");
    x.type = "button";
    x.className = "attach-x";
    x.title = "移除附件";
    x.setAttribute("aria-label", "移除附件 " + a.name);
    x.textContent = "×";
    x.onclick = function() { removeAttach(i); };
    chip.appendChild(x);
    el.appendChild(chip);
  });
}
function clearAttachments() {
  for (const a of chatAttachments) { if (a.url) URL.revokeObjectURL(a.url); }
  chatAttachments = [];
  renderAttachments();
}
function removeAttach(i) {
  const a = chatAttachments[i];
  if (a && a.url) URL.revokeObjectURL(a.url);
  chatAttachments.splice(i, 1);
  renderAttachments();
}
function applyNet(on) {
  webOn = !!on;
  document.querySelectorAll("[data-net-switch]").forEach((btn) => btn.setAttribute("aria-checked", webOn ? "true" : "false"));
  document.querySelectorAll(".js-net-label").forEach((el) => { el.textContent = webOn ? "允许联网" : "本机运行 · 不联网"; });
  try { localStorage.setItem("openloc-web", webOn ? "1" : "0"); } catch (e) {}
}
function onChatFiles(ev) {
  const input = ev.target;
  const files = input.files ? Array.from(input.files) : [];
  for (const f of files) {
    const image = (f.type || "").startsWith("image/");
    chatAttachments.push({
      name: f.name,
      kind: image ? "image" : "file",
      url: image ? URL.createObjectURL(f) : "",
      path: "",
      mode: "",
      source: "file",
    });
  }
  input.value = "";
  renderAttachments();
  if (files.length) setComposerNote("已加入当前对话附件。发送时只记下文件名：图片不会上传，本地模型目前只接收文字。");
}
function getPort() { try { return parseInt(localStorage.getItem('openloc-port') || '8080'); } catch (e) { return 8080; } }
window.tab = function(id, btn) {
  setActionNote("");
  document.querySelectorAll(".tab").forEach(t => t.classList.remove("on"));
  const page = document.getElementById(id);
  if (page) page.classList.add("on");
  document.querySelectorAll("#nav button").forEach(b => {
    b.classList.remove("on");
    b.removeAttribute("aria-current");
  });
  const target = (btn && btn.closest && btn.closest("#nav")) ? btn : document.querySelector('#nav button[data-page="' + id + '"]');
  if (target) { target.classList.add("on"); target.setAttribute("aria-current", "page"); }
  const main = document.querySelector(".main");
  if (main) main.scrollTop = 0;
  if (id === "cat") loadCatalog();
  if (id === "chat" || id === "img" || id === "vid" || id === "md") loadModels();
  if (id === "md") { updatePlan(); loadEngineStatus(); }
  if (id === "settings") loadEngineStatus();
  if (id === "img") refreshImgEmpty();
  if (id === "vid") refreshVidEmpty();
};
let themeMode = "light";
function systemIsDark() {
  try { return window.matchMedia("(prefers-color-scheme: dark)").matches; }
  catch (e) { return false; }
}
function normalizeTheme(v) {
  if (v === "dark" || v === "black") return "dark";
  if (v === "system") return "system";
  return "light";
}
window.toggleTheme = function() {
  const resolved = document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
  setTheme(resolved === "dark" ? "light" : "dark");
};
window.setTheme = function(v) {
  themeMode = normalizeTheme(v);
  const theme = themeMode === "system" ? (systemIsDark() ? "dark" : "light") : themeMode;
  document.documentElement.setAttribute("data-theme", theme);
  const sel = document.getElementById("themeSel");
  if (sel) sel.value = themeMode;
  const label = theme === "dark" ? "切换到浅色" : "切换到深色";
  const btn = document.getElementById("themeBtn");
  if (btn) btn.setAttribute("aria-label", label);
  try { localStorage.setItem("openloc-theme", themeMode); } catch (e) {}
};
function paintLayer(known, gpu, ram, disk) {
  const bar = document.getElementById("layerbar");
  if (!bar) return;
  bar.classList.toggle("unknown", !known);
  const g = document.getElementById("layer-gpu-t"); if (g) g.textContent = gpu;
  const r = document.getElementById("layer-ram-t"); if (r) r.textContent = ram;
  const d = document.getElementById("layer-disk-t"); if (d) d.textContent = disk;
}
function markStep(done) {
  const step = document.getElementById("step-hw");
  const num = document.getElementById("step-hw-num");
  const st = document.getElementById("step-hw-status");
  const sub = document.getElementById("step-hw-sub");
  if (!step) return;
  step.classList.toggle("done", !!done);
  if (num) num.textContent = done ? "✓" : "1";
  if (st) st.textContent = done ? "已检测" : (hasTauri() ? "未检测" : "网页预览未检测");
  if (sub) sub.textContent = done ? "已读到本机配置" : (hasTauri() ? "还没读到硬件" : "浏览器读不到显卡和内存");
}
window.loadHw = async function() {
  let h;
  try { h = await invoke("get_hardware"); }
  catch (e) {
    hwSnapshot = OpenLocRecommend.emptyHardware(!hasTauri());
    markStep(false);
    paintLayer(false, "未检测", "未检测", "兜底");
    const gs = document.getElementById("gpu-status"); if (gs) gs.textContent = hasTauri() ? "显卡状态：未检测" : "显卡状态：网页预览未检测";
    ["hw-gpu","hw-cpu","hw-mem","hw-disk"].forEach((id) => { const n = document.getElementById(id); if (n) n.textContent = "未检测"; });
    ["vram-bar","mem-bar","disk-bar"].forEach((id) => { const n = document.getElementById(id); if (n) n.style.width = "0"; });
    paintGpuCard(
      "未检测到 NVIDIA 显卡",
      hasTauri()
        ? "自动检测，只认 nvidia-smi。这次没读到显卡，推理走 CPU / 内存，不会假装有显卡。"
        : "自动检测，只认 nvidia-smi。网页预览读不到显卡，不会假装有显卡。",
      "检测到：无"
    );
    const title = document.getElementById("rec-title");
    if (title) title.textContent = "还不知道这台电脑能流畅跑多大的模型";
    const desc = document.getElementById("rec-desc");
    if (desc) desc.textContent = hasTauri()
      ? "这次没读到显存和内存。读到之后才会标流畅或能跑，并约估 tok/s。现在不编一个每秒 token。"
      : "网页预览没有显存数据。桌面版按显存判断流畅还是能跑，并约估 tok/s。这里不会编一个每秒 token。";
    loadRecommended();
    return;
  }
  hwSnapshot = hardwareFrom(h);
  const vram = h.gpu_vram_gb || 0;
  const smooth = vram >= 16 ? 14 : vram >= 8 ? 8 : vram >= 6 ? 7 : vram >= 4 ? 4 : 2;
  markStep(true);
  document.getElementById("rec-title").textContent = "流畅运行 " + smooth + "B 以内的模型";
  document.getElementById("rec-desc").textContent = "整份权重能放进显存才标流畅，放不进就分到内存，标能跑或较慢。卡片上的 tok/s 按显卡或内存带宽估算，不是实测。";
  document.getElementById("vram-text").textContent = vram ? vram.toFixed(1) + " GB 显存" : "未检测到独立显存，走 CPU / 内存模式";
  document.getElementById("vram-bar").style.width = vram ? Math.min(100, vram / 16 * 100) + "%" : "8%";
  document.getElementById("mem-text").textContent = h.memory_total_gb.toFixed(0) + " GB，可用 " + h.memory_gb.toFixed(0) + " GB";
  document.getElementById("mem-bar").style.width = Math.max(0, Math.min(100, (1 - h.memory_gb / h.memory_total_gb) * 100)) + "%";
  document.getElementById("disk-text").textContent = "剩余 " + h.disk_free_gb.toFixed(0) + " GB" + (h.disk_total_gb ? " / 共 " + h.disk_total_gb.toFixed(0) + " GB" : "");
  document.getElementById("disk-bar").style.width = h.disk_total_gb ? Math.max(0, Math.min(100, (1 - h.disk_free_gb / h.disk_total_gb) * 100)) + "%" : "8%";
  const gpuShort = h.gpu.replace("NVIDIA GeForce ", "");
  document.getElementById("hw-gpu").textContent = gpuShort;
  document.getElementById("hw-gpu-sub").textContent = vram ? vram.toFixed(1) + " GB 显存" : "未检测到独立显存";
  document.getElementById("hw-cpu").textContent = h.cpu.replace("13th Gen Intel(R) Core(TM) ", "").replace("(R)", "");
  document.getElementById("hw-cpu-sub").textContent = h.cpu_count + " 线程";
  document.getElementById("hw-mem").textContent = h.memory_total_gb.toFixed(0) + " GB";
  document.getElementById("hw-mem-sub").textContent = "可用 " + h.memory_gb.toFixed(0) + " GB";
  document.getElementById("hw-disk").textContent = "程序所在盘";
  document.getElementById("hw-disk-sub").textContent = "剩余 " + h.disk_free_gb.toFixed(0) + " GB / 共 " + (h.disk_total_gb ? h.disk_total_gb.toFixed(0) + " GB" : "未知");
  const gs = document.getElementById("gpu-status"); if (gs) gs.textContent = "显卡状态：● " + h.gpu + (vram ? "（" + vram.toFixed(1) + " GB）" : "");
  paintLayer(true, vram ? vram.toFixed(1) + " GB" : "无独立显存", h.memory_total_gb.toFixed(0) + " GB", "按需");
  const cap = document.getElementById("layer-cap");
  if (cap) cap.textContent = "模型先放进显卡，放不下的部分再放到内存。越靠左越快。条的比例按这台电脑的显存、内存和剩余磁盘来，不是某一份模型文件的切片。";
  const vramText = vram ? vram.toFixed(1) + " GB" : "无独立显存";
  paintGpuCard(
    h.gpu + " · " + vramText,
    "自动检测，推理用 CUDA（N 卡）。检测不到就走 CPU / 内存。",
    "检测到：" + h.gpu + (vram ? "（" + vramText + "）" : "（无独立显存）")
  );
  loadRecommended();
  if (catalogIsOpen() && catalogCache.length) renderCatalog();
};
function paintGpuCard(name, info, detected) {
  const n = document.getElementById("gpu-name");
  const gi = document.getElementById("gpu-info");
  const d = document.getElementById("gpu-detected");
  if (n) n.textContent = name;
  if (gi) gi.textContent = info;
  if (d) d.textContent = detected;
}
function fitLabel(fit) {
  const s = String(fit || "");
  if (!s || s.startsWith("待检测")) return "待检测";
  if (s.startsWith("流畅")) return "流畅";
  if (s.startsWith("能跑")) return "能跑";
  return "较慢";
}
function fitClass(fit) {
  const l = fitLabel(fit);
  if (l === "流畅") return "";
  if (l === "能跑") return " mid";
  if (l === "待检测") return " wait";
  return " slow";
}
function cardHtml(m, feat) {
  const view = m.view || OpenLocRecommend.assess(m, hardwareView(), "Q4_K_M");
  const quants = OpenLocRecommend.QUANTS;
  return `<article class="mc${feat ? " feat-mc" : ""}" data-repo="${escHtml(m.repo)}"${feat ? ' data-hero="1"' : ""}><div class="mbody"><div class="mtitle"><b>${escHtml(m.name)}</b>${m.cat === "看图" ? '<span class="tag">这一版还不能识图</span>' : ""}</div><p class="mdesc">${escHtml(m.desc)}</p><p class="mmeta">${escHtml(view.arch)} · ${escHtml(m.cat)} · ${escHtml(m.repo)}</p><div class="mfacts"><div><span class="k">预计速度</span><b class="js-speed" title="${escHtml(view.formula)}">${escHtml(view.speedText)}</b></div><div><span class="k">放在哪</span><b class="js-place">${escHtml(view.place)}</b></div><div><span class="k">体积</span><b class="js-size">${escHtml(view.sizeText)}</b></div></div><p class="muted small js-detail">${escHtml(view.placeDetail)}</p></div><div class="right"><div class="qrow"><select class="qsel" aria-label="${escHtml(m.name)} 的量化" onchange="onQuantChange(this)">${quants.map((q) => `<option value="${q.id}">${escHtml(q.label)}</option>`).join("")}</select><span class="pill-fit js-fit${fitClass(view.fit)}">${escHtml(view.fit)}</span></div><div class="fitbar" title="${escHtml(view.barTitle)}"><span class="js-bar" style="width:${view.barPct}%"></span></div><button type="button" class="js-dl" data-repo="${escHtml(m.repo)}" onclick="askDownload(this.dataset.repo, this)">${escHtml(view.downloadText)}</button></div></article>`;
}
function applyView(article, view) {
  if (!article || !view) return;
  const speed = article.querySelector(".js-speed");
  if (speed) { speed.textContent = view.speedText; speed.title = view.formula; }
  const place = article.querySelector(".js-place");
  if (place) place.textContent = view.place;
  const size = article.querySelector(".js-size");
  if (size) size.textContent = view.sizeText;
  const detail = article.querySelector(".js-detail");
  if (detail) detail.textContent = view.placeDetail;
  const fit = article.querySelector(".js-fit");
  if (fit) { fit.textContent = view.fit; fit.className = "pill-fit js-fit" + fitClass(view.fit); }
  const bar = article.querySelector(".js-bar");
  if (bar) bar.style.width = view.barPct + "%";
  const fitbar = article.querySelector(".fitbar");
  if (fitbar) fitbar.title = view.barTitle;
  const btn = article.querySelector(".js-dl");
  if (btn) btn.textContent = view.downloadText;
  if (article.dataset.hero === "1") paintHero(article.querySelector(".mtitle b") ? { name: article.querySelector(".mtitle b").textContent, repo: article.dataset.repo } : null, view);
}
function paintHero(m, view) {
  const chip = document.getElementById("hero-chip");
  const btn = document.getElementById("hero-dl");
  if (!m) return;
  const shown = view || m.view || OpenLocRecommend.assess(m, hardwareView(), "Q4_K_M");
  if (chip) chip.textContent = m.name + " · " + shown.sizeText + " · " + shown.speedText;
  if (btn) {
    btn.dataset.repo = m.repo || "";
    btn.textContent = shown.downloadText === "下载" ? "下载推荐量化" : shown.downloadText;
  }
}
window.onQuantChange = function(sel) {
  const article = sel && sel.closest ? sel.closest("article") : null;
  if (!article) return;
  const repo = article.getAttribute("data-repo");
  const m = shownModels.find((x) => x.repo === repo) || localModels().find((x) => x.repo === repo);
  if (!m) return;
  applyView(article, OpenLocRecommend.assess(m, hardwareView(), sel.value));
};
window.askDownload = async function(repo, btn) {
  if (btn && btn.dataset && btn.dataset.repo) repo = btn.dataset.repo;
  let sel = btn && (btn.closest(".mc") || btn.closest(".hero-actions")) ? (btn.closest(".mc") || btn.parentElement).querySelector("select") : null;
  if (!sel && btn && btn.id === "hero-dl") sel = document.querySelector('#recmodels article[data-hero="1"] select');
  const quant = ((sel && sel.value) || "Q4_K_M").replace("（常用）", "");
  if (!repo) { setActionNote("还没有可下载的推荐。先等目录出来。"); return; }
  if (!hasTauri()) {
    setActionNote("网页预览不会下载。桌面版会到 Hugging Face 的 " + repo + " 查找 " + quant + " 量化文件，对上名字才开始拉，不会造一个假文件。");
    return;
  }
  setActionNote("正在查询 " + repo + " 的文件体积…");
  try {
    const prefs = downloadPrefs();
    const detail = await invoke("hf_repo_detail", {
      repo,
      hfBase: OpenLocSettings.hfApiBase(prefs.hfMirror),
      hfToken: prefs.hfToken,
    });
    const files = (detail && detail.files) || [];
    const hit = files.find((f) => String(f.path || "").toUpperCase().includes(quant.toUpperCase())) || files[0];
    if (!hit) { setActionNote("仓库里没有找到 GGUF 文件，没有开始下载。"); return; }
    await runDownload(repo, hit.path, files, "model");
  } catch (e) { setActionNote("没有开始下载：" + e); }
};
function totalB(params) {
  const scale = OpenLocRecommend.scaleOf(params);
  return scale.totalB == null ? 99 : scale.totalB;
}
function smallerModels(models) {
  return models.filter((m) => totalB(m.params) <= 12).sort((a, b) => totalB(a.params) - totalB(b.params));
}
function recommendList(models) {
  const good = models.filter((m) => m.fit && m.fit.startsWith("流畅"));
  if (good.length) return good.slice(0, 3);
  const small = smallerModels(models);
  return (small.length ? small : models).slice(0, 3);
}
function catalogIsOpen() {
  const cat = document.getElementById("cat");
  return !!(cat && cat.classList.contains("on"));
}
window.loadRecommended = async function() {
  const el = document.getElementById("recmodels"); if (!el) return;
  let models;
  try { models = await invoke("get_catalog"); }
  catch (e) { models = localModels(); }
  rememberModels(models);
  models = withView(models);
  const list = recommendList(models);
  const hw = hardwareView();
  const anySmooth = models.some((m) => m.fit === "流畅");
  const note = document.getElementById("fit-note");
  if (!list.length) { el.innerHTML = "<p class='muted'>目录是空的。</p>"; return; }
  paintHero(list[0]);
  let head = "";
  if (!hw.detected && hw.preview) head = "<p class='muted small'>网页预览没有显存数据。下面先列出总量约 12B 及以内的目录，速度写「待检测 / 网页预览」，不代表已经适合你的电脑。</p>";
  else if (!hw.detected) head = "<p class='muted small'>还没有读到这台电脑的硬件。速度写「约估不可用」，不把目录当成已经适合你。</p>";
  else if (!anySmooth) head = "<p class='muted small'>这些模型的整份权重放不进当前显存。下面是较小的几个，速度是约估，不是实测。</p>";
  el.innerHTML = head + list.map((m, i) => cardHtml(m, i === 0)).join("");
  if (note && !catalogIsOpen()) {
    if (!hw.detected) {
      note.hidden = false;
      note.textContent = hw.preview
        ? "适合我的电脑：网页预览判断不了显存，筛选会暂时列出较小的模型，速度标成待检测 / 网页预览。"
        : "适合我的电脑：硬件没读到，筛选会暂时列出较小的模型，速度标成约估不可用。";
    } else if (!anySmooth) {
      note.hidden = false;
      note.textContent = "适合我的电脑：没有模型能整份放进显存。筛选列出较小的模型，并按内存判断能跑还是较慢。";
    } else {
      note.hidden = true;
      note.textContent = "";
    }
  }
};
window.loadCatalog = async function() {
  const el = document.getElementById("catalog");
  if (el) el.textContent = "加载中…";
  try { catalogCache = await invoke("get_catalog"); }
  catch (e) { catalogCache = localModels(); }
  renderCatalog();
};
function renderCatalog() {
  const el = document.getElementById("catalog");
  const note = document.getElementById("fit-note");
  rememberModels(catalogCache);
  let list = withView(catalogCache.slice());
  const hw = hardwareView();
  let explain = "";
  if (catFilter === "fit") {
    const good = list.filter((m) => m.fit === "流畅");
    if (good.length) list = good;
    else {
      list = withView(smallerModels(catalogCache));
      if (!hw.detected && hw.preview) explain = "没有本机显存数据，下面只列出总量约 12B 及以内的目录，速度是待检测 / 网页预览，不代表已经适合你的电脑。";
      else if (!hw.detected) explain = "硬件没读到，下面只列出总量约 12B 及以内的目录，速度是约估不可用。";
      else explain = "没有模型能整份放进显存。下面列出较小的模型，能跑或较慢都是约估，不是实测。";
    }
  } else if (catFilter !== "all") list = list.filter((m) => m.cat === catFilter);
  if (note) { note.hidden = !explain; note.textContent = explain; }
  el.innerHTML = list.length ? list.map((m) => cardHtml(m, false)).join("") : "<p class='muted'>这个筛选下没有模型，换个筛选试试。</p>";
}
window.setFilter = function(f, btn) {
  catFilter = f;
  document.querySelectorAll("#catpills button").forEach(b => b.classList.remove("on"));
  if (btn) btn.classList.add("on");
  renderCatalog();
};
window.catTab = function(which, btn) {
  for (const id of ["cat-rec","cat-inst","cat-img","cat-search"]) document.getElementById(id).style.display = "none";
  document.getElementById("cat-"+which).style.display = "block";
  document.querySelectorAll(".subtabs button").forEach(b => b.classList.remove("on"));
  if (btn) btn.classList.add("on");
  if (which === "inst") loadInstalled();
  if (which === "img") loadImgModels();
};
window.importPrompt = function() {
  catTab("inst", document.getElementById("sub-inst"));
  const box = document.getElementById("importpath");
  if (box) box.focus();
  const msg = document.getElementById("importmsg");
  if (msg) msg.textContent = hasTauri() ? "把模型的完整路径填在下面再导入。分卷选第一卷。" : "网页预览通常拿不到完整路径。把路径填在下面；没有路径就不会导入。";
};
window.loadInstalled = async function() {
  const el = document.getElementById("installed");
  const tabBtn = document.getElementById("sub-inst");
  try {
    const list = await invoke("list_local_model_info");
    const h = await invoke("get_hardware");
    hwSnapshot = hardwareFrom(h);
    if (tabBtn) tabBtn.textContent = "已安装（" + list.length + "）";
    const step3 = document.getElementById("step-model");
    const step3sub = document.getElementById("step-model-sub");
    if (list.length && step3) { step3.classList.add("done"); if (step3sub) step3sub.textContent = "本机已有模型"; }
    el.innerHTML = list.length ? list.map((m) => {
      const view = estimateInstalled(m, hwSnapshot);
      const enc = encodeURIComponent(m.name);
      return `<article class="mc"><div><div class="mtitle"><b>${escHtml(m.name)}</b><span class="pill-fit${fitClass(view.fit)}">${escHtml(view.fit)}</span></div><div class="mmeta">${escHtml(view.quant)} · ${escHtml(view.sizeText)} · ${escHtml(view.speedText)}</div><p class="muted small">${escHtml(view.place)}。${escHtml(view.placeDetail)}</p><div class="fitbar" title="${escHtml(view.barTitle)}"><span style="width:${view.barPct}%"></span></div></div><div class="right"><div class="row"><button class="sec" type="button" onclick="openModelFolder(decodeURIComponent('${enc}'))">打开位置</button><button class="sec" type="button" onclick="delModel(decodeURIComponent('${enc}'))">删除</button><button type="button" onclick="runInstalled(decodeURIComponent('${enc}'))">运行</button></div></div></article>`;
    }).join("") : "<p class='muted'>还没有已安装模型。去推荐模型下载，或在下面按完整路径导入。</p>";
  } catch (e) {
    if (tabBtn) tabBtn.textContent = "已安装";
    el.innerHTML = "<p class='muted'>" + (hasTauri() ? ("没能读取已安装模型：" + e) : "网页预览看不到本机 data/models 里的文件。桌面版会在这里列出，并能打开位置、删除或运行。") + "</p>";
  }
};
window.runInstalled = function(name) {
  tab("md", document.querySelector("nav [data-page=md]"));
  const sel = document.getElementById("runmodel");
  if (sel) { sel.value = name; updatePlan(); }
};
window.openModelFolder = async function(name) {
  if (!hasTauri()) { setActionNote("网页预览打不开文件夹。桌面版会打开「" + name + "」所在的位置。"); return; }
  try { await invoke("open_folder", { path: name }); } catch (e) { setActionNote("没能打开位置：" + e); }
};
window.openModelsFolder = async function() {
  if (!hasTauri()) { setActionNote("网页预览打不开 data/models。桌面版会打开模型目录。"); return; }
  try { await invoke("open_folder", { path: "data/models" }); } catch (e) { setActionNote("没能打开模型目录：" + e); }
};
window.openOutputsFolder = async function() {
  if (!hasTauri()) { setActionNote("网页预览打不开 data/outputs。桌面版会打开作品目录。"); return; }
  try { await invoke("open_folder", { path: "data/outputs" }); } catch (e) { setActionNote("没能打开作品目录：" + e); }
};
window.openDataFolder = async function() {
  if (!hasTauri()) { setActionNote("网页预览打不开 data 目录。桌面版会打开数据目录。"); return; }
  try { await invoke("open_folder", { path: "data" }); } catch (e) { setActionNote("没能打开数据目录：" + e); }
};
async function chooseStorageDir(which) {
  const msg = document.getElementById(which === "model" ? "modeldir-msg" : "outputdir-msg");
  const input = document.getElementById(which === "model" ? "modeldir" : "outputdir");
  if (!hasTauri()) {
    if (msg) msg.textContent = "网页预览打不开系统文件夹对话框，也不会假装已经改盘。";
    return;
  }
  let path = "";
  try { path = await invoke("pick_folder"); }
  catch (e) {
    if (msg) msg.textContent = "没能打开文件夹对话框：" + e + "。这次没有改。";
    return;
  }
  if (!path) {
    if (msg) msg.textContent = "没有选择文件夹，目录保持不变。原来的文件也不会搬家。";
    return;
  }
  try {
    const message = await invoke(which === "model" ? "set_model_dir" : "set_output_dir", { path: path });
    if (input) input.value = path;
    if (msg) msg.textContent = message;
  } catch (e) {
    if (msg) msg.textContent = String(e);
  }
}
window.chooseModelDir = function() { return chooseStorageDir("model"); };
window.chooseOutputDir = function() { return chooseStorageDir("output"); };
async function loadStorageDirs() {
  if (!hasTauri()) return;
  try {
    const dirs = await invoke("storage_dirs");
    const models = document.getElementById("modeldir");
    const outputs = document.getElementById("outputdir");
    if (models && dirs && dirs.models) models.value = dirs.models;
    if (outputs && dirs && dirs.outputs) outputs.value = dirs.outputs;
  } catch (e) {}
}
window.checkUpdate = function() {
  const el = document.getElementById("aboutmsg");
  if (el) el.textContent = "没有在检查更新服务器。OpenLoc 这一版不联网查版本，请到项目仓库看有没有新版本。";
};
window.openProjectPage = function() {
  const url = (window.OpenLocSettings && OpenLocSettings.PROJECT_URL) || "https://github.com/John7aone/OpenLoc";
  const opened = window.open(url, "_blank", "noopener");
  const el = document.getElementById("aboutmsg");
  if (!opened && el) el.textContent = "如果没有打开浏览器，请自行访问 " + url;
};
window.delModel = async function(name) {
  if (!hasTauri()) { setActionNote("网页预览不会删除本机文件。"); return; }
  if (!confirm("确定删除 " + name + " 吗？")) return;
  try { setActionNote(await invoke("delete_model", { name })); loadInstalled(); } catch (e) { setActionNote("没能删除：" + e); }
};
window.loadImgModels = function() {
  const models = [
    ["Z-Image Turbo", "画图", "2025年11月发布", "速度快，8 步出图，中文提示词友好。目录判断：4 GB 显存也能试试。", "vae.safetensors（推荐）", "约 2.8 GB", "流畅", "整套放进显存的粗略判断，不是对你这台电脑的实测"],
    ["Qwen-Image", "画图", "2025年8月发布", "画面里的中文、英文文字较稳，适合海报、封面、带字的图。", "Q2_K（推荐）", "约 11.2 GB", "较慢", "体积大，常常要分一部分到内存"],
    ["FLUX.1 schnell", "画图", "2024年8月发布", "写实照片和插画都强，英文提示词效果最好，4 步出图。", "Q3_K（推荐）", "约 14.6 GB", "能跑", "文本编码器常常放内存"]
  ];
  document.getElementById("imgmodels").innerHTML = models.map((m) => `<article class="mc"><div><div class="mtitle"><b>${escHtml(m[0])}</b><span class="tag">${escHtml(m[1])}</span><span class="muted small">${escHtml(m[2])}</span></div><p class="mdesc">${escHtml(m[3])}</p><div class="muted small">${escHtml(m[7])}。下载会找主体、文本编码器和 VAE，不是只下一个名字。</div></div><div class="right"><div class="qrow"><select class="qsel" aria-label="${escHtml(m[0])} 量化"><option>${escHtml(m[4])}</option></select><span class="pill-fit${fitClass(m[6])}">${escHtml(m[6])}</span></div><div class="muted small">共 ${escHtml(m[5])}（约数）</div><button type="button" onclick="downloadImgPack('${escHtml(m[0])}')">下载 ${escHtml(m[5])}</button></div></article>`).join("");
};
window.downloadImgPack = function(name) {
  if (!hasTauri()) {
    setActionNote("网页预览不会下载「" + name + "」的主体、文本编码器和 VAE。桌面版才会按整套体积检查磁盘，空间不够不会开始。");
    return;
  }
  setActionNote("「" + name + "」包含主体、文本编码器和 VAE。点开仓库里的权重后，下载会先按整套体积检查磁盘，不够就不会开始。");
  searchHfName(name);
};
window.searchHfName = async function(name) {
  catTab("search", document.getElementById('sub-search')); document.getElementById("hfq").value = name; searchHf();
};
let hfListHtml = "";
function hfHit(raw) {
  if (typeof raw === "string") return { id: raw, downloads: null };
  return { id: (raw && (raw.id || raw.modelId)) || "", downloads: raw ? raw.downloads : null };
}
function renderHfList(hits) {
  const repos = (hits || []).map(hfHit).filter((r) => r.id);
  if (!repos.length) return "<p class='search-empty'>没搜到，换个词试试。</p>";
  return repos.map((r) => {
    const dl = OpenLocHf.formatDownloads(r.downloads);
    const enc = encodeURIComponent(r.id);
    return `<article class="mc hf-repo"><div class="mbody"><div class="mtitle"><b>${escHtml(r.id)}</b></div><div class="mfacts"><div><span class="k">体积</span><b>点开后显示</b></div><div><span class="k">近 30 天下载</span><b>${escHtml(dl)}</b><span class="muted small">整个仓库</span></div><div><span class="k">本机 tok/s</span><b>点开后估算</b></div></div><p class="muted small">每个量化文件的体积不一样。点开后，下载按钮旁边会写出该文件的字节、仓库下载次数，以及估算 tok/s。</p></div><div class="right"><button type="button" data-repo="${enc}" onclick="showFiles(decodeURIComponent(this.dataset.repo))">查看文件并下载</button></div></article>`;
  }).join("");
}
function renderHfDetail(detail) {
  const view = OpenLocHf.presentDetail(detail, hardwareView(), localModels());
  const head = `<div class="hf-head"><button type="button" class="sec" onclick="showHfList()">返回搜索结果</button><b>${escHtml(view.repo)}</b><span class="muted">近 30 天仓库下载 ${escHtml(view.downloadsText)}</span></div>`;
  if (!view.files.length) return head + "<p class='search-empty'>这个仓库里没有可下载的 GGUF 文件。</p>";
  const rows = view.files.map((f) => {
    const encRepo = encodeURIComponent(view.repo);
    const encFile = encodeURIComponent(f.path);
    const extra = f.sizeExtra ? `<span class="muted small">${escHtml(f.sizeExtra)}</span>` : "";
    const cap = f.speedCaption ? `<span class="muted small">${escHtml(f.speedCaption)}</span>` : "";
    return `<article class="hf-file"><div><div class="hf-name">${escHtml(f.path)}</div><div class="mfacts"><div><span class="k">体积</span><b>${escHtml(f.sizeText)}</b>${extra}</div><div><span class="k">近 30 天下载</span><b>${escHtml(f.downloadsText)}</b><span class="muted small">仓库，不是这个文件</span></div><div><span class="k">本机 tok/s</span><b class="hf-speed" title="${escHtml(f.formula)}">${escHtml(f.speedText)}</b>${cap}</div></div><p class="muted small">${escHtml(f.detail)}</p></div><div class="right"><button type="button" data-repo="${encRepo}" data-file="${encFile}" aria-label="下载 ${escHtml(f.path)}" onclick="dlCat(decodeURIComponent(this.dataset.repo), decodeURIComponent(this.dataset.file))">下载</button></div></article>`;
  }).join("");
  return head + `<p class="muted small">共 ${view.files.length} 个 GGUF。mmproj 不在这张表里。</p>` + rows;
}
window.showHfList = function() {
  const el = document.getElementById("hfres");
  if (el) el.innerHTML = hfListHtml || "<p class='search-empty'>还没有搜索结果。</p>";
};
window.searchHf = async function() {
  const el = document.getElementById("hfres");
  const empty = document.getElementById("hfempty");
  const q = document.getElementById("hfq").value.trim();
  if (!q) { if (empty) empty.hidden = false; el.innerHTML = ""; hfListHtml = ""; return; }
  if (empty) empty.hidden = true;
  el.textContent = "搜索中…";
  try {
    const prefs = downloadPrefs();
    const repos = hasTauri()
      ? await invoke("search_hf", { query: q, hfBase: OpenLocSettings.hfApiBase(prefs.hfMirror), hfToken: prefs.hfToken })
      : await OpenLocHf.searchPublic(q);
    hfListHtml = renderHfList(repos);
    el.innerHTML = hfListHtml;
  } catch (e) { hfListHtml = ""; el.innerHTML = "<p class='search-empty'>没有搜到：" + escHtml(e) + "</p>"; }
};
window.showFiles = async function(repo) {
  const el = document.getElementById("hfres");
  if (!el) return;
  if (!repo) return;
  el.innerHTML = "<p class='muted'>正在读取 " + escHtml(repo) + " 的文件体积和下载次数…</p>";
  try {
    const prefs = downloadPrefs();
    const detail = hasTauri()
      ? await invoke("hf_repo_detail", { repo, hfBase: OpenLocSettings.hfApiBase(prefs.hfMirror), hfToken: prefs.hfToken })
      : await OpenLocHf.detailPublic(repo);
    window.__hfRawFiles = (detail && detail.files) || [];
    window.__hfRepo = (detail && detail.repo) || repo;
    el.innerHTML = renderHfDetail(detail);
  } catch (e) { el.innerHTML = "<p class='search-empty'>没有查到文件：" + escHtml(e) + "</p>"; }
};
function downloadPrefs() {
  let mirror = "";
  let prefix = "";
  let token = "";
  try {
    mirror = localStorage.getItem("openloc-hf-mirror") || "";
    prefix = localStorage.getItem("openloc-gh-prefix") || "";
    token = localStorage.getItem("openloc-hf-token") || "";
  } catch (e) {}
  return { hfMirror: mirror, githubPrefix: prefix, hfToken: token };
}
function paintDownload(ev) {
  const dock = document.getElementById("dl-dock");
  const text = document.getElementById("dl-dock-text");
  const bar = document.getElementById("dl-dock-bar");
  const cancel = document.getElementById("dl-cancel");
  if (!dock || !text) return;
  const message = ev && ev.message ? String(ev.message) : "";
  const total = ev && Number(ev.total) > 0 ? Number(ev.total) : 0;
  const received = ev && Number(ev.received) > 0 ? Number(ev.received) : 0;
  const phase = ev && ev.phase ? String(ev.phase) : "";
  dock.hidden = !message;
  text.textContent = message;
  if (bar) bar.style.width = total > 0 ? Math.min(100, Math.round(received / total * 100)) + "%" : "0";
  if (cancel) cancel.hidden = phase === "done" || phase === "cancelled" || phase === "error" || phase === "refused";
}
async function runDownload(repo, chosenPath, rawFiles, kind) {
  const plan = window.OpenLocDownload
    ? OpenLocDownload.bundleFor(chosenPath, rawFiles)
    : { error: "下载计划没有载入。", files: [] };
  if (plan.error) {
    paintDownload({ phase: "refused", message: plan.error, received: 0, total: 0 });
    setActionNote(plan.error);
    return;
  }
  if (!hasTauri()) {
    const names = plan.files.map((f) => f.path).join("、");
    const note = "网页预览不会下载「" + names + "」。桌面版会先按整套体积检查磁盘，不够就不会开始，下载中能看到真实进度并可以取消。";
    paintDownload({ phase: "refused", message: note, received: 0, total: 0 });
    setActionNote(note);
    return;
  }
  const prefs = downloadPrefs();
  const files = plan.files.map((f) => ({
    url: OpenLocSettings.prepareDownloadUrl("https://huggingface.co/" + repo + "/resolve/main/" + f.path, prefs),
    filename: f.path,
    bytes: Number(f.size_bytes || f.bytes || 0),
  }));
  paintDownload({ phase: "progress", message: "正在检查目标盘空间…", received: 0, total: plan.totalBytes || 0 });
  try {
    const message = await invoke("start_download", {
      files: files,
      kind: kind,
      hfToken: prefs.hfToken,
      tokenHost: OpenLocSettings.tokenHost(prefs.hfMirror),
    });
    paintDownload({ phase: "done", message: message, received: plan.totalBytes || 0, total: plan.totalBytes || 0 });
    setActionNote(message);
    loadModels();
    loadInstalled();
  } catch (e) {
    const message = "没有下完：" + e;
    paintDownload({ phase: "error", message: message, received: 0, total: 0 });
    setActionNote(message);
  }
}
window.dlCat = async function(repo, f) {
  if (!hasTauri()) {
    setActionNote("网页预览不会下载「" + f + "」。桌面版会先检查整套文件的磁盘空间，不够就不会开始。");
    return;
  }
  const raw = (window.__hfRawFiles || []).filter((file) => file && file.path);
  const siblings = raw.length ? raw : [{ path: f, size_bytes: 0 }];
  await runDownload(repo, f, siblings, "model");
};
window.dl = async function(kind, url, filename) {
  const els = [document.getElementById("dlmsg"), document.getElementById("run-dlmsg"), document.getElementById("engine-msg")].filter(Boolean);
  const say = (t) => els.forEach((el) => { el.textContent = t; });
  if (!hasTauri()) { say("网页预览不会下载。桌面版才会从公开地址拉取，没有付费加速。"); return; }
  const prefs = downloadPrefs();
  const prepared = OpenLocSettings.prepareDownloadUrl(url, prefs);
  paintDownload({ phase: "progress", message: "正在检查目标盘空间…", received: 0, total: 0 });
  try {
    const message = await invoke("start_download", {
      files: [{ url: prepared, filename: filename, bytes: 0 }],
      kind: kind,
      hfToken: prefs.hfToken,
      tokenHost: OpenLocSettings.tokenHost(prefs.hfMirror),
    });
    say(message);
    paintDownload({ phase: "done", message: message, received: 1, total: 1 });
    loadEngineStatus();
  }
  catch (e) {
    say("没有下完：" + e);
    paintDownload({ phase: "error", message: "没有下完：" + e, received: 0, total: 0 });
  }
};
window.cancelDownload = async function() {
  if (!hasTauri()) {
    paintDownload({ phase: "cancelled", message: "网页预览没有正在进行的下载。", received: 0, total: 0 });
    return;
  }
  try {
    const message = await invoke("cancel_download");
    paintDownload({ phase: "progress", message: message, received: 0, total: 0 });
  } catch (e) {
    paintDownload({ phase: "error", message: "没能取消：" + e, received: 0, total: 0 });
  }
};
window.dlLlama = function() { return dl("engine", OpenLocSettings.LLAMA_ENGINE_URL, "llama.zip"); };
window.dlSd = function() { return dl("engine", OpenLocSettings.SD_ENGINE_URL, "sd.zip"); };
function engineBuildLabel(path) {
  const build = String(path || "").match(/b\d{3,}/i);
  return build ? ("llama.cpp " + build[0]) : "llama.cpp · 已安装";
}
function paintEngineCard(llama, sd, preview) {
  const title = document.getElementById("engine-title");
  const pathEl = document.getElementById("engine-path");
  const el = document.getElementById("engine-info");
  if (preview) {
    if (title) title.textContent = "llama.cpp · 未安装";
    if (pathEl) pathEl.textContent = "网页预览看不到 data/engines 里的 llama-server。";
    if (el) el.textContent = "安装和启动在运行页。桌面版才会真的下载公开包。";
    return;
  }
  if (title) title.textContent = llama ? engineBuildLabel(llama) : "llama.cpp · 未安装";
  if (pathEl) pathEl.textContent = llama || "data/engines 里还没有 llama-server。";
  if (el) el.textContent = (llama ? "聊天引擎已安装。" : "聊天引擎未安装。") + (sd ? "画图引擎已安装。" : "画图引擎未安装。") + "来源是 GitHub 上的公开项目，没有付费加速。";
}
window.loadEngineStatus = async function() {
  const sub = document.getElementById("step-engine-sub");
  const step = document.getElementById("step-engine");
  const runInfo = document.getElementById("run-engine-info");
  try {
    const s = await invoke("engine_status");
    const llama = s && s.llama;
    const sd = s && s.sd;
    paintEngineCard(llama, sd, false);
    if (step) step.classList.toggle("done", !!llama);
    if (sub) sub.textContent = llama ? "聊天引擎已安装，去运行页启动" : "还没安装，去运行页安装并启动";
    if (runInfo) runInfo.textContent = (llama ? "聊天引擎已安装。" : "聊天引擎还没安装。") + (sd ? "画图引擎已安装。" : "画图引擎还没安装。") + "在这一页安装并启动。";
  } catch (e) {
    if (!hasTauri()) {
      paintEngineCard("", "", true);
      if (sub) sub.textContent = "网页预览不能安装，去运行页看说明";
      if (runInfo) runInfo.textContent = "网页预览不会安装或启动引擎。桌面版在这一页安装 llama.cpp 和画图引擎。";
    }
  }
};
window.useInstalledLlama = async function() {
  const msg = document.getElementById("engine-msg");
  if (!hasTauri()) {
    if (msg) msg.textContent = "网页预览看不到本机已有的 llama.cpp，也不会去全盘搜索。桌面版只认 data/engines 里的 llama-server。";
    return;
  }
  await loadEngineStatus();
  const pathEl = document.getElementById("engine-path");
  const path = pathEl ? pathEl.textContent : "";
  const has = path.indexOf("llama-server") >= 0 && path.indexOf("还没有") < 0 && path.indexOf("看不到") < 0;
  if (has) {
    if (msg) msg.textContent = "正在使用已安装的 llama-server，没有重新下载，也没有扫描其它目录。";
    return;
  }
  if (msg) msg.textContent = "data/engines 里还没有 llama-server。请手动导入 zip，或安装已知的公开包。不会去全盘搜索。";
  try { await invoke("open_folder", { path: "data/engines" }); } catch (e) {}
};
window.pickEngineZip = function() {
  const input = document.getElementById("enginezip");
  if (input) input.click();
};
window.updateKnownEngine = function() {
  const msg = document.getElementById("engine-msg");
  if (msg) msg.textContent = "将下载公开的 llama.cpp b12110 Windows CPU 包。这是仓库里写明的已知版本，不是在线查到的更新构建，也不走付费线路。";
  return dl("engine", OpenLocSettings.LLAMA_ENGINE_URL, "llama.zip");
};
function isImageWeight(name) { return /\.(safetensors|ckpt)$/i.test(name || ""); }
async function refreshMediaEmpty(which) {
  const box = document.getElementById(which + "-empty");
  const text = document.getElementById(which + "-empty-text");
  if (!box || !text) return;
  const noun = which === "img" ? "画图" : "视频";
  box.hidden = false;
  if (!hasTauri()) {
    text.textContent = "网页预览看不到" + noun + "引擎和模型。缺引擎去运行页，缺模型去模型页。";
    return;
  }
  let sd = null;
  let infos = [];
  try { const s = await invoke("engine_status"); sd = s && s.sd; } catch (e) {}
  try { infos = await invoke("list_local_model_info"); } catch (e) { infos = []; }
  if (!sd) { text.textContent = "还没装" + noun + "引擎。缺引擎去运行页。"; return; }
  if (!infos.some((m) => isImageWeight(m.name))) { text.textContent = "还没下" + noun + "模型。缺模型去模型页。"; return; }
  box.hidden = true;
}
function refreshImgEmpty() { return refreshMediaEmpty("img"); }
function refreshVidEmpty() { return refreshMediaEmpty("vid"); }
function paintRunButtons(on, s) {
  const start = document.getElementById("startBtn");
  if (!start || startInFlight) return;
  start.style.display = on ? "none" : "inline-block";
  const stop = document.getElementById("stopBtn");
  const chat = document.getElementById("chatBtn");
  if (stop) stop.style.display = on ? "inline-block" : "none";
  if (chat) chat.style.display = on ? "inline-block" : "none";
  const st = document.getElementById("run-state");
  if (st) st.textContent = on ? "运行中" : "未运行";
  const card = document.getElementById("runcard");
  if (on && s) {
    if (card) card.style.display = "block";
    const title = document.getElementById("run-title");
    if (title) title.textContent = "运行中 · " + (s.model || "");
    const sub = document.getElementById("run-sub");
    if (sub) sub.textContent = "只绑定 127.0.0.1，健康检查通过才显示运行中";
    const api = document.getElementById("run-api");
    if (api) api.textContent = (window.OpenLocChat ? OpenLocChat.loopbackUrl(s.port || getPort()) : ("http://127.0.0.1:" + (s.port || getPort()) + "/v1"));
  } else if (card) {
    card.style.display = "none";
  }
}
function paintProbe(probe) {
  const text = probe && probe.message ? String(probe.message) : "";
  const phase = probe && probe.phase ? String(probe.phase) : "";
  const warn = phase === "empty" || phase === "repeat" || phase === "timeout" || phase === "failed";
  for (const id of ["probe-run", "probe-chat"]) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.hidden = !text;
    el.textContent = text;
    el.classList.toggle("warn", warn && !!text);
  }
}
function applyChatStatus(s) {
  const on = !!(s && s.running);
  const dot = document.getElementById("modelDot");
  if (dot) {
    dot.classList.toggle("on", on);
    dot.title = on ? "本地模型运行中" : "本地模型未启动";
  }
  const ad = document.getElementById("agentDot");
  if (ad) { ad.classList.toggle("on", on); ad.title = on ? "本地模型运行中" : "本地模型未启动"; }
  const al = document.getElementById("agentModelLabel");
  if (al) al.textContent = on && s.model ? ("本地模型：" + s.model) : "本地模型：还没有启动";
  const line = document.getElementById("chat-service-line");
  if (line) {
    if (!hasTauri()) line.textContent = "网页预览没有本机聊天服务。安装、启动和对话要在桌面版里做。";
    else line.textContent = (s && s.detail) ? s.detail : (on ? "运行中" : "未启动");
  }
  const next = document.getElementById("chat-empty-next");
  if (next) {
    next.textContent = on
      ? "本机聊天服务已在运行。直接发消息即可。对话只发到 127.0.0.1，不会上传。"
      : "本地模型还没有启动。先在「运行」页启动一个模型，再在这里发消息。";
  }
  const chatSel = document.getElementById("chatmodel");
  if (chatSel) {
    if (on && s.model) {
      chatSel.innerHTML = `<option value="${escHtml(s.model)}">${escHtml(s.model)}</option>`;
      chatSel.value = s.model;
    } else {
      const label = knownModels.length
        ? "本地模型：还没有启动（已下载 " + knownModels.length + " 个）"
        : "本地模型：还没有启动";
      chatSel.innerHTML = `<option value="">${escHtml(label)}</option>`;
    }
  }
  paintRunButtons(on, s);
  paintProbe(s && s.probe);
  const off = document.getElementById("offload-note");
  if (off && s && s.offload) off.textContent = s.offload;
}
async function refreshChatModel() {
  if (!hasTauri()) {
    applyChatStatus(null);
    return;
  }
  try {
    applyChatStatus(await invoke("get_chat_status"));
  } catch (e) {
    applyChatStatus({ running: false, detail: "没能确认聊天服务状态：" + e + "。下一步：打开「运行」页重新启动。" });
  }
}
window.loadModels = async function() {
  let list = [];
  try { list = await invoke("list_local_models"); }
  catch (e) { list = []; }
  knownModels = Array.isArray(list) ? list : [];
  const ml = document.getElementById("modellist");
  if (ml) ml.innerHTML = knownModels.map((m) => `<li>${escHtml(m)}</li>`).join("");
  for (const id of ["imgmodel", "vidmodel", "runmodel"]) {
    const sel = document.getElementById(id);
    if (!sel) continue;
    const prev = sel.value;
    if (!knownModels.length) sel.innerHTML = '<option value="">还没有已安装模型</option>';
    else {
      sel.innerHTML = knownModels.map((m) => `<option value="${escHtml(m)}">${escHtml(m)}</option>`).join("");
      if (prev && knownModels.includes(prev)) sel.value = prev;
    }
  }
  await refreshChatModel();
  updatePlan();
};
window.importModel = async function() {
  const msg = document.getElementById("importmsg");
  const path = document.getElementById("importpath").value.trim();
  if (!path) { if (msg) msg.textContent = "先填写模型的完整路径。没有路径就不会导入。"; return; }
  if (!hasTauri()) { if (msg) msg.textContent = "网页预览不会把文件复制进 data/models。桌面版才会按这条路径导入。"; return; }
  try { msg.textContent = await invoke("import_model", { path }); loadModels(); loadInstalled(); }
  catch (e) { msg.textContent = "没有导入：" + e; }
};
window.setCtx = function(v, btn) {
  runCtx = v;
  document.querySelectorAll("#ctxpills button").forEach(b => b.classList.remove("on"));
  if (btn) btn.classList.add("on");
  document.getElementById("ctx-now").textContent = v === 'auto' ? '自动' : (v/1024) + 'K';
  updatePlan();
};
function estimateInstalled(info, hw) {
  const quant = OpenLocRecommend.inferQuant(info && info.name) || "Q4_K_M";
  const hit = OpenLocRecommend.matchCatalog(info && info.name, localModels());
  return OpenLocRecommend.assess({
    name: info ? info.name : "",
    repo: hit ? hit.repo : "",
    params: hit ? hit.params : "",
    desc: hit ? hit.desc : "",
    cat: hit ? hit.cat : "",
    sizeGb: info && info.size_gb > 0 ? info.size_gb : undefined,
  }, hw || hardwareView(), quant);
}
function paintEstimate(view) {
  const es = document.getElementById("est-speed");
  const note = document.getElementById("est-speed-note");
  if (!view) {
    if (es) { es.textContent = hasTauri() ? "选中模型后约估" : "待检测 / 网页预览"; es.title = ""; }
    if (note) note.textContent = hasTauri()
      ? "选中已安装模型后，按显存、内存和量化约估 tok/s。这不是启动之后测到的速度。"
      : "网页预览没有硬件数据，不会编一个 tok/s。";
    return;
  }
  const name = document.getElementById("runmodel") ? document.getElementById("runmodel").value : "";
  const measured = storedMeasure(name);
  if (measured) {
    if (es) { es.textContent = measured.speedText; es.title = "实测。公式约估仍是「" + view.speedText + "」。"; }
    if (note) note.textContent = measured.note + " 公式约估仍是「" + view.speedText + "」。";
    const run = document.getElementById("run-speed");
    if (run) run.textContent = measured.speedText;
    return;
  }
  if (es) { es.textContent = view.speedText; es.title = view.formula; }
  if (note) note.textContent = "约估。和推荐卡片同一套带宽公式，不是启动之后测到的速度。";
}
function storedMeasure(name) {
  if (!name) return null;
  try {
    const raw = JSON.parse(localStorage.getItem("openloc-measured") || "null");
    if (raw && raw.key && String(raw.key).indexOf(name + "|") === 0 && raw.speedText) return raw;
  } catch (e) {}
  return null;
}
function rememberSpeed(meta) {
  if (!window.OpenLocSpeed || !meta || !meta.firstAt || !(meta.tokens > 0)) return;
  const modelEl = document.getElementById("chatmodel");
  const model = modelEl && modelEl.value ? modelEl.value : "";
  if (!model) return;
  const ctxEl = document.getElementById("ctx");
  const off = document.getElementById("offload-note");
  const text = OpenLocSpeed.measuredText({
    tokens: meta.tokens,
    ms: Date.now() - meta.firstAt,
    model: model,
    ctx: ctxEl ? ctxEl.value : "",
    offload: off && off.textContent ? off.textContent + " " : "",
  });
  if (!text) return;
  try {
    localStorage.setItem("openloc-measured", JSON.stringify({
      key: model + "|" + (ctxEl ? ctxEl.value : ""),
      speedText: text.speedText,
      note: text.note,
    }));
  } catch (e) {}
  const es = document.getElementById("est-speed");
  const note = document.getElementById("est-speed-note");
  const run = document.getElementById("run-speed");
  if (es) es.textContent = text.speedText;
  if (run) run.textContent = text.speedText;
  if (note) note.textContent = text.note;
}
window.updatePlan = async function() {
  const sel = document.getElementById("runmodel");
  const desc = document.getElementById("plan-desc");
  if (!sel || !sel.value) {
    if (desc) desc.textContent = hasTauri() ? "选一个已下载模型后，这里会算它放进显存还是内存，并约估 tok/s。" : "网页预览没有已安装模型。下面三条是分层示意，长度不代表你的电脑，也不会编一个 tok/s。";
    paintEstimate(null);
    return;
  }
  try {
    const list = await invoke("list_local_model_info");
    const m = list.find(x => x.name === sel.value);
    const h = await invoke("get_hardware");
    if (!m) { paintEstimate(null); return; }
    hwSnapshot = hardwareFrom(h);
    const view = estimateInstalled(m, hwSnapshot);
    const vram = h.gpu_vram_gb || 0;
    const fits = view.fit === "流畅";
    document.getElementById("plan-vram").textContent = "显卡 · " + h.gpu.replace("NVIDIA GeForce ", "");
    document.getElementById("plan-vram-sub").textContent = m.size_gb.toFixed(1) + " GB 模型 / " + (vram ? vram.toFixed(1) + " GB 显存" : "无独立显存");
    document.getElementById("plan-vram-bar").style.width = vram ? Math.min(100, m.size_gb / vram * 100) + "%" : "8%";
    document.getElementById("plan-mem").textContent = "内存 · " + h.memory_total_gb.toFixed(0) + " GB";
    document.getElementById("plan-mem-bar").style.width = Math.min(100, m.size_gb / h.memory_total_gb * 100) + "%";
    const memSub = document.getElementById("plan-mem-sub"); if (memSub) memSub.textContent = fits ? "不需要" : "放不进显存的部分会到这里";
    const diskSub = document.getElementById("plan-disk-sub"); if (diskSub) diskSub.textContent = "按需读取";
    if (desc) desc.textContent = view.place + "。" + view.placeDetail;
    paintEstimate(view);
  } catch (e) {
    if (desc) desc.textContent = "没能算出分层：" + e;
    const es = document.getElementById("est-speed");
    if (es) { es.textContent = "约估不可用"; es.title = ""; }
    const note = document.getElementById("est-speed-note");
    if (note) note.textContent = "没有拿到模型体积或硬件数据，所以不填 tok/s。";
  }
};
window.toggleThink = function() {
  const c = document.getElementById("thinkmode");
  c.checked = !c.checked;
  const b = document.getElementById("thinkBtn");
  if (b) b.setAttribute("aria-checked", c.checked ? "true" : "false");
  const lab = document.getElementById("thinkLab"); if (lab) lab.textContent = c.checked ? "开" : "关";
  const flag = document.querySelector(".think-flag"); if (flag) flag.textContent = c.checked ? "思考：开" : "思考：关";
};
window.toggleLan = function() {
  const b = document.getElementById("lanBtn");
  const on = b.getAttribute("aria-checked") !== "true";
  b.setAttribute("aria-checked", on ? "true" : "false");
  document.getElementById("lanLab").textContent = on ? "开" : "关";
  document.getElementById("lanmode").checked = on;
  document.getElementById("runmsg").textContent = on
    ? "已记下「想开局域网」。当前版本启动聊天服务时仍然只绑定 127.0.0.1，不会对手机或其他电脑开放。"
    : "局域网访问关着。聊天服务只在本机。";
  try { localStorage.setItem("openloc-lan", on ? "1" : "0"); } catch (e) {}
};
function authOn(key) { try { return localStorage.getItem(key) !== "0"; } catch (e) { return true; } }
function persistAuth() {
  localStorage.setItem("openloc-auth-chat", document.getElementById("auth-chat").checked ? "1" : "0");
  localStorage.setItem("openloc-auth-img", document.getElementById("auth-img").checked ? "1" : "0");
  localStorage.setItem("openloc-auth-agent", document.getElementById("auth-agent").checked ? "1" : "0");
  localStorage.setItem("openloc-auth-tray", document.getElementById("auth-tray").checked ? "1" : "0");
}
window.saveAuth = async function() {
  const msg = document.getElementById("authmsg");
  try {
    persistAuth();
    if (!hasTauri()) {
      if (msg) msg.textContent = "授权已写在这台电脑上。网页预览不会改托盘行为。";
      return;
    }
    if (msg) msg.textContent = await invoke("set_tray_enabled", { enabled: document.getElementById("auth-tray").checked });
  } catch (e) { if (msg) msg.textContent = "授权已记下，但托盘设置没有生效：" + e; }
};
window.loadBackground = async function() {
  const el = document.getElementById("bglist"); el.textContent = "查询中…";
  try {
    const list = await invoke("list_background");
    el.innerHTML = list.length ? list.map(x => `<div class="mcard"><div class="mtitle"><b>${x.name}</b><span>PID ${x.pid} · ${x.mem_mb} MB</span></div><button class="sec" onclick="stopBg('${x.name}')">停止这个程序</button></div>`).join("") : "后台没有 OpenLoc 的程序在跑。";
  } catch (e) { el.textContent = hasTauri() ? ("失败：" + e) : "网页预览没有 OpenLoc 的后台进程。"; }
};
window.stopBg = async function(name) {
  if (!confirm("确定停止 " + name + " 吗？聊天 / 画图服务会停掉。")) return;
  try { alert(await invoke("stop_process", { name })); loadBackground(); } catch (e) { alert("失败：" + e); }
};
window.startRunModel = async function() {
  if (!hasTauri()) {
    document.getElementById("runmsg").textContent = "网页预览不能启动推理引擎，也没有在本机拉起 llama-server。";
    document.getElementById("runlog").textContent = "网页预览：没有启动。";
    document.getElementById("run-state").textContent = "网页预览";
    return;
  }
  if (!authOn("openloc-auth-chat")) {
    document.getElementById("runmsg").textContent = "你没授权 OpenLoc 启动聊天服务。下一步：打开「设置」→ 授权控制，勾上“允许启动 / 停止聊天服务”。";
    return;
  }
  const m = document.getElementById("runmodel").value;
  if (!m) {
    document.getElementById("runmsg").textContent = "还没有选择已下载的 GGUF。下一步：到「模型」页下载或按路径导入，再回到这一页选择它。";
    return;
  }
  const ctx = runCtx === 'auto' ? 16384 : runCtx;
  const card = document.getElementById("startcard"); card.style.display = "block";
  document.getElementById("start-title").textContent = "正在启动 " + m;
  document.getElementById("run-state").textContent = "等待健康检查";
  document.getElementById("runmsg").textContent = "";
  startInFlight = true;
  const t0 = Date.now();
  const timer = setInterval(() => {
    const s = Math.floor((Date.now() - t0) / 1000);
    document.getElementById("start-sub").textContent = "等待 127.0.0.1:" + getPort() + " 健康检查 · 已用 " + s + " 秒";
    document.getElementById("start-pct").textContent = "未完成";
    document.getElementById("start-bar").style.width = "40%";
    document.getElementById("start-log").textContent = "健康检查返回 ok 之前，不会把状态标成运行中。这不是完成比例。";
  }, 1000);
  try {
    const r = await invoke("start_chat", { model: m, ctx: ctx, port: getPort() });
    clearInterval(timer);
    startInFlight = false;
    document.getElementById("start-title").textContent = "健康检查已通过";
    document.getElementById("start-pct").textContent = "已通过";
    document.getElementById("start-bar").style.width = "100%";
    document.getElementById("start-log").textContent = r;
    document.getElementById("run-state").textContent = "运行中";
    const lanOn = document.getElementById("lanBtn") && document.getElementById("lanBtn").getAttribute("aria-checked") === "true";
    document.getElementById("runmsg").textContent = r + "（思考模式：" + (document.getElementById("thinkmode").checked ? "开" : "关") + "，只有引擎真的返回思考片段才会显示）" + (lanOn ? " 已记下局域网访问，但服务仍只绑定 127.0.0.1，没有对局域网开放。" : "");
    document.getElementById("runlog").textContent = r;
    try {
      const h = await invoke("get_hardware");
      const list = await invoke("list_local_model_info");
      const info = list.find(x => x.name === m);
      document.getElementById("run-vram").textContent = (info ? info.size_gb.toFixed(1) : "—") + " GB / " + (h.gpu_vram_gb ? h.gpu_vram_gb.toFixed(1) + " GB" : "无");
      document.getElementById("run-mem").textContent = h.memory_gb.toFixed(1) + " GB / " + h.memory_total_gb.toFixed(0) + " GB";
    } catch (e) {
      document.getElementById("runlog").textContent = r + "\n硬件数字没刷新：" + e;
    }
    await refreshChatModel();
  } catch (e) {
    clearInterval(timer);
    startInFlight = false;
    const text = String(e);
    document.getElementById("start-title").textContent = "没有启动成功";
    document.getElementById("start-pct").textContent = "";
    document.getElementById("start-bar").style.width = "0";
    document.getElementById("start-log").textContent = text;
    document.getElementById("runmsg").textContent = text;
    document.getElementById("runlog").textContent = text;
    document.getElementById("run-state").textContent = "未运行";
    await refreshChatModel();
  }
};
window.stopRunModel = async function() {
  try {
    const r = await invoke("stop_chat");
    document.getElementById("runmsg").textContent = r;
    document.getElementById("runlog").textContent = r;
  } catch (e) {
    document.getElementById("runmsg").textContent = "没有停止成功：" + e + "。下一步：到设置里刷新后台程序，确认 llama-server 是否还在。";
  }
  await refreshChatModel();
};
window.copyApi = function() { const t = document.getElementById("run-api").textContent; try { navigator.clipboard.writeText(t); alert("已复制：" + t); } catch (e) { alert(t); } };
window.startChat = async function() {
  try { alert(await invoke("start_chat", { model: document.getElementById("chatmodel").value, ctx: parseInt(document.getElementById("ctx").value), port: getPort() })); }
  catch (e) { alert("失败：" + e); }
};
window.stopChat = async function() { alert(await invoke("stop_chat")); };
window.toggleNet = function() {
  applyNet(!webOn);
  const note = webOn
    ? (hasTauri()
      ? "已记下「允许联网」。发送时会尝试检索；失败会说明原因，不会编造搜索结果。Agent 这条路径本身不会去检索。"
      : "已记下「允许联网」。网页预览没有联网检索，发送时不会附带搜索结果。")
    : "已切换为「本机运行 · 不联网」。发送时不会检索。";
  setComposerNote(note);
  setAgentNote(note);
};
window.pickAttach = function() {
  const input = document.getElementById("chatfile");
  if (input) input.click();
};
window.captureForChat = async function() {
  if (!hasTauri()) {
    setComposerNote("网页预览不能框选截图，没有贴上图片。请用桌面版 OpenLoc。");
    return;
  }
  setComposerNote("正在打开选区。框住要截的范围，点确认后才会加入当前对话；取消则不贴图。");
  try {
    const shot = await invoke("capture_chat_image");
    if (!shot || !shot.name || !shot.path || shot.mode !== "region") {
      setComposerNote("没有贴上图片。没有拿到选区截图。");
      return;
    }
    chatAttachments.push({
      name: shot.name,
      kind: "image",
      url: "",
      path: shot.path,
      mode: "region",
      source: "screenshot",
    });
    renderAttachments();
    setComposerNote("已把选区截图加入当前对话附件（" + shot.name + "）。图片留在本机，没有上传。");
  } catch (e) {
    setComposerNote("没有贴上图片。" + e);
  }
};
function addMsg(role, text) {
  const box = document.getElementById("chatbox");
  const empty = document.getElementById("chat-empty");
  if (empty) empty.hidden = true;
  const d = document.createElement("div");
  d.className = role === "user" ? "msg-user" : "msg-ai";
  d.textContent = (role === "user" ? "你：" : "AI：") + text;
  box.appendChild(d); box.scrollTop = box.scrollHeight;
  return d;
}
function thinkOn() {
  const box = document.getElementById("thinkmode");
  return !box || box.checked;
}
function setSending(on) {
  sending = on;
  const btn = document.getElementById("sendBtn");
  if (!btn) return;
  btn.classList.toggle("stop", on);
  btn.setAttribute("aria-label", on ? "停止生成" : "发送");
  btn.title = on ? "停止生成" : "发送";
  btn.innerHTML = on
    ? '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="1.2"/></svg>'
    : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V6M6.5 11.5L12 6l5.5 5.5"/></svg>';
}
function paintActive() {
  if (!activeReply) return;
  activeReply.el.textContent = OpenLocChat.renderAi(activeReply.state);
}
window.onSendClick = function() {
  if (sending) cancelSend();
  else sendChat();
};
window.cancelSend = async function() {
  const current = activeReply;
  sendGen += 1;
  if (current) {
    current.state = OpenLocChat.reduceStream(current.state, { kind: "cancelled", text: "" });
    current.el.textContent = OpenLocChat.renderAi(current.state);
  }
  activeReply = null;
  setSending(false);
  if (!hasTauri()) return;
  try { await invoke("cancel_chat"); }
  catch (e) { setComposerNote("停止请求没有送到本机服务：" + OpenLocChat.errText(e) + "。界面已不再等待后续文字。"); }
};
window.sendChat = async function() {
  if (sending) return;
  const raw = document.getElementById("chatin").value.trim();
  const atts = chatAttachments.slice();
  const plan = OpenLocChat.planSend({
    raw: raw,
    attachmentNames: atts.map((a) => a.name),
    webOn: webOn,
    hasTauri: hasTauri(),
  });
  if (plan.kind === "empty") return;
  document.getElementById("chatin").value = "";
  setComposerNote("");
  addMsg("user", plan.shown);
  clearAttachments();
  if (plan.kind === "attachment-only" || plan.kind === "preview") {
    addMsg("ai", plan.reply);
    return;
  }
  let modelText = plan.modelText;
  if (plan.kind === "search") {
    try {
      const res = await invoke("web_search", { query: plan.query });
      const applied = OpenLocChat.afterSearch(modelText, { ok: true, text: res });
      if (applied.note) addMsg("ai", applied.note);
      modelText = applied.modelText;
    } catch (e) {
      const applied = OpenLocChat.afterSearch(modelText, { ok: false, error: OpenLocChat.errText(e) });
      if (applied.note) addMsg("ai", applied.note);
      modelText = applied.modelText;
    }
  }
  let status = null;
  try { status = await invoke("get_chat_status"); }
  catch (e) {
    addMsg("ai", "没能确认聊天服务状态：" + OpenLocChat.errText(e) + "。下一步：打开「运行」页重新启动。本次没有编造回复。");
    return;
  }
  const gate = OpenLocChat.gateService(status);
  if (!gate.ok) {
    addMsg("ai", gate.reply);
    return;
  }
  const messages = chatTurns.concat([{ role: "user", content: modelText }]);
  chatTurns.push({ role: "user", content: modelText });
  persistCurrent();
  const pending = addMsg("ai", "正在生成本机回复…");
  const gen = ++sendGen;
  const streamMeta = { firstAt: 0, tokens: 0 };
  const state = { text: "", reasoning: "", status: "", done: false, cancelled: false, error: "" };
  activeReply = { gen: gen, el: pending, state: state };
  setSending(true);
  const take = (ev) => {
    if (!activeReply || activeReply.gen !== gen) return;
    activeReply.state = OpenLocChat.reduceStream(activeReply.state, ev);
    paintActive();
  };
  try {
    const listen = window.__TAURI__ && window.__TAURI__.event && window.__TAURI__.event.listen;
    if (typeof listen === "function") {
      let settled = false;
      const unlisten = await listen("openloc-chat", function(ev) {
        const payload = ev && ev.payload ? ev.payload : ev;
        if (!payload || Number(payload.id) !== gen) return;
        if (payload.kind === "delta" && payload.text && !streamMeta.firstAt) streamMeta.firstAt = Date.now();
        if (payload.kind === "usage") streamMeta.tokens = parseInt(payload.text, 10) || 0;
        take(payload);
        if (payload.kind === "done" || payload.kind === "error" || payload.kind === "cancelled") settled = true;
      });
      try {
        await invoke("chat_stream", { messages: messages, think: thinkOn(), streamId: gen });
        const startedAt = Date.now();
        while (!settled && gen === sendGen && Date.now() - startedAt < 300000) {
          await new Promise((resolve) => setTimeout(resolve, 40));
        }
        if (!settled && gen === sendGen) {
          take({ kind: "error", text: "请求失败：等了 300 秒还没有收完。下一步：点停止，或到「运行」页确认服务仍在。本次没有编造回复。" });
        }
      } finally {
        if (typeof unlisten === "function") unlisten();
      }
    } else {
      const reply = await invoke("chat_ask", { message: modelText, messages: messages, think: thinkOn() });
      take({ kind: "delta", text: reply || "" });
      take({ kind: "done", text: "" });
    }
    if (activeReply && activeReply.gen === gen && !activeReply.state.cancelled && !activeReply.state.error && activeReply.state.text) {
      chatTurns.push({ role: "assistant", content: activeReply.state.text });
      rememberSpeed(streamMeta);
      persistCurrent();
    }
  } catch (e) {
    take({ kind: "error", text: OpenLocChat.errText(e) });
  } finally {
    if (activeReply && activeReply.gen === gen) activeReply = null;
    if (gen === sendGen) setSending(false);
  }
};
document.getElementById("chatin") && document.getElementById("chatin").addEventListener("keydown", function(e) {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); if (!sending) sendChat(); }
  if (e.key === "Escape" && sending) { e.preventDefault(); cancelSend(); }
});
function mediaPath(text) {
  const raw = String(text || "");
  const i = raw.indexOf("：");
  return i >= 0 ? raw.slice(i + 1).trim() : "";
}
async function showPreview(boxId, text) {
  const box = document.getElementById(boxId);
  if (!box) return;
  box.innerHTML = "";
  const path = mediaPath(text);
  if (!path || !hasTauri()) return;
  try {
    const preview = await invoke("media_preview", { path: path });
    if (preview.kind === "image") {
      const img = document.createElement("img");
      img.alt = "生成结果";
      img.src = preview.data_url;
      img.style.maxWidth = "100%";
      box.appendChild(img);
    } else if (preview.kind === "video") {
      const video = document.createElement("video");
      video.controls = true;
      video.src = preview.data_url;
      video.style.maxWidth = "100%";
      box.appendChild(video);
    }
  } catch (e) {
    const p = document.createElement("p");
    p.className = "muted small";
    p.textContent = String(e);
    box.appendChild(p);
  }
}
window.stopMedia = async function() {
  if (!hasTauri()) return;
  try { await invoke("cancel_media"); } catch (e) {}
};
window.genImg = async function() {
  const msg = document.getElementById("imgmsg");
  const stop = document.getElementById("img-stop");
  if (!authOn("openloc-auth-img")) { if (msg) msg.textContent = "你没授权 OpenLoc 启动画图引擎：去设置 → 授权控制，勾上“允许启动画图 / 视频引擎”。"; return; }
  if (!hasTauri()) { if (msg) msg.textContent = "网页预览不会生成图片。"; return; }
  const size = parseInt((document.getElementById("imgsize") || {}).value || "512", 10) === 768 ? 768 : 512;
  if (msg) msg.textContent = "正在生成图片，可以停止。这不是完成比例。";
  if (stop) stop.hidden = false;
  try {
    const text = await invoke("generate_image", { model: document.getElementById("imgmodel").value, prompt: document.getElementById("imgprompt").value, steps: parseInt(document.getElementById("imgsteps").value), width: size, height: size });
    if (msg) msg.textContent = text;
    await showPreview("img-preview", text);
  } catch (e) {
    if (msg) msg.textContent = String(e);
  } finally {
    if (stop) stop.hidden = true;
  }
};
window.genMotion = async function() {
  const msg = document.getElementById("vidmsg");
  if (!hasTauri()) { if (msg) msg.textContent = "网页预览不会生成视频。"; return; }
  if (msg) msg.textContent = "正在做动效视频，可以停止。这是 ffmpeg 动效，不是扩散生成。";
  try {
    const text = await invoke("generate_motion_video", { image: document.getElementById("vidimg").value, seconds: 3 });
    if (msg) msg.textContent = text;
    await showPreview("vid-preview", text);
  } catch (e) { if (msg) msg.textContent = String(e); }
};
window.genVid = async function() {
  const msg = document.getElementById("vidmsg");
  if (!authOn("openloc-auth-img")) { if (msg) msg.textContent = "你没授权 OpenLoc 启动画图 / 视频引擎：去设置 → 授权控制，勾上“允许启动画图 / 视频引擎”。"; return; }
  if (!hasTauri()) { if (msg) msg.textContent = "网页预览不会生成视频。"; return; }
  if (msg) msg.textContent = "正在生成扩散视频，可以停止。没有完成前不会给你假视频。";
  try {
    const text = await invoke("generate_diffusion_video", { model: document.getElementById("vidmodel").value, prompt: document.getElementById("vidprompt").value, frames: 25 });
    if (msg) msg.textContent = text;
    await showPreview("vid-preview", text);
  } catch (e) { if (msg) msg.textContent = String(e); }
};
async function loadFfmpegNote() {
  const el = document.getElementById("vid-ffmpeg");
  if (!el) return;
  if (!hasTauri()) { el.textContent = "网页预览不会生成视频，也看不到本机有没有 ffmpeg。"; return; }
  try { el.textContent = await invoke("ffmpeg_status"); } catch (e) { el.textContent = String(e); }
}
window.runAgent = async function() {
  const el = document.getElementById("asteps");
  const task = document.getElementById("atask").value.trim();
  const folder = document.getElementById("afolder").value.trim();
  if (!folder) { setAgentNote("先填写工作文件夹的完整路径。没有路径就不会执行。"); return; }
  if (!task) { setAgentNote("先写任务，或点中间的例子。"); return; }
  const extra = (webOn ? "联网开关是开的，但 Agent 不会去检索，也不会编造网页结果。\n" : "当前不联网，Agent 不会去检索。\n") + (agentAttachments.length ? "截图只留在本页，Agent 读不到图片内容，也没有上传。\n" : "");
  if (!hasTauri()) {
    el.textContent = "网页预览不会在文件夹里真的执行。桌面版才会按这个任务跑，并且只限这个文件夹。\n" + extra + "任务还在输入框里，没有执行。";
    return;
  }
  if (!authOn("openloc-auth-agent")) { setAgentNote("你没授权 Agent 跑命令：去设置 → 授权控制，勾上“允许 Agent 在工作文件夹里跑命令”。"); return; }
  el.textContent = "Agent 运行中…\n" + extra;
  try {
    const steps = await invoke("agent_run", { folder, task });
    el.textContent = extra + steps.join("\n");
  } catch (e) { el.textContent = extra + "没有跑完：" + e; }
};
window.fillTask = function(s) {
  if (!agentTasks.length) newAgentTask();
  document.getElementById("atask").value = s;
  const cur = agentTasks.find((t) => t.on);
  if (cur) { cur.text = s; cur.title = s.slice(0, 18); renderAgentTasks(); }
};
function renderAgentTasks() {
  const el = document.getElementById("agent-tasks");
  if (!el) return;
  if (!agentTasks.length) { el.innerHTML = '<div class="muted small">还没有任务</div>'; return; }
  el.innerHTML = agentTasks.map((t) => `<button type="button" class="task${t.on ? " on" : ""}" onclick="pickAgentTask(${t.id})">${escHtml(t.title || "任务")}</button>`).join("");
}
window.newAgentTask = function() {
  const cur = agentTasks.find((t) => t.on);
  if (cur) cur.text = document.getElementById("atask").value;
  agentTasks.forEach((t) => { t.on = false; });
  const id = Date.now();
  agentTasks.unshift({ id, title: "新任务", text: "", on: true });
  document.getElementById("atask").value = "";
  document.getElementById("asteps").textContent = "";
  agentAttachments.forEach((a) => { if (a.url) URL.revokeObjectURL(a.url); });
  agentAttachments = [];
  renderAgentAttach();
  renderAgentTasks();
};
window.pickAgentTask = function(id) {
  const cur = agentTasks.find((t) => t.on);
  if (cur) cur.text = document.getElementById("atask").value;
  agentTasks.forEach((t) => { t.on = t.id === id; });
  const next = agentTasks.find((t) => t.on);
  document.getElementById("atask").value = (next && next.text) || "";
  renderAgentTasks();
};
window.pickAgentFolder = function() {
  const input = document.getElementById("afolder");
  if (input) input.focus();
  setAgentNote(hasTauri()
    ? "请把工作文件夹的完整路径填在右上角。这一版没有单独的系统选文件夹窗口，路径以输入框为准。"
    : "网页预览打不开系统的选文件夹窗口。把完整路径填在右上角；没有路径就不会执行。");
};
function renderAgentAttach() {
  const el = document.getElementById("agent-attach");
  if (!el) return;
  el.replaceChildren();
  if (!agentAttachments.length) { el.hidden = true; return; }
  el.hidden = false;
  agentAttachments.forEach((a, i) => {
    const chip = document.createElement("span");
    chip.className = "attach-chip";
    const badge = document.createElement("span");
    badge.className = "attach-badge";
    badge.textContent = "图";
    const name = document.createElement("span");
    name.className = "attach-name";
    name.textContent = a.name;
    const x = document.createElement("button");
    x.type = "button";
    x.className = "attach-x";
    x.textContent = "×";
    x.onclick = function() { agentAttachments.splice(i, 1); renderAgentAttach(); };
    chip.append(badge, name, x);
    el.appendChild(chip);
  });
}
window.captureForAgent = async function() {
  if (!hasTauri()) {
    setAgentNote("网页预览不能框选截图，没有贴上图片。请用桌面版 OpenLoc。");
    return;
  }
  setAgentNote("正在打开选区。确认后才会记在这个任务旁；取消则不贴图。");
  try {
    const shot = await invoke("capture_chat_image");
    if (!shot || !shot.name || !shot.path || shot.mode !== "region") {
      setAgentNote("没有贴上图片。没有拿到选区截图。");
      return;
    }
    agentAttachments.push({ name: shot.name, path: shot.path, mode: "region" });
    renderAgentAttach();
    setAgentNote("已把选区截图记在这个任务旁（" + shot.name + "）。Agent 读不到图片内容，图片也没有上传。");
  } catch (e) { setAgentNote("没有贴上图片。" + e); }
};
function readSessions() {
  if (!window.OpenLocSessions) { chatSessions = []; return; }
  try { chatSessions = OpenLocSessions.load(localStorage.getItem(OpenLocSessions.key)); }
  catch (e) { chatSessions = []; }
}
function writeSessions() {
  if (!window.OpenLocSessions) return;
  try { localStorage.setItem(OpenLocSessions.key, OpenLocSessions.save(chatSessions)); } catch (e) {}
}
function renderSessions() {
  const el = document.getElementById("chat-history");
  if (!el) return;
  if (!chatSessions.length) { el.innerHTML = '<p class="muted small">还没有对话</p>'; return; }
  el.innerHTML = chatSessions.map((s) => `<div class="mcard"><button type="button" class="sec" onclick="openSession('${escHtml(s.id)}')">${escHtml(s.title)}</button><button type="button" class="sec" onclick="deleteSession('${escHtml(s.id)}')">删除</button></div>`).join("");
}
function persistCurrent() {
  if (!window.OpenLocSessions || !chatTurns.length) {
    renderSessions();
    return;
  }
  if (!chatSessionId) chatSessionId = String(Date.now());
  chatSessions = OpenLocSessions.upsert(chatSessions, { id: chatSessionId, turns: chatTurns });
  writeSessions();
  renderSessions();
}
function paintTurns(turns) {
  const box = document.getElementById("chatbox");
  if (!box) return;
  box.querySelectorAll(".msg-user,.msg-ai").forEach((n) => n.remove());
  const empty = document.getElementById("chat-empty");
  if (empty) empty.hidden = !!(turns && turns.length);
  (turns || []).forEach((t) => addMsg(t.role === "user" ? "user" : "ai", t.content));
}
window.openSession = function(id) {
  if (sending) return;
  persistCurrent();
  const found = chatSessions.find((s) => s.id === id);
  if (!found) return;
  chatSessionId = found.id;
  chatTurns = found.turns.map((t) => ({ role: t.role, content: t.content }));
  paintTurns(chatTurns);
  renderSessions();
};
window.deleteSession = function(id) {
  if (!window.OpenLocSessions) return;
  chatSessions = OpenLocSessions.remove(chatSessions, id);
  writeSessions();
  if (chatSessionId === id) {
    chatSessionId = "";
    chatTurns = [];
    paintTurns([]);
  }
  renderSessions();
};
window.newChat = function() {
  if (sending) cancelSend();
  persistCurrent();
  chatSessionId = String(Date.now());
  chatTurns = [];
  paintTurns([]);
  document.getElementById("chatin").value = "";
  clearAttachments();
  setComposerNote("");
  renderSessions();
};
window.saveLang = function(v) {
  try { localStorage.setItem("openloc-lang", v); } catch (e) {}
  const el = document.getElementById("langmsg");
  if (!el) return;
  el.textContent = v === "en"
    ? "界面只有简体中文。选 English 不会翻译，也不会重新加载。"
    : "已记下语言。界面只有简体中文，不会重新加载。";
};
window.savePort = function() {
  const v = OpenLocSettings.validPort(document.getElementById("apiport").value);
  const el = document.getElementById("portmsg");
  if (v == null) {
    if (el) el.textContent = "端口无效。请填写 1 到 65535。这次没有保存。";
    return false;
  }
  try { localStorage.setItem("openloc-port", String(v)); } catch (e) {}
  if (el) el.textContent = "已保存端口 " + v + "。下次启动聊天服务时生效，被占用时不会自动换端口。";
  return true;
};
function readApis() {
  try {
    const raw = JSON.parse(localStorage.getItem("openloc-apis") || "[]");
    if (!Array.isArray(raw)) return [];
    return raw.filter((x) => x && x.name && x.base && x.model).map((x) => ({
      id: String(x.id || "").replace(/[^a-zA-Z0-9]/g, "").slice(0, 24),
      name: String(x.name),
      model: String(x.model),
      base: String(x.base),
      key: String(x.key || ""),
    })).filter((x) => x.id);
  } catch (e) { return []; }
}
function writeApis(list) {
  localStorage.setItem("openloc-apis", JSON.stringify(list.map((x) => ({
    id: x.id, name: x.name, model: x.model, base: x.base, key: x.key,
  }))));
}
let apiEditId = "";
window.renderApiList = function() {
  const el = document.getElementById("api-list");
  if (!el) return;
  const list = readApis();
  if (!list.length) {
    el.innerHTML = "<p class='muted'>还没有第三方接口。</p>";
    return;
  }
  el.innerHTML = list.map((x) => {
    const keyNote = x.key ? "Key 已保存在本机" : "未填 Key";
    return `<div class="api-row"><div class="api-meta"><b>${escHtml(x.name)} ${escHtml(x.model)}</b><span>${escHtml(x.base)} · ${keyNote}</span></div><div class="api-actions"><button class="sec" type="button" onclick="editApiEntry('${escHtml(x.id)}')">编辑</button><button class="sec" type="button" onclick="deleteApiEntry('${escHtml(x.id)}')">删除</button></div></div>`;
  }).join("");
};
window.openApiForm = function(id) {
  apiEditId = id || "";
  const form = document.getElementById("api-form");
  if (form) form.hidden = false;
  const found = id ? readApis().find((x) => x.id === id) : null;
  document.getElementById("api-name").value = found ? found.name : "";
  document.getElementById("api-model").value = found ? found.model : "";
  document.getElementById("api-base").value = found ? found.base : "";
  document.getElementById("api-key").value = "";
  const hint = document.getElementById("api-form-hint");
  if (hint) hint.textContent = found && found.key ? "Key 已在本机。留空会保留，输入新的会替换。" : "Key 只写在这台电脑上。可以留空。";
  const msg = document.getElementById("api-form-msg");
  if (msg) msg.textContent = "";
};
window.closeApiForm = function() {
  apiEditId = "";
  const form = document.getElementById("api-form");
  if (form) form.hidden = true;
};
window.editApiEntry = function(id) { openApiForm(id); };
window.deleteApiEntry = function(id) {
  const list = readApis();
  const found = list.find((x) => x.id === id);
  if (!found) return;
  if (!confirm("删除「" + found.name + "」？Key 会一并从这台电脑清掉。对话不会因此改用别的接口。")) return;
  writeApis(list.filter((x) => x.id !== id));
  if (apiEditId === id) closeApiForm();
  renderApiList();
};
window.saveApiEntry = function() {
  const msg = document.getElementById("api-form-msg");
  const draft = OpenLocSettings.normalizeApiDraft({
    id: apiEditId,
    name: document.getElementById("api-name").value,
    model: document.getElementById("api-model").value,
    base: document.getElementById("api-base").value,
    key: document.getElementById("api-key").value,
  });
  if (draft.error) { if (msg) msg.textContent = draft.error; return; }
  const list = readApis();
  const entry = draft.entry;
  if (!entry.id) entry.id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const prev = list.find((x) => x.id === entry.id);
  if (!entry.key && prev) entry.key = prev.key;
  const next = prev ? list.map((x) => x.id === entry.id ? entry : x) : list.concat([entry]);
  try { writeApis(next); } catch (e) { if (msg) msg.textContent = "没能写入本地存储：" + e; return; }
  closeApiForm();
  renderApiList();
  const note = document.getElementById("api-note");
  if (note) note.textContent = "已写在这台电脑上。对话和 Agent 目前仍只走本机 llama.cpp，顶部还不能改用这条接口。";
};
window.saveSettings = async function() {
  const msg = document.getElementById("savemsg");
  const lang = document.getElementById("langSel").value;
  const theme = document.getElementById("themeSel").value;
  const tokenRaw = document.getElementById("hf-token").value;
  const clearToken = tokenRaw.trim() === "-";
  const checked = OpenLocSettings.validatePrefs({
    hfMirror: document.getElementById("hf-mirror").value,
    githubPrefix: document.getElementById("gh-prefix").value,
    hfToken: clearToken ? "" : tokenRaw,
  });
  if (checked.error) { if (msg) msg.textContent = checked.error; return; }
  if (!savePort()) { if (msg) msg.textContent = "端口无效，这次没有保存。"; return; }
  try {
    localStorage.setItem("openloc-hf-mirror", checked.hfMirror);
    localStorage.setItem("openloc-gh-prefix", checked.githubPrefix);
    if (clearToken) localStorage.removeItem("openloc-hf-token");
    else if (checked.hfToken) localStorage.setItem("openloc-hf-token", checked.hfToken);
    document.getElementById("hf-token").value = "";
    document.getElementById("hf-mirror").value = checked.hfMirror;
    document.getElementById("gh-prefix").value = checked.githubPrefix;
  } catch (e) { if (msg) msg.textContent = "没能写入本地存储：" + e; return; }
  setTheme(theme);
  saveLang(lang);
  await saveAuth();
  const tokenHint = document.getElementById("hf-token-hint");
  if (tokenHint) {
    tokenHint.textContent = localStorage.getItem("openloc-hf-token")
      ? "令牌已在本机，输入框不回显。输入新的会替换，输入一个减号再保存会清掉。"
      : "下载需要同意协议的模型时才发给 huggingface.co，或你填写的镜像。不回显。";
  }
  if (msg) msg.textContent = "已保存在这台电脑上。端口下次启动聊天服务时生效。镜像和前缀只用于之后的免费下载。";
};
(function() {
  try {
    const v = localStorage.getItem("openloc-theme") || "light"; setTheme(v);
    const p = localStorage.getItem("openloc-port"); if (p && document.getElementById("apiport")) document.getElementById("apiport").value = p;
    const l = localStorage.getItem("openloc-lang"); if (l && document.getElementById("langSel")) document.getElementById("langSel").value = l;
    const mirror = localStorage.getItem("openloc-hf-mirror");
    const prefix = localStorage.getItem("openloc-gh-prefix");
    if (mirror && document.getElementById("hf-mirror")) document.getElementById("hf-mirror").value = mirror;
    if (prefix && document.getElementById("gh-prefix")) document.getElementById("gh-prefix").value = prefix;
    const tokenHint = document.getElementById("hf-token-hint");
    if (tokenHint && localStorage.getItem("openloc-hf-token")) tokenHint.textContent = "令牌已在本机，输入框不回显。输入新的会替换，输入一个减号再保存会清掉。";
    document.getElementById("auth-chat").checked = authOn("openloc-auth-chat");
    document.getElementById("auth-img").checked = authOn("openloc-auth-img");
    document.getElementById("auth-agent").checked = authOn("openloc-auth-agent");
    document.getElementById("auth-tray").checked = authOn("openloc-auth-tray");
    applyNet(localStorage.getItem("openloc-web") === "1");
    if (localStorage.getItem("openloc-lan") === "1") toggleLan();
    renderApiList();
  } catch (e) {}
  try {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onScheme = function() { if (themeMode === "system") setTheme("system"); };
    if (mq.addEventListener) mq.addEventListener("change", onScheme);
    else if (mq.addListener) mq.addListener(onScheme);
  } catch (e) {}
  const banner = document.getElementById("preview-banner");
  if (banner && hasTauri()) banner.hidden = true;
  const file = document.getElementById("chatfile");
  if (file) file.addEventListener("change", onChatFiles);
  const engineZip = document.getElementById("enginezip");
  if (engineZip) engineZip.addEventListener("change", async function() {
    const f = this.files && this.files[0];
    const msg = document.getElementById("engine-msg");
    this.value = "";
    if (!f) return;
    if (!hasTauri()) {
      if (msg) msg.textContent = "网页预览不会导入「" + f.name + "」。桌面版才会解压本机 zip。";
      return;
    }
    const path = f.path || "";
    if (!path) {
      if (msg) msg.textContent = "只拿到文件名「" + f.name + "」，没有完整路径，所以没有导入。";
      return;
    }
    try {
      const result = await invoke("import_engine_zip", { path: path });
      if (msg) msg.textContent = result;
      loadEngineStatus();
    } catch (e) { if (msg) msg.textContent = "没有导入：" + e; }
  });
  const importFile = document.getElementById("importfile");
  if (importFile) importFile.addEventListener("change", function() {
    const f = this.files && this.files[0];
    const msg = document.getElementById("importmsg");
    if (!f) return;
    const path = f.path || "";
    if (path) { document.getElementById("importpath").value = path; importModel(); }
    else if (msg) msg.textContent = "只拿到文件名「" + f.name + "」，没有完整路径，所以没有导入。请把路径填在输入框里，或用桌面版。";
    this.value = "";
  });
  // 先让窗口画出概览，再去读硬件、模型和引擎。这些调用在主线程上会把窗口冻住。
  const startShellWork = function() {
    loadImgModels();
    loadHw();
    loadModels();
    loadEngineStatus();
    loadStorageDirs();
    loadFfmpegNote();
    readSessions();
    renderSessions();
    refreshImgEmpty();
    refreshVidEmpty();
    setInterval(function() { refreshChatModel(); }, 4000);
    const listen = window.__TAURI__ && window.__TAURI__.event && window.__TAURI__.event.listen;
    if (typeof listen === "function") {
      listen("openloc-probe", function(ev) {
        const payload = ev && ev.payload ? ev.payload : ev;
        paintProbe(payload);
      });
      listen("openloc-download", function(ev) {
        const payload = ev && ev.payload ? ev.payload : ev;
        paintDownload(payload);
      });
    }
  };
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(function() { requestAnimationFrame(startShellWork); });
  } else {
    setTimeout(startShellWork, 0);
  }
})();
