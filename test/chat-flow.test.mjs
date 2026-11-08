import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const root = new URL("..", import.meta.url);
const flowCode = fs.readFileSync(new URL("src/chat-flow.js", root), "utf8");
const context = {};
vm.createContext(context);
vm.runInContext(flowCode, context);
const chat = context.OpenLocChat;

test("联网默认关闭，地址只写 loopback", () => {
  assert.equal(chat.defaultWebOn(), false);
  assert.equal(chat.loopbackUrl(8080), "http://127.0.0.1:8080/v1");
  assert.equal(chat.loopbackUrl(8080).includes("0.0.0.0"), false);
});

test("服务未启动时不发送，并给出下一步", () => {
  const plan = chat.planSend({ raw: "你好", attachmentNames: [], webOn: false, hasTauri: true });
  assert.equal(plan.kind, "check-service");
  assert.equal(plan.search, false);
  const blocked = chat.gateService({ running: false, detail: "未启动" });
  assert.equal(blocked.ok, false);
  assert.match(blocked.reply, /下一步/);
  assert.match(blocked.reply, /运行/);
  const ready = chat.gateService({ running: true, model: "a.gguf" });
  assert.equal(ready.ok, true);
});

test("纯文本模型不把附件当已识别内容", () => {
  const only = chat.planSend({ raw: "", attachmentNames: ["shot.png"], webOn: false, hasTauri: true });
  assert.equal(only.kind, "attachment-only");
  assert.match(only.reply, /没有发给模型/);
  assert.match(only.reply, /没有把图片当成已识别的内容/);
  const withText = chat.planSend({ raw: "这是什么", attachmentNames: ["shot.png"], webOn: false, hasTauri: true });
  assert.match(withText.modelText, /看不到文件内容/);
  assert.match(withText.shown, /没有上传/);
});

test("联网关闭不会进入检索；失败时不编造结果", () => {
  const off = chat.planSend({ raw: "今天新闻", attachmentNames: [], webOn: false, hasTauri: true });
  assert.equal(off.search, false);
  assert.equal(off.kind, "check-service");
  const on = chat.planSend({ raw: "今天新闻", attachmentNames: [], webOn: true, hasTauri: true });
  assert.equal(on.kind, "search");
  assert.equal(on.query, "今天新闻");
  const failed = chat.afterSearch(on.modelText, { ok: false, error: "HTTP 403" });
  assert.match(failed.note, /没有接上/);
  assert.equal(failed.modelText, on.modelText);
  const empty = chat.afterSearch("问题", { ok: true, text: "没搜到相关结果" });
  assert.match(empty.note, /不附带搜索摘要/);
  assert.equal(empty.modelText, "问题");
});

test("网页预览不假装有模型或搜索", () => {
  const preview = chat.planSend({ raw: "你好", attachmentNames: [], webOn: true, hasTauri: false });
  assert.equal(preview.kind, "preview");
  assert.equal(preview.search, false);
  assert.match(preview.reply, /没有搜索结果/);
  assert.match(preview.reply, /没有生成回复/);
});

test("流式增量可取消，已收到的文字保留", () => {
  let state = chat.reduceStream({}, { kind: "delta", text: "你" });
  state = chat.reduceStream(state, { kind: "delta", text: "好" });
  state = chat.reduceStream(state, { kind: "cancelled", text: "" });
  assert.equal(state.text, "你好");
  assert.equal(state.cancelled, true);
  const view = chat.renderAi(state);
  assert.match(view, /你好/);
  assert.match(view, /已停止生成/);
  const err = chat.reduceStream({ text: "半" }, { kind: "error", text: "请求失败：连接被拒绝。下一步：重新启动。" });
  assert.match(chat.renderAi(err), /半/);
  assert.match(chat.renderAi(err), /下一步/);
});

test("没有真实思考片段时不显示思考过程", () => {
  const state = chat.reduceStream({}, { kind: "done", text: "" });
  state.text = "";
  const done = chat.reduceStream({ text: "" }, { kind: "done" });
  assert.equal(done.reasoning, "");
  assert.match(chat.renderAi(done), /空内容/);
  assert.equal(chat.renderAi(done).includes("思考过程"), false);
  const thought = chat.reduceStream({}, { kind: "reasoning", text: "先看问题" });
  const withDelta = chat.reduceStream(thought, { kind: "delta", text: "答案" });
  assert.match(chat.renderAi(withDelta), /思考过程（引擎实际返回）/);
  assert.match(chat.renderAi(withDelta), /先看问题/);
  assert.match(chat.renderAi(withDelta), /答案/);
});

test("页面默认不联网，发送走同一套判断", () => {
  const html = fs.readFileSync(new URL("src/index.html", root), "utf8");
  const main = fs.readFileSync(new URL("src/main.js", root), "utf8");
  assert.match(html, /id="netBtn"[^>]*aria-checked="false"/);
  assert.match(main, /let webOn = false/);
  assert.equal(main.includes("let webOn = true"), false);
  assert.match(main, /OpenLocChat\.planSend/);
  assert.match(main, /OpenLocChat\.reduceStream/);
  assert.match(main, /127\.0\.0\.1/);
  assert.match(html, /chat-flow\.js/);
});
