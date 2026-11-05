// Tauri 2 withGlobalTauri: use the injected global API, no bundler needed.
// 直接打开 src/index.html 时没有这个对象，界面仍可走查，但不能检测硬件或启动引擎。
function hasTauri() {
  return !!(window.__TAURI__ && window.__TAURI__.core && typeof window.__TAURI__.core.invoke === "function");
}
function invoke(cmd, args) {
  if (!hasTauri()) {
    const err = new Error("网页预览");
    err.web = true;
    return Promise.reject(err);
  }
  return window.__TAURI__.core.invoke(cmd, args);
}
let catalogCache = [];
let catFilter = 'fit';
let runCtx = 'auto';
let webOn = false;
const SAMPLE_REC = [
  { name: "Qwen3.5 4B", desc: "4B 小模型，普通笔记本也可以先从它入门。", params: "4B", repo: "unsloth/Qwen3.5-4B-GGUF" },
  { name: "Gemma 4 E4B", desc: "高效小模型，内存小的电脑也可以先试。", params: "E4B（高效小模型）", repo: "unsloth/gemma-4-E4B-it-GGUF" },
  { name: "Qwen3.5 9B", desc: "速度和效果比较均衡的日常选择。", params: "9B", repo: "unsloth/Qwen3.5-9B-GGUF" },
];
function getPort() { try { return parseInt(localStorage.getItem('openloc-port') || '8080'); } catch (e) { return 8080; } }
window.tab = function(id, btn) {
  const page = document.getElementById(id);
  if (!page) return;
  document.querySelectorAll(".tab").forEach(t => t.classList.remove("on"));
  page.classList.add("on");
  document.querySelectorAll("#nav button").forEach(b => {
    b.classList.remove("on");
    b.removeAttribute("aria-current");
  });
  const fromNav = btn && btn.closest && btn.closest("#nav");
  const target = fromNav ? btn : document.querySelector('#nav button[data-page="' + id + '"]');
  if (target) {
    target.classList.add("on");
    target.setAttribute("aria-current", "page");
  }
  const main = document.querySelector(".main");
  if (main) main.scrollTop = 0;
  if (id === "overview") refreshOverviewSteps();
  if (id === "cat") { loadCatalog(); refreshCatEmpty(); }
  if (id === "md") { loadModels(); loadEngineStatus(); }
  if (id === "chat") { loadModels(); refreshChatEmpty(); }
  if (id === "agent") refreshAgentEmpty();
  if (id === "img") { loadModels(); refreshImgEmpty(); }
  if (id === "vid") { loadModels(); refreshVidEmpty(); }
  if (id === "settings") loadEngineStatus();
};
function normalizeTheme(v) {
  return (v === "dark" || v === "black") ? "dark" : "light";
}
window.toggleTheme = function() {
  const cur = normalizeTheme(document.documentElement.getAttribute("data-theme"));
  setTheme(cur === "dark" ? "light" : "dark");
};
window.setTheme = function(v) {
  const theme = normalizeTheme(v);
  document.documentElement.setAttribute("data-theme", theme);
  const label = theme === "dark" ? "切换到浅色" : "切换到深色";
  for (const id of ["themeBtn", "themeBtn2"]) {
    const el = document.getElementById(id);
    if (el) el.setAttribute("aria-label", label);
  }
  try { localStorage.setItem("openloc-theme", theme); } catch (e) {}
};
function setText(id, text) { const n = document.getElementById(id); if (n) n.textContent = text; }
function showHwUnavailable(reason) {
  setText("gpu-status", reason);
  setText("hw-gpu", "未检测");
  setText("hw-gpu-sub", reason);
  setText("hw-cpu", "未检测");
  setText("hw-cpu-sub", "没有读取本机");
  setText("hw-mem", "未检测");
  setText("hw-mem-sub", "没有读取本机");
  setText("hw-disk", "未检测");
  setText("hw-disk-sub", "没有读取本机");
  setText("vram-text", "未检测");
  setText("mem-text", "未检测");
  setText("disk-text", "未检测");
  ["vram-bar", "mem-bar", "disk-bar"].forEach(id => {
    const n = document.getElementById(id);
    if (n) n.style.width = "0%";
  });
  setText("rec-title", "推荐模型（未按本机检测）");
  setText("rec-desc", reason + "。下面的例子来自公开目录，适合程度不是按你的电脑算的。桌面程序里点重新检测，会按显存重算。");
  setText("step-hw-sub", reason);
  setText("step-hw-status", "未检测");
  setText("step-hw-num", "1");
  const step = document.getElementById("step-hw");
  if (step) step.classList.remove("done");
  const gi = document.getElementById("gpu-info");
  if (gi) gi.textContent = reason + "。";
  renderRec(SAMPLE_REC, true);
}
window.loadHw = async function() {
  if (!hasTauri()) {
    showHwUnavailable("网页预览，没有检测本机硬件");
    return;
  }
  let h;
  try { h = await invoke("get_hardware"); }
  catch (e) { showHwUnavailable("没有检测到本机硬件"); return; }
  if (!h || (!h.cpu && !(h.memory_total_gb > 0))) {
    showHwUnavailable("没有检测到本机硬件");
    return;
  }
  const vram = h.gpu_vram_gb || 0;
  const noGpu = !(vram > 0);
  setText("gpu-status", "显卡：" + h.gpu + (vram ? "（" + vram.toFixed(1) + " GB）" : "（无独立显存）"));
  const smooth = vram >= 16 ? 14 : vram >= 8 ? 8 : vram >= 6 ? 7 : vram >= 4 ? 4 : 2;
  if (noGpu) {
    setText("rec-title", "没检测到独立显存，先用小模型");
    setText("rec-desc", "没有读到独立显卡。下面的“流畅 / 能跑”按内存粗算，放不进显存就会分到内存，速度会慢。");
  } else {
    setText("rec-title", "流畅运行 " + smooth + "B 以内的模型");
    setText("rec-desc", "推荐按显存算，不是按内存算：模型能放进显存才流畅，放不进显存只能分到内存，速度会变慢。右边的推荐里，标“流畅”的才能放进你的显存。");
  }
  setText("vram-text", vram ? vram.toFixed(1) + " GB 显存" : "未检测到独立显存，走 CPU / 内存模式");
  document.getElementById("vram-bar").style.width = vram ? Math.min(100, vram / 16 * 100) + "%" : "0%";
  setText("mem-text", h.memory_total_gb.toFixed(0) + " GB，可用 " + h.memory_gb.toFixed(0) + " GB");
  document.getElementById("mem-bar").style.width = Math.max(0, Math.min(100, (1 - h.memory_gb / Math.max(h.memory_total_gb, 0.1)) * 100)) + "%";
  setText("disk-text", "剩余 " + h.disk_free_gb.toFixed(0) + " GB" + (h.disk_total_gb ? " / 共 " + h.disk_total_gb.toFixed(0) + " GB" : ""));
  document.getElementById("disk-bar").style.width = h.disk_total_gb ? Math.max(0, Math.min(100, (1 - h.disk_free_gb / h.disk_total_gb) * 100)) + "%" : "0%";
  const gpuShort = (h.gpu || "").replace("NVIDIA GeForce ", "");
  setText("hw-gpu", gpuShort || "未检测到显卡");
  setText("hw-gpu-sub", vram ? vram.toFixed(1) + " GB 显存" : "未检测到独立显存");
  setText("hw-cpu", (h.cpu || "").replace("13th Gen Intel(R) Core(TM) ", "").replace("(R)", "") || "未检测到处理器");
  setText("hw-cpu-sub", h.cpu_count + " 线程");
  setText("hw-mem", h.memory_total_gb.toFixed(0) + " GB");
  setText("hw-mem-sub", "可用 " + h.memory_gb.toFixed(0) + " GB");
  setText("hw-disk", "程序所在盘");
  setText("hw-disk-sub", "剩余 " + h.disk_free_gb.toFixed(0) + " GB / 共 " + (h.disk_total_gb ? h.disk_total_gb.toFixed(0) + " GB" : "未知"));
  const gi = document.getElementById("gpu-info");
  if (gi) gi.textContent = h.gpu + " · " + (vram ? vram.toFixed(1) + " GB" : "无独立显存") + "。这是本机检测结果。";
  const step = document.getElementById("step-hw");
  if (step) step.classList.add("done");
  setText("step-hw-num", "✓");
  setText("step-hw-status", noGpu ? "无独立显卡" : "已检测");
  setText("step-hw-sub", noGpu ? "已读到本机，没有独立显存，可以走 CPU / 内存" : "已读到本机显卡");
  await loadRecommended();
};
function fitLabel(fit) { if (!fit || fit === "未检测") return "未检测"; if (fit.startsWith("流畅")) return "流畅"; if (fit.startsWith("能跑")) return "能跑"; return "较慢"; }
function recButton(m, unknown) {
  if (unknown) return `<button type="button" onclick="tab('cat')">去模型</button>`;
  return `<button type="button" onclick="showFiles('${m.repo}')">查看量化文件并下载</button>`;
}
function renderRec(models, unknown) {
  const el = document.getElementById("recmodels");
  if (!el) return;
  if (!models || !models.length) {
    el.innerHTML = "<p class=\"muted\">没有可展示的推荐。</p>";
    return;
  }
  const note = unknown ? `<p class="muted small">下面是公开目录里的例子。适合程度标「未检测」，不是按这台电脑算的。</p>` : "";
  const top = models[0];
  const pill = fitLabel(unknown ? "未检测" : top.fit);
  const pillClass = unknown ? "pill-unknown" : "pill-fit";
  const rest = models.slice(1).map(m => {
    const p = fitLabel(unknown ? "未检测" : m.fit);
    const pc = unknown ? "pill-unknown" : "pill-fit";
    const bar = unknown ? "" : `<div class="bar"><div class="fill teal" style="width:${p === "流畅" ? 90 : 55}%"></div></div>`;
    const meta = unknown ? m.params : (m.params + " ｜ " + m.fit);
    return `<div class="modelrow"><div class="mleft"><div class="mtitle"><b>${m.name}</b><span class="${pc}">${p}</span></div><div class="mdesc">${m.desc}</div><div class="mmeta">${meta}</div></div><div class="mright">${bar}${recButton(m, unknown)}</div></div>`;
  }).join("");
  el.innerHTML = note + `<div class="feat"><div class="row"><b>${top.name}</b><span class="${pillClass}">${pill}</span><span class="muted small">${unknown ? "目录示例" : "主推"}</span></div><div class="mdesc">${top.desc}</div><div class="statrow"><div class="stat"><div class="k">参数</div><div class="v">${top.params}</div></div><div class="stat"><div class="k">适合程度</div><div class="v">${unknown ? "未检测" : top.fit}</div></div><div class="stat"><div class="k">来源</div><div class="v">${top.repo}</div></div></div>${recButton(top, unknown)}</div>` + rest;
}
window.loadRecommended = async function() {
  const el = document.getElementById("recmodels"); if (!el) return;
  if (!hasTauri()) { renderRec(SAMPLE_REC, true); return; }
  try {
    const models = await invoke("get_catalog_with_fit");
    const good = models.filter(m => m.fit && m.fit.startsWith("流畅")).slice(0, 3);
    const list = good.length ? good : models.slice(0, 3);
    renderRec(list, false);
  } catch (e) {
    setText("rec-title", "目录没加载，下面不是按本机推荐");
    renderRec(SAMPLE_REC, true);
  }
};
window.loadCatalog = async function() {
  const el = document.getElementById("catalog");
  el.textContent = "加载中…";
  try {
    const models = await invoke("get_catalog_with_fit");
    catalogCache = models;
    renderCatalog();
  } catch (e) { el.textContent = !hasTauri() ? "网页预览加载不了模型目录。桌面程序里这里可以查看 Hugging Face 文件并下载。" : ("目录加载失败：" + e); }
};
function renderCatalog() {
  const el = document.getElementById("catalog");
  let list = catalogCache;
  if (catFilter === 'fit') list = list.filter(m => m.fit.startsWith("流畅"));
  else if (catFilter !== 'all') list = list.filter(m => m.cat === catFilter);
  el.innerHTML = list.length ? list.map(m => `<div class="modelrow"><div class="mleft"><div class="mtitle"><b>${m.name}</b><span class="pill-fit">${fitLabel(m.fit)}</span></div><div class="mdesc">${m.desc}</div><div class="mmeta">${m.cat} ｜ ${m.params} ｜ 仓库 ${m.repo} ｜ ${m.fit}</div></div><div class="mright"><div class="bar"><div class="fill teal" style="width:${fitLabel(m.fit) === '流畅' ? 90 : fitLabel(m.fit) === '能跑' ? 55 : 25}%"></div></div><button onclick="showFiles('${m.repo}')">查看量化文件并下载</button></div></div>`).join("") : "这个筛选下没有模型，换个筛选试试。";
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
  catTab('inst', document.getElementById('sub-inst'));
  const p = prompt("输入要导入的模型完整路径，例如 C:\\Models\\qwen.gguf");
  if (p) { document.getElementById("importpath").value = p; importModel(); }
};
window.loadInstalled = async function() {
  const el = document.getElementById("installed");
  try {
    const list = await invoke("list_local_model_info");
    const h = await invoke("get_hardware");
    el.innerHTML = list.length ? list.map(m => {
      const quant = (m.name.match(/Q\d+_[A-Z0-9_]+/i) || [""])[0] || "—";
      const fit = m.size_gb <= (h.gpu_vram_gb || 0) ? "流畅" : m.size_gb <= h.memory_total_gb ? "能跑" : "较慢";
      const pct = Math.min(100, m.size_gb / Math.max(1, h.gpu_vram_gb || 8) * 100);
      return `<div class="modelrow"><div class="mleft"><div class="mtitle"><b>${m.name}</b><span class="pill-fit">${fit}</span></div><div class="mmeta">${quant} · ${m.size_gb.toFixed(1)} GB</div><div class="bar"><div class="fill teal" style="width:${pct}%"></div></div></div><div class="mright"><button class="sec" onclick="openModelFolder('${m.name}')">打开位置</button><button class="sec" onclick="delModel('${m.name}')">删除</button><button onclick="runInstalled('${m.name}')">运行</button></div></div>`;
    }).join("") : "<p class=\"muted\">已安装列表是空的。</p>";
  } catch (e) { el.textContent = "失败：" + e; }
};
window.runInstalled = function(name) {
  tab('md'); const sel = document.getElementById("runmodel");
  if (sel) { sel.value = name; updatePlan(); }
};
window.openModelFolder = async function(name) {
  try { await invoke("open_folder", { path: name }); } catch (e) { alert("失败：" + e); }
};
window.openModelsFolder = async function() { try { await invoke("open_folder", { path: "data/models" }); } catch (e) { alert("失败：" + e); } };
window.openDataFolder = async function() { try { await invoke("open_folder", { path: "data" }); } catch (e) { alert("失败：" + e); } };
window.delModel = async function(name) {
  if (!confirm("确定删除 " + name + " 吗？")) return;
  try { alert(await invoke("delete_model", { name })); loadInstalled(); } catch (e) { alert("失败：" + e); }
};
window.loadImgModels = function() {
  const models = [
    ["Z-Image Turbo", "画图", "2025年11月发布", "阿里通义 · 速度快，8 步出图，中文提示词友好，4 GB 显存也能跑。", "本地 · vae.safetensors（推荐）", "约 2.8 GB", "流畅", "整个模型放进显存"],
    ["Qwen-Image", "画图", "2025年8月发布", "阿里 Qwen · 画面里的中文、英文文字最准，适合海报、封面、带字的图。", "Q2_K（推荐）", "约 11.2 GB", "较慢", "部分放内存，生成较慢"],
    ["FLUX.1 schnell", "画图", "2024年8月发布", "Black Forest Labs · 画质标杆，4 步出图，写实照片和插画都强，英文提示词效果最好。", "Q3_K（推荐）", "约 14.6 GB", "能跑", "文本编码器放内存"],
  ];
  document.getElementById("imgmodels").innerHTML = models.map(m => `<div class="modelrow"><div class="mleft"><div class="mtitle"><b>${m[0]}</b><span class="pill-fit">${m[6]}</span></div><div class="mdesc">${m[3]}</div><div class="mmeta">${m[1]} · ${m[2]} · 量化：${m[4]} ｜ 共 ${m[5]}（约数，以官方仓库为准）</div><div class="muted small">${m[7]}</div></div><div class="mright"><button onclick="searchHfName('${m[0]}')">在 HuggingFace 搜这个模型</button></div></div>`).join("");
};
window.searchHfName = async function(name) {
  catTab("search", document.getElementById('sub-search')); document.getElementById("hfq").value = name; searchHf();
};
window.searchHf = async function() {
  const el = document.getElementById("hfres"); el.textContent = "搜索中…";
  try {
    const repos = await invoke("search_hf", { query: document.getElementById("hfq").value });
    el.innerHTML = repos.length ? repos.map(r => `<div class="mcard"><div class="mtitle"><b>${r}</b><button onclick="showFiles('${r}')">查看文件并下载</button></div></div>`).join("") : "没搜到，换个词试试。";
  } catch (e) { el.textContent = "失败：" + e; }
};
window.showFiles = async function(repo) {
  const el = document.getElementById("catfiles");
  el.textContent = "查询 HuggingFace 文件列表中…";
  try {
    const files = await invoke("list_hf_files", { repo });
    el.innerHTML = "<b>" + repo + "</b><br>" + files.map(f => `${f} <button onclick="dlCat('${repo}','${f}')">下载</button>`).join("<br>");
    const hf = document.getElementById("hfres"); if (hf && document.getElementById("cat-search").style.display !== "none") hf.innerHTML = el.innerHTML;
  } catch (e) { el.textContent = "失败：" + e; }
};
window.dlCat = async function(repo, f) {
  await invoke("download_file", { url: `https://huggingface.co/${repo}/resolve/main/${f}`, filename: f, kind: "model" });
  alert("已开始下载 " + f);
};
window.dlLlama = function() {
  return dl("engine", document.getElementById("llamaurl").value, "llama.zip", "run-dlmsg");
};
window.dlSd = function() {
  return dl("engine", document.getElementById("sdurl").value, "sd.zip", "run-dlmsg");
};
window.dl = async function(kind, url, filename, msgId) {
  const el = document.getElementById(msgId || "dlmsg");
  if (!hasTauri()) {
    if (el) el.textContent = "网页预览不能下载。请用 npm run tauri dev 打开桌面程序，在运行页安装引擎。";
    return;
  }
  try {
    const r = await invoke("download_file", { url, filename, kind });
    if (el) el.textContent = r;
    loadEngineStatus();
    refreshOverviewSteps();
  } catch (e) { if (el) el.textContent = "失败：" + e; }
};
function engineLine(llama, sd, web) {
  if (web) return "网页预览不能安装或启动引擎，也看不到本机是否已安装。";
  const chat = llama ? "已安装" : "未安装";
  const draw = sd ? "已安装" : "未安装";
  return "聊天引擎：" + chat + "；画图 / 视频引擎：" + draw + "。在运行页安装并启动。";
}
window.loadEngineStatus = async function() {
  const apply = (t) => { setText("engine-info", t); setText("run-engine-info", t); };
  if (!hasTauri()) { apply(engineLine(null, null, true)); return; }
  try {
    const s = await invoke("engine_status");
    apply(engineLine(s.llama, s.sd, false));
  } catch (e) { apply("没读到引擎状态。可以在运行页重新安装。"); }
};
window.loadModels = async function() {
  let list = [];
  try { list = await invoke("list_local_models"); } catch (e) { list = []; }
  const modelList = document.getElementById("modellist");
  if (modelList) modelList.innerHTML = list.map(m => `<li>${m}</li>`).join("");
  for (const id of ["chatmodel", "imgmodel", "vidmodel", "runmodel"]) {
    const sel = document.getElementById(id);
    if (sel) sel.innerHTML = list.map(m => `<option value="${m}">${m}</option>`).join("");
  }
  refreshRunEmpty();
  try { await updatePlan(); } catch (e) {}
  await refreshCatEmpty();
};
window.importModel = async function() {
  try { document.getElementById("importmsg").textContent = await invoke("import_model", { path: document.getElementById("importpath").value }); loadModels(); loadInstalled(); }
  catch (e) { document.getElementById("importmsg").textContent = "失败：" + e; }
};
window.setCtx = function(v, btn) {
  runCtx = v;
  document.querySelectorAll("#ctxpills button").forEach(b => b.classList.remove("on"));
  if (btn) btn.classList.add("on");
  document.getElementById("ctx-now").textContent = v === 'auto' ? '自动' : (v/1024) + 'K';
  updatePlan();
};
window.updatePlan = async function() {
  const sel = document.getElementById("runmodel"); if (!sel || !sel.value) return;
  try {
    const list = await invoke("list_local_model_info");
    const m = list.find(x => x.name === sel.value);
    const h = await invoke("get_hardware");
    if (!m) return;
    const vram = h.gpu_vram_gb || 0;
    document.getElementById("plan-vram").textContent = "显卡 · " + h.gpu.replace("NVIDIA GeForce ", "");
    document.getElementById("plan-vram-sub").textContent = m.size_gb.toFixed(1) + " GB 模型 / " + (vram ? vram.toFixed(1) + " GB 显存" : "无独立显存");
    document.getElementById("plan-vram-bar").style.width = vram ? Math.min(100, m.size_gb / vram * 100) + "%" : "8%";
    document.getElementById("plan-mem").textContent = "内存 · " + h.memory_total_gb.toFixed(0) + " GB";
    document.getElementById("plan-mem-bar").style.width = Math.min(100, m.size_gb / h.memory_total_gb * 100) + "%";
    document.getElementById("plan-desc").textContent = m.size_gb <= vram ? "整个模型都能放进显存，速度最快。" : "模型放不进显存的部分会分到内存，速度会变慢。";
    document.getElementById("est-speed").textContent = m.size_gb <= vram ? "流畅" : "能跑";
  } catch (e) {}
};
function authOn(key) { try { return localStorage.getItem(key) !== "0"; } catch (e) { return true; } }
window.saveAuth = async function() {
  try {
    localStorage.setItem("openloc-auth-chat", document.getElementById("auth-chat").checked ? "1" : "0");
    localStorage.setItem("openloc-auth-img", document.getElementById("auth-img").checked ? "1" : "0");
    localStorage.setItem("openloc-auth-agent", document.getElementById("auth-agent").checked ? "1" : "0");
    localStorage.setItem("openloc-auth-tray", document.getElementById("auth-tray").checked ? "1" : "0");
    document.getElementById("authmsg").textContent = await invoke("set_tray_enabled", { enabled: document.getElementById("auth-tray").checked });
  } catch (e) { document.getElementById("authmsg").textContent = "保存失败：" + e; }
};
window.loadBackground = async function() {
  const el = document.getElementById("bglist"); el.textContent = "查询中…";
  try {
    const list = await invoke("list_background");
    el.innerHTML = list.length ? list.map(x => `<div class="mcard"><div class="mtitle"><b>${x.name}</b><span>PID ${x.pid} · ${x.mem_mb} MB</span></div><button class="sec" onclick="stopBg('${x.name}')">停止这个程序</button></div>`).join("") : "后台没有 OpenLoc 的程序在跑。";
  } catch (e) { el.textContent = "失败：" + e; }
};
window.stopBg = async function(name) {
  if (!confirm("确定停止 " + name + " 吗？聊天 / 画图服务会停掉。")) return;
  try { alert(await invoke("stop_process", { name })); loadBackground(); } catch (e) { alert("失败：" + e); }
};
window.startRunModel = async function() {
  if (!authOn("openloc-auth-chat")) { alert("你没授权 OpenLoc 启动聊天服务：去设置 → 授权控制，勾上“允许启动 / 停止聊天服务”。"); return; }
  const m = document.getElementById("runmodel").value; if (!m) { alert("还没选中模型。先到模型页下载或导入一个。"); return; }
  const ctx = runCtx === 'auto' ? 16384 : runCtx;
  const card = document.getElementById("startcard"); card.style.display = "block";
  document.getElementById("start-title").textContent = "正在启动 " + m;
  document.getElementById("run-state").textContent = "正在加载";
  const t0 = Date.now();
  const timer = setInterval(() => {
    const s = Math.floor((Date.now() - t0) / 1000);
    document.getElementById("start-sub").textContent = "读取模型信息 · 已用 " + s + " 秒";
    const pct = Math.min(95, Math.floor(s / 60 * 100));
    document.getElementById("start-pct").textContent = pct + "%";
    document.getElementById("start-bar").style.width = pct + "%";
    document.getElementById("start-log").textContent = s < 5 ? "准备…" : s < 20 ? "读取模型…" : s < 40 ? "分配缓存…" : "预热…";
  }, 1000);
  try {
    const r = await invoke("start_chat", { model: m, ctx: ctx, port: getPort() });
    clearInterval(timer);
    document.getElementById("start-pct").textContent = "100%";
    document.getElementById("start-bar").style.width = "100%";
    document.getElementById("start-log").textContent = "完成：" + r;
    document.getElementById("run-state").textContent = "正在运行";
    document.getElementById("startBtn").style.display = "none";
    document.getElementById("stopBtn").style.display = "inline-block";
    document.getElementById("chatBtn").style.display = "inline-block";
    document.getElementById("runmsg").textContent = r + "（思考模式：" + (document.getElementById("thinkmode").checked ? "开" : "关") + "，仅支持思考的模型有效）";
    const h = await invoke("get_hardware");
    const list = await invoke("list_local_model_info");
    const info = list.find(x => x.name === m);
    document.getElementById("runcard").style.display = "block";
    document.getElementById("run-title").textContent = "运行中 · " + m;
    document.getElementById("run-sub").textContent = "实际按空闲显存自动分配";
    document.getElementById("run-vram").textContent = (info ? info.size_gb.toFixed(1) : "—") + " GB / " + (h.gpu_vram_gb ? h.gpu_vram_gb.toFixed(1) + " GB" : "无");
    document.getElementById("run-mem").textContent = h.memory_gb.toFixed(1) + " GB / " + h.memory_total_gb.toFixed(0) + " GB";
    document.getElementById("run-api").textContent = "http://127.0.0.1:" + getPort() + "/v1";
    document.getElementById("runlog").textContent = "聊天服务已启动：" + m + "，端口 " + getPort();
  } catch (e) {
    clearInterval(timer);
    document.getElementById("runmsg").textContent = "失败：" + e;
    document.getElementById("run-state").textContent = "准备运行";
  }
};
window.stopRunModel = async function() {
  try { alert(await invoke("stop_chat")); } catch (e) { alert("失败：" + e); }
  document.getElementById("startBtn").style.display = "inline-block";
  document.getElementById("stopBtn").style.display = "none";
  document.getElementById("chatBtn").style.display = "none";
  document.getElementById("runcard").style.display = "none";
  document.getElementById("run-state").textContent = "准备运行";
};
window.copyApi = function() { const t = document.getElementById("run-api").textContent; try { navigator.clipboard.writeText(t); alert("已复制：" + t); } catch (e) { alert(t); } };
window.startChat = async function() {
  try { alert(await invoke("start_chat", { model: document.getElementById("chatmodel").value, ctx: parseInt(document.getElementById("ctx").value), port: getPort() })); }
  catch (e) { alert("失败：" + e); }
};
window.stopChat = async function() { alert(await invoke("stop_chat")); };
window.toggleNet = function() {
  webOn = !webOn;
  const label = webOn ? "本机运行 · 已联网" : "本机运行 · 不联网";
  const a = document.getElementById("netBtn"); if (a) a.textContent = label;
  const b = document.getElementById("netBtn2"); if (b) b.textContent = webOn ? "联网：开" : "联网";
};
function addMsg(role, text) {
  const box = document.getElementById("chatbox");
  const d = document.createElement("div");
  d.className = role === "user" ? "msg-user" : "msg-ai";
  d.textContent = (role === "user" ? "你：" : "AI：") + text;
  box.appendChild(d); box.scrollTop = box.scrollHeight;
}
window.sendChat = async function() {
  const msg = document.getElementById("chatin").value.trim(); if (!msg) return;
  document.getElementById("chatin").value = "";
  addMsg("user", msg);
  addMsg("ai", "思考中…");
  try {
    let ask = msg;
    if (webOn) {
      const res = await invoke("web_search", { query: msg });
      addMsg("ai", "联网搜索结果：\n" + res);
      ask = "联网搜索结果（仅供参考，回答时以这些结果为准，不要编造更新的信息）：\n" + res + "\n\n用户问题：" + msg;
    }
    const r = await invoke("chat_ask", { message: ask });
    const box = document.getElementById("chatbox");
    if (box.lastChild) box.lastChild.textContent = "AI：" + r;
  } catch (e) {
    const box = document.getElementById("chatbox");
    const msg = (!hasTauri() || (e && e.web)) ? "网页预览没有聊天服务。请用 npm run tauri dev 打开桌面程序，先在运行页启动。" : ("失败：" + e);
    if (box.lastChild) box.lastChild.textContent = msg;
  }
};
document.getElementById("chatin") && document.getElementById("chatin").addEventListener("keydown", function(e) {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChat(); }
});
window.genImg = async function() {
  if (!hasTauri()) { document.getElementById("imgmsg").textContent = "网页预览不能画图。"; return; }
  if (!authOn("openloc-auth-img")) { alert("你没授权 OpenLoc 启动画图引擎：去设置 → 授权控制，勾上“允许启动画图 / 视频引擎”。"); return; }
  try { document.getElementById("imgmsg").textContent = await invoke("generate_image", { model: document.getElementById("imgmodel").value, prompt: document.getElementById("imgprompt").value, steps: parseInt(document.getElementById("imgsteps").value), width: 512, height: 512 }); }
  catch (e) { document.getElementById("imgmsg").textContent = "失败：" + e; }
};
window.genMotion = async function() {
  if (!hasTauri()) { document.getElementById("vidmsg").textContent = "网页预览不能生成动效视频。"; return; }
  try { document.getElementById("vidmsg").textContent = await invoke("generate_motion_video", { image: document.getElementById("vidimg").value, seconds: 3 }); }
  catch (e) { document.getElementById("vidmsg").textContent = "失败：" + e; }
};
window.genVid = async function() {
  if (!hasTauri()) { document.getElementById("vidmsg").textContent = "网页预览不能生成扩散视频。"; return; }
  if (!authOn("openloc-auth-img")) { alert("你没授权 OpenLoc 启动画图 / 视频引擎：去设置 → 授权控制，勾上“允许启动画图 / 视频引擎”。"); return; }
  try { document.getElementById("vidmsg").textContent = await invoke("generate_diffusion_video", { model: document.getElementById("vidmodel").value, prompt: document.getElementById("vidprompt").value, frames: 25 }); }
  catch (e) { document.getElementById("vidmsg").textContent = "失败：" + e; }
};
window.takeShot = async function() {
  const el = document.getElementById("shotmsg");
  try { const r = await invoke("take_screenshot"); if (el) el.textContent = r; alert(r + "\n\n把这张图发给 Muse，就能帮你看问题了。"); }
  catch (e) { if (el) el.textContent = "截屏失败：" + e; alert("截屏失败：" + e); }
};
window.runAgent = async function() {
  if (!document.getElementById("afolder").value.trim()) { refreshAgentEmpty(); focusAgentFolder(); return; }
  if (!hasTauri()) { document.getElementById("asteps").textContent = "网页预览不能运行 Agent。"; return; }
  if (!authOn("openloc-auth-agent")) { alert("你没授权 Agent 跑命令：去设置 → 授权控制，勾上“允许 Agent 在工作文件夹里跑命令”。"); return; }
  const el = document.getElementById("asteps");
  el.textContent = "Agent 运行中…";
  try { const steps = await invoke("agent_run", { folder: document.getElementById("afolder").value, task: document.getElementById("atask").value }); el.textContent = steps.join("\n"); }
  catch (e) { el.textContent = "失败：" + e; }
};
window.fillTask = function(s) { document.getElementById("atask").value = s; };
window.newChat = function() { document.getElementById("chatbox").innerHTML = ""; document.getElementById("chatin").value = ""; };
window.saveLang = function(v) {
  try { localStorage.setItem("openloc-lang", v); } catch (e) {}
  document.getElementById("langmsg").textContent = v === "en" ? "界面目前只有简体中文，选 English 暂不翻译，下一版再做英文界面。" : "已保存：跟随系统（简体中文）。界面目前只有简体中文。";
};
window.savePort = function() {
  const v = parseInt(document.getElementById("apiport").value) || 8080;
  try { localStorage.setItem("openloc-port", String(v)); } catch (e) {}
  document.getElementById("portmsg").textContent = "已保存端口 " + v + "，下次启动聊天服务时生效。";
};
function setStepMark(id, done, n) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.toggle("done", !!done);
  const num = el.querySelector(".num");
  if (num) num.textContent = done ? "✓" : String(n);
}
async function refreshOverviewSteps() {
  if (!hasTauri()) {
    setStepMark("step-engine", false, 2);
    setStepMark("step-model", false, 3);
    return;
  }
  try {
    const s = await invoke("engine_status");
    const ok = !!(s && (s.llama || s.sd));
    setStepMark("step-engine", ok, 2);
    setText("step-engine-sub", s && s.llama ? "聊天引擎已安装，去运行页启动" : "还没安装，去运行页安装并启动");
  } catch (e) {
    setStepMark("step-engine", false, 2);
  }
  try {
    const list = await invoke("list_local_model_info");
    const ok = !!(list && list.length);
    setStepMark("step-model", ok, 3);
    setText("step-model-sub", ok ? "本机已有模型" : "还没下载，去模型页选一个");
  } catch (e) {
    setStepMark("step-model", false, 3);
  }
}
function refreshRunEmpty() {
  const sel = document.getElementById("runmodel");
  const none = !sel || !sel.value;
  const empty = document.getElementById("md-empty");
  const body = document.getElementById("md-body");
  const text = document.getElementById("md-empty-text");
  const btn = empty && empty.querySelector("button");
  if (text) text.textContent = hasTauri() ? "还没选中要运行的模型。" : "网页预览选不了本机模型。";
  if (btn) btn.textContent = hasTauri() ? "去模型页下载" : "去模型页";
  if (empty) empty.hidden = !none;
  if (body) body.hidden = !!none;
}
async function refreshCatEmpty() {
  const box = document.getElementById("cat-empty");
  const text = document.getElementById("cat-empty-text");
  const btn = box && box.querySelector("button");
  if (!box) return;
  if (!hasTauri()) {
    box.hidden = false;
    if (text) text.textContent = "网页预览看不到本机已下载的模型。";
    if (btn) btn.textContent = "去看推荐模型";
    return;
  }
  try {
    const list = await invoke("list_local_model_info");
    const none = !list.length;
    box.hidden = !none;
    if (text) text.textContent = "还没有下载模型。";
    if (btn) btn.textContent = "去下载推荐模型";
  } catch (e) {
    box.hidden = false;
    if (text) text.textContent = "没读到本机模型列表。";
    if (btn) btn.textContent = "去看推荐模型";
  }
}
async function refreshChatEmpty() {
  const box = document.getElementById("chat-empty");
  const text = document.getElementById("chat-empty-text");
  const btn = box && box.querySelector("button");
  if (!box) return;
  if (!hasTauri()) {
    box.hidden = false;
    if (text) text.textContent = "网页预览没有聊天服务。";
    if (btn) btn.textContent = "去运行页";
    return;
  }
  try {
    const s = await invoke("get_chat_status");
    box.hidden = !!(s && s.running);
    if (text) text.textContent = "聊天服务还没启动。";
    if (btn) btn.textContent = "去运行页启动";
  } catch (e) {
    box.hidden = false;
    if (text) text.textContent = "没确认到聊天服务是否已启动。";
    if (btn) btn.textContent = "去运行页";
  }
}
function refreshAgentEmpty() {
  const box = document.getElementById("agent-empty");
  const input = document.getElementById("afolder");
  if (!box || !input) return;
  box.hidden = !!input.value.trim();
}
window.focusAgentFolder = function() {
  const input = document.getElementById("afolder");
  if (!input) return;
  input.focus();
  input.scrollIntoView({ block: "center" });
};
window.goDownloadModel = function() {
  tab("cat");
  catTab("rec", document.getElementById("sub-rec"));
  const anchor = document.getElementById("cat-rec");
  if (anchor) anchor.scrollIntoView({ block: "nearest" });
};
function isImageWeight(name) { return /\.(safetensors|ckpt)$/i.test(name || ""); }
async function refreshMediaEmpty(which) {
  const box = document.getElementById(which + "-empty");
  const text = document.getElementById(which + "-empty-text");
  const btn = document.getElementById(which + "-empty-btn");
  if (!box || !text || !btn) return;
  const noun = which === "img" ? "画图" : "视频";
  if (!hasTauri()) {
    box.hidden = false;
    text.textContent = "网页预览看不到" + noun + "引擎和模型。";
    btn.textContent = "去运行页";
    btn.onclick = function() { tab("md"); };
    return;
  }
  let sd = null;
  let infos = [];
  try { const s = await invoke("engine_status"); sd = s && s.sd; } catch (e) {}
  try { infos = await invoke("list_local_model_info"); } catch (e) { infos = []; }
  if (!sd) {
    box.hidden = false;
    text.textContent = "还没装" + noun + "引擎。";
    btn.textContent = "去运行页装引擎";
    btn.onclick = function() { tab("md"); };
    return;
  }
  if (!infos.some(m => isImageWeight(m.name))) {
    box.hidden = false;
    text.textContent = "还没下" + noun + "模型。";
    btn.textContent = "去模型页下载";
    btn.onclick = function() { tab("cat"); catTab("img", document.getElementById("sub-img")); };
    return;
  }
  box.hidden = true;
}
function refreshImgEmpty() { return refreshMediaEmpty("img"); }
function refreshVidEmpty() { return refreshMediaEmpty("vid"); }
(async function() {
  try {
    const v = localStorage.getItem("openloc-theme") || "light"; setTheme(v);
    const p = localStorage.getItem("openloc-port"); if (p) document.getElementById("apiport").value = p;
    const l = localStorage.getItem("openloc-lang"); if (l) document.getElementById("langSel").value = l;
    document.getElementById("auth-chat").checked = authOn("openloc-auth-chat");
    document.getElementById("auth-img").checked = authOn("openloc-auth-img");
    document.getElementById("auth-agent").checked = authOn("openloc-auth-agent");
    document.getElementById("auth-tray").checked = authOn("openloc-auth-tray");
  } catch (e) {}
  const folder = document.getElementById("afolder");
  if (folder) folder.addEventListener("input", refreshAgentEmpty);
  // 首次打开固定落在概览，不恢复上次页面。
  tab("overview");
  try {
    await Promise.all([loadHw(), loadModels(), refreshOverviewSteps(), loadEngineStatus(), refreshChatEmpty(), refreshImgEmpty(), refreshVidEmpty()]);
  } catch (e) {}
  refreshAgentEmpty();
  document.documentElement.setAttribute("data-ready", "1");
})();
