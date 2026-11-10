//! 下载前的磁盘判断、真实进度文案，以及可取消的拷贝。
//! 不编造百分比，也不把取消后的半截文件说成已经下好。

use std::io::{Read, Write};

pub const SPACE_MARGIN: u64 = 512 * 1024 * 1024;

pub fn format_bytes(n: u64) -> String {
    const KB: f64 = 1024.0;
    const MB: f64 = 1024.0 * 1024.0;
    const GB: f64 = 1024.0 * 1024.0 * 1024.0;
    let n = n as f64;
    if n >= GB {
        format!("{:.1} GB", n / GB)
    } else if n >= MB {
        format!("{:.1} MB", n / MB)
    } else if n >= KB {
        format!("{:.0} KB", n / KB)
    } else {
        format!("{n:.0} B")
    }
}

pub fn format_rate(bytes_per_sec: u64) -> String {
    format!("{}/s", format_bytes(bytes_per_sec))
}

/// 有 Content-Length 就用它。没有才用仓库列出的字节。两边都没有就不开始。
pub fn pick_length(declared: u64, content_length: Option<u64>) -> Option<u64> {
    if let Some(n) = content_length.filter(|n| *n > 0) {
        return Some(n);
    }
    if declared > 0 {
        Some(declared)
    } else {
        None
    }
}

pub fn missing_size_message(name: &str) -> String {
    format!("没读到「{name}」的大小，这次没有开始下载，避免占满磁盘。")
}

/// 不够就返回原因。够则 None，调用方才可以创建文件。
pub fn space_refusal(free: u64, need: u64) -> Option<String> {
    let required = need.saturating_add(SPACE_MARGIN);
    if free >= required {
        return None;
    }
    let short = required - free;
    Some(format!(
        "空间不够，这次没有开始下载。整套 {}，还要留 {}，目标盘可用 {}，还差 {}。",
        format_bytes(need),
        format_bytes(SPACE_MARGIN),
        format_bytes(free),
        format_bytes(short)
    ))
}

fn norm_path(path: &str) -> String {
    let slash = path.replace('\\', "/");
    let trimmed = if slash.len() > 1 {
        slash.trim_end_matches('/').to_string()
    } else {
        slash
    };
    trimmed.to_ascii_lowercase()
}

/// 选能装下目标路径的那块盘。挂载点越长越优先，避免 `/` 盖住 `/data`。
pub fn free_on_mounts(path: &str, mounts: &[(&str, u64)]) -> Option<u64> {
    let path = norm_path(path);
    let mut best: Option<(usize, u64)> = None;
    for (mount, free) in mounts {
        let mount = norm_path(mount);
        if mount.is_empty() {
            continue;
        }
        let matched = if mount == "/" {
            path.starts_with('/')
        } else {
            path == mount || path.starts_with(&(mount.clone() + "/"))
        };
        if !matched {
            continue;
        }
        let longer = best.map(|(len, _)| mount.len() > len).unwrap_or(true);
        if longer {
            best = Some((mount.len(), *free));
        }
    }
    best.map(|(_, free)| free)
}

pub fn progress_label(
    name: &str,
    index: usize,
    count: usize,
    received: u64,
    total: u64,
    bytes_per_sec: u64,
) -> String {
    let which = if count > 1 {
        format!("（{index}/{count}）")
    } else {
        String::new()
    };
    format!(
        "正在下载 {name}{which}：{} / {}，约 {}。",
        format_bytes(received),
        format_bytes(total),
        format_rate(bytes_per_sec)
    )
}

pub fn done_message(paths: &[String]) -> String {
    if paths.is_empty() {
        return "没有文件被写入。".to_string();
    }
    format!("已下载到 {}。", paths.join("、"))
}

pub fn already_local_message(paths: &[String]) -> String {
    format!("已在目标目录，没有重新下载：{}。", paths.join("、"))
}

pub fn cancel_message(kept_complete: usize) -> String {
    if kept_complete == 0 {
        "已取消下载。没下完的文件已删除。".to_string()
    } else {
        format!("已取消下载。没下完的文件已删除。已经下完整的 {kept_complete} 个文件留在目录里。")
    }
}

pub fn removed_partial_note(name: &str) -> String {
    format!("「{name}」上次没下完，已删除，这次从头下载。")
}

#[derive(Debug, PartialEq, Eq)]
pub enum CopyStop {
    Finished,
    Cancelled,
}

