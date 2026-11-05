// Tauri 2 withGlobalTauri: use the injected global API, no bundler needed.
const invoke = (...args) => window.__TAURI__.core.invoke(...args);
window.tab = function(id, btn) {
  document.querySelectorAll(".tab").forEach(t => t.classList.remove("on"));
  document.getElementById(id).classList.add("on");
  document.querySelectorAll("nav button").forEach(b => b.classList.remove("on"));
  if (btn) btn.classList.add("on");
  if (id === "cat") loadCatalog();
  if (id === "chat" || id === "img" || id === "vid") loadModels();
};
window.setTheme = function(v) {
  document.documentElement.setAttribute("data-theme", v === "light" ? "" : v);
  const a = document.getElementById("theme"); if (a) a.value = v;
  const b = document.getElementById("theme2"); if (b) b.value = v;
  try { localStorage.setItem("openloc-theme", v); } catch (e) {}
};
window.loadHw = async function() {
  const h = await invoke("get_hardware");
  document.getElementById("hwout").textContent = JSON.stringify(h, null, 2);
  document.getElementById("gpu-status").textContent = "显卡状态：● " + h.gpu + (h.gpu_vram_gb ? "（" + h.gpu_vram_gb.toFixed(1) + "GB）" : "");
  const vram = h.gpu_vram_gb || 0;
  const smooth = vram >= 16 ? 14 : vram >= 8 ? 8 : vram >= 6 ? 7 : vram >= 4 ? 4 : 2;
  const best = smooth >= 8 ? "Qwen 2.5 7B（约 4.7GB，当前最佳匹配）" : smooth >= 4 ? "Qwen 2.5 3B 或 Gemma 4 E4B" : "Qwen 2.5 0.5B（先跑起来再说）";
  document.getElementById("rec-title").textContent = "流畅运行 " + smooth + "B 以内的模型";
  document.getElementById("rec-desc").textContent = "当前最佳匹配：" + best + "。显存不够时，模型会分到内存里跑，速度会变慢，这是正常的。";
  document.getElementById("vram-text").textContent = vram ? vram.toFixed(1) + " GB 显存" : "未检测到独立显存，走 CPU / 内存模式";
  document.getElementById("vram-bar").style.width = vram ? "100%" : "8%";
  const memUsed = h.memory_total_gb ? Math.max(0, Math.min(100, (1 - h.memory_gb / h.memory_total_gb) * 100)) : 0;
  document.getElementById("mem-text").textContent = h.memory_total_gb.toFixed(0) + " GB，可用 " + h.memory_gb.toFixed(0) + " GB";
  document.getElementById("mem-bar").style.width = memUsed + "%";
  document.getElementById("disk-text").textContent = "剩余 " + h.disk_free_gb.toFixed(0) + " GB" + (h.disk_total_gb ? " / 共 " + h.disk_total_gb.toFixed(0) + " GB" : "");
  const diskUsed = h.disk_total_gb ? Math.max(0, Math.min(100, (1 - h.disk_free_gb / h.disk_total_gb) * 100)) : 0;
  document.getElementById("disk-bar").style.width = diskUsed + "%";
};
window.loadCatalog = async function() {
  const el = document.getElementById("catalog");
  el.textContent = "加载中…";
  try {
    const models = await invoke("get_catalog_with_fit");
    el.innerHTML = models.map(m => `<div style="border-bottom:1px solid #ddd;padding:8px 0"><b>${m.name}</b> ${m.params}<br><span class="muted">${m.desc}</span><br><span class="muted">仓库 ${m.repo} ｜ ${m.fit}</span><br><button onclick="showFiles('${m.repo}')">查看量化文件并下载</button></div>`).join("");
  } catch (e) { el.textContent = "失败：" + e; }
};
window.showFiles = async function(repo) {
  const el = document.getElementById("catfiles");
  el.textContent = "查询 HuggingFace 文件列表中…";
  try {
    const files = await invoke("list_hf_files", { repo });
    el.innerHTML = "<b>" + repo + "</b><br>" + files.map(f => `${f} <button onclick="dlCat('${repo}','${f}')">下载</button>`).join("<br>"); const hf = document.getElementById("hfres"); if (hf) hf.innerHTML = el.innerHTML;
  } catch (e) { el.textContent = "失败：" + e; }
};
window.dlCat = async function(repo, f) {
  await invoke("download_file", { url: `https://huggingface.co/${repo}/resolve/main/${f}`, filename: f, kind: "model" });
  alert("已开始下载 " + f);
};
window.dl = async function(kind, url, filename) {
  try { document.getElementById("dlmsg").textContent = await invoke("download_file", { url, filename, kind }); }
  catch (e) { document.getElementById("dlmsg").textContent = "失败：" + e; }
};
window.loadModels = async function() {
  const list = await invoke("list_local_models");
  document.getElementById("modellist").innerHTML = list.map(m => `<li>${m}</li>`).join("");
  for (const id of ["chatmodel", "imgmodel", "vidmodel", "runmodel"]) {
    const sel = document.getElementById(id);
    if (sel) sel.innerHTML = list.map(m => `<option value="${m}">${m}</option>`).join("");
  }
};
window.importModel = async function() {
  try { document.getElementById("importmsg").textContent = await invoke("import_model", { path: document.getElementById("importpath").value }); loadModels(); }
  catch (e) { document.getElementById("importmsg").textContent = "失败：" + e; }
};
window.startChat = async function() {
  try { alert(await invoke("start_chat", { model: document.getElementById("chatmodel").value, ctx: parseInt(document.getElementById("ctx").value) })); }
  catch (e) { alert("失败：" + e); }
};
window.stopChat = async function() { alert(await invoke("stop_chat")); };
window.sendChat = async function() {
  const box = document.getElementById("chatbox");
  const msg = document.getElementById("chatin").value;
  box.textContent += "\n你：" + msg + "\n思考中…";
  try { const r = await invoke("chat_ask", { message: msg }); box.textContent += "\nAI：" + r + "\n"; }
  catch (e) { box.textContent += "\n失败：" + e + "\n"; }
};
window.genImg = async function() {
  try { document.getElementById("imgmsg").textContent = await invoke("generate_image", { model: document.getElementById("imgmodel").value, prompt: document.getElementById("imgprompt").value, steps: parseInt(document.getElementById("imgsteps").value), width: 512, height: 512 }); }
  catch (e) { document.getElementById("imgmsg").textContent = "失败：" + e; }
};
window.genMotion = async function() {
  try { document.getElementById("vidmsg").textContent = await invoke("generate_motion_video", { image: document.getElementById("vidimg").value, seconds: 3 }); }
  catch (e) { document.getElementById("vidmsg").textContent = "失败：" + e; }
};
window.genVid = async function() {
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
  el.textContent = "Agent 运行中…";
  try { const steps = await invoke("agent_run", { folder: document.getElementById("afolder").value, task: document.getElementById("atask").value }); el.textContent = steps.join("\n"); }
  catch (e) { el.textContent = "失败：" + e; }
};

