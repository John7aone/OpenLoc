import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const root = new URL("..", import.meta.url);
const read = (rel) => fs.readFileSync(new URL(rel, root), "utf8");

test("试答提示在运行页和对话页，不弹框、不写入对话", () => {
  const html = read("src/index.html");
  const main = read("src/main.js");
  const rust = read("src-tauri/src/chat_proto.rs");
  const app = read("src-tauri/src/main.rs");
  assert.match(html, /id="probe-run"/);
  assert.match(html, /id="probe-chat"/);
  const paint = main.slice(main.indexOf("function paintProbe"), main.indexOf("function applyChatStatus"));
  assert.equal(paint.includes("alert("), false);
  assert.match(paint, /probe-run/);
  assert.match(paint, /probe-chat/);
  assert.match(paint, /empty/);
  assert.match(paint, /repeat/);
  assert.match(paint, /timeout/);
  assert.match(main, /openloc-probe/);
  assert.match(main, /paintProbe\(s && s\.probe\)/);
  assert.equal(paint.includes("chatTurns"), false);
  assert.match(app, /schedule_warmup/);
  assert.match(app, /probe_stop/);
  assert.match(rust, /WARMUP_TEXT: &str = "你好"/);
  assert.match(rust, /enable_thinking": false/);
  assert.match(rust, /不会写入对话/);
  assert.match(rust, /模板可能不匹配/);
});
