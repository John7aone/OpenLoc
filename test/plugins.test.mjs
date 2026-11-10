import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const root = new URL("..", import.meta.url);
const context = {};
vm.createContext(context);
vm.runInContext(fs.readFileSync(new URL("src/plugins.js", root), "utf8"), context);
const plugins = context.OpenLocPlugins;

test("内置两类插件，权限在安装前用中文写清", () => {
  const list = plugins.catalog();
  assert.equal(list.map((item) => item.id).join(","), "web-search,read-files");
  assert.match(plugins.permissionText("network"), /访问网络/);
  assert.match(plugins.permissionText("network"), /DuckDuckGo/);
  assert.match(plugins.permissionText("read_files"), /不会静默扫描整盘/);
  assert.match(plugins.byId("web-search").permissionText, /不需要 API Key/);
});

test("不认识的入口和仓库地址不会安装", () => {
  const script = plugins.validateManifest({ id: "evil", name: "坏", permission: "network", entry: "run.js" });
  assert.equal(script.ok, false);
  assert.match(script.error, /不会执行/);
  const shell = plugins.validateManifest({ id: "evil", name: "坏", permission: "shell", entry: "search" });
  assert.equal(shell.ok, false);
  assert.match(plugins.parseRepo("https://gitlab.com/a/b").error, /GitHub/);
  assert.match(plugins.parseRepo("../secret").error, /没有安装/);
  const ok = plugins.parseRepo("https://github.com/owner/demo.git");
  assert.equal(ok.ok, true);
  assert.equal(ok.owner, "owner");
  assert.equal(ok.repo, "demo");
});

test("未启用就不查网、不读文件；模型的搜索行可以认出来", () => {
  const off = plugins.searchDecision({ webOn: true, enabled: false });
  assert.equal(off.action, "disabled");
  assert.match(off.note, /没有启用/);
  assert.match(off.note, /没有访问网络/);
  assert.equal(plugins.searchDecision({ webOn: false, enabled: true }).action, "none");
  assert.equal(plugins.searchDecision({ webOn: true, enabled: true }).action, "search");
  const call = plugins.toolCall("[[search: 今天的新闻]]");
  assert.equal(call.tool, "search");
  assert.equal(call.query, "今天的新闻");
  assert.equal(plugins.toolCall("普通回答"), null);
  const unread = plugins.readPlan({ enabled: false, paths: ["C:/notes.md"] });
  assert.equal(unread.shouldRead, false);
  assert.match(unread.note, /没有读取正文/);
  const empty = plugins.readPlan({ enabled: true, paths: [] });
  assert.equal(empty.shouldRead, false);
  assert.equal(empty.note, "");
  const ready = plugins.readPlan({ enabled: true, paths: ["C:/notes.md"] });
  assert.equal(ready.shouldRead, true);
  assert.equal(ready.paths.join("|"), "C:/notes.md");
});

test("对话工具面板不新增侧栏，安装按钮在页面里", () => {
  const html = fs.readFileSync(new URL("src/index.html", root), "utf8");
  const main = fs.readFileSync(new URL("src/main.js", root), "utf8");
  const nav = html.match(/<nav id="nav">([\s\S]*?)<\/nav>/)[1];
  const pages = [...nav.matchAll(/data-page="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(pages, ["overview", "cat", "md", "chat", "agent", "img", "vid", "settings"]);
  assert.match(html, /id="tool-panel"/);
  assert.match(html, /plugins\.js/);
  assert.match(main, /OpenLocPlugins/);
  assert.match(main, /install_builtin_plugin/);
  assert.match(main, /plugin_search/);
  assert.match(main, /plugin_read_files/);
  assert.equal((html + main).toLowerCase().includes("locmodel"), false);
  assert.equal((html + main).includes("开通加速"), false);
});
