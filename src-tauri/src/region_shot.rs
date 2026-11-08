//! 对话里的截图只走区域选择。
//! 确认后才把 PNG 写到调用方给的路径；取消或失败不写整屏，避免没选却贴上一张全屏。

use std::fs;
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};

pub const CANCELLED: &str = "已取消选区，没有贴上图片。";
pub const NO_TOOL: &str = "这台电脑没有可用的区域截图工具，没有改成整屏截图，也没有贴上图片。";
pub const NO_GUI: &str = "当前没有图形桌面，不能框选截图，没有贴上图片。";

#[derive(Debug, PartialEq, Eq)]
pub enum RegionEnd {
    Saved,
    Cancelled,
    Failed(String),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PathMode {
    /// 参数后面再跟输出文件路径。
    TrailingPath,
    /// 工具把 PNG 打到标准输出。
    StdoutPng,
    /// Wayland：slurp 选区，grim 按几何写入文件。
    SlurpGrim,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RegionTool {
    pub program: &'static str,
    pub args_before_path: &'static [&'static str],
    pub path_mode: PathMode,
}

/// 这些参数都是「让用户框一块」，不是整屏。顺序只影响先试哪一个。
pub fn unix_region_tools() -> &'static [RegionTool] {
    &[
        RegionTool {
            program: "gnome-screenshot",
            args_before_path: &["-a", "-f"],
            path_mode: PathMode::TrailingPath,
        },
        RegionTool {
            program: "spectacle",
            args_before_path: &["-r", "-b", "-n", "-o"],
            path_mode: PathMode::TrailingPath,
        },
        RegionTool {
            program: "scrot",
            args_before_path: &["-s"],
            path_mode: PathMode::TrailingPath,
        },
        RegionTool {
            program: "screencapture",
            args_before_path: &["-i"],
            path_mode: PathMode::TrailingPath,
        },
        RegionTool {
            program: "flameshot",
            args_before_path: &["gui", "-r"],
            path_mode: PathMode::StdoutPng,
        },
        RegionTool {
            program: "grim",
            args_before_path: &[],
            path_mode: PathMode::SlurpGrim,
        },
    ]
}

pub fn classify_region_end(code: Option<i32>, is_png: bool) -> RegionEnd {
    if code == Some(2) {
        return RegionEnd::Cancelled;
    }
    if code == Some(0) && is_png {
        return RegionEnd::Saved;
    }
    if code == Some(0) {
        return RegionEnd::Failed("选区没有生成图片，没有贴上图片。".to_string());
    }
    RegionEnd::Failed("选区截图没有完成，没有贴上图片。".to_string())
}

pub fn windows_region_script() -> &'static str {
    WINDOWS_REGION_PS1
}

/// 点「截图」后：先把屏幕冻在内存里，再让用户框选。
/// 只有点「确认」或按 Enter 才把选区裁下来写到 -OutFile。
/// Esc、右键或「取消」直接退出，不写文件。不会把整屏存成附件。
/// 事件回调里用 $script: 和 global 函数，避免 WinForms 回调找不到脚本里的函数。
const WINDOWS_REGION_PS1: &str = r#"
param(
  [Parameter(Mandatory = $true)]
  [string]$OutFile
)
$ErrorActionPreference = "Stop"
Add-Type -TypeDefinition @"
using System.Runtime.InteropServices;
public class OpenLocDpi {
  [DllImport("user32.dll")]
  public static extern bool SetProcessDPIAware();
}
"@
[OpenLocDpi]::SetProcessDPIAware() | Out-Null
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
if ($vs.Width -lt 8 -or $vs.Height -lt 8) {
  [Console]::Error.WriteLine("没有检测到显示器")
  exit 1
}

$script:full = New-Object System.Drawing.Bitmap $vs.Width, $vs.Height
$grab = [System.Drawing.Graphics]::FromImage($script:full)
$grab.CopyFromScreen($vs.X, $vs.Y, 0, 0, $script:full.Size)
$grab.Dispose()

$script:form = New-Object System.Windows.Forms.Form
$script:form.FormBorderStyle = "None"
$script:form.StartPosition = "Manual"
$script:form.Location = New-Object System.Drawing.Point $vs.X, $vs.Y
$script:form.Size = New-Object System.Drawing.Size $vs.Width, $vs.Height
$script:form.TopMost = $true
$script:form.ShowInTaskbar = $false
$script:form.KeyPreview = $true
$script:form.Cursor = [System.Windows.Forms.Cursors]::Cross
$script:form.BackColor = [System.Drawing.Color]::Black
$dbl = $script:form.GetType().GetProperty("DoubleBuffered", [Reflection.BindingFlags]"Instance,NonPublic")
if ($dbl) { $dbl.SetValue($script:form, $true, $null) }

