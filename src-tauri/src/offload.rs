//! 按权重体积和显存决定 llama-server 的 `-ngl`。
//! 读不到层数时不假装算过；放不进显存又不知道层数时不把层塞进显卡。

use std::fs::File;
use std::io::Read;
use std::path::Path;

const READ_LIMIT: usize = 4 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OffloadPlan {
    pub gpu_layers: u32,
    pub message: String,
}

pub fn plan(block_count: u32, weight_bytes: u64, vram_bytes: u64) -> OffloadPlan {
    let weight = format_gb(weight_bytes);
    let vram = format_gb(vram_bytes);
    if vram_bytes == 0 {
        return OffloadPlan {
            gpu_layers: 0,
            message: format!("没有检测到 NVIDIA 显存，按 CPU 启动（GPU 层数 0）。模型约 {weight}，层放在内存里。"),
        };
    }
    let usable = (vram_bytes as f64) * 0.85;
    let overhead = 800_u64 * 1024 * 1024;
    if block_count == 0 {
        if (weight_bytes.saturating_add(overhead) as f64) <= usable {
            return OffloadPlan {
                gpu_layers: 999,
                message: format!("没读到层数。模型约 {weight}，显存约 {vram}，看起来放得下，已请求尽量放进显卡（GPU 层数 999）。这不是逐层实测。"),
            };
        }
        return OffloadPlan {
            gpu_layers: 0,
            message: format!("没读到层数，模型约 {weight}，显存约 {vram}，放不进显存。这次不把层放到显卡（GPU 层数 0），避免显存不够直接失败。层放在内存里，会更慢。"),
        };
    }
    if (weight_bytes.saturating_add(overhead) as f64) <= usable {
        return OffloadPlan {
            gpu_layers: block_count,
            message: format!("模型约 {weight}，显存约 {vram}，按体积可以放进显卡（GPU 层数 {block_count}/{block_count}）。"),
        };
    }
    let budget = usable - (overhead as f64);
    let budget = if budget > 0.0 { budget } else { 0.0 };
    let layers = if weight_bytes == 0 {
        0
    } else {
        ((block_count as f64) * budget / (weight_bytes as f64)).floor() as u32
    };
    let layers = layers.min(block_count.saturating_sub(1));
    OffloadPlan {
        gpu_layers: layers,
        message: format!("模型约 {weight}，显存约 {vram}，将把一部分层放在内存（GPU 层数 {layers}/{block_count}）。速度会慢于全部放进显卡。"),
    }
}

fn format_gb(bytes: u64) -> String {
    let gb = (bytes as f64) / 1024.0 / 1024.0 / 1024.0;
    if bytes == 0 {
        "0 GB".to_string()
    } else {
        format!("{gb:.1} GB")
    }
}

pub fn block_count(path: &Path) -> Option<u32> {
    let mut file = File::open(path).ok()?;
    let mut buf = vec![0u8; READ_LIMIT];
    let n = file.read(&mut buf).ok()?;
    buf.truncate(n);
    block_count_from_bytes(&buf)
}

pub fn block_count_from_bytes(data: &[u8]) -> Option<u32> {
    if data.len() < 24 || &data[0..4] != b"GGUF" {
        return None;
    }
    let mut i = 4usize;
    let _version = read_u32(data, &mut i)?;
    let _tensors = read_u64(data, &mut i)?;
    let pairs = read_u64(data, &mut i)?;
    for _ in 0..pairs {
        let key_len = read_u64(data, &mut i)? as usize;
        if i + key_len > data.len() {
            return None;
        }
        let key = String::from_utf8_lossy(&data[i..i + key_len]).to_string();
        i += key_len;
        let ty = read_u32(data, &mut i)?;
        if key.ends_with(".block_count") {
            return read_int(data, &mut i, ty);
        }
        i = skip_value(data, i, ty)?;
    }
    None
}

fn read_u32(data: &[u8], i: &mut usize) -> Option<u32> {
    let end = i.checked_add(4)?;
    let bytes: [u8; 4] = data.get(*i..end)?.try_into().ok()?;
    *i = end;
    Some(u32::from_le_bytes(bytes))
}

fn read_u64(data: &[u8], i: &mut usize) -> Option<u64> {
    let end = i.checked_add(8)?;
    let bytes: [u8; 8] = data.get(*i..end)?.try_into().ok()?;
    *i = end;
    Some(u64::from_le_bytes(bytes))
}

fn read_int(data: &[u8], i: &mut usize, ty: u32) -> Option<u32> {
    match ty {
        4 | 5 => read_u32(data, i).map(|n| n as u32),
        10 | 11 => {
            let n = read_u64(data, i)?;
            u32::try_from(n).ok()
        }
        _ => None,
    }
}

fn skip_value(data: &[u8], mut i: usize, ty: u32) -> Option<usize> {
    match ty {
        0 | 1 | 7 => i = i.checked_add(1)?,
        2 | 3 => i = i.checked_add(2)?,
        4 | 5 | 6 => i = i.checked_add(4)?,
        10 | 11 | 12 => i = i.checked_add(8)?,
        8 => {
            let len = read_u64(data, &mut i)? as usize;
            i = i.checked_add(len)?;
        }
        9 => {
            let et = read_u32(data, &mut i)?;
            let n = read_u64(data, &mut i)? as usize;
            if n > 1_000_000 {
                return None;
            }
            for _ in 0..n {
                i = skip_value(data, i, et)?;
            }
        }
        _ => return None,
    }
    if i > data.len() {
        None
    } else {
        Some(i)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gguf_with_block_count(key: &str, value: u32) -> Vec<u8> {
        let mut buf = Vec::new();
        buf.extend(b"GGUF");
        buf.extend(&3u32.to_le_bytes());
        buf.extend(&0u64.to_le_bytes());
        buf.extend(&1u64.to_le_bytes());
        buf.extend(&(key.len() as u64).to_le_bytes());
        buf.extend(key.as_bytes());
        buf.extend(&4u32.to_le_bytes());
        buf.extend(&value.to_le_bytes());
        buf
    }

    #[test]
    fn reads_block_count_and_ignores_other_files() {
        let raw = gguf_with_block_count("qwen2.block_count", 36);
        assert_eq!(block_count_from_bytes(&raw), Some(36));
        assert_eq!(block_count_from_bytes(b"not a model"), None);
    }

    #[test]
    fn partial_offload_when_vram_is_short() {
        let nine_gb = 9 * 1024 * 1024 * 1024;
        let eight_gb = 8 * 1024 * 1024 * 1024;
        let partial = plan(40, nine_gb, eight_gb);
        assert!(partial.gpu_layers < 40, "{}", partial.message);
        assert!(partial.message.contains("一部分层放在内存"), "{}", partial.message);
        assert!(partial.message.contains("GPU 层数"), "{}", partial.message);
        let fit = super::plan(32, 4 * 1024 * 1024 * 1024, eight_gb);
        assert_eq!(fit.gpu_layers, 32);
        assert!(fit.message.contains("32/32"));
        let cpu = super::plan(32, nine_gb, 0);
        assert_eq!(cpu.gpu_layers, 0);
        assert!(cpu.message.contains("CPU"));
        let unknown = super::plan(0, nine_gb, eight_gb);
        assert_eq!(unknown.gpu_layers, 0);
        assert!(unknown.message.contains("没读到层数"));
    }
}
