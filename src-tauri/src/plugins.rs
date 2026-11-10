//! 本机插件：只认清单，不执行仓库里的脚本。
//! 入口只能是已经内置的网络搜索或读文件。

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};

pub const PERM_NETWORK: &str = "network";
pub const PERM_READ: &str = "read_files";
pub const ENTRY_SEARCH: &str = "search";
pub const ENTRY_READ: &str = "read_files";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PluginManifest {
    pub id: String,
    pub name: String,
    pub permission: String,
    pub entry: String,
    pub enabled: bool,
    pub source: String,
}

pub fn permission_text(permission: &str) -> String {
    match permission {
        PERM_NETWORK => "会访问网络：用 DuckDuckGo 的公开网页搜索，不需要 API Key，也不会把对话发到别的云端模型。".to_string(),
        PERM_READ => "会读取你这次选中的文件或文件夹。不会静默扫描整盘，也不会读取你没选的位置。".to_string(),
        _ => "这个权限不认识，不会安装。".to_string(),
    }
}

pub fn builtin(id: &str) -> Option<PluginManifest> {
    match id {
        "web-search" => Some(PluginManifest {
            id: "web-search".into(),
            name: "网络搜索".into(),
            permission: PERM_NETWORK.into(),
            entry: ENTRY_SEARCH.into(),
            enabled: true,
            source: "builtin".into(),
        }),
        "read-files" => Some(PluginManifest {
            id: "read-files".into(),
            name: "读本地文件".into(),
            permission: PERM_READ.into(),
            entry: ENTRY_READ.into(),
            enabled: true,
            source: "builtin".into(),
        }),
        _ => None,
    }
}

pub fn validate_manifest(value: &Value, source: &str) -> Result<PluginManifest, String> {
    let id = value.get("id").and_then(|v| v.as_str()).unwrap_or("").trim();
    let name = value.get("name").and_then(|v| v.as_str()).unwrap_or("").trim();
    let permission = value.get("permission").and_then(|v| v.as_str()).unwrap_or("").trim();
    let entry = value.get("entry").and_then(|v| v.as_str()).unwrap_or("").trim();
    if !id_ok(id) {
        return Err("插件 id 只能是 2 到 40 位的小写字母、数字和连字符。这次没有安装，也没有执行任何脚本。".into());
    }
    if name.is_empty() || name.chars().count() > 40 {
        return Err("插件名称不对。这次没有安装。".into());
    }
    if permission != PERM_NETWORK && permission != PERM_READ {
        return Err("权限只能是「访问网络」或「读取你选的文件」。其他权限不会安装，也不会执行脚本。".into());
    }
    if entry != ENTRY_SEARCH && entry != ENTRY_READ {
        return Err("这个仓库的入口不是 OpenLoc 内置的搜索或读文件。不会执行它的脚本，这次没有安装。".into());
    }
    if (entry == ENTRY_SEARCH && permission != PERM_NETWORK) || (entry == ENTRY_READ && permission != PERM_READ) {
        return Err("入口和权限对不上。搜索只能申请访问网络，读文件只能申请读取你选的文件。这次没有安装。".into());
    }
    Ok(PluginManifest {
        id: id.to_string(),
        name: name.to_string(),
        permission: permission.to_string(),
        entry: entry.to_string(),
        enabled: false,
        source: source.to_string(),
    })
}

fn id_ok(id: &str) -> bool {
    let n = id.len();
    (2..=40).contains(&n)
        && id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        && !id.starts_with('-')
        && !id.ends_with('-')
}

pub fn parse_github_repo(input: &str) -> Result<(String, String), String> {
    let raw = input.trim().trim_end_matches('/').trim_end_matches(".git");
    let rest = raw
        .strip_prefix("https://github.com/")
        .or_else(|| raw.strip_prefix("http://github.com/"))
        .unwrap_or(raw);
    if rest.contains("://") || rest.contains('\\') || rest.contains("..") {
        return Err("只接受 GitHub 上的公开仓库，例如 owner/repo。这次没有安装。".into());
    }
    let mut parts = rest.split('/').filter(|p| !p.is_empty());
    let owner = parts.next().unwrap_or("");
    let repo = parts.next().unwrap_or("");
    if parts.next().is_some() || !part_ok(owner) || !part_ok(repo) {
        return Err("仓库地址应是 owner/repo，或 https://github.com/owner/repo。这次没有安装。".into());
    }
    Ok((owner.to_string(), repo.to_string()))
}

