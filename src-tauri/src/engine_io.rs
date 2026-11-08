//! 引擎压缩包解压、可执行文件查找、本机端口是否能绑定。
//! 不启动进程，也不访问网络。

use std::fs::{self, File};
use std::io;
use std::path::{Component, Path, PathBuf};

pub fn find_named_binary(root: &Path, names: &[&str]) -> Option<PathBuf> {
    find_named_binary_depth(root, names, 0)
}

fn find_named_binary_depth(root: &Path, names: &[&str], depth: usize) -> Option<PathBuf> {
    if depth > 8 || !root.is_dir() {
        return None;
    }
    let mut dirs = Vec::new();
    let rd = fs::read_dir(root).ok()?;
    for entry in rd.flatten() {
        let path = entry.path();
        if path.is_file() {
            let fname = entry.file_name();
            let fname = fname.to_string_lossy();
            if names.iter().any(|n| fname.eq_ignore_ascii_case(n)) {
                return Some(path);
            }
        } else if path.is_dir() {
            dirs.push(path);
        }
    }
    for dir in dirs {
        if let Some(hit) = find_named_binary_depth(&dir, names, depth + 1) {
            return Some(hit);
        }
    }
    None
}

pub fn safe_join(dest: &Path, name: &str) -> Result<PathBuf, String> {
    if name.is_empty() || name.contains('\0') {
        return Err("压缩包路径不安全，已停止解压。".to_string());
    }
    let rel = Path::new(name);
    if rel.is_absolute() {
        return Err(
            "压缩包包含绝对路径，已停止解压。下一步：不要使用来路不明的压缩包，改回设置里的官方地址再安装。"
                .to_string(),
        );
    }
    let mut out = dest.to_path_buf();
    for c in rel.components() {
        match c {
            Component::Normal(part) => out.push(part),
            Component::CurDir => {}
            _ => {
                return Err(
                    "压缩包包含不安全路径，已停止解压。下一步：不要使用来路不明的压缩包，改回设置里的官方地址再安装。"
                        .to_string(),
                );
            }
        }
    }
    Ok(out)
}

pub fn extract_zip(zip_path: &Path, dest_dir: &Path) -> Result<(), String> {
    let file = File::open(zip_path).map_err(|e| format!("打不开压缩包：{e}"))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| {
        format!("压缩包打不开或没有下完整：{e}。下一步：删除 data/engines 里对应的 zip 后重新安装。")
    })?;
    fs::create_dir_all(dest_dir).map_err(|e| format!("无法创建引擎目录：{e}"))?;
    let mut total: u64 = 0;
    const MAX_BYTES: u64 = 2 * 1024 * 1024 * 1024;
    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("读取压缩包条目失败：{e}"))?;
        let raw_name = entry.name().to_string();
        if raw_name.is_empty() {
            continue;
        }
        let out = safe_join(dest_dir, &raw_name)?;
        if raw_name.ends_with('/') || entry.is_dir() {
            fs::create_dir_all(&out).map_err(|e| format!("创建目录失败：{e}"))?;
            continue;
        }
        if let Some(parent) = out.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("创建目录失败：{e}"))?;
        }
        let mut outfile = File::create(&out).map_err(|e| format!("写出文件失败：{e}"))?;
        let n = io::copy(&mut entry, &mut outfile).map_err(|e| format!("解压失败：{e}"))?;
        total = total.saturating_add(n);
        if total > MAX_BYTES {
            return Err(
                "解压后的体积超过 2GB，已停止。下一步：确认下载的是 CPU 可执行包，而不是带多套 CUDA 运行库的超大包。"
                    .to_string(),
            );
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if let Some(mode) = entry.unix_mode() {
                let _ = fs::set_permissions(&out, fs::Permissions::from_mode(mode));
            }
            let fname = out.file_name().and_then(|s| s.to_str()).unwrap_or("");
            if matches!(fname, "llama-server" | "sd-cli" | "sd-server") {
                let _ = fs::set_permissions(&out, fs::Permissions::from_mode(0o755));
            }
        }
    }
    Ok(())
}

