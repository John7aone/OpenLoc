// Tauri 2 withGlobalTauri: use the injected global API, no bundler needed.
const invoke = (...args) => window.__TAURI__.core.invoke(...args);
let catalogCache = [];
let catFilter = 'fit';
let runCtx = 'auto';
let webOn = false;
let chatAttachments = [];
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
    if (a.mode) {
      const mode = document.createElement("span");
      mode.className = "attach-mode";
      mode.textContent = a.mode === "region" ? "选区" : "整屏";
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
  const btn = document.getElementById("netBtn");
  const label = document.getElementById("netLabel");
  if (btn) btn.setAttribute("aria-checked", webOn ? "true" : "false");
  if (label) label.textContent = webOn ? "允许联网" : "本机运行 · 不联网";
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
  document.getElementById("rec-title").textContent = "流畅运行 " + smooth + "B 以内的模型";
  document.getElementById("rec-desc").textContent = "推荐按显存算，不是按内存算：模型能放进显存才流畅，放不进显存只能分到内存，速度会变慢。右边的推荐里，标“流畅”的才能放进你的显存。";
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
function fitLabel(fit) { if (fit.startsWith("流畅")) return "流畅"; if (fit.startsWith("能跑")) return "能跑"; return "较慢"; }
window.loadRecommended = async function() {
  const el = document.getElementById("recmodels"); if (!el) return;
  try {
    const models = await invoke("get_catalog_with_fit");
    const good = models.filter(m => m.fit.startsWith("流畅")).slice(0, 3);
    const list = good.length ? good : models.slice(0, 3);
    const top = list[0];
    el.innerHTML = `<div class="feat"><div class="row"><b style="font-size:18px">${top.name}</b><span class="pill-fit">${fitLabel(top.fit)}</span><span class="muted small">主推</span></div><div class="mdesc">${top.desc}</div><div class="statrow"><div class="stat"><div class="k">参数</div><div class="v">${top.params}</div></div><div class="stat"><div class="k">适合程度</div><div class="v">${top.fit}</div></div><div class="stat"><div class="k">来源</div><div class="v">${top.repo}</div></div></div><button onclick="showFiles('${top.repo}')">查看量化文件并下载</button></div>` + list.slice(1).map(m => `<div class="modelrow"><div class="mleft"><div class="mtitle"><b>${m.name}</b><span class="pill-fit">${fitLabel(m.fit)}</span></div><div class="mdesc">${m.desc}</div><div class="mmeta">${m.params} ｜ ${m.fit}</div></div><div class="mright"><div class="bar"><div class="fill teal" style="width:${fitLabel(m.fit) === '流畅' ? 90 : 55}%"></div></div><button onclick="showFiles('${m.repo}')">查看量化文件并下载</button></div></div>`).join("");
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
window.dl = async function(kind, url, filename) {
  try { document.getElementById("dlmsg").textContent = await invoke("download_file", { url, filename, kind }); loadEngineStatus(); }
  catch (e) { document.getElementById("dlmsg").textContent = "失败：" + e; }
};
window.loadEngineStatus = async function() {
  try { const s = await invoke("engine_status"); const el = document.getElementById("engine-info"); if (el) el.textContent = "聊天引擎：" + (s.llama ? "已安装（" + s.llama + "）" : "未安装") + "；画图引擎：" + (s.sd ? "已安装" : "未安装") + "。引擎不在安装包里，第一次用时点下载，免费。"; } catch (e) {}
};
async function refreshChatModel() {
  const dot = document.getElementById("modelDot");
  if (!dot) return;
  if (!hasTauri()) {
    dot.classList.remove("on");
    dot.title = "本地模型未启动";
    return;
  }
  try {
    const s = await invoke("get_chat_status");
    const on = !!s.running;
    dot.classList.toggle("on", on);
    dot.title = on ? "本地模型运行中" : "本地模型未启动";
    const sel = document.getElementById("chatmodel");
    if (sel && on && s.model && [...sel.options].some((o) => o.value === s.model)) sel.value = s.model;
  } catch (e) {
    dot.classList.remove("on");
    dot.title = "本地模型未启动";
  }
}
window.loadModels = async function() {
  let list;
  try { list = await invoke("list_local_models"); }
  catch (e) {
    const chatSel = document.getElementById("chatmodel");
    if (chatSel && chatSel.options.length === 0) chatSel.innerHTML = '<option value="">本地模型：还没有启动</option>';
    refreshChatModel();
    return;
  }
  const ml = document.getElementById("modellist");
  if (ml) ml.innerHTML = list.map((m) => `<li>${escHtml(m)}</li>`).join("");
  const chatSel = document.getElementById("chatmodel");
  if (chatSel) {
    const prev = chatSel.value;
    chatSel.innerHTML = '<option value="">本地模型：还没有启动</option>' + list.map((m) => `<option value="${escHtml(m)}">${escHtml(m)}</option>`).join("");
    chatSel.value = prev && list.includes(prev) ? prev : "";
  }
  for (const id of ["imgmodel", "vidmodel", "runmodel"]) {
    const sel = document.getElementById(id);
    if (sel) sel.innerHTML = list.map((m) => `<option value="${escHtml(m)}">${escHtml(m)}</option>`).join("");
  }
  refreshChatModel();
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
  applyNet(!webOn);
  if (webOn) {
    setComposerNote(hasTauri()
      ? "已记下「允许联网」。发送时会尝试检索；失败会说明原因，不会编造搜索结果。"
      : "已记下「允许联网」。网页预览没有联网检索，发送时不会附带搜索结果。");
  } else {
    setComposerNote("已切换为「本机运行 · 不联网」。发送时不会检索。");
  }
};
window.pickAttach = function() {
  const input = document.getElementById("chatfile");
  if (input) input.click();
};
window.captureForChat = async function() {
  if (!hasTauri()) {
    setComposerNote("网页预览不可截屏，桌面版可用。没有贴上图片。");
    return;
  }
  setComposerNote("正在打开截屏…");
  try {
    const shot = await invoke("capture_chat_image");
    if (!shot || !shot.name || !shot.path) {
      setComposerNote("没有贴上图片。桌面版没有返回截图文件。");
      return;
    }
    chatAttachments.push({
      name: shot.name,
      kind: "image",
      url: "",
      path: shot.path,
      mode: shot.mode === "region" ? "region" : "screen",
      source: "screenshot",
    });
    renderAttachments();
    const how = shot.mode === "region" ? "系统选区" : "整屏";
    setComposerNote("已把" + how + "截图加入当前对话附件（" + shot.name + "）。图片留在本机，没有上传。");
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
window.sendChat = async function() {
  const raw = document.getElementById("chatin").value.trim();
  const atts = chatAttachments.slice();
  if (!raw && !atts.length) return;
  document.getElementById("chatin").value = "";
  setComposerNote("");
  const names = atts.map((a) => a.name).join("、");
  let shown = raw;
  if (atts.length) {
    const tail = "（本机附件：" + names + "。只留在这条对话里，没有上传；本地模型目前只接收文字。）";
    shown = raw ? raw + "\n" + tail : tail;
  }
  addMsg("user", shown);
  clearAttachments();
  if (!raw) {
    addMsg("ai", "附件已记在上面。没有文字问题，这次没有发给模型，也没有把图片当成已识别的内容。");
    return;
  }
  let ask = raw;
  if (atts.length) ask += "\n（用户在本机附了文件，当前接口只接收文字，你看不到文件内容：" + names + "）";
  if (webOn) {
    if (!hasTauri()) {
      addMsg("ai", "已记录「允许联网」。网页预览没有接上联网检索，本次没有搜索结果，也不会编造。");
    } else {
      try {
        const res = await invoke("web_search", { query: raw });
        const empty = !res || res.indexOf("没搜到") === 0;
        if (empty) {
          addMsg("ai", "联网检索没有返回可用结果。本次只把原问题发给本地模型，不附带搜索摘要。");
        } else {
          addMsg("ai", "联网检索结果（下面是检索返回的内容，不是模型编造）：\n" + res);
          ask = "联网搜索结果（仅供参考，回答时以这些结果为准，不要编造更新的信息）：\n" + res + "\n\n用户问题：" + ask;
        }
      } catch (e) {
        addMsg("ai", "联网检索没有接上（" + e + "）。已记录「允许联网」偏好，本次不附带搜索结果。");
      }
    }
  }
  if (!hasTauri()) {
    addMsg("ai", "网页预览没有本地模型。请在桌面版的「运行」页启动后再发。这次没有生成回复。");
    return;
  }
  const pending = addMsg("ai", "思考中…");
  try {
    const r = await invoke("chat_ask", { message: ask });
    pending.textContent = r ? "AI：" + r : "AI：（本地模型返回了空内容）";
  } catch (e) {
    pending.textContent = "本地模型没有回应：" + e + "。没有编造回复。";
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
window.newChat = function() {
  const box = document.getElementById("chatbox");
  box.querySelectorAll(".msg-user,.msg-ai").forEach((n) => n.remove());
  const empty = document.getElementById("chat-empty");
  if (empty) empty.hidden = false;
  document.getElementById("chatin").value = "";
  clearAttachments();
  setComposerNote("");
};
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
    applyNet(localStorage.getItem("openloc-web") === "1");
  } catch (e) {}
  const file = document.getElementById("chatfile");
  if (file) file.addEventListener("change", onChatFiles);
  loadHw(); loadModels();
})();
