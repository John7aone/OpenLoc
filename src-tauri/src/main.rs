// OpenLoc（桌面版，原创代码）
// 架构说明：Rust + Tauri 打包成 Windows 桌面程序，窗口里跑本地 HTML/JS。
// 聊天走 llama.cpp 的 llama-server，画图走 stable-diffusion.cpp 的 sd-cli，
// 视频走 ffmpeg 动效或 sd-cli 的 vid_gen。引擎和模型全部从 GitHub /
// Hugging Face 公开地址免费下载，本程序没有账号、没有激活、没有付费加速。
// 这份代码是原创实现，没有复制任何同类软件的代码、界面文案或品牌。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod chat_proto;
mod engine_io;
mod region_shot;

use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};
use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use sysinfo::{Disks, Pid, System};

const LLAMA_PORT: u16 = 8080;

#[derive(Default)]
struct AppState {
    chat_running: Mutex<bool>,
    chat_model: Mutex<String>,
    chat_port: Mutex<u16>,
    chat_pid: Mutex<Option<u32>>,
    tray_enabled: Mutex<bool>,
    /// 托盘菜单「退出」会先把这个标成 true，关窗口时就不再隐藏到托盘。
    quitting: AtomicBool,
    chat_gen: AtomicU64,
}

// ---------- 目录 ----------
fn base_dir() -> PathBuf {
    // 程序所在目录旁的 data 文件夹；开发模式下退回到当前目录下的 data。
    let exe = std::env::current_exe().unwrap_or_else(|_| PathBuf::from("."));
    let dir = exe.parent().map(|p| p.join("data")).unwrap_or_else(|| PathBuf::from("data"));
    let _ = fs::create_dir_all(&dir);
    dir
}
fn engines_dir() -> PathBuf { base_dir().join("engines") }
fn models_dir() -> PathBuf { base_dir().join("models") }
fn outputs_dir() -> PathBuf { base_dir().join("outputs") }
fn ensure_dirs() {
    for d in [engines_dir(), models_dir(), outputs_dir()] {
        let _ = fs::create_dir_all(d);
    }
}

// ---------- 硬件 ----------
#[derive(Serialize)]
struct Hardware {
    cpu: String,
    cpu_count: usize,
    memory_gb: f64,
    memory_total_gb: f64,
    disk_free_gb: f64,
    gpu: String,
    gpu_vram_gb: f64,
    disk_total_gb: f64,
}

#[tauri::command]
fn get_hardware() -> Hardware {
    let mut sys = System::new_all();
    sys.refresh_all();
    let cpu = sys.cpus().first().map(|c| c.brand().to_string()).unwrap_or_default();
    let total = sys.total_memory() as f64 / 1024.0 / 1024.0 / 1024.0;
    let avail = sys.available_memory() as f64 / 1024.0 / 1024.0 / 1024.0;
    let disks = Disks::new_with_refreshed_list();
    let free = disks.iter().map(|d| d.available_space()).max().unwrap_or(0) as f64
        / 1024.0 / 1024.0 / 1024.0;
    let disk_total = disks.iter().map(|d| d.total_space()).max().unwrap_or(0) as f64
        / 1024.0 / 1024.0 / 1024.0;
    // 显卡：Windows 下用 nvidia-smi，有就显示，没有就写“未检测到 NVIDIA 显卡”。
    let gpu = Command::new("nvidia-smi")
        .args(["--query-gpu=name", "--format=csv,noheader"])
        .output()
        .ok()
        .and_then(|o| {
            let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if s.is_empty() { None } else { Some(s) }
        })
        .unwrap_or_else(|| "未检测到 NVIDIA 显卡（CPU 模式可用）".to_string());
    let gpu_vram_gb = Command::new("nvidia-smi")
        .args(["--query-gpu=memory.total", "--format=csv,noheader,nounits"])
        .output()
        .ok()
        .and_then(|o| {
            String::from_utf8_lossy(&o.stdout)
                .trim()
                .parse::<f64>()
                .ok()
                .map(|mib| mib / 1024.0)
        })
        .unwrap_or(0.0);
    Hardware {
        cpu,
        cpu_count: sys.cpus().len(),
        memory_gb: avail,
        memory_total_gb: total,
        disk_free_gb: free,
        gpu,
        gpu_vram_gb,
        disk_total_gb: disk_total,
    }
}

fn parse_scale(params: &str) -> Option<(f64, f64)> {
    // 返回（总参数 B，激活参数 B）。「见仓库」不猜。
    // tok/s 在 src/recommend.js；这里只给能不能放进显存的标签。
    if params.is_empty() || params.contains("见仓库") {
        return None;
    }
    let chars: Vec<char> = params.chars().collect();
    let mut i = 0;
    let mut total: Option<f64> = None;
    let mut active: Option<f64> = None;
    while i < chars.len() {
        let c = chars[i];
        if c.is_ascii_digit() || (c == '.' && i + 1 < chars.len() && chars[i + 1].is_ascii_digit()) {
            let start = i;
            i += 1;
            while i < chars.len() && (chars[i].is_ascii_digit() || chars[i] == '.') {
                i += 1;
            }
            let num: String = chars[start..i].iter().collect();
            let mut j = i;
            while j < chars.len() && chars[j].is_whitespace() {
                j += 1;
            }
            if j < chars.len() && (chars[j] == 'B' || chars[j] == 'b') {
                if let Ok(v) = num.parse::<f64>() {
                    let window: String = chars[j..].iter().take(8).collect();
                    total = Some(total.map(|t| t.max(v)).unwrap_or(v));
                    if window.contains("激活") {
                        active = Some(v);
                    }
                }
                i = j + 1;
                continue;
            }
        }
        i += 1;
    }
    let total = total?;
    Some((total, active.unwrap_or(total)))
}

fn fit_hint(params: &str, mem_gb: f64, vram_gb: f64) -> String {
    // 与 src/recommend.js 的落点同一口径：Q4_K_M 按每 10 亿参数 0.56GB，
    // 再加 0.8GB 余量。整份放进显存的 85% 才标流畅。混合专家按总参数占地方，
    // 不按激活参数假装整份模型放得进显存。
    let Some((total, _)) = parse_scale(params) else {
        return "待检测：参数规模见仓库，不估算能不能放进显存".to_string();
    };
    let runtime = total * 0.56 + 0.8;
    let usable = vram_gb * 0.85;
    if vram_gb > 0.0 && runtime <= usable {
        format!("流畅：估计约 {:.0}GB，能放进 {:.0}GB 显存", runtime, vram_gb)
    } else if mem_gb > 0.0 && runtime <= mem_gb * 0.75 {
        if vram_gb > 0.0 {
            format!(
                "能跑：估计约 {:.0}GB，放不进 {:.0}GB 显存，会分到内存",
                runtime, vram_gb
            )
        } else {
            format!("能跑：估计约 {:.0}GB，没有独立显存，放在内存", runtime)
        }
    } else {
        format!("较慢：估计约 {:.0}GB，内存也可能不够", runtime)
    }
}

// ---------- 模型目录：16 个公开模型，描述为本程序自己所写 ----------
#[derive(Serialize, Clone)]
struct CatalogModel {
    id: String,
    name: String,
    repo: String,
    params: String,
    desc: String,
    cat: String,
}

