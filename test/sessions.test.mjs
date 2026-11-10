import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const root = new URL("..", import.meta.url);
function load(rel, name) {
  const context = {};
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(new URL(rel, root), "utf8"), context);
  return context[name];
}
const sessions = load("src/sessions.js", "OpenLocSessions");
const speed = load("src/speed-note.js", "OpenLocSpeed");

test("会话列表来自真实记录，空列表不造你好", () => {
  assert.equal(sessions.load("[]").length, 0);
  assert.equal(sessions.load("not json").length, 0);
  const title = sessions.titleFrom([{ role: "user", content: "  帮我写一段说明  " }]);
  assert.equal(title, "帮我写一段说明");
  const saved = sessions.upsert([], { id: "a", turns: [{ role: "user", content: "你好啊" }, { role: "assistant", content: "在。" }] });
  assert.equal(saved.length, 1);
  assert.equal(saved[0].title, "你好啊");
  assert.equal(saved[0].turns.length, 2);
  const empty = sessions.upsert(saved, { id: "a", turns: [] });
  assert.equal(empty.length, 0);
  const html = fs.readFileSync(new URL("src/index.html", root), "utf8");
  assert.equal(html.includes('<b>你好</b>'), false);
  assert.match(html, /id="chat-history"/);
  assert.match(html, /sessions\.js/);
  assert.match(fs.readFileSync(new URL("src/main.js", root), "utf8"), /OpenLocSessions/);
});

test("没有 token 计数时不写实测", () => {
  assert.equal(speed.measuredText({ tokens: 0, ms: 1000 }), null);
  assert.equal(speed.measuredText({ tokens: 20, ms: 50 }), null);
  const text = speed.measuredText({ tokens: 24, ms: 1200, model: "qwen.gguf", ctx: "4096", offload: "GPU 层数 0。" });
  assert.match(text.speedText, /^实测约 /);
  assert.match(text.note, /不是公式约估/);
  assert.match(text.note, /qwen\.gguf/);
  const main = fs.readFileSync(new URL("src/main.js", root), "utf8");
  const html = fs.readFileSync(new URL("src/index.html", root), "utf8");
  assert.match(main, /OpenLocSpeed/);
  assert.match(html, /speed-note\.js/);
  assert.match(html, /id="api-help"/);
  assert.match(html, /这一版还不能识图/);
  assert.match(html, /Cursor/);
  assert.match(html, /Continue/);
  assert.match(html, /OpenCode/);
});