window.catTab = function(which, btn) {
  for (const id of ["cat-rec","cat-inst","cat-img","cat-search"]) document.getElementById(id).style.display = "none";
  document.getElementById("cat-"+which).style.display = "block";
  if (which === "inst") loadInstalled();
  if (which === "img") loadImgModels();
};
window.loadInstalled = async function() {
  const el = document.getElementById("installed");
  try {
    const list = await invoke("list_local_model_info");
    el.innerHTML = list.length ? list.map(m => `<div style="border-bottom:1px solid #ddd;padding:8px 0"><b>${m.name}</b> ${m.size_gb.toFixed(1)} GB <button onclick="delModel('${m.name}')">删除</button></div>`).join("") : "还没有已安装模型，去推荐模型页下一个，或在运行页导入。";
  } catch (e) { el.textContent = "失败：" + e; }
};
window.delModel = async function(name) {
  if (!confirm("确定删除 " + name + " 吗？")) return;
  try { alert(await invoke("delete_model", { name })); loadInstalled(); } catch (e) { alert("失败：" + e); }
};
window.loadImgModels = function() {
  const models = [
    ["Z-Image Turbo", "通义出品，速度快，8 步出图，中文提示词友好，适合先跑起来试手。"],
    ["Qwen-Image", "Qwen 出品，画面里的中英文字最准，适合海报、封面、带字的图。"],
    ["FLUX.1 schnell", "Black Forest Labs 出品，画质标杆，4 步出图，写实照片和插画都强，英文提示词效果最好。"],
  ];
  document.getElementById("imgmodels").innerHTML = models.map(m => `<div style="border-bottom:1px solid #ddd;padding:8px 0"><b>${m[0]}</b><br><span class="muted">${m[1]}</span><br><button onclick="searchHfName('${m[0]}')">在 HuggingFace 搜这个模型</button></div>`).join("");
};
window.searchHfName = async function(name) {
  catTab("search"); document.getElementById("hfq").value = name; searchHf();
};
window.searchHf = async function() {
  const el = document.getElementById("hfres"); el.textContent = "搜索中…";
  try {
    const repos = await invoke("search_hf", { query: document.getElementById("hfq").value });
    el.innerHTML = repos.length ? repos.map(r => `<div>${r} <button onclick="showFiles('${r}')">查看文件并下载</button></div>`).join("") : "没搜到，换个词试试。";
  } catch (e) { el.textContent = "失败：" + e; }
};
window.fillTask = function(s) { document.getElementById("atask").value = s; };
window.newChat = function() { document.getElementById("chatbox").textContent = ""; document.getElementById("chatin").value = ""; };
window.startRunModel = async function() {
  try {
    const m = document.getElementById("runmodel").value;
    const ctx = document.getElementById("runctx").value;
    const r = await invoke("start_chat", { model: m, ctx: ctx === "auto" ? 16384 : parseInt(ctx) });
    document.getElementById("runmsg").textContent = r + "（思考模式：" + (document.getElementById("thinkmode").checked ? "开" : "关") + "，仅支持思考的模型有效）";
  } catch (e) { document.getElementById("runmsg").textContent = "失败：" + e; }
};

(function() {
  try { const v = localStorage.getItem("openloc-theme") || "light"; setTheme(v); } catch (e) {}
  loadHw(); loadModels();
})();