/// 只探测 127.0.0.1。绑定成功后立即放开，避免自己占住端口。
pub fn port_bindable(port: u16) -> bool {
    if port == 0 {
        return false;
    }
    match std::net::TcpListener::bind(("127.0.0.1", port)) {
        Ok(listener) => {
            drop(listener);
            true
        }
        Err(_) => false,
    }
}

pub fn tail_text(path: &Path, max_chars: usize) -> String {
    let text = fs::read_to_string(path).unwrap_or_default().replace('\0', "");
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return "（日志是空的）".to_string();
    }
    let count = trimmed.chars().count();
    if count <= max_chars {
        trimmed.to_string()
    } else {
        trimmed.chars().skip(count - max_chars).collect()
    }
}

pub fn should_stop_process(name: &str, pid: u32, our_pid: Option<u32>, cmd_has_our_engine: bool) -> bool {
    if !name.to_lowercase().contains("llama-server") {
        return false;
    }
    Some(pid) == our_pid || cmd_has_our_engine
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write_zip(path: &Path, files: &[(&str, &[u8])]) -> zip::result::ZipResult<()> {
        let file = File::create(path)?;
        let mut zip = zip::ZipWriter::new(file);
        let opts = zip::write::SimpleFileOptions::default();
        for (name, bytes) in files {
            zip.start_file(*name, opts)?;
            zip.write_all(bytes)?;
        }
        zip.finish()?;
        Ok(())
    }

    #[test]
    fn finds_nested_and_flat_llama_server() {
        let root = std::env::temp_dir().join(format!("openloc-find-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("llama/win")).unwrap();
        fs::write(root.join("llama/win/llama-server.exe"), b"exe").unwrap();
        let hit = find_named_binary(&root, &["llama-server", "llama-server.exe"]).unwrap();
        assert!(hit.ends_with("llama-server.exe"));
        fs::write(root.join("llama-server"), b"bin").unwrap();
        let hit = find_named_binary(&root, &["llama-server", "llama-server.exe"]).unwrap();
        assert!(hit.ends_with("llama-server") || hit.ends_with("llama-server.exe"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn extract_zip_finds_root_exe_like_windows_cpu_pack() {
        let root = std::env::temp_dir().join(format!("openloc-zip-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let zip_path = root.join("llama.zip");
        write_zip(
            &zip_path,
            &[
                ("llama-server.exe", b"not-a-real-binary"),
                ("ggml.dll", b"dll"),
                ("nested/llama-cli.exe", b"cli"),
            ],
        )
        .unwrap();
        let dest = root.join("llama");
        extract_zip(&zip_path, &dest).unwrap();
        let hit = find_named_binary(&dest, &["llama-server.exe"]).unwrap();
        assert_eq!(fs::read(&hit).unwrap(), b"not-a-real-binary");
        assert!(dest.join("ggml.dll").is_file());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn extract_rejects_zip_slip() {
        let root = std::env::temp_dir().join(format!("openloc-slip-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let zip_path = root.join("bad.zip");
        write_zip(&zip_path, &[("../evil.txt", b"nope")]).unwrap();
        let dest = root.join("out");
        let err = extract_zip(&zip_path, &dest).unwrap_err();
        assert!(err.contains("不安全") || err.contains("绝对路径") || err.contains("停止解压"));
        assert!(!root.join("evil.txt").exists());
        assert!(!dest.join("evil.txt").exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn port_zero_is_not_bindable_and_busy_port_is_detected() {
        assert!(!port_bindable(0));
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        assert!(!port_bindable(port));
        drop(listener);
        assert!(port_bindable(port));
    }

    #[test]
    fn stop_only_matches_our_llama_server() {
        assert!(should_stop_process("llama-server.exe", 5, Some(5), false));
        assert!(should_stop_process("llama-server", 9, None, true));
        assert!(!should_stop_process("llama-server", 9, Some(5), false));
        assert!(!should_stop_process("notepad.exe", 5, Some(5), true));
    }
}