fn catalog() -> Vec<CatalogModel> {
    let rows = [
        ("qwen3.8-flash-next", "Qwen3.8 Flash Next", "unsloth/Qwen3.8-Flash-Next-GGUF", "180B 总量 / 约 6B 激活", "旗舰级混合专家模型，激活参数不大，适合想试大模型上限的用户。", "推理"),
        ("qwen3.8-27b", "Qwen3.8 27B", "unsloth/Qwen3.8-27B-GGUF", "27B", "大参数量通用模型，显存和内存要求都比较高。", "对话"),
        ("muse-glimmer-30b", "Muse Glimmer 30B", "unsloth/Muse-Glimmer-30B-GGUF", "30B", "30B 级通用对话模型，适合长对话和写作。", "对话"),
        ("qwen3.6-35b-a3b", "Qwen3.6 35B A3B", "unsloth/Qwen3.6-35B-A3B-GGUF", "35B 总量 / 约 3B 激活", "混合专家结构，实际激活参数小，推理成本相对低。", "推理"),
        ("qwen3.6-27b", "Qwen3.6 27B", "unsloth/Qwen3.6-27B-GGUF", "27B", "27B 级通用模型，中文表现较好。", "对话"),
        ("gemma-4-26b-a4b", "Gemma 4 26B A4B", "unsloth/gemma-4-26B-A4B-it-GGUF", "26B 总量 / 约 4B 激活", "谷歌 Gemma 系列的混合专家版本，指令跟随较稳。", "看图"),
        ("gemma-4-31b", "Gemma 4 31B", "unsloth/gemma-4-31B-it-GGUF", "31B", "31B 级指令模型，适合问答和摘要。", "看图"),
        ("gemma-4-12b", "Gemma 4 12B", "unsloth/gemma-4-12b-it-GGUF", "12B", "12B 中等规模，普通家用显卡比较现实的选择。", "看图"),
        ("gemma-4-e4b", "Gemma 4 E4B", "unsloth/gemma-4-E4B-it-GGUF", "E4B（高效小模型）", "高效小模型，内存小的电脑也可以先从它入门。", "看图"),
        ("qwen3.5-122b-a10b", "Qwen3.5 122B A10B", "unsloth/Qwen3.5-122B-A10B-GGUF", "122B 总量 / 约 10B 激活", "超大总量模型，只建议大显存或大内存机器尝试。", "推理"),
        ("qwen3.5-9b", "Qwen3.5 9B", "unsloth/Qwen3.5-9B-GGUF", "9B", "9B 级，速度和效果比较均衡的日常选择。", "对话"),
        ("qwen3.5-4b", "Qwen3.5 4B", "unsloth/Qwen3.5-4B-GGUF", "4B", "4B 小模型，普通笔记本 CPU 也能跑起来。", "对话"),
        ("glm-4.7-flash", "GLM-4.7 Flash", "unsloth/GLM-4.7-Flash-GGUF", "见仓库（Flash 系列）", "智谱 Flash 系列，速度快，适合高频对话。", "对话"),
        ("devstral-small-2-24b", "Devstral Small 2 24B", "unsloth/Devstral-Small-2-24B-Instruct-2512-GGUF", "24B", "偏编程和工具调用的 24B 模型，适合 Agent 任务。", "编程"),
        ("gpt-oss-20b", "GPT-OSS 20B", "unsloth/gpt-oss-20b-GGUF", "20B", "开源权重的大模型，适合想试非中系模型的。", "对话"),
        ("gpt-oss-120b", "GPT-OSS 120B", "unsloth/gpt-oss-120b-GGUF", "120B", "120B 级，只建议大显存机器尝试。", "推理"),
    ];
    rows.iter()
        .map(|(id, name, repo, params, desc, cat)| CatalogModel {
            id: id.to_string(),
            name: name.to_string(),
            repo: repo.to_string(),
            params: params.to_string(),
            desc: desc.to_string(),
            cat: cat.to_string(),
        })
        .collect()
}

#[tauri::command]
fn get_catalog() -> Vec<CatalogModel> {
    catalog()
}

#[tauri::command]
fn get_catalog_with_fit() -> Vec<serde_json::Value> {
    let hw = get_hardware();
    catalog()
        .iter()
        .map(|m| {
            serde_json::json!({
                "id": m.id, "name": m.name, "repo": m.repo,
                "params": m.params, "desc": m.desc, "cat": m.cat,
                "fit": fit_hint(&m.params, hw.memory_total_gb, hw.gpu_vram_gb),
            })
        })
        .collect()
}

const HF_UA: &str = "OpenLoc/0.1";

#[derive(Serialize, Clone)]
struct HfSearchHit {
    id: String,
    downloads: Option<u64>,
}

#[derive(Serialize, Clone)]
struct HfFileMeta {
    path: String,
    size_bytes: Option<u64>,
}

#[derive(Serialize, Clone)]
struct HfRepoDetail {
    repo: String,
    downloads: Option<u64>,
    total_params: Option<u64>,
    files: Vec<HfFileMeta>,
}

fn json_u64(v: Option<&serde_json::Value>) -> Option<u64> {
    let value = v?;
    if let Some(n) = value.as_u64() {
        return Some(n);
    }
    let f = value.as_f64()?;
    if f.is_finite() && f >= 0.0 && f < (u64::MAX as f64) {
        Some(f as u64)
    } else {
        None
    }
}

fn is_downloadable_gguf(path: &str) -> bool {
    let lower = path.to_lowercase();
    let name = lower.rsplit('/').next().unwrap_or(&lower);
    name.ends_with(".gguf") && !name.starts_with("mmproj")
}

fn parse_hf_search(v: &serde_json::Value) -> Vec<HfSearchHit> {
    let mut out = Vec::new();
    let Some(arr) = v.as_array() else {
        return out;
    };
    for m in arr {
        let Some(id) = m.get("id").and_then(|x| x.as_str()) else {
            continue;
        };
        if id.is_empty() {
            continue;
        }
        out.push(HfSearchHit {
            id: id.to_string(),
            downloads: json_u64(m.get("downloads")),
        });
    }
    out
}

fn parse_hf_repo(repo: &str, v: &serde_json::Value) -> HfRepoDetail {
    let mut files = Vec::new();
    if let Some(arr) = v.get("siblings").and_then(|s| s.as_array()) {
        for sib in arr {
            let Some(path) = sib.get("rfilename").and_then(|x| x.as_str()) else {
                continue;
            };
            if !is_downloadable_gguf(path) {
                continue;
            }
            let mut size = json_u64(sib.get("size"));
            if size.is_none() {
                size = json_u64(sib.get("lfs").and_then(|lfs| lfs.get("size")));
            }
            files.push(HfFileMeta {
                path: path.to_string(),
                size_bytes: size,
            });
        }
    }
    let total_params = json_u64(v.get("gguf").and_then(|g| g.get("total")));
    HfRepoDetail {
        repo: repo.to_string(),
        downloads: json_u64(v.get("downloads")),
        total_params,
        files,
    }
}

fn hf_client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(45))
        .build()
        .map_err(|e| e.to_string())
}

fn fetch_hf_json(
    url: &str,
    token: &Option<String>,
    token_host: Option<&str>,
) -> Result<serde_json::Value, String> {
    let req = hf_client()?.get(url).header("User-Agent", HF_UA);
    let resp = apply_hf_auth(req, url, token, token_host)
        .send()
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    resp.json().map_err(|e| e.to_string())
}

fn hf_model_api_url(root: &str, repo: &str) -> String {
    let path = repo
        .split('/')
        .map(url_encode)
        .collect::<Vec<_>>()
        .join("/");
    format!("{root}/api/models/{path}?blobs=true")
}

fn https_host(url: &str) -> Option<String> {
    let rest = url.strip_prefix("https://")?;
    let hostport = rest.split(['/', '?', '#']).next().unwrap_or("");
    if hostport.is_empty() || hostport.contains('@') || hostport.contains(' ') || hostport.contains('[') {
        return None;
    }
    let host = hostport.split(':').next().unwrap_or("");
    if host.is_empty()
        || host.starts_with('.')
        || host.ends_with('.')
        || host.contains("..")
        || !host.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
    {
        return None;
    }
    Some(host.to_ascii_lowercase())
}

/// 只接受主机名，或 `https://主机` 这种根地址。带路径的值一律拒绝。
fn normalize_token_host(raw: &str) -> Option<String> {
    let t = raw.trim().trim_end_matches('/');
    if t.is_empty() {
        return None;
    }
    if t.starts_with("https://") {
        let rest = t.trim_start_matches("https://");
        if rest.contains('/') || rest.contains('?') || rest.contains('#') {
            return None;
        }
        return https_host(t);
    }
    if t.contains('/') || t.contains(':') || t.contains('@') {
        return None;
    }
    https_host(&format!("https://{t}"))
}

fn should_attach_hf_token(url: &str, token_host: Option<&str>) -> bool {
    let Some(host) = https_host(url) else {
        return false;
    };
    if host == "huggingface.co" || host.ends_with(".huggingface.co") {
        return true;
    }
    match token_host.and_then(normalize_token_host) {
        Some(allowed) if allowed == host => true,
        _ => false,
    }
}