fn part_ok(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 80
        && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
}

pub fn parse_ddg_html(html: &str) -> Vec<(String, String, String)> {
    let mut out = Vec::new();
    let mut rest = html;
    while out.len() < 5 {
        let Some(a) = rest.find("result__a") else { break };
        rest = &rest[a..];
        let Some(gt) = rest.find('>') else { break };
        let tag = &rest[..gt];
        let href = attr_href(tag).unwrap_or_default();
        let Some(end) = rest.find("</a>") else { break };
        let title = strip_tags(&rest[gt + 1..end]).trim().to_string();
        rest = &rest[end..];
        let snippet = if let Some(s) = rest.find("result__snippet") {
            let after = &rest[s..];
            if let (Some(gt2), Some(end2)) = (after.find('>'), after.find("</a>")) {
                rest = &after[end2..];
                strip_tags(&after[gt2 + 1..end2]).trim().to_string()
            } else {
                String::new()
            }
        } else {
            String::new()
        };
        if !title.is_empty() {
            out.push((title, decode_result_href(&href), snippet));
        }
    }
    out
}

fn attr_href(tag: &str) -> Option<String> {
    let key = "href=\"";
    let start = tag.find(key)? + key.len();
    let end = tag[start..].find('"')? + start;
    Some(tag[start..end].to_string())
}

fn decode_result_href(href: &str) -> String {
    let href = href.trim();
    if let Some(pos) = href.find("uddg=") {
        let enc = href[pos + 5..].split('&').next().unwrap_or("");
        return url_decode(enc);
    }
    if href.starts_with("//") {
        return format!("https:{href}");
    }
    href.to_string()
}

fn url_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => out.push(b' '),
            b'%' if i + 2 < bytes.len() => {
                let hex = &s[i + 1..i + 3];
                if let Ok(v) = u8::from_str_radix(hex, 16) {
                    out.push(v);
                    i += 3;
                    continue;
                }
                out.push(bytes[i]);
            }
            b => out.push(b),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

