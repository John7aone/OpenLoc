//! 本机 llama-server 的请求、健康检查和错误文案。
//! 地址固定为 127.0.0.1，不把对话发到别的主机。

use serde_json::Value;
use std::time::Duration;

pub const LOOPBACK_HOST: &str = "127.0.0.1";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChatTurn {
    pub role: String,
    pub content: String,
}

#[derive(Debug, PartialEq, Eq)]
pub enum SsePiece {
    Delta(String),
    Reasoning(String),
    Done,
}

#[derive(Default)]
pub struct SseParser {
    buf: String,
    raw: String,
    deltas: usize,
}

impl SseParser {
    pub fn push(&mut self, chunk: &str) -> Vec<SsePiece> {
        self.raw.push_str(chunk);
        self.feed(chunk)
    }

    fn feed(&mut self, chunk: &str) -> Vec<SsePiece> {
        self.buf.push_str(chunk);
        let mut out = Vec::new();
        loop {
            let Some(pos) = self.buf.find('\n') else {
                break;
            };
            let mut line = self.buf[..pos].to_string();
            self.buf.drain(..=pos);
            if line.ends_with('\r') {
                line.pop();
            }
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let Some(data) = line.strip_prefix("data:") else {
                continue;
            };
            let data = data.trim();
            if data == "[DONE]" {
                out.push(SsePiece::Done);
                continue;
            }
            let Ok(v) = serde_json::from_str::<Value>(data) else {
                continue;
            };
            if let Some(text) = delta_text(&v, &["content"]) {
                self.deltas += 1;
                out.push(SsePiece::Delta(text));
            }
            if let Some(text) = delta_text(&v, &["reasoning_content", "reasoning"]) {
                out.push(SsePiece::Reasoning(text));
            }
        }
        out
    }

    pub fn finish(&mut self) -> Result<Vec<SsePiece>, String> {
        let mut extra = Vec::new();
        if !self.buf.is_empty() {
            let rest = std::mem::take(&mut self.buf);
            extra.extend(self.feed(&(rest + "\n")));
        }
        if self.deltas == 0 {
            if let Some(message) = json_api_error(&self.raw) {
                return Err(err_http(0, &message));
            }
            if let Some(text) = json_message_content(&self.raw) {
                if !text.is_empty() {
                    self.deltas += 1;
                    extra.push(SsePiece::Delta(text));
                }
            }
        }
        Ok(extra)
    }
}

fn delta_text(v: &Value, keys: &[&str]) -> Option<String> {
    let delta = v.pointer("/choices/0/delta")?;
    for key in keys {
        if let Some(text) = delta.get(*key).and_then(|x| x.as_str()) {
            if !text.is_empty() {
                return Some(text.to_string());
            }
        }
    }
    None
}

fn json_message_content(raw: &str) -> Option<String> {
    let v: Value = serde_json::from_str(raw.trim()).ok()?;
    v.pointer("/choices/0/message/content")
        .and_then(|x| x.as_str())
        .map(|s| s.to_string())
}