fn clean_hf_token(raw: Option<String>) -> Result<Option<String>, String> {
    let Some(raw) = raw else {
        return Ok(None);
    };
    let t = raw.trim();
    if t.is_empty() {
        return Ok(None);
    }
    if t.len() > 512 || t.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("HuggingFace 令牌格式不对，这次没有带上它。".to_string());
    }
    Ok(Some(t.to_string()))
}

fn hf_api_root(hf_base: &Option<String>) -> Result<String, String> {
    let raw = hf_base.as_deref().unwrap_or("").trim();
    if raw.is_empty() {
        return Ok("https://huggingface.co".to_string());
    }
    match normalize_token_host(raw) {
        Some(host) => Ok(format!("https://{host}")),
        None => Err(
            "HuggingFace 镜像必须是 https 网站根地址，不能带路径或账号。留空则走官方 huggingface.co。"
                .to_string(),
        ),
    }
}

fn form_escape(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn repo_ok(repo: &str) -> bool {
    !repo.is_empty()
        && repo.len() <= 200
        && !repo.contains("..")
        && repo.matches('/').count() == 1
        && !repo.starts_with('/')
        && !repo.ends_with('/')
        && repo
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' || c == '/')
}

fn apply_hf_auth(
    req: reqwest::blocking::RequestBuilder,
    url: &str,
    token: &Option<String>,
    token_host: Option<&str>,
) -> reqwest::blocking::RequestBuilder {
    if let Some(tok) = token {
        if should_attach_hf_token(url, token_host) {
            return req.header("Authorization", format!("Bearer {tok}"));
        }
    }
    req
}

fn load_hf_repo(
    repo: &str,
    hf_base: Option<String>,
    hf_token: Option<String>,
) -> Result<HfRepoDetail, String> {
    if !repo_ok(repo) {
        return Err("仓库名不对。应是 组织/仓库 这种形式。".to_string());
    }
    let root = hf_api_root(&hf_base)?;
    let token = clean_hf_token(hf_token)?;
    let url = hf_model_api_url(&root, repo);
    let api = fetch_hf_json(&url, &token, Some(root.as_str()))
        .map_err(|e| format!("查询文件失败：{e}"))?;
    Ok(parse_hf_repo(repo, &api))
}

#[tauri::command]
fn list_hf_files(
    repo: String,
    hf_base: Option<String>,
    hf_token: Option<String>,
) -> Result<Vec<String>, String> {
    Ok(load_hf_repo(&repo, hf_base, hf_token)?
        .files
        .into_iter()
        .map(|f| f.path)
        .collect())
}

#[tauri::command]
fn hf_repo_detail(
    repo: String,
    hf_base: Option<String>,
    hf_token: Option<String>,
) -> Result<HfRepoDetail, String> {
    load_hf_repo(&repo, hf_base, hf_token)
}

// ---------- 下载（断点续传，416 视为已完成） ----------
#[tauri::command]
fn download_file(
    url: String,
    filename: String,
    kind: String,
    hf_token: Option<String>,
    token_host: Option<String>,
) -> Result<String, String> {
    ensure_dirs();
    let dir = if kind == "model" { models_dir() } else { engines_dir() };
    let _ = fs::create_dir_all(&dir);
    let dest = dir.join(&filename);
    let mut start: u64 = 0;
    if dest.exists() {
        start = fs::metadata(&dest).map(|m| m.len()).unwrap_or(0);
    }
    let token = clean_hf_token(hf_token)?;
    let client = reqwest::blocking::Client::new();
    let mut req = client.get(&url).header("User-Agent", "FreeLocalAI/2.0");
    req = apply_hf_auth(req, &url, &token, token_host.as_deref());
    if start > 0 {
        req = req.header("Range", format!("bytes={}-", start));
    }
    let mut resp = req.send().map_err(|e| e.to_string())?;
    if resp.status().as_u16() == 416 {
        return finalize_download(&dest, &filename, &kind);
    }
    if !resp.status().is_success() {
        return Err(format!("下载失败：HTTP {}", resp.status()));
    }
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(start > 0)
        .write(true)
        .truncate(start == 0)
        .open(&dest)
        .map_err(|e| e.to_string())?;
    let mut buf = [0u8; 65536];
    loop {
        use std::io::Read;
        let n = resp.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n]).map_err(|e| e.to_string())?;
    }
    // 引擎解压后要补可执行权限（Linux/macOS；Windows 不受影响）。
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&dest, fs::Permissions::from_mode(0o755));
    }
    finalize_download(&dest, &filename, &kind)
}

fn import_stem(name: &str) -> String {
    let lower = name.to_lowercase();
    let stem = lower.strip_suffix(".zip").unwrap_or(&lower);
    let mut out = String::new();
    for c in stem.chars() {
        if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' {
            out.push(c);
        } else {
            out.push('_');
        }
        if out.len() >= 80 {
            break;
        }
    }
    let out = out.trim_matches('.').to_string();
    if out.is_empty() { "engine".to_string() } else { out }
}

#[tauri::command]
fn import_engine_zip(path: String) -> Result<String, String> {
    let src = PathBuf::from(path.trim());
    if !src.is_file() {
        return Err("路径不存在或不是文件。下一步：在桌面版选择本机上的 zip。".to_string());
    }
    let name = src.file_name().and_then(|s| s.to_str()).unwrap_or("").to_string();
    if !name.to_lowercase().ends_with(".zip") {
        return Err("只接受 .zip。下一步：选择 llama.cpp 或 stable-diffusion.cpp 的可执行包。".to_string());
    }
    ensure_dirs();
    let stem = import_stem(&name);
    let dir = engines_dir().join("manual").join(&stem);
    let dest_zip = engines_dir().join("manual").join(format!("{stem}.zip"));
    if let Some(parent) = dest_zip.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("无法创建引擎目录：{e}"))?;
    }
    fs::copy(&src, &dest_zip).map_err(|e| format!("复制压缩包失败：{e}"))?;
    engine_io::extract_zip(&dest_zip, &dir)?;
    let llama = engine_io::find_named_binary(&dir, &["llama-server", "llama-server.exe"]);
    let sd = engine_io::find_named_binary(&dir, &["sd-cli", "sd-cli.exe", "sd-server", "sd-server.exe"]);
    match (llama, sd) {
        (Some(found), _) => Ok(format!("聊天引擎已导入，找到 {}", found.display())),
        (None, Some(found)) => Ok(format!("画图引擎已导入，找到 {}", found.display())),
        (None, None) => Err(
            "压缩包已解压，但里面没有 llama-server 或 sd-cli。下一步：确认这是可执行包，不是源码包。"
                .to_string(),
        ),
    }
}

#[tauri::command]
fn list_local_models() -> Vec<String> {
    ensure_dirs();
    fs::read_dir(models_dir())
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .map(|e| e.file_name().to_string_lossy().to_string())
                .filter(|n| n.to_lowercase().ends_with(".gguf"))
                .collect()
        })
        .unwrap_or_default()
}

#[tauri::command]
fn import_model(path: String) -> Result<String, String> {
    let src = PathBuf::from(&path);
    if !src.is_file() {
        return Err("路径不存在或不是文件".to_string());
    }
    let ext = src.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
    if !["gguf", "safetensors", "ckpt"].contains(&ext.as_str()) {
        return Err("只支持 .gguf / .safetensors / .ckpt".to_string());
    }
    ensure_dirs();
    let name = src.file_name().unwrap().to_string_lossy().to_string();
    fs::copy(&src, models_dir().join(&name)).map_err(|e| e.to_string())?;
    Ok(format!("已导入：{}", name))
}

// ---------- 引擎路径 ----------
fn find_llama_server() -> Option<PathBuf> {
    engine_io::find_named_binary(&engines_dir(), &["llama-server", "llama-server.exe"])
}

fn find_sd_cli() -> Option<PathBuf> {
    engine_io::find_named_binary(&engines_dir(), &["sd-cli", "sd-cli.exe", "sd-server", "sd-server.exe"])
}