$script:dragging = $false
$script:accepted = $false
$script:start = New-Object System.Drawing.Point 0, 0
$script:rect = [System.Drawing.Rectangle]::Empty

$hint = New-Object System.Windows.Forms.Label
$hint.Text = "拖拽框选要截的区域，然后点「确认」。Esc 或「取消」不贴图。"
$hint.ForeColor = [System.Drawing.Color]::White
$hint.BackColor = [System.Drawing.Color]::FromArgb(255, 29, 78, 216)
$hint.TextAlign = "MiddleCenter"
$hint.AutoSize = $false
$hint.Height = 36
$hint.Width = [Math]::Min(640, [Math]::Max(280, $script:form.ClientSize.Width - 48))
$hint.Location = New-Object System.Drawing.Point ([Math]::Max(8, ($script:form.ClientSize.Width - $hint.Width) / 2), 20)
$script:form.Controls.Add($hint)

$script:confirm = New-Object System.Windows.Forms.Button
$script:confirm.Text = "确认"
$script:confirm.Size = New-Object System.Drawing.Size 88, 32
$script:confirm.Visible = $false
$script:confirm.FlatStyle = "Flat"
$script:confirm.BackColor = [System.Drawing.Color]::FromArgb(255, 37, 99, 235)
$script:confirm.ForeColor = [System.Drawing.Color]::White
$script:cancelBtn = New-Object System.Windows.Forms.Button
$script:cancelBtn.Text = "取消"
$script:cancelBtn.Size = New-Object System.Drawing.Size 88, 32
$script:cancelBtn.Visible = $false
$script:cancelBtn.FlatStyle = "Flat"
$script:form.Controls.Add($script:cancelBtn)
$script:form.Controls.Add($script:confirm)

function global:OpenLocHideActions {
  $script:confirm.Visible = $false
  $script:cancelBtn.Visible = $false
}
function global:OpenLocShowActions([System.Drawing.Rectangle]$r) {
  $bw = 88
  $bh = 32
  $pad = 8
  $x = $r.X + $r.Width - ($bw * 2 + $pad)
  $y = $r.Y + $r.Height + $pad
  if ($x -lt 8) { $x = 8 }
  $maxX = $script:form.ClientSize.Width - ($bw * 2 + $pad) - 8
  if ($x -gt $maxX) { $x = [Math]::Max(8, $maxX) }
  if ($y + $bh -gt $script:form.ClientSize.Height - 8) { $y = $r.Y - $bh - $pad }
  if ($y -lt 48) { $y = 48 }
  $script:cancelBtn.Location = New-Object System.Drawing.Point $x, $y
  $script:confirm.Location = New-Object System.Drawing.Point ($x + $bw + $pad), $y
  $script:cancelBtn.Visible = $true
  $script:confirm.Visible = $true
  $script:cancelBtn.BringToFront()
  $script:confirm.BringToFront()
}

$script:form.Add_MouseDown({
  if ($_.Button -eq [System.Windows.Forms.MouseButtons]::Right) {
    $script:accepted = $false
    $script:form.Close()
    return
  }
  if ($_.Button -ne [System.Windows.Forms.MouseButtons]::Left) { return }
  $script:dragging = $true
  $script:start = $_.Location
  $script:rect = [System.Drawing.Rectangle]::Empty
  OpenLocHideActions
  $script:form.Invalidate()
})
$script:form.Add_MouseMove({
  if (-not $script:dragging) { return }
  $x1 = [Math]::Min($script:start.X, $_.X)
  $y1 = [Math]::Min($script:start.Y, $_.Y)
  $x2 = [Math]::Max($script:start.X, $_.X)
  $y2 = [Math]::Max($script:start.Y, $_.Y)
  $script:rect = New-Object System.Drawing.Rectangle $x1, $y1, ($x2 - $x1), ($y2 - $y1)
  $script:form.Invalidate()
})
$script:form.Add_MouseUp({
  if (-not $script:dragging) { return }
  $script:dragging = $false
  if ($script:rect.Width -ge 8 -and $script:rect.Height -ge 8) {
    OpenLocShowActions $script:rect
  } else {
    OpenLocHideActions
  }
  $script:form.Invalidate()
})
$script:form.Add_KeyDown({
  if ($_.KeyCode -eq [System.Windows.Forms.Keys]::Escape) {
    $script:accepted = $false
    $script:form.Close()
  } elseif ($_.KeyCode -eq [System.Windows.Forms.Keys]::Enter) {
    if ($script:rect.Width -ge 8 -and $script:rect.Height -ge 8) {
      $script:accepted = $true
      $script:form.Close()
    }
  }
})
$script:confirm.Add_Click({
  if ($script:rect.Width -ge 8 -and $script:rect.Height -ge 8) {
    $script:accepted = $true
    $script:form.Close()
  }
})
$script:cancelBtn.Add_Click({
  $script:accepted = $false
  $script:form.Close()
})
$script:form.Add_Paint({
  $g = $_.Graphics
  $g.DrawImage($script:full, 0, 0, $script:full.Width, $script:full.Height)
  $dim = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(90, 0, 0, 0))
  $g.FillRectangle($dim, 0, 0, $script:form.ClientSize.Width, $script:form.ClientSize.Height)
  $dim.Dispose()
  if ($script:rect.Width -ge 1 -and $script:rect.Height -ge 1) {
    $g.DrawImage($script:full, $script:rect, $script:rect, [System.Drawing.GraphicsUnit]::Pixel)
    $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(255, 37, 99, 235), 3)
    $g.DrawRectangle($pen, $script:rect)
    $pen.Dispose()
  }
})