pub fn format_search(hits: &[(String, String, String)]) -> String {
    if hits.is_empty() {
        return "没搜到相关结果，请换个词再试。".into();
    }
    hits.iter()
        .enumerate()
        .map(|(i, (title, url, snippet))| {
            let link = if url.is_empty() { "（没有来源链接）".to_string() } else { url.clone() };
            format!("{}. {}\n来源：{}\n{}", i + 1, title, link, snippet)
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn strip_tags(s: &str) -> String {
    let mut out = String::new();
    let mut in_tag = false;
    for c in s.chars() {
        if c == '<' {
            in_tag = true;
        } else if c == '>' {
            in_tag = false;
        } else if !in_tag {
            out.push(c);
        }
    }
    out.replace("&amp;", "&").replace("&quot;", "\"").replace("&#x27;", "'").replace("&lt;", "<").replace("&gt;", ">")
}

const TEXT_EXT: &[&str] = &[
    "txt", "md", "markdown", "json", "csv", "log", "html", "htm", "rs", "js", "mjs", "py", "toml", "yml", "yaml", "css",
];

pub fn read_selected(paths: &[String]) -> String {
    if paths.is_empty() {
        return "还没有选择文件或文件夹，没有读取。不会扫描整盘。".into();
    }
    let mut files: Vec<PathBuf> = Vec::new();
    let mut notes = Vec::new();
    for raw in paths {
        let path = PathBuf::from(raw.trim());
        if raw.contains('\0') || raw.split(['/', '\\']).any(|p| p == "..") {
            notes.push(format!("已跳过「{raw}」：路径里有 ..，没有读取。"));
            continue;
        }
        if path.is_dir() {
            match expand_dir(&path) {
                Ok(mut kids) => files.append(&mut kids),
                Err(err) => notes.push(err),
            }
        } else if path.is_file() {
            files.push(path);
        } else {
            notes.push(format!("找不到「{}」，没有读取。", path.display()));
        }
    }
    files.sort();
    files.dedup();
    files.truncate(20);
    let mut body = Vec::new();
    let mut total = 0usize;
    for file in files {
        if total >= 24_000 {
            notes.push("摘录已经够长，后面的文件没有再读。".into());
            break;
        }
        match read_one(&file) {
            Ok(text) => {
                let take: String = text.chars().take(8000).collect();
                total += take.chars().count();
                body.push(format!("## {}\n{}", file.display(), take));
            }
            Err(err) => notes.push(err),
        }
    }
    let mut out = format!(
        "已按你的选择读取 {} 段（只包括这些文件，没有扫整盘）。",
        body.len()
    );
    if !notes.is_empty() {
        out.push('\n');
        out.push_str(&notes.join("\n"));
    }
    if !body.is_empty() {
        out.push_str("\n\n");
        out.push_str(&body.join("\n\n"));
    }
    out
}

fn expand_dir(dir: &Path) -> Result<Vec<PathBuf>, String> {
    let canon = dir.canonicalize().map_err(|e| format!("打不开文件夹 {}：{e}", dir.display()))?;
    let rd = fs::read_dir(&canon).map_err(|e| format!("列不出 {}：{e}", canon.display()))?;
    let mut out = Vec::new();
    for entry in rd.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Ok(child) = path.canonicalize() else { continue };
        if !child.starts_with(&canon) {
            continue;
        }
        out.push(child);
        if out.len() >= 20 {
            break;
        }
    }
    if out.is_empty() {
        return Err(format!("文件夹 {} 这一层没有可读的文件。没有往下递归，也没有扫整盘。", canon.display()));
    }
    Ok(out)
}

fn read_one(path: &Path) -> Result<String, String> {
    let len = fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    if len > 2 * 1024 * 1024 {
        return Err(format!("「{}」超过 2 MB，没有读入对话。", path.display()));
    }
    let ext = path.extension().and_then(|s| s.to_str()).unwrap_or("").to_ascii_lowercase();
    let bytes = fs::read(path).map_err(|e| format!("读不了「{}」：{e}", path.display()))?;
    if TEXT_EXT.contains(&ext.as_str()) || ext.is_empty() {
        return Ok(lossy_text(&bytes));
    }
    if ext == "docx" {
        return docx_text(&bytes).map_err(|e| format!("「{}」的 Word 文档没有解析出来：{e}", path.display()));
    }
    if ext == "pdf" {
        let text = pdf_text(&bytes);
        if text.chars().count() < 2 {
            return Err(format!("「{}」是 PDF，但没有抽出文字（可能是扫描件）。没有编造内容。", path.display()));
        }
        return Ok(text);
    }
    Err(format!("「{}」这一版解析不了（.{ext}）。没有编造内容。", path.display()))
}

fn lossy_text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).chars().take(8000).collect()
}

pub fn docx_text(bytes: &[u8]) -> Result<String, String> {
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).map_err(|e| format!("不是完整的 docx：{e}"))?;
    let mut xml = String::new();
    let mut file = archive
        .by_name("word/document.xml")
        .map_err(|_| "docx 里没有 word/document.xml".to_string())?;
    file.read_to_string(&mut xml).map_err(|e| e.to_string())?;
    let text = strip_tags(&xml.replace("</w:p>", "\n"));
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.is_empty() {
        return Err("文档里没有文字".into());
    }
    Ok(text.chars().take(8000).collect())
}

pub fn pdf_text(bytes: &[u8]) -> String {
    let raw = String::from_utf8_lossy(bytes);
    let mut out = String::new();
    let chars: Vec<char> = raw.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '(' {
            i += 1;
            let mut lit = String::new();
            while i < chars.len() && chars[i] != ')' {
                if chars[i] == '\\' && i + 1 < chars.len() {
                    i += 1;
                }
                if chars[i].is_ascii_graphic() || chars[i].is_whitespace() || ('\u{4e00}'..='\u{9fff}').contains(&chars[i]) {
                    lit.push(chars[i]);
                }
                i += 1;
            }
            if lit.chars().count() >= 2 {
                if !out.is_empty() {
                    out.push(' ');
                }
                out.push_str(lit.trim());
            }
        }
        i += 1;
        if out.chars().count() > 8000 {
            break;
        }
    }
    out
}

pub fn save_manifest(dir: &Path, plugin: &PluginManifest) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| format!("无法创建插件目录：{e}"))?;
    let path = dir.join("openloc-plugin.json");
    let text = serde_json::to_string_pretty(plugin).map_err(|e| format!("无法写下插件清单：{e}"))?;
    fs::write(path, text).map_err(|e| format!("无法写下插件清单：{e}"))
}