fn json_api_error(raw: &str) -> Option<String> {
    let v: Value = serde_json::from_str(raw.trim()).ok()?;
    v.pointer("/error/message")
        .and_then(|x| x.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

pub fn normalize_messages(input: Vec<(String, String)>) -> Result<Vec<ChatTurn>, String> {
    if input.is_empty() {
        return Err(err_empty_message());
    }
    if input.len() > 40 {
        return Err(
            "对话太长（超过 40 轮）。下一步：点「新对话」后再发。本次没有发给模型。".to_string(),
        );
    }
    let mut total = 0usize;
    let mut out = Vec::new();
    for (role, content) in input {
        let role = role.trim().to_ascii_lowercase();
        if role != "user" && role != "assistant" && role != "system" {
            return Err(format!("对话角色无效：{role}。本次没有发给模型。"));
        }
        let content = content.trim().to_string();
        if content.is_empty() {
            continue;
        }
        let chars = content.chars().count();
        if chars > 20000 || total + chars > 100_000 {
            return Err("这条对话太长，没有发送。下一步：缩短文字，或点「新对话」。".to_string());
        }
        total += chars;
        out.push(ChatTurn { role, content });
    }
    if out.is_empty() || !out.iter().any(|m| m.role == "user") {
        return Err(err_empty_message());
    }
    Ok(out)
}

/// 一轮回答的上限。不传时 llama-server 的 n_predict 是 -1，思考模型会一直写到上下文耗尽。
pub const DEFAULT_MAX_TOKENS: u32 = 1024;
/// 略高于 1，用来压住「同一段话再来一遍」。1.0 表示关闭，这是 llama-server 的默认值。
pub const DEFAULT_REPEAT_PENALTY: f64 = 1.1;
pub const DEFAULT_REPEAT_LAST_N: i32 = 256;
/// 思考段的 token 预算。到点后由模型模板自己的结束标记收束，再生成正文。
pub const DEFAULT_REASONING_BUDGET: i32 = 128;

pub fn chat_body(messages: &[ChatTurn], think: bool, stream: bool) -> Value {
    let msgs: Vec<Value> = messages
        .iter()
        .map(|m| serde_json::json!({"role": m.role, "content": m.content}))
        .collect();
    let mut body = serde_json::json!({
        "model": "local",
        "messages": msgs,
        "temperature": 0.7,
        "stream": stream,
        "max_tokens": DEFAULT_MAX_TOKENS,
        "repeat_penalty": DEFAULT_REPEAT_PENALTY,
        "repeat_last_n": DEFAULT_REPEAT_LAST_N,
        // 必须显式传 true/false。不传时 b12110 的 --reasoning auto 会按模板自己打开思考，
        // Qwen3.5 会停在未闭合的思考段里，把同一句问候改写很多遍，正文一直出不来。
        "chat_template_kwargs": {"enable_thinking": think},
    });
    if think {
        body["reasoning_budget_tokens"] = serde_json::json!(DEFAULT_REASONING_BUDGET);
    }
    body
}

/// 引擎不认识上限、防复读或思考字段时的退路。不再打开思考，避免没有结束标记的长生成。
fn chat_body_fallback(messages: &[ChatTurn], stream: bool) -> Value {
    let msgs: Vec<Value> = messages
        .iter()
        .map(|m| serde_json::json!({"role": m.role, "content": m.content}))
        .collect();
    serde_json::json!({
        "model": "local",
        "messages": msgs,
        "temperature": 0.7,
        "stream": stream,
    })
}

pub fn health_url(port: u16) -> String {
    format!("http://{LOOPBACK_HOST}:{port}/health")
}

pub fn chat_url(port: u16) -> String {
    format!("http://{LOOPBACK_HOST}:{port}/v1/chat/completions")
}

pub fn launch_args(model: &std::path::Path, port: u16, ctx: u32) -> Vec<String> {
    vec![
        "-m".to_string(),
        model.display().to_string(),
        "--host".to_string(),
        LOOPBACK_HOST.to_string(),
        "--port".to_string(),
        port.to_string(),
        "-c".to_string(),
        ctx.to_string(),
        // 用 GGUF 里自带的 jinja chat template，结束标记跟着模型走。
        // 不传 --chat-template，避免用一套通用模板盖掉模型自己的。
        "--jinja".to_string(),
    ]
}

pub fn ready_to_mark_running(process_alive: bool, health_ok: bool) -> bool {
    process_alive && health_ok
}

pub fn health_is_ready(status: u16, body: &str) -> bool {
    if !(200..300).contains(&status) {
        return false;
    }
    serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|v| v.get("status").and_then(|s| s.as_str()).map(|s| s == "ok"))
        .unwrap_or(false)
}

pub fn err_engine_missing() -> String {
    "还没安装聊天引擎，找不到 llama-server。下一步：打开「运行」页，点「安装聊天引擎」，看到“找到 llama-server”后再启动。不会去调用本机别的已安装程序。".to_string()
}

pub fn err_model_missing(name: &str) -> String {
    format!("模型文件不存在：{name}。下一步：到「模型」页下载或按完整路径导入 GGUF，确认文件在 data/models 里，再回「运行」页选择它启动。")
}

pub fn err_model_name() -> String {
    "模型名不能包含路径。下一步：只选择 data/models 里列出的文件名。".to_string()
}

pub fn err_port_busy(port: u16) -> String {
    format!("端口 {port} 已被占用，没有启动新的聊天服务，也没有把状态标成运行中。下一步：打开「设置」，把本地 API 端口改成一个空闲端口并保存，然后回到「运行」页重新启动。OpenLoc 不会关掉占用该端口的其他程序。")
}

pub fn err_not_running() -> String {
    "聊天服务还没启动。下一步：打开「运行」页，选择已下载的 GGUF，点「启动模型」，等到健康检查通过、状态变成运行中，再回到对话发送。".to_string()
}

pub fn err_health_timeout(port: u16, log_tail: &str) -> String {
    format!("聊天服务没有在 127.0.0.1:{port} 上就绪（健康检查未通过）。下一步：确认模型文件完整、端口没被占用，查看 data/logs/llama-server.log。本次没有把状态标成运行中。日志摘录：{log_tail}")
}

pub fn err_process_exited(log_tail: &str) -> String {
    format!("聊天进程启动后退出了，健康检查没有通过。下一步：打开 data/logs/llama-server.log 看原因（常见是模型不兼容或文件损坏），换一个 GGUF 后再启动。本次没有把状态标成运行中。日志摘录：{log_tail}")
}

pub fn err_request(detail: &str) -> String {
    format!("请求失败：{detail}。下一步：到「运行」页确认服务仍是运行中；若端口冲突，到「设置」改端口后重新启动。本次没有编造回复。")
}

pub fn err_conn_refused(port: u16) -> String {
    format!("聊天服务未在 127.0.0.1:{port} 响应。下一步：打开「运行」页重新启动模型，确认状态是运行中后再发。本次没有编造回复。")
}

pub fn err_http(code: u16, body: &str) -> String {
    let body = clamp(body, 300);
    if code == 0 {
        return format!("请求失败：{body}。下一步：到「运行」页确认服务仍是运行中。本次没有编造回复。");
    }
    format!("请求失败：本地聊天服务返回 HTTP {code}。{body} 下一步：确认运行页的模型已加载完成；若刚启动，等健康检查通过后再发。本次没有编造回复。")
}

pub fn err_empty_message() -> String {
    "没有可发送的文字。下一步：在对话输入框写下问题后再发送。".to_string()
}

pub fn err_zip_no_llama() -> String {
    "压缩包已解压，但里面没有 llama-server 或 llama-server.exe。下一步：设置里的地址应是 llama.cpp 的 Windows 可执行包（llama-b…-bin-win-cpu-x64.zip），不要填源码包，然后重新安装。".to_string()
}

pub fn err_spawn(detail: &str) -> String {
    format!("没能启动 llama-server：{detail}。下一步：重新安装聊天引擎，确认 llama-server.exe 和它旁边的 dll 都在。")
}

fn clamp(text: &str, max_chars: usize) -> String {
    let one_line = text.replace('\n', " ").trim().to_string();
    if one_line.chars().count() <= max_chars {
        one_line
    } else {
        one_line.chars().take(max_chars).collect::<String>() + "…"
    }
}

pub fn map_transport_error(err: &reqwest::Error, port: u16) -> String {
    let raw = err.to_string();
    if err.is_connect() || raw.to_lowercase().contains("connection refused") {
        return err_conn_refused(port);
    }
    if err.is_timeout() {
        return err_request(&format!("等待 127.0.0.1:{port} 超过时限"));
    }
    err_request(&raw)
}

fn http_client(timeout: Duration) -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .timeout(timeout)
        .connect_timeout(Duration::from_secs(3))
        .build()
        .map_err(|e| err_request(&e.to_string()))
}