/// 按实际读到的字节回调。调用方用读到的量显示进度，不先画一个假的百分比。
pub fn copy_counted<R: Read>(
    mut reader: R,
    mut writer: impl Write,
    total: u64,
    mut stop: impl FnMut() -> bool,
    mut on_chunk: impl FnMut(u64),
) -> Result<CopyStop, String> {
    let mut buf = [0u8; 64 * 1024];
    let mut got = 0u64;
    loop {
        if stop() {
            return Ok(CopyStop::Cancelled);
        }
        let n = reader.read(&mut buf).map_err(|e| format!("读取下载数据失败：{e}"))?;
        if n == 0 {
            break;
        }
        writer
            .write_all(&buf[..n])
            .map_err(|e| format!("写入文件失败：{e}"))?;
        got = got.saturating_add(n as u64);
        on_chunk(got);
        if total > 0 && got > total.saturating_add(1024 * 1024) {
            return Err("下载比读到的大小多出 1 MB 以上，已停止，避免写满磁盘。没下完的文件不会保留。".to_string());
        }
    }
    if stop() {
        return Ok(CopyStop::Cancelled);
    }
    if total > 0 && got < total {
        return Err(format!(
            "下载提前结束：收到 {}，预期 {}。没下完的文件不会保留。",
            format_bytes(got),
            format_bytes(total)
        ));
    }
    Ok(CopyStop::Finished)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    use std::sync::atomic::{AtomicBool, Ordering};

    #[test]
    fn short_disk_explains_the_gap_and_does_not_start() {
        let need = 12 * 1024 * 1024 * 1024;
        let free = 7 * 1024 * 1024 * 1024;
        let text = space_refusal(free, need).unwrap();
        assert!(text.contains("没有开始下载"), "{text}");
        assert!(text.contains("还差"), "{text}");
        assert!(text.contains("512"), "{text}");
        assert!(space_refusal(need + SPACE_MARGIN, need).is_none());
        assert!(space_refusal(need + SPACE_MARGIN - 1, need).is_some());
    }

    #[test]
    fn length_comes_from_the_server_when_it_sends_one() {
        assert_eq!(pick_length(10, Some(20)), Some(20));
        assert_eq!(pick_length(10, None), Some(10));
        assert_eq!(pick_length(0, Some(8)), Some(8));
        assert_eq!(pick_length(0, None), None);
        assert_eq!(pick_length(0, Some(0)), None);
        let missing = missing_size_message("model.gguf");
        assert!(missing.contains("没有开始下载"));
        assert!(missing.contains("model.gguf"));
    }

    #[test]
    fn mount_match_prefers_the_longer_drive() {
        let mounts = [("/", 1u64), ("/data", 9u64), ("/database", 3u64)];
        assert_eq!(free_on_mounts("/data/models/a.gguf", &mounts), Some(9));
        assert_eq!(free_on_mounts("/var/tmp", &mounts), Some(1));
        assert_eq!(free_on_mounts("/database/x", &mounts), Some(3));
        let win = [("C:\\", 5u64), ("D:\\", 8u64)];
        assert_eq!(free_on_mounts("C:\\OpenLoc\\data\\models", &win), Some(5));
        assert_eq!(free_on_mounts("D:\\models\\a.gguf", &win), Some(8));
    }

    #[test]
    fn progress_uses_real_bytes_and_cancel_drops_the_partial() {
        let data = vec![7u8; 200_000];
        let stop = AtomicBool::new(false);
        let mut out = Vec::new();
        let mut seen = Vec::new();
        let end = copy_counted(Cursor::new(data.clone()), &mut out, data.len() as u64, || stop.load(Ordering::SeqCst), |n| {
            seen.push(n);
        })
        .unwrap();
        assert_eq!(end, CopyStop::Finished);
        assert_eq!(out.len(), data.len());
        assert!(seen.last().copied().unwrap() >= data.len() as u64);
        let label = progress_label("a.gguf", 1, 2, 1024 * 1024, 10 * 1024 * 1024, 512 * 1024);
        assert!(label.contains("a.gguf"));
        assert!(label.contains("1/2"));
        assert!(label.contains('/'));
        assert!(!label.contains("续传"));
        assert!(done_message(&["C:\\m\\a.gguf".into()]).contains("已下载到"));
        let cancel = cancel_message(0);
        assert!(cancel.contains("已取消"));
        assert!(cancel.contains("已删除"));
        assert!(!cancel.contains("续传"));

        let stop = AtomicBool::new(true);
        let mut out = Vec::new();
        let end = copy_counted(Cursor::new(data), &mut out, 200_000, || stop.load(Ordering::SeqCst), |_| {}).unwrap();
        assert_eq!(end, CopyStop::Cancelled);
        assert!(out.is_empty());
    }

    #[test]
    fn short_body_is_not_called_complete() {
        let stop = AtomicBool::new(false);
        let err = copy_counted(Cursor::new(vec![1, 2, 3]), Vec::<u8>::new(), 100, || stop.load(Ordering::SeqCst), |_| {}).unwrap_err();
        assert!(err.contains("不会保留"), "{err}");
    }
}