[void]$script:form.ShowDialog()
$script:form.Dispose()

if (-not $script:accepted) {
  $script:full.Dispose()
  exit 2
}

$x = [Math]::Max(0, [Math]::Min([int]$script:rect.X, $script:full.Width - 1))
$y = [Math]::Max(0, [Math]::Min([int]$script:rect.Y, $script:full.Height - 1))
$rw = [Math]::Min([int]$script:rect.Width, $script:full.Width - $x)
$rh = [Math]::Min([int]$script:rect.Height, $script:full.Height - $y)
if ($rw -lt 8 -or $rh -lt 8) {
  $script:full.Dispose()
  exit 2
}
$cropRect = New-Object System.Drawing.Rectangle $x, $y, $rw, $rh
$crop = $script:full.Clone($cropRect, $script:full.PixelFormat)
$script:full.Dispose()
$crop.Save($OutFile, [System.Drawing.Imaging.ImageFormat]::Png)
$crop.Dispose()
exit 0
"#;

fn command_exists(cmd: &str) -> bool {
    #[cfg(windows)]
    let finder = "where";
    #[cfg(not(windows))]
    let finder = "which";
    Command::new(finder)
        .arg(cmd)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

fn gui_session() -> bool {
    if cfg!(windows) || cfg!(target_os = "macos") {
        return true;
    }
    std::env::var_os("DISPLAY").is_some() || std::env::var_os("WAYLAND_DISPLAY").is_some()
}

pub fn is_png(path: &Path) -> bool {
    let mut file = match fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return false,
    };
    let mut buf = [0u8; 8];
    matches!(file.read(&mut buf), Ok(8) if buf == *b"\x89PNG\r\n\x1a\n")
}

fn finish(out: &Path, code: Option<i32>, stderr: &str) -> Result<(), String> {
    match classify_region_end(code, is_png(out)) {
        RegionEnd::Saved => Ok(()),
        RegionEnd::Cancelled => {
            let _ = fs::remove_file(out);
            Err(CANCELLED.to_string())
        }
        RegionEnd::Failed(msg) => {
            let _ = fs::remove_file(out);
            let extra = stderr.trim();
            if extra.is_empty() {
                Err(msg)
            } else {
                let clip: String = extra.chars().take(180).collect();
                Err(format!("{msg} {clip}"))
            }
        }
    }
}

fn run_trailing(tool: &RegionTool, out: &Path) -> Result<(), String> {
    let mut cmd = Command::new(tool.program);
    cmd.args(tool.args_before_path);
    cmd.arg(out);
    let status = cmd.status().map_err(|e| format!("无法打开选区工具 {}：{}", tool.program, e))?;
    finish(out, status.code(), "")
}

fn run_stdout(tool: &RegionTool, out: &Path) -> Result<(), String> {
    let output = Command::new(tool.program)
        .args(tool.args_before_path)
        .output()
        .map_err(|e| format!("无法打开选区工具 {}：{}", tool.program, e))?;
    if output.status.success() && output.stdout.starts_with(b"\x89PNG\r\n\x1a\n") {
        fs::write(out, &output.stdout).map_err(|e| format!("保存选区失败：{}", e))?;
        return Ok(());
    }
    let _ = fs::remove_file(out);
    if output.status.success() {
        Err("选区没有生成图片，没有贴上图片。".to_string())
    } else {
        Err(CANCELLED.to_string())
    }
}

