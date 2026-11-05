// Tauri 2 withGlobalTauri: use the injected global API, no bundler needed.
const invoke = (...args) => window.__TAURI__.core.invoke(...args);
let catalogCache = [];
let catFilter = 'fit';
let runCtx = 'auto';
let webOn = false;
function getPort() { try { return parseInt(localStorage.getItem('openloc-port') || '8080'); } catch (e) { return 8080; } }
window.tab = function(id, btn) {
  document.querySelectorAll(".tab").forEach(t => t.classList.remove("on"));
  document.getElementById(id).classList.add("on");
  document.querySelectorAll("nav button").forEach(b => b.classList.remove("on"));
  if (btn) btn.classList.add("on");
  if (id === "cat") loadCatalog();
  if (id === "chat" || id === "img" || id === "vid" || id === "md") loadModels();
  if (id === "md") updatePlan();
  if (id === "settings") loadEngineStatus();
};
window.toggleTheme = function() {
  const cur = document.documentElement.getAttribute("data-theme") === "black" ? "black" : "light";
  setTheme(cur === "black" ? "light" : "black");
};
window.setTheme = function(v) {
  document.documentElement.setAttribute("data-theme", v === "light" ? "" : v);
  const label = v === "black" ? "切换浅色主题" : "切换黑色主题";
  const a = document.getElementById("themeBtn"); if (a) a.textContent = label;
  const b = document.getElementById("themeBtn2"); if (b) b.textContent = label;
  try { localStorage.setItem("openloc-theme", v); } catch (e) {}
};
window.loadHw = async function() {
  const h = await invoke("get_hardware");
  document.getElementById("gpu-status").textContent = "显卡状态：● " + h.gpu + (h.gpu_vram_gb ? "（" + h.gpu_vram_gb.toFixed(1) + "GB）" : "");
  const vram = h.gpu_vram_gb || 0;
  const smooth = vram >= 16 ? 14 : vram >= 8 ? 8 : vram >= 6 ? 7 : vram >= 4 ? 4 : 2;
  const best = smooth >= 8 ? "Qwen 2.5 7B（约 4.7GB，当前最佳匹配）" : smooth >= 4 ? "Qwen 2.5 3B 或 Gemma 4 E4B" : "Qwen 2.5 0.5B（先跑起来再说）";
  document.getElementById("rec-title").textContent = "流畅运行 " + smooth + "B 以内的模型";
  document.getElementById("rec-desc").textContent = "当前最佳匹配：" + best + "。显存不够时，模型会分到内存里跑，速度会变慢，这是正常的。";
  document.getElementById("vram-text").textContent = vram ? vram.toFixed(1) + " GB 显存" : "未检测到独立显存，走 CPU / 内存模式";
  document.getElementById("vram-bar").style.width = vram ? Math.min(100, vram / 16 * 100) + "%" : "8%";
  document.getElementById("mem-text").textContent = h.memory_total_gb.toFixed(0) + " GB，可用 " + h.memory_gb.toFixed(0) + " GB";
  document.getElementById("mem-bar").style.width = Math.max(0, Math.min(100, (1 - h.memory_gb / h.memory_total_gb) * 100)) + "%";
  document.getElementById("disk-text").textContent = "剩余 " + h.disk_free_gb.toFixed(0) + " GB" + (h.disk_total_gb ? " / 共 " + h.disk_total_gb.toFixed(0) + " GB" : "");
  document.getElementById("disk-bar").style.width = h.disk_total_gb ? Math.max(0, Math.min(100, (1 - h.disk_free_gb / h.disk_total_gb) * 100)) + "%" : "8%";
  // 硬件卡片：分行显示，不贴 JSON
  const gpuShort = h.gpu.replace("NVIDIA GeForce ", "");
  document.getElementById("hw-gpu").textContent = gpuShort;
  document.getElementById("hw-gpu-sub").textContent = vram ? vram.toFixed(1) + " GB 显存" : "未检测到独立显存";
  document.getElementById("hw-cpu").textContent = h.cpu.replace("13th Gen Intel(R) Core(TM) ", "").replace("(R)", "");
  document.getElementById("hw-cpu-sub").textContent = h.cpu_count + " 线程";
  document.getElementById("hw-mem").textContent = h.memory_total_gb.toFixed(0) + " GB";
  document.getElementById("hw-mem-sub").textContent = "可用 " + h.memory_gb.toFixed(0) + " GB";
  document.getElementById("hw-disk").textContent = "程序所在盘";
  document.getElementById("hw-disk-sub").textContent = "剩余 " + h.disk_free_gb.toFixed(0) + " GB / 共 " + (h.disk_total_gb ? h.disk_total_gb.toFixed(0) + " GB" : "未知");
  const gi = document.getElementById("gpu-info"); if (gi) gi.textContent = h.gpu + " · " + (vram ? vram.toFixed(1) + " GB" : "无独立显存") + "，自动检测，推理用 CUDA（N 卡）。";
  loadRecommended();
};
function fitLabel(fit) { if (fit.startsWith("适合")) return "流畅"; if (fit.startsWith("勉强")) return "能跑"; return "较慢"; }
window.loadRecommended = async function() {
  const el = document.getElementById("recmodels"); if (!el) return;
  try {
    const models = await invoke("get_catalog_with_fit");
    const good = models.filter(m => m.fit.startsWith("适合")).slice(0, 3);
    const list = good.length ? good : models.slice(0, 3);
    el.innerHTML = list.map(m => `<div class="mcard"><div class="mtitle"><b>${m.name}</b><span class="pill-fit">${fitLabel(m.fit)}</span></div><div class="mdesc">${m.desc}</div><div class="mmeta">${m.params} ｜ ${m.fit}</div><button onclick="showFiles('${m.repo}')">查看量化文件并下载</button></div>`).join("");
  } catch (e) { el.textContent = "失败：" + e; }
};
window.loadCatalog = async function() {
  const el = document.getElementById("catalog");
  el.textContent = "加载中…";
  try {
    const models = await invoke("get_catalog_with_fit");
    catalogCache = models;
    renderCatalog();
  } catch (e) { el.textContent = "失败：" + e; }
};
function renderCatalog() {
  const el = document.getElementById("catalog");
  let list = catalogCache;
  if (catFilter === 'fit') list = list.filter(m => m.fit.startsWith("适合"));
  else if (catFilter !== 'all') list = list.filter(m => m.cat === catFilter);
  el.innerHTML = list.length ? list.map(m => `<div class="mcard"><div class="mtitle"><b>${m.name}</b><span>${m.params}</span></div><div class="mdesc">${m.desc}</div><div class="mmeta">${m.cat} ｜ 仓库 ${m.repo} ｜ ${m.fit}</div><div class="bar"><div class="fill teal" style="width:${fitLabel(m.fit) === '流畅' ? 90 : fitLabel(m.fit) === '能跑' ? 55 : 25}%"></div></div><div class="row"><span class="pill-fit">${fitLabel(m.fit)}</span><button onclick="showFiles('${m.repo}')">查看量化文件并下载</button></div></div>`).join("") : "这个筛选下没有模型，换个筛选试试。";
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
      return `<div class="mcard"><div class="mtitle"><b>${m.name}</b><span>${quant} · ${m.size_gb.toFixed(1)} GB</span></div><div class="row"><span class="pill-fit">${fit}</span><div class="bar" style="flex:1"><div class="fill teal" style="width:${pct}%"></div></div></div><div class="row"><button class="sec" onclick="openModelFolder('${m.name}')">打开位置</button><button class="sec" onclick="delModel('${m.name}')">删除</button><button onclick="runInstalled('${m.name}')">运行</button></div></div>`;
    }).join("") : "还没有已安装模型，去推荐模型页下一个，或在下面导入。";
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
  document.getElementById("imgmodels").innerHTML = models.map(m => `<div class="mcard"><div class="mtitle"><b>${m[0]}</b><span>${m[1]} · ${m[2]}</span></div><div class="mdesc">${m[3]}</div><div class="mmeta">量化：${m[4]} ｜ 共 ${m[5]}</div><div class="row"><span class="pill-fit">${m[6]}</span><span class="muted small">${m[7]}</span><button onclick="searchHfName('${m[0]}')">在 HuggingFace 搜这个模型</button></div><p class="muted small">大小为约数，以官方仓库为准。</p></div>`).join("");
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
window.dl = async function(kind, url, filename) {
  try { document.getElementById("dlmsg").textContent = await invoke("download_file", { url, filename, kind }); loadEngineStatus(); }
  catch (e) { document.getElementById("dlmsg").textContent = "失败：" + e; }
};
window.loadEngineStatus = async function() {
  try { const s = await invoke("engine_status"); const el = document.getElementById("engine-info"); if (el) el.textContent = "聊天引擎：" + (s.llama ? "已安装（" + s.llama + "）" : "未安装") + "；画图引擎：" + (s.sd ? "已安装" : "未安装") + "。引擎不在安装包里，第一次用时点下载，免费。"; } catch (e) {}
};
window.loadModels = async function() {
  const list = await invoke("list_local_models");
  document.getElementById("modellist") && (document.getElementById("modellist").innerHTML = list.map(m => `<li>${m}</li>`).join(""));
  for (const id of ["chatmodel", "imgmodel", "vidmodel", "runmodel"]) {
    const sel = document.getElementById(id);
    if (sel) sel.innerHTML = list.map(m => `<option value="${m}">${m}</option>`).join("");
  }
  updatePlan();
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
  const m = document.getElementById("runmodel").value; if (!m) { alert("先在模型页下载或导入一个模型。"); return; }
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
    if (box.lastChild) box.lastChild.textContent = "失败：" + e;
  }
};
document.getElementById("chatin") && document.getElementById("chatin").addEventListener("keydown", function(e) {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChat(); }
});
window.genImg = async function() {
  if (!authOn("openloc-auth-img")) { alert("你没授权 OpenLoc 启动画图引擎：去设置 → 授权控制，勾上“允许启动画图 / 视频引擎”。"); return; }
  try { document.getElementById("imgmsg").textContent = await invoke("generate_image", { model: document.getElementById("imgmodel").value, prompt: document.getElementById("imgprompt").value, steps: parseInt(document.getElementById("imgsteps").value), width: 512, height: 512 }); }
  catch (e) { document.getElementById("imgmsg").textContent = "失败：" + e; }
};
window.genMotion = async function() {
  try { document.getElementById("vidmsg").textContent = await invoke("generate_motion_video", { image: document.getElementById("vidimg").value, seconds: 3 }); }
  catch (e) { document.getElementById("vidmsg").textContent = "失败：" + e; }
};
window.genVid = async function() {
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
(function() {
  try {
    const v = localStorage.getItem("openloc-theme") || "light"; setTheme(v);
    const p = localStorage.getItem("openloc-port"); if (p) document.getElementById("apiport").value = p;
    const l = localStorage.getItem("openloc-lang"); if (l) document.getElementById("langSel").value = l;
    document.getElementById("auth-chat").checked = authOn("openloc-auth-chat");
    document.getElementById("auth-img").checked = authOn("openloc-auth-img");
    document.getElementById("auth-agent").checked = authOn("openloc-auth-agent");
    document.getElementById("auth-tray").checked = authOn("openloc-auth-tray");
  } catch (e) {}
  loadHw(); loadModels();
})();
