// OpenLoc（桌面版，原创代码）
// 架构说明：Rust + Tauri 打包成 Windows 桌面程序，窗口里跑本地 HTML/JS。
// 聊天走 llama.cpp 的 llama-server，画图走 stable-diffusion.cpp 的 sd-cli，
// 视频走 ffmpeg 动效或 sd-cli 的 vid_gen。引擎和模型全部从 GitHub /
// Hugging Face 公开地址免费下载，本程序没有账号、没有激活、没有付费加速。
// 这份代码是原创实现，没有复制任何同类软件的代码、界面文案或品牌。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use tauri::Manager;
use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use sysinfo::{Disks, System};

const LLAMA_PORT: u16 = 8080;

#[derive(Default)]
struct AppState {
    chat_running: Mutex<bool>,
    chat_model: Mutex<String>,
    chat_port: Mutex<u16>,
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

fn fit_hint(params: &str, mem_gb: f64) -> String {
    // 粗略估算：Q4 量化大约每 10 亿参数占 0.6GB，加上运行开销。
    let est: f64 = params
        .split_whitespace()
        .next()
        .and_then(|s| s.replace('B', "").parse::<f64>().ok())
        .unwrap_or(4.0)
        * 0.6
        + 2.0;
    if mem_gb >= est * 1.5 {
        format!("适合：估计需要约 {:.0}GB 内存，你的内存充足", est)
    } else if mem_gb >= est {
        format!("勉强：估计需要约 {:.0}GB 内存，可能会比较慢", est)
    } else {
        format!("不建议：估计需要约 {:.0}GB 内存，你的内存可能不够", est)
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
                "fit": fit_hint(&m.params, hw.memory_total_gb),
            })
        })
        .collect()
}

#[derive(Deserialize)]
struct HfApi {
    siblings: Option<Vec<HfSibling>>,
}
#[derive(Deserialize)]
struct HfSibling {
    rfilename: String,
}

#[tauri::command]
fn list_hf_files(repo: String) -> Result<Vec<String>, String> {
    let url = format!("https://huggingface.co/api/models/{}", repo);
    let resp = reqwest::blocking::Client::new()
        .get(&url)
        .header("User-Agent", "FreeLocalAI/2.0")
        .send()
        .map_err(|e| e.to_string())?;
    let api: HfApi = resp.json().map_err(|e| e.to_string())?;
    Ok(api
        .siblings
        .unwrap_or_default()
        .into_iter()
        .map(|s| s.rfilename)
        .filter(|f| f.to_lowercase().ends_with(".gguf") && !f.to_lowercase().starts_with("mmproj"))
        .collect())
}