fn run_slurp_grim(out: &Path) -> Result<(), String> {
    let slurp = Command::new("slurp")
        .output()
        .map_err(|e| format!("无法打开选区工具 slurp：{}", e))?;
    if !slurp.status.success() {
        return Err(CANCELLED.to_string());
    }
    let geo = String::from_utf8_lossy(&slurp.stdout).trim().to_string();
    if geo.is_empty() {
        return Err(CANCELLED.to_string());
    }
    let status = Command::new("grim")
        .args(["-g", &geo])
        .arg(out)
        .status()
        .map_err(|e| format!("无法按选区保存：{}", e))?;
    finish(out, status.code(), "")
}

#[cfg(windows)]
fn capture_windows(out: &Path) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    let script_path = std::env::temp_dir().join(format!("openloc-region-{}.ps1", std::process::id()));
    let mut body = vec![0xEF, 0xBB, 0xBF];
    body.extend_from_slice(WINDOWS_REGION_PS1.as_bytes());
    fs::write(&script_path, &body).map_err(|e| format!("无法准备选区：{e}。没有贴上图片。"))?;
    let output = Command::new("powershell.exe")
        .args(["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-File"])
        .arg(&script_path)
        .arg("-OutFile")
        .arg(out)
        .creation_flags(0x0800_0000)
        .output();
    let _ = fs::remove_file(&script_path);
    let output = output.map_err(|e| format!("无法启动选区：{e}。没有贴上图片。"))?;
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    finish(out, output.status.code(), &stderr)
}

fn capture_with_tools(out: &Path) -> Result<(), String> {
    if !gui_session() {
        return Err(NO_GUI.to_string());
    }
    for tool in unix_region_tools() {
        match tool.path_mode {
            PathMode::SlurpGrim => {
                if !command_exists("grim") || !command_exists("slurp") {
                    continue;
                }
                return run_slurp_grim(out);
            }
            PathMode::TrailingPath => {
                if !command_exists(tool.program) {
                    continue;
                }
                return run_trailing(tool, out);
            }
            PathMode::StdoutPng => {
                if !command_exists(tool.program) {
                    continue;
                }
                return run_stdout(tool, out);
            }
        }
    }
    Err(NO_TOOL.to_string())
}

/// 把用户确认的选区写成 PNG。取消和失败都返回 Err，并且不留下整屏文件。
pub fn capture_region_file(out: &Path) -> Result<(), String> {
    if let Some(parent) = out.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("无法创建截图目录：{}", e))?;
    }
    let _ = fs::remove_file(out);
    #[cfg(windows)]
    {
        capture_windows(out)
    }
    #[cfg(not(windows))]
    {
        capture_with_tools(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancel_and_missing_file_do_not_count_as_saved() {
        assert_eq!(classify_region_end(Some(2), false), RegionEnd::Cancelled);
        assert_eq!(classify_region_end(Some(2), true), RegionEnd::Cancelled);
        assert_eq!(classify_region_end(Some(0), false), RegionEnd::Failed("选区没有生成图片，没有贴上图片。".into()));
        assert_eq!(classify_region_end(Some(1), false), RegionEnd::Failed("选区截图没有完成，没有贴上图片。".into()));
        assert_eq!(classify_region_end(None, false), RegionEnd::Failed("选区截图没有完成，没有贴上图片。".into()));
        assert_eq!(classify_region_end(Some(0), true), RegionEnd::Saved);
    }

    #[test]
    fn region_tools_are_not_fullscreen() {
        for tool in unix_region_tools() {
            let args = tool.args_before_path.join(" ");
            match tool.program {
                "gnome-screenshot" => assert!(args.split_whitespace().any(|a| a == "-a"), "{args}"),
                "spectacle" => assert!(args.split_whitespace().any(|a| a == "-r"), "{args}"),
                "scrot" => assert!(args.split_whitespace().any(|a| a == "-s"), "{args}"),
                "screencapture" => assert!(args.split_whitespace().any(|a| a == "-i"), "{args}"),
                "flameshot" => {
                    assert!(args.contains("gui"));
                    assert!(args.split_whitespace().any(|a| a == "-r"));
                    assert!(!args.contains("full"));
                }
                "grim" => assert_eq!(tool.path_mode, PathMode::SlurpGrim),
                other => panic!("意外的截图工具 {other}"),
            }
        }
    }

    #[test]
    fn windows_picker_crops_after_confirm_and_has_cancel() {
        let script = windows_region_script();
        assert!(script.contains("确认"));
        assert!(script.contains("取消"));
        assert!(script.contains("exit 2"));
        assert!(script.contains("$crop.Save"));
        assert!(!script.contains("$full.Save"));
        assert!(script.contains("Keys]::Escape"));
    }
}