fn plugins_root() -> PathBuf {
    let exe = std::env::current_exe().unwrap_or_else(|_| PathBuf::from("."));
    let dir = exe.parent().map(|p| p.join("data").join("plugins")).unwrap_or_else(|| PathBuf::from("data/plugins"));
    let _ = fs::create_dir_all(&dir);
    dir
}

fn plugin_dir(id: &str) -> PathBuf {
    plugins_root().join(id)
}

pub fn search_web(query: &str) -> Result<String, String> {
    let q = query.trim();
    if q.is_empty() {
        return Err("没有搜索词。这次没有访问网络。".into());
    }
    let url = format!("https://html.duckduckgo.com/html/?q={}", url_encode(q));
    let client = reqwest::blocking::Client::builder()
        .user_agent("OpenLoc")
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| format!("搜索客户端没有建起来：{e}"))?;
    let html = client
        .get(&url)
        .send()
        .map_err(|e| format!("网络搜索没有连上：{e}"))?
        .text()
        .map_err(|e| format!("搜索结果读不下来：{e}"))?;
    Ok(format_search(&parse_ddg_html(&html)))
}

fn url_encode(s: &str) -> String {
    let mut out = String::new();
    for b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(*b as char),
            b' ' => out.push('+'),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn fetch_github_manifest(owner: &str, repo: &str) -> Result<PluginManifest, String> {
    let client = reqwest::blocking::Client::builder()
        .user_agent("OpenLoc")
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| format!("访问 GitHub 失败：{e}"))?;
    let meta_url = format!("https://api.github.com/repos/{owner}/{repo}");
    let meta = client
        .get(&meta_url)
        .header("Accept", "application/vnd.github+json")
        .send()
        .map_err(|e| format!("访问 GitHub 失败：{e}"))?;
    if meta.status().as_u16() == 404 {
        return Err("找不到这个公开仓库。这次没有安装。".into());
    }
    if !meta.status().is_success() {
        return Err(format!("GitHub 返回 HTTP {}。这次没有安装。", meta.status()));
    }
    let meta_json: Value = meta.json().map_err(|_| "GitHub 没有返回仓库信息。这次没有安装。".to_string())?;
    let branch = meta_json.get("default_branch").and_then(|v| v.as_str()).unwrap_or("main");
    let raw = format!("https://raw.githubusercontent.com/{owner}/{repo}/{branch}/openloc-plugin.json");
    let file = client.get(&raw).send().map_err(|e| format!("下载插件清单失败：{e}"))?;
    if file.status().as_u16() == 404 {
        return Err("这个仓库根目录没有 openloc-plugin.json。没有安装，也没有执行脚本。".into());
    }
    if !file.status().is_success() {
        return Err(format!("插件清单下载失败：HTTP {}。没有执行脚本。", file.status()));
    }
    let text = file.text().map_err(|e| format!("插件清单读不下来：{e}"))?;
    let value: Value = serde_json::from_str(&text).map_err(|_| "插件清单不是 JSON。没有安装，也没有执行脚本。".to_string())?;
    let mut plugin = validate_manifest(&value, &format!("github:{owner}/{repo}"))?;
    plugin.source = format!("github:{owner}/{repo}");
    Ok(plugin)
}