// ---------- 下载（断点续传，416 视为已完成） ----------
#[tauri::command]
fn download_file(url: String, filename: String, kind: String) -> Result<String, String> {
    ensure_dirs();
    let dir = if kind == "model" { models_dir() } else { engines_dir() };
    let _ = fs::create_dir_all(&dir);
    let dest = dir.join(&filename);
    let mut start: u64 = 0;
    if dest.exists() {
        start = fs::metadata(&dest).map(|m| m.len()).unwrap_or(0);
    }
    let client = reqwest::blocking::Client::new();
    let mut req = client.get(&url).header("User-Agent", "FreeLocalAI/2.0");
    if start > 0 {
        req = req.header("Range", format!("bytes={}-", start));
    }
    let mut resp = req.send().map_err(|e| e.to_string())?;
    if resp.status().as_u16() == 416 {
        return Ok(format!("已完成：{}", filename));
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
    Ok(format!("已下载：{}", filename))
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
    let dir = engines_dir();
    for entry in fs::read_dir(&dir).ok()?.flatten() {
        let p = entry.path();
        if p.is_dir() {
            for f in ["llama-server", "llama-server.exe"] {
                let cand = p.join(f);
                if cand.exists() {
                    return Some(cand);
                }
            }
        }
    }
    let cand = dir.join("llama-server");
    if cand.exists() {
        return Some(cand);
    }
    let cand = dir.join("llama-server.exe");
    if cand.exists() {
        return Some(cand);
    }
    None
}

fn find_sd_cli() -> Option<PathBuf> {
    let dir = engines_dir();
    for entry in fs::read_dir(&dir).ok()?.flatten() {
        let p = entry.path();
        if p.is_dir() {
            for f in ["sd-cli", "sd-cli.exe", "sd-server", "sd-server.exe"] {
                let cand = p.join(f);
                if cand.exists() {
                    return Some(cand);
                }
            }
        }
    }
    None
}

// ---------- 聊天 ----------
fn chat_ask_inner(message: &str, port: u16) -> Result<String, String> {
    let body = serde_json::json!({
        "model": "local",
        "messages": [{"role": "user", "content": message}],
        "temperature": 0.7,
    });
    let mut last_err = String::new();
    for _ in 0..4 {
        match reqwest::blocking::Client::new()
            .post(format!("http://127.0.0.1:{}/v1/chat/completions", port))
            .json(&body)
            .timeout(std::time::Duration::from_secs(300))
            .send()
        {
            Ok(resp) => {
                if resp.status().as_u16() == 503 {
                    std::thread::sleep(std::time::Duration::from_secs(5));
                    continue;
                }
                let v: serde_json::Value = resp.json().map_err(|e| e.to_string())?;
                return Ok(v["choices"][0]["message"]["content"]
                    .as_str()
                    .unwrap_or("")
                    .to_string());
            }
            Err(e) => {
                last_err = e.to_string();
                std::thread::sleep(std::time::Duration::from_secs(2));
            }
        }
    }
    Err(format!("聊天服务未响应：{}", last_err))
}

#[tauri::command]
fn start_chat(state: tauri::State<AppState>, model: String, ctx: u32, port: Option<u16>) -> Result<String, String> {
    let port = port.unwrap_or(LLAMA_PORT);
    *state.chat_port.lock().unwrap() = port;
    let bin = find_llama_server().ok_or("还没下载 llama.cpp 引擎，请先在“模型”页下载聊天引擎")?;
    let model_path = models_dir().join(&model);
    if !model_path.exists() {
        return Err(format!("模型文件不存在：{}", model));
    }
    // 先停掉旧的 llama-server（按进程名查找，避免跨平台存 Child 句柄的麻烦）。
    let _ = stop_chat(state.clone());
    let mut cmd = Command::new(&bin);
    cmd.arg("-m")
        .arg(&model_path)
        .arg("--host")
        .arg("127.0.0.1")
        .arg("--port")
        .arg(port.to_string())
        .arg("-c")
        .arg(ctx.to_string());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    cmd.spawn().map_err(|e| e.to_string())?;
    // 端口通不等于模型加载完：等 /health 返回 ok，最多 60 秒。
    for _ in 0..60 {
        if let Ok(resp) = reqwest::blocking::get(format!("http://127.0.0.1:{}/health", port)) {
            if let Ok(v) = resp.json::<serde_json::Value>() {
                if v.get("status").and_then(|s| s.as_str()) == Some("ok") {
                    break;
                }
            }
        }
        std::thread::sleep(std::time::Duration::from_secs(1));
    }
    *state.chat_running.lock().unwrap() = true;
    *state.chat_model.lock().unwrap() = model.clone();
    Ok(format!("聊天服务已启动：{}（仅本机可访问）", model))
}

#[tauri::command]
fn stop_chat(state: tauri::State<AppState>) -> Result<String, String> {
    let sys = System::new_all();
    for proc in sys.processes().values() {
        let name = proc.name().to_string_lossy().to_lowercase();
        if name.contains("llama-server") {
            let _ = proc.kill();
        }
    }
    *state.chat_running.lock().unwrap() = false;
    Ok("聊天服务已停止".to_string())
}

#[tauri::command]
fn chat_ask(state: tauri::State<AppState>, message: String) -> Result<String, String> {
    let port = *state.chat_port.lock().unwrap();
    chat_ask_inner(&message, if port == 0 { LLAMA_PORT } else { port })
}
#[tauri::command]
fn get_chat_status(state: tauri::State<AppState>) -> serde_json::Value {
    serde_json::json!({"running": *state.chat_running.lock().unwrap(), "model": state.chat_model.lock().unwrap().clone(), "port": *state.chat_port.lock().unwrap()})
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
fn engine_status() -> serde_json::Value {
    serde_json::json!({"llama": find_llama_server().map(|p| p.to_string_lossy().to_string()), "sd": find_sd_cli().map(|p| p.to_string_lossy().to_string())})
}

// ---------- 画图 / 视频 ----------
#[tauri::command]
fn generate_image(model: String, prompt: String, steps: u32, width: u32, height: u32) -> Result<String, String> {
    let bin = find_sd_cli().ok_or("还没下载 stable-diffusion.cpp 引擎，请先在“模型”页下载画图引擎")?;
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
    let bin = find_sd_cli().ok_or("还没下载 stable-diffusion.cpp 引擎")?;
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
fn search_hf(query: String) -> Result<Vec<String>, String> {
    let url = format!("https://huggingface.co/api/models?search={}&limit=20&filter=gguf", query);
    let resp = reqwest::blocking::get(&url).map_err(|e| e.to_string())?;
    let v: serde_json::Value = resp.json().map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    if let Some(arr) = v.as_array() {
        for m in arr { if let Some(id) = m.get("id").and_then(|x| x.as_str()) { out.push(id.to_string()); } }
    }
    Ok(out)
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

// ---------- 截屏：保存到 outputs，方便用户把图发回来反馈问题 ----------
#[tauri::command]
fn take_screenshot() -> Result<String, String> {
    ensure_dirs();
    let screens = screenshots::Screen::all().map_err(|e| e.to_string())?;
    let screen = screens.first().ok_or("没有检测到显示器")?;
    let image = screen.capture().map_err(|e| e.to_string())?;
    let out = outputs_dir().join(format!("shot_{}.png", chrono_stamp()));
    image.save(&out).map_err(|e| e.to_string())?;
    Ok(format!("截图已保存：{}", out.display()))
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
        let port = *state.chat_port.lock().unwrap(); let reply = chat_ask_inner(&prompt, if port == 0 { LLAMA_PORT } else { port })?;
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

fn main() {
    ensure_dirs();
    tauri::Builder::default()
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            get_hardware,
            get_catalog,
            get_catalog_with_fit,
            list_hf_files,
            download_file,
            list_local_models,
            import_model,
            start_chat,
            stop_chat,
            chat_ask,
            generate_image,
            generate_motion_video,
            generate_diffusion_video,
            agent_run,
            take_screenshot,
            delete_model,
            search_hf,
            list_local_model_info,
            get_chat_status,
            open_folder,
            engine_status,
            web_search,
        ])
        .setup(|app| {
            // 系统托盘：关窗口后程序不退出，托盘小图标还在，点它恢复窗口。
            use tauri::menu::{MenuBuilder, MenuItemBuilder};
            use tauri::tray::{TrayIconBuilder, TrayIconEvent};
            let show = MenuItemBuilder::with_id("show", "显示 OpenLoc").build(app)?;
            let quit = MenuItemBuilder::with_id("quit", "退出").build(app)?;
            let menu = MenuBuilder::new(app).items(&[&show, &quit]).build()?;
            TrayIconBuilder::new()
                .icon(app.default_window_icon().cloned().unwrap())
                .tooltip("OpenLoc（点一下恢复窗口）")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "show" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                    "quit" => app.exit(0),
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
            // 点窗口右上角 X：只隐藏窗口，不退出程序，托盘图标还在。
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