pub fn probe_health_blocking(port: u16, timeout: Duration) -> Result<(), String> {
    let resp = http_client(timeout)?
        .get(health_url(port))
        .header("User-Agent", "OpenLoc")
        .send()
        .map_err(|e| map_transport_error(&e, port))?;
    let code = resp.status().as_u16();
    let body = resp.text().unwrap_or_default();
    if health_is_ready(code, &body) {
        Ok(())
    } else {
        Err(format!("健康检查未通过：HTTP {code} {}", clamp(&body, 180)))
    }
}

pub fn extract_completion(v: &Value) -> String {
    v.pointer("/choices/0/message/content")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string()
}

pub fn complete_chat(port: u16, messages: &[ChatTurn], think: bool) -> Result<String, String> {
    let client = http_client(Duration::from_secs(300))?;
    let first = post_blocking(&client, port, &chat_body(messages, think, false))?;
    let resp = if first.status().as_u16() == 400 {
        let _ = first.text().unwrap_or_default();
        post_blocking(&client, port, &chat_body_fallback(messages, false))?
    } else {
        first
    };
    let code = resp.status().as_u16();
    let body = resp.text().map_err(|e| map_transport_error(&e, port))?;
    if !(200..300).contains(&code) {
        let detail = json_api_error(&body).unwrap_or(body);
        return Err(err_http(code, &detail));
    }
    let v: Value = serde_json::from_str(&body).map_err(|e| err_request(&format!("回复不是 JSON：{e}")))?;
    if let Some(message) = v
        .pointer("/error/message")
        .and_then(|x| x.as_str())
        .filter(|s| !s.is_empty())
    {
        return Err(err_http(code, message));
    }
    Ok(extract_completion(&v))
}

fn post_blocking(
    client: &reqwest::blocking::Client,
    port: u16,
    body: &Value,
) -> Result<reqwest::blocking::Response, String> {
    client
        .post(chat_url(port))
        .header("User-Agent", "OpenLoc")
        .json(body)
        .send()
        .map_err(|e| map_transport_error(&e, port))
}

pub struct StreamOutcome {
    pub cancelled: bool,
}

pub async fn open_and_read_stream(
    port: u16,
    messages: &[ChatTurn],
    think: bool,
    mut stop: impl FnMut() -> bool,
    mut on_note: impl FnMut(String),
    mut on_piece: impl FnMut(SsePiece),
) -> Result<StreamOutcome, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(300))
        .connect_timeout(Duration::from_secs(3))
        .pool_max_idle_per_host(0)
        .tcp_nodelay(true)
        .build()
        .map_err(|e| err_request(&e.to_string()))?;
    let first = post_async(&client, port, &chat_body(messages, think, true)).await?;
    let (resp, note) = if first.status().as_u16() == 400 {
        let _ = first.text().await.unwrap_or_default();
        let again = post_async(&client, port, &chat_body_fallback(messages, true)).await?;
        let note = if think {
            Some(
                "思考开关未被当前引擎接受，这次按普通对话发送，没有编造思考过程。".to_string(),
            )
        } else {
            None
        };
        (again, note)
    } else {
        (first, None)
    };
    let code = resp.status().as_u16();
    if !(200..300).contains(&code) {
        let body = resp.text().await.unwrap_or_default();
        let detail = json_api_error(&body).unwrap_or(body);
        return Err(err_http(code, &detail));
    }
    if let Some(text) = note.clone() {
        on_note(text);
    }
    let mut parser = SseParser::default();
    let mut cancelled = false;
    let mut resp = resp;
    loop {
        if stop() {
            cancelled = true;
            break;
        }
        match resp.chunk().await {
            Ok(Some(chunk)) => {
                let text = String::from_utf8_lossy(&chunk);
                for piece in parser.push(&text) {
                    on_piece(piece);
                }
            }
            Ok(None) => break,
            Err(err) => {
                if stop() {
                    cancelled = true;
                    break;
                }
                drop(resp);
                return Err(map_transport_error(&err, port));
            }
        }
    }
    // 丢掉响应会关掉这条连接。llama-server 看到断开后会取消槽位里的生成。
    drop(resp);
    if !cancelled {
        for piece in parser.finish()? {
            on_piece(piece);
        }
    }
    Ok(StreamOutcome { cancelled })
}

async fn post_async(
    client: &reqwest::Client,
    port: u16,
    body: &Value,
) -> Result<reqwest::Response, String> {
    client
        .post(chat_url(port))
        .header("User-Agent", "OpenLoc")
        .json(body)
        .send()
        .await
        .map_err(|e| map_transport_error(&e, port))
}

/// 启动后的试答。很短，并且关掉思考。不写入用户的对话记录。
pub const WARMUP_TEXT: &str = "你好";
pub const WARMUP_MAX_TOKENS: u32 = 16;
pub const WARMUP_TIMEOUT: Duration = Duration::from_secs(45);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WarmupPhase {
    Ok,
    Empty,
    Repeat,
    Timeout,
    Failed,
    Yielded,
}