fn finalize_download(dest: &Path, filename: &str, kind: &str) -> Result<String, String> {
    let lower = filename.to_lowercase();
    if kind == "engine" && lower.ends_with(".zip") {
        let sub = if lower.contains("sd") && !lower.contains("llama") {
            "sd"
        } else {
            "llama"
        };
        let dir = engines_dir().join(sub);
        engine_io::extract_zip(dest, &dir)?;
        if sub == "llama" {
            return match find_llama_server() {
                Some(path) => Ok(format!("聊天引擎已安装，找到 {}", path.display())),
                None => Err(chat_proto::err_zip_no_llama()),
            };
        }
        return match find_sd_cli() {
            Some(path) => Ok(format!("画图引擎已安装，找到 {}", path.display())),
            None => Err(
                "压缩包已解压，但里面没有 sd-cli 或 sd-server。下一步：确认地址是 stable-diffusion.cpp 的 Windows 可执行包后重新安装。"
                    .to_string(),
            ),
        };
    }
    Ok(format!("已下载：{filename}"))
}

// ---------- 聊天 ----------
fn model_file_name_ok(name: &str) -> bool {
    !name.is_empty()
        && !name.contains('\0')
        && !name.contains('/')
        && !name.contains('\\')
        && !name.contains("..")
        && Path::new(name).file_name().and_then(|s| s.to_str()) == Some(name)
}

fn pid_alive(pid: u32) -> bool {
    if Path::new(&format!("/proc/{pid}")).exists() {
        return true;
    }
    let sys = System::new_all();
    sys.process(Pid::from_u32(pid)).is_some()
}

fn llama_log_path() -> PathBuf {
    base_dir().join("logs").join("llama-server.log")
}

fn engine_cmd_hit(proc: &sysinfo::Process, engines: &Path) -> bool {
    let marker = engines.to_string_lossy();
    if marker.is_empty() {
        return false;
    }
    if proc.cmd().iter().any(|arg| arg.to_string_lossy().contains(marker.as_ref())) {
        return true;
    }
    proc.exe().map(|path| path.starts_with(engines)).unwrap_or(false)
}

fn stop_our_llama(our_pid: Option<u32>) -> usize {
    let engines = engines_dir();
    let sys = System::new_all();
    let mut n = 0;
    for proc in sys.processes().values() {
        let name = proc.name().to_string_lossy().to_string();
        let pid = proc.pid().as_u32();
        let ours = Some(pid) == our_pid
            || engine_io::should_stop_process(&name, pid, our_pid, engine_cmd_hit(proc, &engines));
        if ours && proc.kill() {
            n += 1;
        }
    }
    n
}

fn chat_turns_from(message: String, messages: Option<Vec<ChatIn>>) -> Result<Vec<chat_proto::ChatTurn>, String> {
    if let Some(list) = messages {
        if !list.is_empty() {
            return chat_proto::normalize_messages(list.into_iter().map(|m| (m.role, m.content)).collect());
        }
    }
    chat_proto::normalize_messages(vec![("user".to_string(), message)])
}

fn require_running(state: &AppState) -> Result<u16, String> {
    let port = *state.chat_port.lock().unwrap();
    let running = *state.chat_running.lock().unwrap();
    if !running || port == 0 {
        return Err(chat_proto::err_not_running());
    }
    match chat_proto::probe_health_blocking(port, Duration::from_millis(1500)) {
        Ok(()) => Ok(port),
        Err(err) => {
            *state.chat_running.lock().unwrap() = false;
            if err.contains("下一步") {
                Err(err)
            } else {
                Err(format!(
                    "聊天服务健康检查未通过（127.0.0.1:{port}）：{err}。下一步：回到「运行」页停止并重新启动，确认状态变成运行中后再发。本次没有编造回复。"
                ))
            }
        }
    }
}

fn chat_ask_inner(message: &str, port: u16) -> Result<String, String> {
    if port == 0 {
        return Err(chat_proto::err_not_running());
    }
    let turns = chat_proto::normalize_messages(vec![("user".to_string(), message.to_string())])?;
    chat_proto::complete_chat(port, &turns, false)
}

#[derive(Deserialize)]
struct ChatIn {
    role: String,
    content: String,
}

#[derive(Clone, Serialize)]
struct ChatStreamEvent {
    id: u64,
    kind: String,
    text: String,
}

fn emit_chat(app: &tauri::AppHandle, id: u64, kind: &str, text: impl Into<String>) {
    let _ = app.emit(
        "openloc-chat",
        ChatStreamEvent {
            id,
            kind: kind.to_string(),
            text: text.into(),
        },
    );
}

#[tauri::command]
fn start_chat(state: tauri::State<AppState>, model: String, ctx: u32, port: Option<u16>) -> Result<String, String> {
    let port = port.unwrap_or(LLAMA_PORT);
    if port == 0 {
        return Err("端口无效。下一步：在设置里填写 1 到 65535 之间的空闲端口并保存。".to_string());
    }
    let ctx = if ctx == 0 { 4096 } else { ctx };
    if !model_file_name_ok(&model) {
        return Err(chat_proto::err_model_name());
    }
    let bin = find_llama_server().ok_or_else(chat_proto::err_engine_missing)?;
    let model_path = models_dir().join(&model);
    if !model_path.is_file() {
        return Err(chat_proto::err_model_missing(&model));
    }
    let old_pid = state.chat_pid.lock().unwrap().take();
    stop_our_llama(old_pid);
    *state.chat_running.lock().unwrap() = false;
    let ready_at = Instant::now() + Duration::from_secs(5);
    while !engine_io::port_bindable(port) {
        if Instant::now() > ready_at {
            *state.chat_port.lock().unwrap() = port;
            return Err(chat_proto::err_port_busy(port));
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    let log_path = llama_log_path();
    if let Some(parent) = log_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("无法写启动日志：{e}"))?;
    }
    let log_file = fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&log_path)
        .map_err(|e| format!("无法写启动日志：{e}"))?;
    let err_file = log_file.try_clone().map_err(|e| format!("无法写启动日志：{e}"))?;
    let mut cmd = Command::new(&bin);
    cmd.args(chat_proto::launch_args(&model_path, port, ctx))
        .current_dir(bin.parent().unwrap_or(Path::new(".")))
        .stdout(Stdio::from(log_file))
        .stderr(Stdio::from(err_file));
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let mut child = cmd.spawn().map_err(|e| chat_proto::err_spawn(&e.to_string()))?;
    let pid = child.id();
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    *state.chat_pid.lock().unwrap() = Some(pid);
    *state.chat_port.lock().unwrap() = port;
    *state.chat_model.lock().unwrap() = model.clone();
    *state.chat_running.lock().unwrap() = false;
    let deadline = Instant::now() + Duration::from_secs(120);
    loop {
        if !pid_alive(pid) {
            *state.chat_pid.lock().unwrap() = None;
            *state.chat_running.lock().unwrap() = false;
            return Err(chat_proto::err_process_exited(&engine_io::tail_text(&log_path, 400)));
        }
        if chat_proto::probe_health_blocking(port, Duration::from_millis(800)).is_ok()
            && chat_proto::ready_to_mark_running(true, true)
        {
            *state.chat_running.lock().unwrap() = true;
            return Ok(format!(
                "聊天服务已启动：{model}（仅 127.0.0.1:{port}，健康检查已通过）"
            ));
        }
        if Instant::now() > deadline {
            stop_our_llama(Some(pid));
            *state.chat_pid.lock().unwrap() = None;
            *state.chat_running.lock().unwrap() = false;
            return Err(chat_proto::err_health_timeout(
                port,
                &engine_io::tail_text(&log_path, 400),
            ));
        }
        std::thread::sleep(Duration::from_millis(500));
    }
}

#[tauri::command]
fn stop_chat(state: tauri::State<AppState>) -> Result<String, String> {
    state.chat_gen.fetch_add(1, Ordering::SeqCst);
    let pid = state.chat_pid.lock().unwrap().take();
    let n = stop_our_llama(pid);
    *state.chat_running.lock().unwrap() = false;
    if n == 0 {
        Ok("聊天服务已停止（没有发现这次启动的 llama-server）".to_string())
    } else {
        Ok(format!("聊天服务已停止（{n} 个进程）"))
    }
}

#[tauri::command]
fn chat_ask(
    state: tauri::State<AppState>,
    message: String,
    messages: Option<Vec<ChatIn>>,
    think: Option<bool>,
) -> Result<String, String> {
    let port = require_running(&state)?;
    let turns = chat_turns_from(message, messages)?;
    chat_proto::complete_chat(port, &turns, think.unwrap_or(false))
}