fn installed() -> Vec<PluginManifest> {
    let mut out = Vec::new();
    let Ok(rd) = fs::read_dir(plugins_root()) else { return out };
    for entry in rd.flatten() {
        if !entry.path().is_dir() {
            continue;
        }
        if let Ok(plugin) = load_manifest(&entry.path()) {
            out.push(plugin);
        }
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out
}

fn require_enabled(id: &str) -> Result<PluginManifest, String> {
    let plugin = load_manifest(&plugin_dir(id)).map_err(|_| {
        format!("插件「{id}」还没安装。到对话的「工具」里安装后再用。这次没有调用。")
    })?;
    if !plugin.enabled {
        return Err(match plugin.entry.as_str() {
            ENTRY_SEARCH => "网络搜索插件没有启用。到对话的「工具」里打开后再查。这次没有访问网络。".into(),
            _ => "读文件插件没有启用，没有读取正文。".into(),
        });
    }
    Ok(plugin)
}

#[derive(Serialize)]
pub struct PluginCard {
    id: String,
    name: String,
    permission: String,
    permission_text: String,
    entry: String,
    installed: bool,
    enabled: bool,
    source: String,
    blurb: String,
}

fn card_from(plugin: &PluginManifest, installed_flag: bool) -> PluginCard {
    let blurb = match plugin.id.as_str() {
        "web-search" => "用 DuckDuckGo 的公开网页搜索，不需要 API Key。",
        "read-files" => "只读你选中的文件或文件夹里的文本。",
        _ => "来自你填写的公开仓库清单。只启用内置入口，不执行仓库脚本。",
    };
    PluginCard {
        id: plugin.id.clone(),
        name: plugin.name.clone(),
        permission: plugin.permission.clone(),
        permission_text: permission_text(&plugin.permission),
        entry: plugin.entry.clone(),
        installed: installed_flag,
        enabled: installed_flag && plugin.enabled,
        source: plugin.source.clone(),
        blurb: blurb.to_string(),
    }
}

#[tauri::command]
pub fn list_plugins() -> Vec<PluginCard> {
    let have = installed();
    let mut out = Vec::new();
    for id in ["web-search", "read-files"] {
        let builtin = builtin(id).unwrap();
        if let Some(found) = have.iter().find(|p| p.id == id) {
            out.push(card_from(found, true));
        } else {
            let mut shown = builtin;
            shown.enabled = false;
            out.push(card_from(&shown, false));
        }
    }
    for plugin in &have {
        if plugin.id != "web-search" && plugin.id != "read-files" {
            out.push(card_from(plugin, true));
        }
    }
    out
}

#[tauri::command]
pub fn install_builtin_plugin(id: String) -> Result<String, String> {
    let plugin = builtin(&id).ok_or_else(|| "没有这个内置插件。".to_string())?;
    let dir = plugin_dir(&plugin.id);
    if dir.join("openloc-plugin.json").is_file() {
        return Ok(format!("「{}」已经装过。可以在列表里启用或卸载。{}", plugin.name, permission_text(&plugin.permission)));
    }
    save_manifest(&dir, &plugin)?;
    Ok(format!("已安装「{}」。{}", plugin.name, permission_text(&plugin.permission)))
}

#[tauri::command]
pub fn preview_github_plugin(repo: String) -> Result<PluginCard, String> {
    let (owner, name) = parse_github_repo(&repo)?;
    let plugin = fetch_github_manifest(&owner, &name)?;
    Ok(card_from(&plugin, false))
}

#[tauri::command]
pub fn install_github_plugin(repo: String) -> Result<String, String> {
    let (owner, name) = parse_github_repo(&repo)?;
    let mut plugin = fetch_github_manifest(&owner, &name)?;
    let dir = plugin_dir(&plugin.id);
    if dir.join("openloc-plugin.json").is_file() {
        return Err(format!("「{}」已经装过，没有覆盖，也没有执行脚本。", plugin.name));
    }
    plugin.enabled = true;
    save_manifest(&dir, &plugin)?;
    Ok(format!(
        "已安装「{}」。没有执行仓库里的脚本，只用内置的{}。{}",
        plugin.name,
        if plugin.entry == ENTRY_SEARCH { "网络搜索" } else { "读文件" },
        permission_text(&plugin.permission)
    ))
}

#[tauri::command]
pub fn set_plugin_enabled(id: String, enabled: bool) -> Result<String, String> {
    if !id_ok(&id) {
        return Err("插件 id 不对。".into());
    }
    let dir = plugin_dir(&id);
    let mut plugin = load_manifest(&dir)?;
    plugin.enabled = enabled;
    save_manifest(&dir, &plugin)?;
    if enabled {
        Ok(format!("已启用「{}」。{}", plugin.name, permission_text(&plugin.permission)))
    } else {
        Ok(format!("已停用「{}」。对话里不会再调用它。", plugin.name))
    }
}

#[tauri::command]
pub fn uninstall_plugin(id: String) -> Result<String, String> {
    if !id_ok(&id) {
        return Err("插件 id 不对。".into());
    }
    let dir = plugin_dir(&id);
    if !dir.is_dir() {
        return Err("这个插件不在本机，没有卸载。".into());
    }
    fs::remove_dir_all(&dir).map_err(|e| format!("没能卸载：{e}"))?;
    Ok("已从本机插件目录卸掉。没有删你的其他文件。".into())
}

#[tauri::command]
pub fn plugin_search(query: String) -> Result<String, String> {
    let _plugin = require_enabled("web-search")?;
    search_web(&query)
}

#[tauri::command]
pub fn plugin_read_files(paths: Vec<String>) -> Result<String, String> {
    let _plugin = require_enabled("read-files")?;
    if paths.len() > 40 {
        return Err("一次最多读 40 个路径。这次没有读取。".into());
    }
    Ok(read_selected(&paths))
}

pub fn load_manifest(dir: &Path) -> Result<PluginManifest, String> {
    let text = fs::read_to_string(dir.join("openloc-plugin.json")).map_err(|_| "插件清单丢了。".to_string())?;
    let value: Value = serde_json::from_str(&text).map_err(|_| "插件清单不是 JSON。".to_string())?;
    let mut plugin = validate_manifest(&value, value.get("source").and_then(|v| v.as_str()).unwrap_or("local"))?;
    plugin.enabled = value.get("enabled").and_then(|v| v.as_bool()).unwrap_or(false);
    if let Some(source) = value.get("source").and_then(|v| v.as_str()) {
        plugin.source = source.to_string();
    }
    Ok(plugin)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_rejects_scripts_and_unknown_permissions() {
        let ok = serde_json::json!({"id":"web-search","name":"网络搜索","permission":"network","entry":"search"});
        let plugin = validate_manifest(&ok, "builtin").unwrap();
        assert_eq!(plugin.entry, "search");
        assert!(permission_text(&plugin.permission).contains("访问网络"));
        let script = serde_json::json!({"id":"bad-tool","name":"坏","permission":"network","entry":"run.js"});
        let err = validate_manifest(&script, "github").unwrap_err();
        assert!(err.contains("不会执行"), "{err}");
        let weird = serde_json::json!({"id":"bad-tool","name":"坏","permission":"shell","entry":"search"});
        assert!(validate_manifest(&weird, "github").unwrap_err().contains("不会安装"));
    }

    #[test]
    fn github_address_stays_on_a_public_repo() {
        assert_eq!(parse_github_repo("owner/demo").unwrap(), ("owner".into(), "demo".into()));
        assert_eq!(
            parse_github_repo("https://github.com/owner/demo.git").unwrap(),
            ("owner".into(), "demo".into())
        );
        assert!(parse_github_repo("../secret").is_err());
        assert!(parse_github_repo("https://gitlab.com/owner/demo").is_err());
    }

    #[test]
    fn search_hits_keep_the_real_link() {
        let html = r#"<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&amp;rut=1">示例标题</a><a class="result__snippet" href="x">一段摘要</a>"#;
        let hits = parse_ddg_html(html);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].0, "示例标题");
        assert_eq!(hits[0].1, "https://example.com/a");
        let text = format_search(&hits);
        assert!(text.contains("来源：https://example.com/a"), "{text}");
        assert!(format_search(&[]).starts_with("没搜到"));
    }

    #[test]
    fn docx_and_pdf_extract_text_or_say_nothing() {
        let xml = br#"<?xml version="1.0"?><w:document><w:p><w:t>Hello doc</w:t></w:p></w:document>"#;
        let mut cursor = Cursor::new(Vec::new());
        {
            let mut zip = zip::ZipWriter::new(&mut cursor);
            let opts = zip::write::SimpleFileOptions::default();
            zip.start_file("word/document.xml", opts).unwrap();
            std::io::Write::write_all(&mut zip, xml).unwrap();
            zip.finish().unwrap();
        }
        let text = docx_text(cursor.get_ref()).unwrap();
        assert!(text.contains("Hello doc"), "{text}");
        let pdf = b"%PDF-1.1\nBT (Hello PDF) Tj ET\n";
        assert!(pdf_text(pdf).contains("Hello PDF"));
        assert!(pdf_text(b"%PDF empty").chars().count() < 2);
    }

    #[test]
    fn read_selected_does_not_walk_outside_the_choice() {
        let root = std::env::temp_dir().join(format!("openloc-plugin-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("picked")).unwrap();
        fs::write(root.join("picked").join("note.md"), "只读这一份").unwrap();
        fs::write(root.join("secret.txt"), "不该读到").unwrap();
        let text = read_selected(&[root.join("picked").display().to_string()]);
        assert!(text.contains("只读这一份"), "{text}");
        assert!(!text.contains("不该读到"), "{text}");
        assert!(text.contains("没有扫整盘"), "{text}");
        let skipped = read_selected(&["../secret.txt".into()]);
        assert!(skipped.contains("没有读取") || skipped.contains("跳过"), "{skipped}");
        let _ = fs::remove_dir_all(&root);
    }
}