impl WarmupPhase {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ok => "ok",
            Self::Empty => "empty",
            Self::Repeat => "repeat",
            Self::Timeout => "timeout",
            Self::Failed => "failed",
            Self::Yielded => "yielded",
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct WarmupReport {
    pub phase: WarmupPhase,
    pub message: String,
    pub seconds: f64,
}

pub fn warmup_running_message() -> String {
    "正在后台试答「你好」（字数很少，已关闭思考）。这不影响你直接对话，也不会写入对话记录。".to_string()
}

pub fn warmup_body() -> Value {
    serde_json::json!({
        "model": "local",
        "messages": [{"role": "user", "content": WARMUP_TEXT}],
        "temperature": 0.7,
        "stream": false,
        "max_tokens": WARMUP_MAX_TOKENS,
        "repeat_penalty": DEFAULT_REPEAT_PENALTY,
        "repeat_last_n": DEFAULT_REPEAT_LAST_N,
        "chat_template_kwargs": {"enable_thinking": false},
    })
}

/// 引擎拒绝思考或防复读字段时仍保留很短的长度上限，避免试答自己说个没完。
fn warmup_body_plain() -> Value {
    serde_json::json!({
        "model": "local",
        "messages": [{"role": "user", "content": WARMUP_TEXT}],
        "temperature": 0.7,
        "stream": false,
        "max_tokens": WARMUP_MAX_TOKENS,
    })
}

pub fn reply_is_repetitive(text: &str) -> bool {
    let compact: String = text.split_whitespace().collect::<Vec<_>>().join("");
    let chars: Vec<char> = compact.chars().collect();
    if chars.len() < 6 {
        return false;
    }
    let max_unit = chars.len() / 3;
    for unit in 2..=max_unit {
        if chars.len() % unit != 0 {
            continue;
        }
        let times = chars.len() / unit;
        if times < 3 {
            continue;
        }
        let piece = &chars[..unit];
        if chars.chunks(unit).all(|chunk| chunk == piece) {
            return true;
        }
    }
    let window = 8.min(chars.len() / 3);
    if window >= 4 {
        let mut i = 0;
        while i + window <= chars.len() {
            let needle: String = chars[i..i + window].iter().collect();
            if compact.matches(needle.as_str()).count() >= 3 {
                return true;
            }
            i += window;
        }
    }
    false
}

pub fn judge_warmup_text(text: &str) -> WarmupPhase {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        WarmupPhase::Empty
    } else if reply_is_repetitive(trimmed) {
        WarmupPhase::Repeat
    } else {
        WarmupPhase::Ok
    }
}

pub fn warmup_message(phase: WarmupPhase, seconds: f64, detail: &str) -> String {
    match phase {
        WarmupPhase::Ok => format!(
            "试答正常，用时 {:.1} 秒。这条试答没有写入对话，你可以直接聊天。",
            seconds
        ),
        WarmupPhase::Empty => {
            "试答没有正文。模板可能不匹配，建议换模型，或在运行页关闭思考后再启动。你仍可以直接对话。"
                .to_string()
        }
        WarmupPhase::Repeat => {
            "试答出现复读，没有正常结束。模板可能不匹配，建议换模型，或关闭思考后再启动。你仍可以直接对话。"
                .to_string()
        }
        WarmupPhase::Timeout => {
            "试答超时，没有在时限内结束。模板可能不匹配，建议换模型，或关闭思考后再启动。你仍可以直接对话。"
                .to_string()
        }
        WarmupPhase::Failed => format!(
            "试答没有完成：{}。建议换模型或关闭思考后再启动。你仍可以直接对话。",
            clamp(detail, 160)
        ),
        WarmupPhase::Yielded => "试答已停下，把服务让给这次对话。没有写入对话记录。".to_string(),
    }
}

fn warmup_report(phase: WarmupPhase, started: std::time::Instant, detail: &str) -> WarmupReport {
    let seconds = started.elapsed().as_secs_f64();
    WarmupReport {
        message: warmup_message(phase, seconds, detail),
        phase,
        seconds,
    }
}

enum WarmupStop {
    Yielded,
    Timeout,
    Failed(String),
}

async fn post_until_stop(
    client: &reqwest::Client,
    port: u16,
    body: &Value,
    stop: &mut impl FnMut() -> bool,
) -> Result<reqwest::Response, WarmupStop> {
    let pending = client
        .post(chat_url(port))
        .header("User-Agent", "OpenLoc")
        .json(body)
        .send();
    tokio::pin!(pending);
    loop {
        if stop() {
            return Err(WarmupStop::Yielded);
        }
        tokio::select! {
            biased;
            _ = tokio::time::sleep(Duration::from_millis(80)) => {}
            result = &mut pending => {
                return match result {
                    Ok(resp) => Ok(resp),
                    Err(err) if err.is_timeout() => Err(WarmupStop::Timeout),
                    Err(err) => Err(WarmupStop::Failed(err.to_string())),
                };
            }
        }
    }
}

fn stop_report(stop: WarmupStop, started: std::time::Instant) -> WarmupReport {
    match stop {
        WarmupStop::Yielded => warmup_report(WarmupPhase::Yielded, started, ""),
        WarmupStop::Timeout => warmup_report(WarmupPhase::Timeout, started, ""),
        WarmupStop::Failed(detail) => warmup_report(WarmupPhase::Failed, started, &detail),
    }
}

