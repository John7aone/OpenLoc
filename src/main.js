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
function estGb(params) {
  const act = String(params).match(/约\s*([\d.]+)\s*B\s*激活/);
  if (act) return parseFloat(act[1]) * 0.6 + 2;
  const m = String(params).match(/([\d.]+)\s*B/);
  return (m ? parseFloat(m[1]) : 8) * 0.6 + 2;
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
function normalizeTheme(v) { return (v === "dark" || v === "black") ? "dark" : "light"; }
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
    markStep(false);
    paintLayer(false, "未检测", "未检测", "兜底");
    const gs = document.getElementById("gpu-status"); if (gs) gs.textContent = "显卡状态：网页预览未检测";
    ["hw-gpu","hw-cpu","hw-mem","hw-disk"].forEach((id) => { const n = document.getElementById(id); if (n) n.textContent = "未检测"; });
    ["vram-bar","mem-bar","disk-bar"].forEach((id) => { const n = document.getElementById(id); if (n) n.style.width = "0"; });
    const gi = document.getElementById("gpu-info");
    if (gi) gi.textContent = "网页预览读不到显卡。桌面版会在这里显示检测到的 NVIDIA 显卡和显存；检测不到就走 CPU / 内存，不会假装有显卡。";
    const title = document.getElementById("rec-title");
    if (title) title.textContent = "还不知道这台电脑能流畅跑多大的模型";
    const desc = document.getElementById("rec-desc");
    if (desc) desc.textContent = "网页预览没有显存数据。桌面版按显存判断：能放进显存才标流畅，放不进就分到内存，速度会变慢。";
    loadRecommended();
    return;
  }
  const vram = h.gpu_vram_gb || 0;
  const smooth = vram >= 16 ? 14 : vram >= 8 ? 8 : vram >= 6 ? 7 : vram >= 4 ? 4 : 2;
  markStep(true);
  document.getElementById("rec-title").textContent = "流畅运行 " + smooth + "B 以内的模型";
  document.getElementById("rec-desc").textContent = "推荐按显存算，不是按内存算：模型能放进显存才流畅，放不进显存只能分到内存，速度会变慢。标“流畅”的才能放进你的显存。";
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
  const gi = document.getElementById("gpu-info"); if (gi) gi.textContent = h.gpu + " · " + (vram ? vram.toFixed(1) + " GB" : "无独立显存") + "。自动检测，推理用 CUDA（N 卡）。检测不到就走 CPU / 内存。";
  loadRecommended();
};
function fitLabel(fit) {
  if (!fit || fit === "待检测") return "待检测";
  if (fit.startsWith("流畅")) return "流畅";
  if (fit.startsWith("能跑")) return "能跑";
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
  const quants = ["Q4_K_M（常用）", "Q5_K_M", "Q6_K", "Q8_0"];
  return `<article class="mc${feat ? " feat-mc" : ""}"><div><div class="mtitle"><b>${escHtml(m.name)}</b>${m.cat === "看图" ? '<span class="tag">看图</span>' : ""}<span class="muted small">${escHtml(m.params)}</span></div><p class="mdesc">${escHtml(m.desc)}</p><div class="mmeta">${escHtml(m.cat)} · ${escHtml(m.repo)}</div></div><div class="right"><div class="qrow"><select class="qsel" aria-label="${escHtml(m.name)} 的量化">${quants.map((q) => `<option>${q}</option>`).join("")}</select><span class="pill-fit${fitClass(m.fit)}">${fitLabel(m.fit)}</span></div><div class="muted small">大小以仓库为准</div><button type="button" data-repo="${escHtml(m.repo)}" onclick="askDownload(this.dataset.repo, this)">下载</button></div></article>`;
}
function paintHero(m) {
  const chip = document.getElementById("hero-chip");
  const btn = document.getElementById("hero-dl");
  if (!m) return;
  if (chip) chip.textContent = m.name + " · " + m.params;
  if (btn) btn.dataset.repo = m.repo;
}
window.askDownload = async function(repo, btn) {
  if (btn && btn.dataset && btn.dataset.repo) repo = btn.dataset.repo;
  const sel = btn && (btn.closest(".mc") || btn.closest(".hero-actions")) ? (btn.closest(".mc") || btn.parentElement).querySelector("select") : null;
  const quant = ((sel && sel.value) || "Q4_K_M").replace("（常用）", "");
  if (!repo) { setActionNote("还没有可下载的推荐。先等目录出来。"); return; }
  if (!hasTauri()) {
    setActionNote("网页预览不会下载。桌面版会到 Hugging Face 的 " + repo + " 查找 " + quant + " 量化文件，对上名字才开始拉，不会造一个假文件。");
    return;
  }
  setActionNote("正在查询 " + repo + " …");
  try {
    const files = await invoke("list_hf_files", { repo });
    const hit = files.find((f) => f.toUpperCase().includes(quant.toUpperCase())) || files[0];
    if (!hit) { setActionNote("仓库里没有找到 GGUF 文件，没有开始下载。"); return; }
    await invoke("download_file", { url: "https://huggingface.co/" + repo + "/resolve/main/" + hit, filename: hit, kind: "model" });
    setActionNote("已开始下载 " + hit + "。");
  } catch (e) { setActionNote("没有开始下载：" + e); }
};
function totalB(params) {
  const all = [...String(params).matchAll(/([\d.]+)\s*B/gi)].map((m) => parseFloat(m[1]));
  return all.length ? Math.max(...all) : 99;
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
window.loadRecommended = async function() {
  const el = document.getElementById("recmodels"); if (!el) return;
  let models;
  try { models = await invoke("get_catalog_with_fit"); }
  catch (e) { models = localModels(); }
  const list = recommendList(models);
  const judged = models.some((m) => m.fit && m.fit.startsWith("流畅"));
  const note = document.getElementById("fit-note");
  if (!list.length) { el.innerHTML = "<p class='muted'>目录是空的。</p>"; return; }
  paintHero(list[0]);
  const head = judged ? "" : "<p class='muted small'>没有本机显存数据时，这里先列出总量约 12B 及以内的目录，标签是“待检测”，不代表已经适合你的电脑。</p>";
  el.innerHTML = head + list.map((m, i) => cardHtml(m, i === 0)).join("");
  if (note && !judged) { note.hidden = false; note.textContent = "适合我的电脑：网页预览判断不了显存，筛选会暂时列出较小的模型，并标成待检测。"; }
};
window.loadCatalog = async function() {
  const el = document.getElementById("catalog");
  if (el) el.textContent = "加载中…";
  try { catalogCache = await invoke("get_catalog_with_fit"); }
  catch (e) { catalogCache = localModels(); }
  renderCatalog();
};
function renderCatalog() {
  const el = document.getElementById("catalog");
  const note = document.getElementById("fit-note");
  let list = catalogCache.slice();
  let explain = "";
  if (catFilter === "fit") {
    const good = list.filter((m) => m.fit && m.fit.startsWith("流畅"));
    if (good.length) list = good;
    else {
      list = smallerModels(list);
      explain = "没有本机显存数据，下面只列出总量约 12B 及以内的目录，不代表已经适合你的电脑。";
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
    if (tabBtn) tabBtn.textContent = "已安装（" + list.length + "）";
    const step3 = document.getElementById("step-model");
    const step3sub = document.getElementById("step-model-sub");
    if (list.length && step3) { step3.classList.add("done"); if (step3sub) step3sub.textContent = "本机已有模型"; }
    el.innerHTML = list.length ? list.map((m) => {
      const quant = (m.name.match(/Q\d+_[A-Z0-9_]+/i) || ["—"])[0];
      const fit = m.size_gb <= (h.gpu_vram_gb || 0) ? "流畅" : m.size_gb <= h.memory_total_gb ? "能跑" : "较慢";
      const pct = Math.min(100, m.size_gb / Math.max(1, h.gpu_vram_gb || 8) * 100);
      const enc = encodeURIComponent(m.name);
      return `<article class="mc"><div><div class="mtitle"><b>${escHtml(m.name)}</b><span class="pill-fit${fitClass(fit)}">${fit}</span></div><div class="mmeta">${escHtml(quant)} · ${m.size_gb.toFixed(1)} GB</div><div class="bar"><div class="fill teal" style="width:${pct}%"></div></div></div><div class="right"><div class="row"><button class="sec" type="button" onclick="openModelFolder(decodeURIComponent('${enc}'))">打开位置</button><button class="sec" type="button" onclick="delModel(decodeURIComponent('${enc}'))">删除</button><button type="button" onclick="runInstalled(decodeURIComponent('${enc}'))">运行</button></div></div></article>`;
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
window.openDataFolder = async function() {
  if (!hasTauri()) { setActionNote("网页预览打不开 data 目录。"); return; }
  try { await invoke("open_folder", { path: "data" }); } catch (e) { setActionNote("没能打开数据目录：" + e); }
};
window.chooseModelDir = function() { openModelsFolder(); };
window.checkUpdate = function() {
  const el = document.getElementById("aboutmsg");
  if (el) el.textContent = "没有在检查更新服务器。OpenLoc 这一版不联网查版本，请到项目仓库看有没有新版本。";
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
    setActionNote("网页预览不会下载「" + name + "」的主体、文本编码器和 VAE。桌面版才会按所选量化到仓库拉取整套文件。");
    return;
  }
  searchHfName(name);
};
window.searchHfName = async function(name) {
  catTab("search", document.getElementById('sub-search')); document.getElementById("hfq").value = name; searchHf();
};
window.searchHf = async function() {
  const el = document.getElementById("hfres");
  const empty = document.getElementById("hfempty");
  const q = document.getElementById("hfq").value.trim();
  if (!q) { if (empty) empty.hidden = false; el.innerHTML = ""; return; }
  if (empty) empty.hidden = true;
  if (!hasTauri()) {
    el.innerHTML = "<p class='search-empty'>网页预览不会请求 Hugging Face。桌面版会搜索「" + escHtml(q) + "」的 GGUF 仓库，搜到才列出，不会编造仓库名。</p>";
    return;
  }
  el.textContent = "搜索中…";
  try {
    const repos = await invoke("search_hf", { query: q });
    el.innerHTML = repos.length ? repos.map((r) => `<div class="mcard"><div class="mtitle"><b>${escHtml(r)}</b><button type="button" onclick="showFiles('${escHtml(r)}')">查看文件并下载</button></div></div>`).join("") : "<p class='search-empty'>没搜到，换个词试试。</p>";
  } catch (e) { el.innerHTML = "<p class='search-empty'>没有搜到：" + escHtml(e) + "</p>"; }
};
window.showFiles = async function(repo) {
  const el = document.getElementById("catfiles");
  if (!hasTauri()) { if (el) el.textContent = "网页预览不会查询 " + repo + " 的文件列表。"; return; }
  el.textContent = "查询 HuggingFace 文件列表中…";
  try {
    const files = await invoke("list_hf_files", { repo });
    el.innerHTML = "<b>" + escHtml(repo) + "</b><br>" + files.map((f) => `${escHtml(f)} <button type="button" onclick="dlCat('${escHtml(repo)}','${escHtml(f)}')">下载</button>`).join("<br>");
    const hf = document.getElementById("hfres"); if (hf && document.getElementById("cat-search").style.display !== "none") hf.innerHTML = el.innerHTML;
  } catch (e) { el.textContent = "没有查到文件：" + e; }
};
window.dlCat = async function(repo, f) {
  await invoke("download_file", { url: `https://huggingface.co/${repo}/resolve/main/${f}`, filename: f, kind: "model" });
  alert("已开始下载 " + f);
};
window.dl = async function(kind, url, filename) {
  const els = [document.getElementById("dlmsg"), document.getElementById("run-dlmsg")].filter(Boolean);
  const say = (t) => els.forEach((el) => { el.textContent = t; });
  if (!hasTauri()) { say("网页预览不会下载引擎。请在桌面版 OpenLoc 的运行页安装，免费，没有加速通道。"); return; }
  try { say(await invoke("download_file", { url, filename, kind })); loadEngineStatus(); }
  catch (e) { say("没有开始下载：" + e); }
};
window.dlLlama = function() { return dl("engine", document.getElementById("llamaurl").value, "llama.zip"); };
window.dlSd = function() { return dl("engine", document.getElementById("sdurl").value, "sd.zip"); };
window.loadEngineStatus = async function() {
  const el = document.getElementById("engine-info");
  const sub = document.getElementById("step-engine-sub");
  const step = document.getElementById("step-engine");
  const runInfo = document.getElementById("run-engine-info");
  try {
    const s = await invoke("engine_status");
    if (el) el.textContent = "聊天引擎：" + (s.llama ? "已安装（" + s.llama + "）" : "未安装") + "；画图引擎：" + (s.sd ? "已安装" : "未安装") + "。安装和启动在运行页，免费，没有加速通道。";
    if (step) step.classList.toggle("done", !!(s && s.llama));
    if (sub) sub.textContent = s && s.llama ? "聊天引擎已安装，去运行页启动" : "还没安装，去运行页安装并启动";
    if (runInfo) runInfo.textContent = (s && s.llama ? "聊天引擎已安装。" : "聊天引擎还没安装。") + (s && s.sd ? "画图引擎已安装。" : "画图引擎还没安装。") + "在这一页安装并启动。";
  } catch (e) {
    if (!hasTauri()) {
      if (el) el.textContent = "网页预览看不到本机引擎。安装和启动在运行页，桌面版才会真的下载。";
      if (sub) sub.textContent = "网页预览不能安装，去运行页看说明";
      if (runInfo) runInfo.textContent = "网页预览不会安装或启动引擎。桌面版在这一页安装 llama.cpp 和画图引擎。";
    }
  }
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
    const ad = document.getElementById("agentDot");
    if (ad) { ad.classList.toggle("on", on); ad.title = dot.title; }
    const al = document.getElementById("agentModelLabel");
    if (al) al.textContent = on && s.model ? ("本地模型：" + s.model) : "本地模型：还没有启动";
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
    if (!sel) continue;
    if (!list.length) sel.innerHTML = '<option value="">还没有已安装模型</option>';
    else sel.innerHTML = list.map((m) => `<option value="${escHtml(m)}">${escHtml(m)}</option>`).join("");
  }
  refreshChatModel();
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
window.updatePlan = async function() {
  const sel = document.getElementById("runmodel");
  const desc = document.getElementById("plan-desc");
  if (!sel || !sel.value) {
    if (desc) desc.textContent = hasTauri() ? "选一个已下载模型后，这里会算它放进显存还是内存。" : "网页预览没有已安装模型。下面三条是分层示意，长度不代表你的电脑，速度也没有实测。";
    const es = document.getElementById("est-speed"); if (es && !sel?.value) es.textContent = "待实测";
    return;
  }
  try {
    const list = await invoke("list_local_model_info");
    const m = list.find(x => x.name === sel.value);
    const h = await invoke("get_hardware");
    if (!m) return;
    const vram = h.gpu_vram_gb || 0;
    const fits = m.size_gb <= vram && vram > 0;
    document.getElementById("plan-vram").textContent = "显卡 · " + h.gpu.replace("NVIDIA GeForce ", "");
    document.getElementById("plan-vram-sub").textContent = m.size_gb.toFixed(1) + " GB 模型 / " + (vram ? vram.toFixed(1) + " GB 显存" : "无独立显存");
    document.getElementById("plan-vram-bar").style.width = vram ? Math.min(100, m.size_gb / vram * 100) + "%" : "8%";
    document.getElementById("plan-mem").textContent = "内存 · " + h.memory_total_gb.toFixed(0) + " GB";
    document.getElementById("plan-mem-bar").style.width = Math.min(100, m.size_gb / h.memory_total_gb * 100) + "%";
    const memSub = document.getElementById("plan-mem-sub"); if (memSub) memSub.textContent = fits ? "不需要" : "放不进显存的部分会到这里";
    const diskSub = document.getElementById("plan-disk-sub"); if (diskSub) diskSub.textContent = "按需读取";
    if (desc) desc.textContent = fits ? "整个模型都能放进显存。具体每秒多少 token 要等真正跑起来，这里不预填一个速度。" : "模型放不进显存的部分会分到内存，速度会变慢。具体速度待实测。";
    document.getElementById("est-speed").textContent = "待实测";
  } catch (e) {
    if (desc) desc.textContent = "没能算出分层：" + e;
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
    const lanOn = document.getElementById("lanBtn") && document.getElementById("lanBtn").getAttribute("aria-checked") === "true";
    document.getElementById("runmsg").textContent = r + "（思考模式：" + (document.getElementById("thinkmode").checked ? "开" : "关") + "，仅支持思考的模型有效）" + (lanOn ? " 已记下局域网访问，但服务仍只绑定 127.0.0.1，没有对局域网开放。" : "");
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
    setAgentNote("网页预览不可截屏，桌面版可用。没有贴上图片。");
    return;
  }
  setAgentNote("正在打开截屏…");
  try {
    const shot = await invoke("capture_chat_image");
    if (!shot || !shot.name || !shot.path) { setAgentNote("没有贴上图片。桌面版没有返回截图文件。"); return; }
    agentAttachments.push({ name: shot.name, path: shot.path, mode: shot.mode === "region" ? "region" : "screen" });
    renderAgentAttach();
    setAgentNote("已把截图记在这个任务旁（" + shot.name + "）。Agent 读不到图片内容，图片也没有上传。");
  } catch (e) { setAgentNote("没有贴上图片。" + e); }
};
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
    if (localStorage.getItem("openloc-lan") === "1") toggleLan();
  } catch (e) {}
  const banner = document.getElementById("preview-banner");
  if (banner && hasTauri()) banner.hidden = true;
  const file = document.getElementById("chatfile");
  if (file) file.addEventListener("change", onChatFiles);
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
  loadImgModels();
  loadHw(); loadModels(); loadEngineStatus();
  refreshImgEmpty(); refreshVidEmpty();
})();