#[tauri::command]
async fn chat_stream(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    messages: Vec<ChatIn>,
    think: Option<bool>,
    stream_id: u64,
) -> Result<(), String> {
    let port = *state.chat_port.lock().unwrap();
    let running = *state.chat_running.lock().unwrap();
    if !running || port == 0 {
        return Err(chat_proto::err_not_running());
    }
    let probed = tauri::async_runtime::spawn_blocking(move || {
        chat_proto::probe_health_blocking(port, Duration::from_millis(1500))
    })
    .await
    .map_err(|err| chat_proto::err_request(&format!("健康检查任务失败：{err}")))?;
    if let Err(err) = probed {
        *state.chat_running.lock().unwrap() = false;
        return Err(if err.contains("下一步") {
            err
        } else {
            format!("聊天服务健康检查未通过（127.0.0.1:{port}）：{err}。下一步：回到「运行」页停止并重新启动，确认状态变成运行中后再发。本次没有编造回复。")
        });
    }
    let turns = chat_turns_from(String::new(), Some(messages))?;
    let gen = state.chat_gen.fetch_add(1, Ordering::SeqCst) + 1;
    let think = think.unwrap_or(false);
    let app_task = app.clone();
    tauri::async_runtime::spawn(async move {
        let app_stop = app_task.clone();
        let app_note = app_task.clone();
        let app_piece = app_task.clone();
        let outcome = chat_proto::open_and_read_stream(
            port,
            &turns,
            think,
            || app_stop.state::<AppState>().chat_gen.load(Ordering::SeqCst) != gen,
            |note| emit_chat(&app_note, stream_id, "status", note),
            |piece| match piece {
                chat_proto::SsePiece::Delta(text) => emit_chat(&app_piece, stream_id, "delta", text),
                chat_proto::SsePiece::Reasoning(text) => emit_chat(&app_piece, stream_id, "reasoning", text),
                chat_proto::SsePiece::Done => {}
            },
        )
        .await;
        match outcome {
            Ok(result) => {
                let cancelled = result.cancelled
                    || app_task.state::<AppState>().chat_gen.load(Ordering::SeqCst) != gen;
                if cancelled {
                    emit_chat(
                        &app_task,
                        stream_id,
                        "cancelled",
                        "已停止生成。已收到的内容保留，没有继续向本机服务要后续文字。",
                    );
                } else {
                    emit_chat(&app_task, stream_id, "done", "");
                }
            }
            Err(err) => emit_chat(&app_task, stream_id, "error", err),
        }
    });
    Ok(())
}

#[tauri::command]
fn cancel_chat(state: tauri::State<AppState>) -> String {
    state.chat_gen.fetch_add(1, Ordering::SeqCst);
    "已停止生成。已收到的内容保留，没有继续向本机服务要后续文字。".to_string()
}

#[tauri::command]
fn get_chat_status(state: tauri::State<AppState>) -> serde_json::Value {
    let port = *state.chat_port.lock().unwrap();
    let model = state.chat_model.lock().unwrap().clone();
    let pid = *state.chat_pid.lock().unwrap();
    let flagged = *state.chat_running.lock().unwrap();
    let host = chat_proto::LOOPBACK_HOST;
    if !flagged || port == 0 || pid.is_none() {
        let detail = if model.is_empty() {
            "未启动".to_string()
        } else {
            format!("未运行。上次选择的模型：{model}。下一步：打开「运行」页重新启动。")
        };
        return serde_json::json!({
            "running": false,
            "model": model,
            "port": port,
            "host": host,
            "detail": detail,
        });
    }
    let alive = pid_alive(pid.unwrap_or(0));
    let health_ok = alive && chat_proto::probe_health_blocking(port, Duration::from_millis(1200)).is_ok();
    let running = chat_proto::ready_to_mark_running(alive, health_ok);
    *state.chat_running.lock().unwrap() = running;
    let detail = if running {
        format!("运行中：{model}，只绑定 127.0.0.1:{port}")
    } else if !alive {
        "聊天进程已不在。下一步：回到「运行」页重新启动。本次状态已改为未运行。".to_string()
    } else {
        format!("进程还在，但 127.0.0.1:{port} 健康检查未通过。下一步：看 data/logs/llama-server.log，或停止后重新启动。本次状态已改为未运行。")
    };
    serde_json::json!({
        "running": running,
        "model": model,
        "port": port,
        "host": host,
        "detail": detail,
    })
}
#[tauri::command]
fn open_folder(path: String) -> Result<String, String> {
    let p = if Path::new(&path).is_file() { Path::new(&path).parent().map(|x| x.to_path_buf()).unwrap_or_else(|| PathBuf::from(&path)) } else { PathBuf::from(&path) };
    #[cfg(target_os = "windows")]
    { Command::new("explorer").arg(&p).spawn().map_err(|e| e.to_string())?; }
    #[cfg(not(target_os = "windows"))]
    { Command::new("xdg-open").arg(&p).spawn().map_err(|e| e.to_string())?; }
    Ok(format!("已打开：{}", p.display()))
}
#[tauri::command]
fn set_tray_enabled(state: tauri::State<AppState>, enabled: bool) -> String {
    *state.tray_enabled.lock().unwrap() = enabled;
    if enabled { "已开启：关闭窗口后隐藏到托盘".to_string() } else { "已关闭：关闭窗口后直接退出程序".to_string() }
}
#[tauri::command]
fn list_background() -> Vec<serde_json::Value> {
    let sys = System::new_all();
    let names = ["llama-server", "llama-server.exe", "sd-server", "sd-server.exe", "sd-cli", "sd-cli.exe", "ffmpeg", "ffmpeg.exe"];
    let mut out: Vec<serde_json::Value> = Vec::new();
    for proc in sys.processes().values() {
        let name = proc.name().to_string_lossy().to_string();
        if names.iter().any(|n| name.eq_ignore_ascii_case(n)) {
            out.push(serde_json::json!({"name": name, "pid": proc.pid().as_u32(), "mem_mb": proc.memory() / 1024 / 1024}));
        }
    }
    out.sort_by_key(|v| v["pid"].as_u64().unwrap_or(0));
    out
}
#[tauri::command]
fn stop_process(name: String) -> Result<String, String> {
    let allowed = ["llama-server", "llama-server.exe", "sd-server", "sd-server.exe", "sd-cli", "sd-cli.exe", "ffmpeg", "ffmpeg.exe"];
    if !allowed.iter().any(|n| name.eq_ignore_ascii_case(n)) {
        return Err("只能停止 OpenLoc 自己的后台程序（llama-server / sd-server / sd-cli / ffmpeg），不碰其他程序".to_string());
    }
    let sys = System::new_all();
    let mut n = 0;
    for proc in sys.processes().values() {
        if proc.name().to_string_lossy().eq_ignore_ascii_case(&name) {
            if proc.kill() { n += 1; }
        }
    }
    if n == 0 { return Err(format!("{} 没有在运行", name)); }
    Ok(format!("已停止 {}（{} 个进程）", name, n))
}
#[tauri::command]
fn engine_status() -> serde_json::Value {
    serde_json::json!({"llama": find_llama_server().map(|p| p.to_string_lossy().to_string()), "sd": find_sd_cli().map(|p| p.to_string_lossy().to_string())})
}

// ---------- 画图 / 视频 ----------
#[tauri::command]
fn generate_image(model: String, prompt: String, steps: u32, width: u32, height: u32) -> Result<String, String> {
    let bin = find_sd_cli().ok_or("还没安装画图引擎。请打开「运行」页安装后再试。")?;
    let model_path = models_dir().join(&model);
    if !model_path.exists() {
        return Err(format!("模型文件不存在：{}", model));
    }
    ensure_dirs();
    let out = outputs_dir().join(format!("img_{}.png", chrono_stamp()));
    let output = Command::new(&bin)
        .arg("-m")
        .arg(&model_path)
        .arg("-p")
        .arg(&prompt)
        .arg("--steps")
        .arg(steps.to_string())
        .arg("-W")
        .arg(width.to_string())
        .arg("-H")
        .arg(height.to_string())
        .arg("-o")
        .arg(&out)
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(format!(
            "画图失败：{}",
            String::from_utf8_lossy(&output.stderr).chars().take(500).collect::<String>()
        ));
    }
    Ok(format!("已生成：{}", out.display()))
}