/// 健康检查通过后调用。`stop` 返回 true 时立刻丢掉请求，不把试答当成失败。
pub async fn run_warmup(
    port: u16,
    timeout: Duration,
    mut stop: impl FnMut() -> bool,
) -> WarmupReport {
    let started = std::time::Instant::now();
    if stop() {
        return warmup_report(WarmupPhase::Yielded, started, "");
    }
    let client = match reqwest::Client::builder()
        .timeout(timeout)
        .connect_timeout(Duration::from_secs(3))
        .build()
    {
        Ok(client) => client,
        Err(err) => return warmup_report(WarmupPhase::Failed, started, &err.to_string()),
    };
    let first = match post_until_stop(&client, port, &warmup_body(), &mut stop).await {
        Ok(resp) => resp,
        Err(stop) => return stop_report(stop, started),
    };
    let resp = if first.status().as_u16() == 400 {
        let _ = first.text().await.unwrap_or_default();
        if stop() {
            return warmup_report(WarmupPhase::Yielded, started, "");
        }
        match post_until_stop(&client, port, &warmup_body_plain(), &mut stop).await {
            Ok(resp) => resp,
            Err(stop) => return stop_report(stop, started),
        }
    } else {
        first
    };
    if stop() {
        return warmup_report(WarmupPhase::Yielded, started, "");
    }
    let code = resp.status().as_u16();
    let body = match resp.text().await {
        Ok(body) => body,
        Err(err) if err.is_timeout() => return warmup_report(WarmupPhase::Timeout, started, ""),
        Err(err) => return warmup_report(WarmupPhase::Failed, started, &err.to_string()),
    };
    if !(200..300).contains(&code) {
        let detail = json_api_error(&body).unwrap_or_else(|| clamp(&body, 160));
        return warmup_report(WarmupPhase::Failed, started, &detail);
    }
    if let Some(message) = json_api_error(&body) {
        return warmup_report(WarmupPhase::Failed, started, &message);
    }
    let text = extract_completion(&serde_json::from_str(&body).unwrap_or(Value::Null));
    warmup_report(judge_warmup_text(&text), started, "")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::{Arc, Mutex};
    use std::thread;
    use std::time::Duration;

    #[test]
    fn launch_and_urls_stay_on_loopback() {
        let args = launch_args(std::path::Path::new("demo.gguf"), 18080, 4096);
        assert!(args.windows(2).any(|w| w == ["--host", "127.0.0.1"]));
        assert!(args.iter().any(|a| a == "--jinja"));
        assert!(!args.iter().any(|a| a == "--no-jinja" || a == "--chat-template" || a == "0.0.0.0" || a == "localhost"));
        assert!(health_url(8080).starts_with("http://127.0.0.1:8080/"));
        assert!(chat_url(8080).contains("127.0.0.1"));
        assert!(!chat_url(8080).contains("0.0.0.0"));
    }

    #[test]
    fn health_and_running_flag_follow_the_probe() {
        assert!(health_is_ready(200, r#"{"status":"ok"}"#));
        assert!(!health_is_ready(200, r#"{"status":"loading"}"#));
        assert!(!health_is_ready(503, r#"{"status":"ok"}"#));
        assert!(!ready_to_mark_running(true, false));
        assert!(!ready_to_mark_running(false, true));
        assert!(ready_to_mark_running(true, true));
    }

    #[test]
    fn errors_name_the_next_step() {
        for text in [
            err_engine_missing(),
            err_model_missing("missing.gguf"),
            err_port_busy(8080),
            err_not_running(),
            err_health_timeout(8080, "boom"),
            err_process_exited("exit"),
            err_request("超时"),
            err_conn_refused(8080),
            err_http(500, "bad"),
            err_zip_no_llama(),
        ] {
            assert!(text.contains("下一步"), "{text}");
        }
        assert!(err_model_missing("a.gguf").contains("a.gguf"));
        assert!(err_port_busy(8081).contains("8081"));
        assert!(err_conn_refused(9).contains("127.0.0.1:9"));
    }

    #[test]
    fn sse_parser_handles_split_chunks_done_and_reasoning() {
        let mut p = SseParser::default();
        let mut all = Vec::new();
        all.extend(p.push("data: {\"choices\":[{\"delta\":{\"content\":\"你\"}}]}\n"));
        all.extend(p.push("\ndata: {\"choices\":[{\"delta\":{\"reasoning_content\":\"想\"}}]}\n\n"));
        all.extend(p.push("data: {\"choices\":[{\"delta\":{\"content\":\"好\"}}]}\n\ndata: [DONE]\n\n"));
        assert_eq!(
            all,
            vec![
                SsePiece::Delta("你".into()),
                SsePiece::Reasoning("想".into()),
                SsePiece::Delta("好".into()),
                SsePiece::Done,
            ]
        );
    }

    #[test]
    fn sse_finish_reads_non_stream_json_and_errors() {
        let mut p = SseParser::default();
        p.push(r#"{"choices":[{"message":{"content":"完整回复"}}]}"#);
        let got = p.finish().unwrap();
        assert_eq!(got, vec![SsePiece::Delta("完整回复".into())]);

        let mut bad = SseParser::default();
        bad.push(r#"{"error":{"message":"模型还没加载"}}"#);
        let err = bad.finish().unwrap_err();
        assert!(err.contains("模型还没加载"));
        assert!(err.contains("下一步"));
    }

    #[test]
    fn think_flag_and_limits_are_explicit() {
        let turns = vec![ChatTurn {
            role: "user".into(),
            content: "hi".into(),
        }];
        let off = chat_body(&turns, false, true);
        assert_eq!(off["chat_template_kwargs"]["enable_thinking"], false);
        assert!(off.get("reasoning_budget_tokens").is_none());
        assert_eq!(off["stream"], true);
        assert_eq!(off["max_tokens"], DEFAULT_MAX_TOKENS);
        assert!(off["max_tokens"].as_u64().unwrap() > 0);
        assert!(off["max_tokens"].as_u64().unwrap() < 100_000);
        assert!(off["repeat_penalty"].as_f64().unwrap() > 1.0);
        assert!(off["repeat_last_n"].as_i64().unwrap() > 0);
        let on = chat_body(&turns, true, false);
        assert_eq!(on["chat_template_kwargs"]["enable_thinking"], true);
        let budget = on["reasoning_budget_tokens"].as_i64().unwrap();
        assert!(budget > 0 && budget < 4096, "{budget}");
        assert_eq!(on["messages"][0]["content"], "hi");
        assert!(on.get("stop").is_none(), "结束标记交给模型模板，不写死一套 stop");
        let legacy = chat_body_fallback(&turns, false);
        assert!(legacy.get("chat_template_kwargs").is_none());
        assert!(legacy.get("max_tokens").is_none());
        assert!(legacy.get("reasoning_budget_tokens").is_none());
    }

    #[test]
    fn normalize_rejects_empty_and_keeps_roles() {
        assert!(normalize_messages(vec![]).unwrap_err().contains("下一步"));
        let ok = normalize_messages(vec![
            ("user".into(), " 问 ".into()),
            ("assistant".into(), "答".into()),
        ])
        .unwrap();
        assert_eq!(ok[0].content, "问");
        assert!(normalize_messages(vec![("tool".into(), "x".into())]).is_err());
    }

    fn serve(script: Vec<(u16, &'static str)>) -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let script = Arc::new(Mutex::new(script));
        thread::spawn(move || {
            for _ in 0..8 {
                let Ok((mut sock, _)) = listener.accept() else { break };
                let _ = sock.set_read_timeout(Some(Duration::from_secs(2)));
                let mut buf = Vec::new();
                let mut tmp = [0u8; 2048];
                loop {
                    match sock.read(&mut tmp) {
                        Ok(0) => break,
                        Ok(n) => {
                            buf.extend_from_slice(&tmp[..n]);
                            if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                                let head = String::from_utf8_lossy(&buf[..pos]).to_string();
                                let content_len = head
                                    .lines()
                                    .find_map(|line| {
                                        let (k, v) = line.split_once(':')?;
                                        if k.eq_ignore_ascii_case("content-length") {
                                            v.trim().parse::<usize>().ok()
                                        } else {
                                            None
                                        }
                                    })
                                    .unwrap_or(0);
                                while buf.len() < pos + 4 + content_len {
                                    match sock.read(&mut tmp) {
                                        Ok(0) | Err(_) => break,
                                        Ok(n) => buf.extend_from_slice(&tmp[..n]),
                                    }
                                }
                                break;
                            }
                        }
                        Err(_) => break,
                    }
                }
                let text = String::from_utf8_lossy(&buf).to_string();
                let mut queue = script.lock().unwrap();
                if queue.is_empty() {
                    break;
                }
                let (code, body) = queue.remove(0);
                let reason = if code == 200 { "OK" } else { "Bad Request" };
                let resp = format!(
                    "HTTP/1.1 {code} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = sock.write_all(resp.as_bytes());
                let _ = text;
            }
        });
        thread::sleep(Duration::from_millis(30));
        port
    }

    #[test]
    fn complete_chat_reads_mock_and_retries_without_thinking() {
        let port = serve(vec![
            (400, r#"{"error":{"message":"unknown field chat_template_kwargs"}}"#),
            (200, r#"{"choices":[{"message":{"content":"本地回复"}}]}"#),
        ]);
        let turns = normalize_messages(vec![("user".into(), "你好".into())]).unwrap();
        let text = complete_chat(port, &turns, true).unwrap();
        assert_eq!(text, "本地回复");
    }

    #[test]
    fn complete_chat_falls_back_when_limits_are_rejected() {
        let port = serve(vec![
            (400, r#"{"error":{"message":"unknown field repeat_penalty"}}"#),
            (200, r#"{"choices":[{"message":{"content":"还能回答"}}]}"#),
        ]);
        let turns = normalize_messages(vec![("user".into(), "你好".into())]).unwrap();
        let text = complete_chat(port, &turns, false).unwrap();
        assert_eq!(text, "还能回答");
    }

    #[test]
    fn complete_chat_refused_port_is_a_clear_error() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let turns = normalize_messages(vec![("user".into(), "你好".into())]).unwrap();
        let err = complete_chat(port, &turns, false).unwrap_err();
        assert!(err.contains("127.0.0.1"), "{err}");
        assert!(err.contains("下一步"), "{err}");
    }

    #[test]
    fn probe_health_accepts_only_ok() {
        let port = serve(vec![(200, r#"{"status":"loading"}"#)]);
        let err = probe_health_blocking(port, Duration::from_secs(2)).unwrap_err();
        assert!(err.contains("健康检查未通过"), "{err}");
        let port = serve(vec![(200, r#"{"status":"ok"}"#)]);
        probe_health_blocking(port, Duration::from_secs(2)).unwrap();
    }

    #[test]
    fn live_model_roundtrip_when_env_set() {
        let Ok(port_text) = std::env::var("OPENLOC_LIVE_PORT") else {
            return;
        };
        let port: u16 = port_text.parse().expect("OPENLOC_LIVE_PORT");
        probe_health_blocking(port, Duration::from_secs(5)).expect("健康检查");
        let turns = normalize_messages(vec![(
            "user".into(),
            "Reply with exactly: pong".into(),
        )])
        .unwrap();
        let text = complete_chat(port, &turns, false).expect("对话");
        assert!(!text.trim().is_empty(), "真实模型返回空内容");
        eprintln!("LIVE_REPLY={}", text.replace('\n', " "));
    }

    fn repetition_of(text: &str, window: usize) -> usize {
        let chars: Vec<char> = text.chars().collect();
        if chars.len() < window {
            return 1;
        }
        let mut best = 1usize;
        let mut i = 0;
        while i + window <= chars.len() && i < 800 {
            let needle: String = chars[i..i + window].iter().collect();
            let count = text.matches(needle.as_str()).count();
            if count > best {
                best = count;
            }
            i += window;
        }
        best
    }

    #[test]
    fn live_greeting_ends_once() {
        let Ok(port_text) = std::env::var("OPENLOC_LIVE_PORT") else {
            return;
        };
        let port: u16 = port_text.parse().expect("OPENLOC_LIVE_PORT");
        probe_health_blocking(port, Duration::from_secs(5)).expect("健康检查");
        let turns = normalize_messages(vec![("user".into(), "你好啊".into())]).unwrap();
        for think in [false, true] {
            let text = complete_chat(port, &turns, think).expect("对话");
            let trimmed = text.trim();
            eprintln!(
                "LIVE_GREETING think={think} chars={} reps={} text={}",
                trimmed.chars().count(),
                repetition_of(trimmed, 12),
                trimmed.replace('\n', " ")
            );
            assert!(!trimmed.is_empty(), "你好啊 返回空内容 think={think}");
            assert!(
                trimmed.chars().count() < 800,
                "你好啊 没有在合理长度内结束 think={think}: {trimmed}"
            );
            assert!(
                repetition_of(trimmed, 12) < 3,
                "你好啊 在复读 think={think}: {trimmed}"
            );
        }
    }

    #[tokio::test]
    async fn live_greeting_stream_ends_once() {
        let Ok(port_text) = std::env::var("OPENLOC_LIVE_PORT") else {
            return;
        };
        let port: u16 = port_text.parse().expect("OPENLOC_LIVE_PORT");
        let turns = normalize_messages(vec![("user".into(), "你好啊".into())]).unwrap();
        let mut text = String::new();
        let mut reason = String::new();
        let outcome = open_and_read_stream(
            port,
            &turns,
            false,
            || false,
            |_| {},
            |piece| match piece {
                SsePiece::Delta(part) => text.push_str(&part),
                SsePiece::Reasoning(part) => reason.push_str(&part),
                SsePiece::Done => {}
            },
        )
        .await
        .expect("流式对话");
        let all = format!("{reason}{text}");
        eprintln!(
            "LIVE_GREETING_STREAM chars={} reps={} text={}",
            all.chars().count(),
            repetition_of(&all, 16),
            all.replace('\n', " ")
        );
        assert!(!outcome.cancelled);
        assert!(!text.trim().is_empty(), "流式正文是空的: {all}");
        assert!(all.chars().count() < 4000, "流式回复没有结束: {all}");
        assert!(repetition_of(&all, 16) < 3, "流式回复在复读: {all}");
    }

    #[tokio::test]
    async fn live_model_stream_when_env_set() {
        let Ok(port_text) = std::env::var("OPENLOC_LIVE_PORT") else {
            return;
        };
        let port: u16 = port_text.parse().expect("OPENLOC_LIVE_PORT");
        let turns = normalize_messages(vec![("user".into(), "Hi".into())]).unwrap();
        let mut text = String::new();
        let outcome = open_and_read_stream(
            port,
            &turns,
            false,
            || false,
            |_| {},
            |piece| {
                if let SsePiece::Delta(part) = piece {
                    text.push_str(&part);
                }
            },
        )
        .await
        .expect("流式对话");
        assert!(!outcome.cancelled);
        assert!(!text.trim().is_empty(), "流式回复是空的");
        eprintln!("LIVE_STREAM={}", text.replace('\n', " "));
    }

    #[tokio::test]
    async fn stream_can_cancel_before_the_rest_arrives() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        thread::spawn(move || {
            let (mut sock, _) = listener.accept().unwrap();
            let _ = sock.set_nodelay(true);
            let _ = sock.set_read_timeout(Some(Duration::from_secs(2)));
            let mut buf = [0u8; 4096];
            let _ = sock.read(&mut buf);
            let part1 = "data: {\"choices\":[{\"delta\":{\"content\":\"甲\"}}]}\n\n";
            let part2 = "data: {\"choices\":[{\"delta\":{\"content\":\"乙\"}}]}\n\ndata: [DONE]\n\n";
            let len = part1.len() + part2.len();
            let head = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {len}\r\nConnection: close\r\n\r\n"
            );
            sock.write_all(head.as_bytes()).unwrap();
            sock.write_all(part1.as_bytes()).unwrap();
            thread::sleep(Duration::from_millis(250));
            let _ = sock.write_all(part2.as_bytes());
        });
        let turns = normalize_messages(vec![("user".into(), "问".into())]).unwrap();
        let mut calls = 0;
        let mut got = Vec::new();
        let outcome = open_and_read_stream(
            port,
            &turns,
            false,
            || {
                calls += 1;
                calls > 1
            },
            |_| {},
            |piece| got.push(piece),
        )
        .await
        .unwrap();
        assert!(outcome.cancelled, "流没有在第二段停下");
        assert_eq!(got, vec![SsePiece::Delta("甲".into())]);
    }

    #[tokio::test]
    async fn cancel_closes_the_server_connection() {
        use std::sync::atomic::{AtomicBool, Ordering as AtomicOrdering};
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let closed = Arc::new(AtomicBool::new(false));
        let flag = closed.clone();
        thread::spawn(move || {
            let (mut sock, _) = listener.accept().unwrap();
            let _ = sock.set_nodelay(true);
            let _ = sock.set_read_timeout(Some(Duration::from_millis(800)));
            let _ = sock.set_write_timeout(Some(Duration::from_millis(400)));
            let mut buf = [0u8; 8192];
            let _ = sock.read(&mut buf);
            let part = "data: {\"choices\":[{\"delta\":{\"content\":\"甲\"}}]}\n\n";
            let head = format!("{:x}\r\n", part.len());
            let resp = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n{head}{part}\r\n"
            );
            sock.write_all(resp.as_bytes()).unwrap();
            // 等客户端处理完第一段并丢掉连接。之后继续写，直到对端不再接收。
            thread::sleep(Duration::from_millis(200));
            let _ = sock.set_write_timeout(Some(Duration::from_millis(200)));
            let buf = vec![b'x'; 64 * 1024];
            let deadline = std::time::Instant::now() + Duration::from_secs(2);
            let mut wrote = 0usize;
            let mut stopped = false;
            while std::time::Instant::now() < deadline {
                match sock.write(&buf) {
                    Ok(0) => {
                        stopped = true;
                        break;
                    }
                    Ok(n) => wrote += n,
                    Err(_) => {
                        stopped = true;
                        break;
                    }
                }
            }
            // 内核发送缓冲能吞下几百 KB。停住之后不应还能连续写很多兆。
            flag.store(stopped && wrote < 6 * 1024 * 1024, AtomicOrdering::SeqCst);
        });
        let turns = normalize_messages(vec![("user".into(), "问".into())]).unwrap();
        let seen = Arc::new(AtomicBool::new(false));
        let seen_stop = seen.clone();
        let seen_piece = seen.clone();
        let outcome = open_and_read_stream(
            port,
            &turns,
            false,
            || seen_stop.load(AtomicOrdering::SeqCst),
            |_| {},
            |piece| {
                if matches!(piece, SsePiece::Delta(_)) {
                    seen_piece.store(true, AtomicOrdering::SeqCst);
                }
            },
        )
        .await
        .unwrap();
        assert!(outcome.cancelled, "已经收到一段后没有停");
        let wait_started = std::time::Instant::now();
        while !closed.load(AtomicOrdering::SeqCst) && wait_started.elapsed() < Duration::from_secs(3) {
            thread::sleep(Duration::from_millis(50));
        }
        assert!(
            closed.load(AtomicOrdering::SeqCst),
            "停止后连接还在，服务端仍能继续把生成内容写出去"
        );
    }

    #[test]
    fn warmup_request_is_short_and_thinking_off() {
        let body = warmup_body();
        assert_eq!(body["messages"][0]["content"], WARMUP_TEXT);
        assert_eq!(body["max_tokens"], WARMUP_MAX_TOKENS);
        assert!(WARMUP_MAX_TOKENS <= 32);
        assert_eq!(body["stream"], false);
        assert_eq!(body["chat_template_kwargs"]["enable_thinking"], false);
        assert!(body.get("reasoning_budget_tokens").is_none());
        let plain = warmup_body_plain();
        assert_eq!(plain["max_tokens"], WARMUP_MAX_TOKENS);
        assert!(plain.get("chat_template_kwargs").is_none());
        let running = warmup_running_message();
        assert!(running.contains("不影响"));
        assert!(running.contains("不会写入对话"));
    }

    #[test]
    fn warmup_judge_flags_empty_and_repetition_only() {
        assert_eq!(judge_warmup_text(""), WarmupPhase::Empty);
        assert_eq!(judge_warmup_text("   "), WarmupPhase::Empty);
        assert_eq!(judge_warmup_text("你好，我在。"), WarmupPhase::Ok);
        assert_eq!(judge_warmup_text("你好"), WarmupPhase::Ok);
        assert!(reply_is_repetitive("你好你好你好"));
        assert!(reply_is_repetitive("abcabcabc"));
        assert_eq!(judge_warmup_text("你好你好你好你好"), WarmupPhase::Repeat);
        assert!(!reply_is_repetitive("你好，今天天气不错。"));
        for phase in [WarmupPhase::Empty, WarmupPhase::Repeat, WarmupPhase::Timeout] {
            let text = warmup_message(phase, 1.2, "");
            assert!(text.contains("模板可能不匹配"), "{text}");
            assert!(text.contains("换模型"), "{text}");
            assert!(text.contains("思考"), "{text}");
            assert!(text.contains("可以直接对话") || text.contains("仍可以直接对话"), "{text}");
        }
        let ok = warmup_message(WarmupPhase::Ok, 1.2, "");
        assert!(ok.contains("试答正常"));
        assert!(ok.contains("没有写入对话"));
        assert!(!ok.contains("模板可能不匹配"));
    }

    #[tokio::test]
    async fn warmup_reads_a_short_reply_and_can_yield() {
        let port = serve(vec![(
            200,
            r#"{"choices":[{"message":{"content":"你好，我在。"}}]}"#,
        )]);
        let report = run_warmup(port, Duration::from_secs(3), || false).await;
        assert_eq!(report.phase, WarmupPhase::Ok, "{}", report.message);
        assert!(report.message.contains("试答正常"));

        let port = serve(vec![(200, r#"{"choices":[{"message":{"content":""}}]}"#)]);
        let empty = run_warmup(port, Duration::from_secs(3), || false).await;
        assert_eq!(empty.phase, WarmupPhase::Empty);

        let port = serve(vec![(
            200,
            r#"{"choices":[{"message":{"content":"你好你好你好你好"}}]}"#,
        )]);
        let repeated = run_warmup(port, Duration::from_secs(3), || false).await;
        assert_eq!(repeated.phase, WarmupPhase::Repeat);

        use std::sync::atomic::{AtomicBool, Ordering as AtomicOrdering};
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        thread::spawn(move || {
            let _hold = listener.accept();
            thread::sleep(Duration::from_secs(3));
        });
        let stop = Arc::new(AtomicBool::new(false));
        let flag = stop.clone();
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(150));
            flag.store(true, AtomicOrdering::SeqCst);
        });
        let started = std::time::Instant::now();
        let yielded = run_warmup(port, Duration::from_secs(8), || stop.load(AtomicOrdering::SeqCst)).await;
        assert_eq!(yielded.phase, WarmupPhase::Yielded, "{}", yielded.message);
        assert!(started.elapsed() < Duration::from_secs(3), "让路没有及时停掉试答");
        assert!(yielded.message.contains("没有写入对话"));
    }
}