fn chrono_stamp() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    secs.to_string()
}

#[tauri::command]
fn generate_motion_video(image: String, seconds: u32) -> Result<String, String> {
    // ffmpeg 动效视频：不是扩散视频，界面上必须这样标注，不能冒充。
    ensure_dirs();
    let out = outputs_dir().join(format!("motion_{}.mp4", chrono_stamp()));
    let output = Command::new("ffmpeg")
        .args([
            "-y", "-loop", "1", "-i", &image,
            "-vf", &format!("scale=1280:720,zoompan=z='min(zoom+0.0015,1.5)':d={}:s=1280x720", seconds * 30),
            "-t", &seconds.to_string(), "-pix_fmt", "yuv420p",
        ])
        .arg(&out)
        .output()
        .map_err(|_| "没有找到 ffmpeg，请先安装 ffmpeg 再试".to_string())?;
    if !output.status.success() {
        return Err("ffmpeg 动效视频生成失败".to_string());
    }
    Ok(format!("已生成动效视频：{}", out.display()))
}

#[tauri::command]
fn generate_diffusion_video(model: String, prompt: String, frames: u32) -> Result<String, String> {
    let bin = find_sd_cli().ok_or("还没安装画图 / 视频引擎。请打开「运行」页安装后再试。")?;
    let model_path = models_dir().join(&model);
    if !model_path.exists() {
        return Err(format!("模型文件不存在：{}", model));
    }
    ensure_dirs();
    let out = outputs_dir().join(format!("vid_{}.mp4", chrono_stamp()));
    let output = Command::new(&bin)
        .arg("-M")
        .arg("vid_gen")
        .arg("-m")
        .arg(&model_path)
        .arg("-p")
        .arg(&prompt)
        .arg("--video-frames")
        .arg(frames.to_string())
        .arg("-o")
        .arg(&out)
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(format!(
            "扩散视频失败（需要 Wan 视频模型和足够显存）：{}",
            String::from_utf8_lossy(&output.stderr).chars().take(500).collect::<String>()
        ));
    }
    Ok(format!("已生成扩散视频：{}", out.display()))
}



// ---------- 模型管理：删除本地模型、搜索 HuggingFace ----------
#[tauri::command]
fn delete_model(name: String) -> Result<String, String> {
    ensure_dirs();
    let full = inside(&models_dir(), &name).ok_or("路径不在模型文件夹内")?;
    std::fs::remove_file(&full).map_err(|e| e.to_string())?;
    Ok(format!("已删除 {}", name))
}
#[tauri::command]
fn search_hf(
    query: String,
    hf_base: Option<String>,
    hf_token: Option<String>,
) -> Result<Vec<HfSearchHit>, String> {
    let root = hf_api_root(&hf_base)?;
    let token = clean_hf_token(hf_token)?;
    let q = form_escape(query.trim());
    if q.is_empty() {
        return Ok(Vec::new());
    }
    let url = format!("{root}/api/models?search={q}&limit=20&filter=gguf");
    let v = fetch_hf_json(&url, &token, Some(root.as_str()))
        .map_err(|e| format!("搜索失败：{e}"))?;
    Ok(parse_hf_search(&v))
}
#[tauri::command]
fn list_local_model_info() -> Vec<serde_json::Value> {
    let mut out = Vec::new();
    if let Ok(rd) = std::fs::read_dir(models_dir()) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            let gb = e.metadata().map(|m| m.len() as f64 / 1e9).unwrap_or(0.0);
            out.push(serde_json::json!({"name": name, "size_gb": gb}));
        }
    }
    out.sort_by(|a,b| a["name"].as_str().cmp(&b["name"].as_str()));
    out
}


// ---------- 联网搜索：程序自己去 DuckDuckGo 搜，把结果贴给本地模型 ----------
fn url_encode(s: &str) -> String {
    let mut out = String::new();
    for b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(*b as char),
            b' ' => out.push('+'),
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}
fn strip_tags(s: &str) -> String {
    let mut out = String::new(); let mut in_tag = false;
    for c in s.chars() { if c == '<' { in_tag = true; } else if c == '>' { in_tag = false; } else if !in_tag { out.push(c); } }
    out.replace("&amp;", "&").replace("&quot;", "\"").replace("&#x27;", "'").replace("&lt;", "<").replace("&gt;", ">")
}
#[tauri::command]
fn web_search(query: String) -> Result<String, String> {
    let url = format!("https://html.duckduckgo.com/html/?q={}", url_encode(&query));
    let client = reqwest::blocking::Client::builder().user_agent("Mozilla/5.0").timeout(std::time::Duration::from_secs(20)).build().map_err(|e| e.to_string())?;
    let html = client.get(&url).send().map_err(|e| e.to_string())?.text().map_err(|e| e.to_string())?;
    let mut results = Vec::new(); let mut rest = html.as_str();
    while results.len() < 5 {
        let a = match rest.find("result__a") { Some(i) => i, None => break };
        rest = &rest[a..];
        let gt = match rest.find('>') { Some(i) => i, None => break };
        let end = match rest.find("</a>") { Some(i) => i, None => break };
        let title = strip_tags(&rest[gt+1..end]).trim().to_string();
        rest = &rest[end..];
        let s = match rest.find("result__snippet") { Some(i) => i, None => { results.push(format!("{}. {}", results.len()+1, title)); continue; } };
        rest = &rest[s..];
        let gt2 = match rest.find('>') { Some(i) => i, None => break };
        let end2 = match rest.find("</a>") { Some(i) => i, None => break };
        let snippet = strip_tags(&rest[gt2+1..end2]).trim().to_string();
        rest = &rest[end2..];
        if !title.is_empty() { results.push(format!("{}. {}\n{}", results.len()+1, title, snippet)); }
    }
    if results.is_empty() { Ok("没搜到相关结果，请换个词再试。".to_string()) } else { Ok(results.join("\n\n")) }
}

// ---------- 截屏：只保存用户确认的选区。取消不写整屏，也不进附件 ----------
#[derive(Serialize)]
struct ChatShot {
    path: String,
    name: String,
    mode: String,
}

#[tauri::command]
fn capture_chat_image() -> Result<ChatShot, String> {
    ensure_dirs();
    let d = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let name = format!("shot_{}_{:03}.png", d.as_secs(), d.subsec_millis());
    let out = outputs_dir().join(&name);
    region_shot::capture_region_file(&out)?;
    Ok(ChatShot {
        path: out.display().to_string(),
        name,
        mode: "region".to_string(),
    })
}

// ---------- Agent：只能在指定工作文件夹内活动 ----------
const BLOCKED_CMD: [&str; 9] = [
    "rm -rf", "format", "del /f", "rd /s", "mkfs", "shutdown", "reboot", "sudo rm", "chmod 777 /",
];

fn inside(folder: &Path, path: &str) -> Option<PathBuf> {
    let base = folder.canonicalize().ok()?;
    let cand = if Path::new(path).is_absolute() {
        PathBuf::from(path)
    } else {
        folder.join(path)
    };
    // 目标文件可能还不存在：先 canonicalize 父目录，再拼文件名。
    let parent = cand.parent().map(|p| p.to_path_buf()).unwrap_or_else(|| folder.to_path_buf());
    let parent_canon = parent.canonicalize().unwrap_or(parent);
    let file = cand.file_name()?.to_os_string();
    let full = parent_canon.join(file);
    if full.starts_with(&base) {
        Some(full)
    } else {
        None
    }
}

fn agent_tool(folder: &Path, tool: &str, args: &HashMap<String, String>) -> String {
    match tool {
        "list_dir" => match fs::read_dir(folder) {
            Ok(rd) => rd
                .filter_map(|e| e.ok())
                .map(|e| e.file_name().to_string_lossy().to_string())
                .collect::<Vec<_>>()
                .join(", "),
            Err(e) => format!("列出文件夹失败：{}", e),
        },
        "read_file" => {
            let path = args.get("path").cloned().unwrap_or_default();
            match inside(folder, &path) {
                Some(p) => fs::read_to_string(p)
                    .map(|s| s.chars().take(4000).collect())
                    .unwrap_or_else(|e| format!("读取失败：{}", e)),
                None => "已拦截：路径超出工作文件夹".to_string(),
            }
        }
        "write_file" => {
            let path = args.get("path").cloned().unwrap_or_default();
            let content = args.get("content").cloned().unwrap_or_default();
            match inside(folder, &path) {
                Some(p) => match fs::write(&p, &content) {
                    Ok(_) => format!("已写入：{}（{} 字）", path, content.chars().count()),
                    Err(e) => format!("写入失败：{}", e),
                },
                None => "已拦截：路径超出工作文件夹".to_string(),
            }
        }
        "run_command" => {
            let cmd = args.get("command").cloned().unwrap_or_default();
            if BLOCKED_CMD.iter().any(|b| cmd.contains(b)) || cmd.contains("..") {
                return "已拦截：危险命令或含 ..".to_string();
            }
            #[cfg(windows)]
            let output = Command::new("cmd").args(["/C", &cmd]).current_dir(folder).output();
            #[cfg(not(windows))]
            let output = Command::new("sh").args(["-c", &cmd]).current_dir(folder).output();
            match output {
                Ok(o) => {
                    let mut s = String::from_utf8_lossy(&o.stdout).to_string();
                    s.push_str(&String::from_utf8_lossy(&o.stderr));
                    s.chars().take(2000).collect()
                }
                Err(e) => format!("命令失败：{}", e),
            }
        }
        "finish" => "完成".to_string(),
        _ => format!("未知工具：{}", tool),
    }
}

#[tauri::command]
fn agent_run(state: tauri::State<AppState>, folder: String, task: String) -> Result<Vec<String>, String> {
    let folder_path = PathBuf::from(&folder);
    if !folder_path.is_dir() {
        return Err("工作文件夹不存在，请先创建它".to_string());
    }
    let mut steps: Vec<String> = Vec::new();
    let known = ["list_dir", "read_file", "write_file", "run_command", "finish"];
    for i in 1..=6 {
        let prompt = format!(
            "你是本地 Agent，只能用下面工具之一，输出一个 JSON，不要多余文字：{{\"tool\": \"list_dir|read_file|write_file|run_command|finish\", \"reason\": \"一句话\", \"args\": {{\"path\": \"\", \"content\": \"\", \"command\": \"\"}}}}。任务：{}。工作文件夹：{}。已完成步骤：{}",
            task, folder, steps.join("；")
        );
        let port = *state.chat_port.lock().unwrap();
        let running = *state.chat_running.lock().unwrap();
        if !running || port == 0 {
            return Err(chat_proto::err_not_running());
        }
        let reply = chat_ask_inner(&prompt, port)?;
        let json_text = reply
            .find('{')
            .and_then(|s| reply.rfind('}').map(|e| &reply[s..=e]))
            .unwrap_or("{}");
        let act: serde_json::Value = serde_json::from_str(json_text).unwrap_or(serde_json::json!({}));
        let mut tool = act.get("tool").and_then(|t| t.as_str()).unwrap_or("").to_string();
        if !known.contains(&tool.as_str()) {
            for k in known {
                if tool.contains(k) {
                    tool = k.to_string();
                    break;
                }
            }
        }
        let mut args: HashMap<String, String> = HashMap::new();
        if let Some(a) = act.get("args").and_then(|a| a.as_object()) {
            for (k, v) in a {
                if let Some(s) = v.as_str() {
                    args.insert(k.clone(), s.to_string());
                }
            }
        }
        // 小模型容错：工具抄成列表、args 缺失时，按任务原文推断写文件。
        if tool == "write_file" && (args.get("path").map(|s| s.is_empty()).unwrap_or(true)
            || args.get("content").map(|s| s.is_empty()).unwrap_or(true))
        {
            let file = extract_txt_name(&task).unwrap_or_else(|| "hello.txt".to_string());
            let content = extract_content(&task).unwrap_or_default();
            args.insert("path".to_string(), args.get("path").filter(|s| !s.is_empty()).cloned().unwrap_or(file));
            args.insert("content".to_string(), args.get("content").filter(|s| !s.is_empty()).cloned().unwrap_or(content));
        }
        if tool == "run_command" && args.get("command").map(|s| s.is_empty()).unwrap_or(true) {
            args.insert("command".to_string(), "ls -la".to_string());
        }
        let reason = act.get("reason").and_then(|r| r.as_str()).unwrap_or("").to_string();
        let result = agent_tool(&folder_path, &tool, &args);
        steps.push(format!("第 {} 步 [{}] {} -> {}", i, tool, reason, result));
        if tool == "finish" {
            break;
        }
    }
    Ok(steps)
}

fn extract_txt_name(task: &str) -> Option<String> {
    // 找第一个 *.txt / *.md / *.py 文件名。
    for ext in ["txt", "md", "py", "json", "html"] {
        if let Some(pos) = task.find(&format!(".{}", ext)) {
            let before = &task[..pos];
            let start = before
                .char_indices()
                .rev()
                .find(|(_, c)| c.is_whitespace() || *c == '，' || *c == '、' || *c == '：' || *c == '/')
                .map(|(i, c)| i + c.len_utf8())
                .unwrap_or(0);
            let name = format!("{}.{}", &before[start..], ext);
            if !name.contains(' ') {
                return Some(name);
            }
        }
    }
    None
}

fn extract_content(task: &str) -> Option<String> {
    let marker = "内容是";
    let pos = task.find(marker)? + marker.len();
    let rest = task[pos..].trim_start();
    let end = rest
        .find(|c: char| c == '，' || c == '。' || c == '、')
        .unwrap_or(rest.len());
    let s = rest[..end].trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

/// 打包图标缺失时托盘仍显示蓝底大写 O，不回退成别的图案。
fn fallback_o_icon() -> tauri::image::Image<'static> {
    const N: u32 = 32;
    let mut rgba = vec![0u8; (N * N * 4) as usize];
    for y in 0..N {
        for x in 0..N {
            let fx = x as f32 + 0.5;
            let fy = y as f32 + 0.5;
            let t = (fx + fy) / (2.0 * N as f32);
            let bg = [
                (0x25 as f32 + (0x1D as f32 - 0x25 as f32) * t).round() as u8,
                (0x63 as f32 + (0x4E as f32 - 0x63 as f32) * t).round() as u8,
                (0xEB as f32 + (0xD8 as f32 - 0xEB as f32) * t).round() as u8,
            ];
            let cx = N as f32 / 2.0;
            let cy = cx - 0.3;
            let rx = 9.3;
            let ry = 11.1;
            let stroke = 2.9;
            let dx = (fx - cx).abs();
            let dy = (fy - cy).abs();
            let n = 2.45_f32;
            let outer = (dx / rx).powf(n) + (dy / ry).powf(n);
            let inner = (dx / (rx - stroke)).powf(n) + (dy / (ry - stroke)).powf(n);
            let letter = outer <= 1.0 && inner >= 1.0;
            let i = ((y * N + x) * 4) as usize;
            if letter {
                rgba[i] = 255;
                rgba[i + 1] = 255;
                rgba[i + 2] = 255;
            } else {
                rgba[i] = bg[0];
                rgba[i + 1] = bg[1];
                rgba[i + 2] = bg[2];
            }
            rgba[i + 3] = 255;
        }
    }
    tauri::image::Image::new_owned(rgba, N, N)
}

#[cfg(test)]
mod fit_tests {
    use super::*;

    #[test]
    fn small_model_fits_8gb() {
        let hint = fit_hint("4B", 32.0, 8.0);
        assert!(hint.starts_with("流畅"), "{hint}");
        let hint = fit_hint("E4B（高效小模型）", 32.0, 8.0);
        assert!(hint.starts_with("流畅"), "{hint}");
    }

    #[test]
    fn moe_uses_total_params_for_vram() {
        let hint = fit_hint("35B 总量 / 约 3B 激活", 32.0, 8.0);
        assert!(hint.starts_with("能跑"), "{hint}");
        assert!(!hint.contains("流畅"));
        let huge = fit_hint("180B 总量 / 约 6B 激活", 32.0, 8.0);
        assert!(huge.starts_with("较慢"), "{huge}");
    }

    #[test]
    fn unknown_scale_is_not_a_guess() {
        let hint = fit_hint("见仓库（Flash 系列）", 32.0, 8.0);
        assert!(hint.starts_with("待检测"), "{hint}");
    }

    #[test]
    fn cpu_only_can_still_run_a_small_model() {
        let hint = fit_hint("4B", 16.0, 0.0);
        assert!(hint.starts_with("能跑"), "{hint}");
        assert!(hint.contains("内存"));
    }
}

#[cfg(test)]
mod settings_net_tests {
    use super::*;

    #[test]
    fn hf_token_stays_off_other_hosts() {
        assert!(!should_attach_hf_token(
            "https://github.com/ggml-org/llama.cpp/releases/download/b12110/llama.zip",
            Some("mirror.example")
        ));
        assert!(!should_attach_hf_token(
            "https://proxy.example/https://github.com/ggml-org/llama.cpp/x.zip",
            Some("https://mirror.example")
        ));
        assert!(!should_attach_hf_token(
            "https://evil.example/org/repo",
            Some("https://mirror.example/extra")
        ));
    }

    #[test]
    fn hf_token_attaches_to_official_and_chosen_mirror() {
        assert!(should_attach_hf_token(
            "https://huggingface.co/org/repo/resolve/main/model.gguf",
            None
        ));
        assert!(should_attach_hf_token(
            "https://mirror.example/org/repo/resolve/main/model.gguf",
            Some("https://mirror.example")
        ));
        assert!(!should_attach_hf_token("http://huggingface.co/org/repo", None));
    }

    #[test]
    fn bad_token_is_rejected_and_blank_is_absent() {
        assert!(clean_hf_token(Some("hf_ok".into())).unwrap().is_some());
        assert!(clean_hf_token(Some("  ".into())).unwrap().is_none());
        assert!(clean_hf_token(Some("bad token".into())).is_err());
        assert!(clean_hf_token(None).unwrap().is_none());
    }

    #[test]
    fn mirror_root_only() {
        assert_eq!(hf_api_root(&None).unwrap(), "https://huggingface.co");
        assert_eq!(
            hf_api_root(&Some("https://mirror.example".into())).unwrap(),
            "https://mirror.example"
        );
        assert!(hf_api_root(&Some("http://mirror.example".into())).is_err());
        assert!(hf_api_root(&Some("https://mirror.example/path".into())).is_err());
    }

    #[test]
    fn import_stem_drops_odd_characters() {
        assert_eq!(import_stem("llama-b12110.zip"), "llama-b12110");
        assert_eq!(import_stem("../sneaky.zip"), "_sneaky");
        assert_eq!(import_stem("..zip"), "engine");
    }
}

#[cfg(test)]
mod hf_meta_tests {
    use super::*;

    #[test]
    fn search_hits_keep_id_and_month_downloads() {
        let v = serde_json::json!([
            {"id": "unsloth/Qwen3.8-Flash-Next-GGUF", "downloads": 1423501},
            {"id": "org/no-count"},
            {"downloads": 3},
            {"id": ""}
        ]);
        let hits = parse_hf_search(&v);
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].id, "unsloth/Qwen3.8-Flash-Next-GGUF");
        assert_eq!(hits[0].downloads, Some(1_423_501));
        assert_eq!(hits[1].id, "org/no-count");
        assert_eq!(hits[1].downloads, None);
    }

    #[test]
    fn model_files_use_sibling_size_skip_mmproj_and_keep_param_count() {
        let v = serde_json::json!({
            "downloads": 10,
            "gguf": {"total": 4_000_000_000u64, "totalFileSize": 999},
            "siblings": [
                {"rfilename": "mmproj-BF16.gguf", "size": 100},
                {"rfilename": "Q4_K_M/model-Q4_K_M.gguf", "size": 2_500_000_000u64},
                {"rfilename": "BF16/a-00001-of-00002.gguf", "lfs": {"size": 11}},
                {"rfilename": "README.md", "size": 12},
                {"rfilename": "nested/mmproj-model.gguf", "size": 8}
            ]
        });
        let d = parse_hf_repo("org/name", &v);
        assert_eq!(d.repo, "org/name");
        assert_eq!(d.downloads, Some(10));
        assert_eq!(d.total_params, Some(4_000_000_000));
        assert_eq!(d.files.len(), 2);
        assert_eq!(d.files[0].path, "Q4_K_M/model-Q4_K_M.gguf");
        assert_eq!(d.files[0].size_bytes, Some(2_500_000_000));
        assert_eq!(d.files[1].path, "BF16/a-00001-of-00002.gguf");
        assert_eq!(d.files[1].size_bytes, Some(11));
    }
}

/// 关窗口时：托盘常驻且不是从菜单退出，才隐藏。点「退出」必须真正结束。
fn hide_on_close(tray_enabled: bool, quitting: bool) -> bool {
    tray_enabled && !quitting
}

#[cfg(test)]
mod tray_tests {
    use super::hide_on_close;

    #[test]
    fn quit_is_not_hidden_back_into_the_tray() {
        assert!(hide_on_close(true, false));
        assert!(!hide_on_close(true, true));
        assert!(!hide_on_close(false, false));
        assert!(!hide_on_close(false, true));
    }
}

fn main() {
    ensure_dirs();
    tauri::Builder::default()
        .manage(AppState {
            chat_running: Mutex::new(false),
            chat_model: Mutex::new(String::new()),
            chat_port: Mutex::new(0),
            chat_pid: Mutex::new(None),
            tray_enabled: Mutex::new(true),
            quitting: AtomicBool::new(false),
            chat_gen: AtomicU64::new(0),
        })
        .invoke_handler(tauri::generate_handler![
            get_hardware,
            get_catalog,
            get_catalog_with_fit,
            list_hf_files,
            hf_repo_detail,
            download_file,
            import_engine_zip,
            list_local_models,
            import_model,
            start_chat,
            stop_chat,
            chat_ask,
            chat_stream,
            cancel_chat,
            generate_image,
            generate_motion_video,
            generate_diffusion_video,
            agent_run,
            capture_chat_image,
            delete_model,
            search_hf,
            list_local_model_info,
            get_chat_status,
            open_folder,
            engine_status,
            set_tray_enabled,
            list_background,
            stop_process,
            web_search,
        ])
        .setup(|app| {
            // 系统托盘：关窗口后默认只隐藏。右键「退出」会真正结束进程。
            use tauri::menu::{MenuBuilder, MenuItemBuilder};
            use tauri::tray::{TrayIconBuilder, TrayIconEvent};
            let show = MenuItemBuilder::with_id("show", "显示 OpenLoc").build(app)?;
            let hide = MenuItemBuilder::with_id("hide", "隐藏窗口").build(app)?;
            let chat = MenuItemBuilder::with_id("chat", "开始对话").build(app)?;
            let models = MenuItemBuilder::with_id("models", "打开模型页").build(app)?;
            let quit = MenuItemBuilder::with_id("quit", "退出").build(app)?;
            let menu = MenuBuilder::new(app).items(&[&show, &hide, &chat, &models, &quit]).build()?;
            let tray_icon = if let Some(icon) = app.default_window_icon() {
                icon.clone()
            } else {
                fallback_o_icon()
            };
            TrayIconBuilder::new()
                .icon(tray_icon)
                .tooltip("OpenLoc（右键菜单里可以退出）")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "show" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                    "hide" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.hide();
                        }
                    }
                    "chat" | "models" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                            let page = if event.id().as_ref() == "chat" { "chat" } else { "cat" };
                            let _ = w.eval(format!("document.querySelector('[data-page=\"{}\"]')?.click()", page));
                        }
                    }
                    "quit" => {
                        if let Some(state) = app.try_state::<AppState>() {
                            state.quitting.store(true, Ordering::SeqCst);
                        }
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { .. } = event {
                        if let Some(w) = tray.app_handle().get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                })
                .build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            // 点窗口右上角 X：默认只隐藏窗口，托盘图标还在。
            // 设置里关掉“后台常驻”，或者托盘菜单点了「退出」，就真正结束。
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let state = window.state::<AppState>();
                let quitting = state.quitting.load(Ordering::SeqCst);
                let tray_on = state.tray_enabled.lock().map(|v| *v).unwrap_or(true);
                if hide_on_close(tray_on, quitting) {
                    let _ = window.hide();
                    api.prevent_close();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
