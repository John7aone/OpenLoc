import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import "../src/settings-prefs.js";

const root = new URL("..", import.meta.url);
const read = (rel) => fs.readFileSync(new URL(rel, root), "utf8");
const prefs = globalThis.OpenLocSettings;

test("下载地址只改写官方主机，拒绝带路径的前缀", () => {
  const llama = prefs.LLAMA_ENGINE_URL;
  assert.match(llama, /^https:\/\/github\.com\/ggml-org\/llama\.cpp\/releases\/download\/b12110\//);
  assert.equal(prefs.prepareDownloadUrl(llama, {}), llama);
  assert.equal(
    prefs.prepareDownloadUrl(llama, { githubPrefix: "https://proxy.example" }),
    "https://proxy.example/" + llama
  );
  assert.equal(prefs.prepareDownloadUrl(llama, { githubPrefix: "https://proxy.example/extra" }), llama);
  assert.equal(prefs.prepareDownloadUrl(llama, { githubPrefix: "http://proxy.example" }), llama);
  const model = "https://huggingface.co/org/repo/resolve/main/model.gguf";
  assert.equal(
    prefs.prepareDownloadUrl(model, { hfMirror: "https://mirror.example" }),
    "https://mirror.example/org/repo/resolve/main/model.gguf"
  );
  assert.equal(prefs.prepareDownloadUrl(model, { hfMirror: "https://mirror.example/hf" }), model);
  assert.equal(prefs.prepareDownloadUrl(llama, { hfMirror: "https://mirror.example" }), llama);
  assert.equal(prefs.hfApiBase(""), "https://huggingface.co");
  assert.equal(prefs.hfApiBase("https://mirror.example/"), "https://mirror.example");
  assert.equal(prefs.tokenHost("https://mirror.example"), "mirror.example");
  assert.equal(prefs.tokenHost("not a url"), "");
});

test("端口、镜像和接口地址按本机规则校验", () => {
  assert.equal(prefs.validPort("8080"), 8080);
  assert.equal(prefs.validPort("8686"), 8686);
  assert.equal(prefs.validPort("0"), null);
  assert.equal(prefs.validPort("65536"), null);
  assert.equal(prefs.validPort("80"), 80);
  const badMirror = prefs.validatePrefs({ hfMirror: "https://mirror.example/path", githubPrefix: "", hfToken: "" });
  assert.match(badMirror.error, /镜像/);
  const badToken = prefs.validatePrefs({ hfMirror: "", githubPrefix: "", hfToken: "has space" });
  assert.match(badToken.error, /令牌/);
  const ok = prefs.validatePrefs({
    hfMirror: "https://mirror.example/",
    githubPrefix: "",
    hfToken: "hf_local",
  });
  assert.equal(ok.error, "");
  assert.equal(ok.hfMirror, "https://mirror.example");
  assert.equal(prefs.apiBaseOk("https://api.example.com/v1"), true);
  assert.equal(prefs.apiBaseOk("http://127.0.0.1:8080/v1"), true);
  assert.equal(prefs.apiBaseOk("http://example.com/v1"), false);
  const draft = prefs.normalizeApiDraft({
    name: "示例",
    model: "demo",
    base: "https://api.example.com/v1",
    key: "secret",
  });
  assert.equal(draft.error, "");
  assert.equal(draft.entry.base, "https://api.example.com/v1");
  assert.match(prefs.normalizeApiDraft({ name: "示例", model: "demo", base: "http://10.0.0.8", key: "" }).error, /https/);
});

test("设置页按区块排好，没有付费线路，侧栏仍是八项", () => {
  const html = read("src/index.html");
  const main = read("src/main.js");
  const css = read("src/styles.css");
  const bundle = html + main + css + read("src/settings-prefs.js");
  for (const label of [
    "模型存放",
    "模型目录",
    "作品保存位置（画图 / 视频）",
    "界面语言",
    "外观",
    "重新检测",
    "推理引擎",
    "用已有的 llama.cpp",
    "手动导入 zip",
    "更新到最新版",
    "本地 API 端口",
    "高级设置",
    "HuggingFace 令牌（可选）",
    "HuggingFace 镜像（可选）",
    "GitHub 下载前缀（可选）",
    "第三方 API",
    "添加 API",
    "保存设置",
    "打开数据目录",
    "授权控制",
  ]) {
    assert.ok(html.includes(label), label);
  }
  assert.match(html, /id="themeSel"/);
  assert.match(html, /id="themeBtn"/);
  assert.match(html, /id="gpu-name"/);
  assert.match(html, /id="apiport"/);
  assert.match(html, /id="auth-chat"/);
  assert.match(html, /settings-prefs\.js/);
  assert.match(main, /OpenLocSettings\.prepareDownloadUrl/);
  assert.match(main, /import_engine_zip/);
  assert.match(css, /#2563eb/);
  assert.equal(bundle.includes("开通加速"), false);
  assert.equal(bundle.toLowerCase().includes("locmodel"), false);
  assert.equal(bundle.includes("高速线路"), false);
  assert.equal(bundle.includes("m1.locmodel.com"), false);
  assert.equal(bundle.includes("m2.locmodel.com"), false);
  assert.equal(html.includes('value="https://hf-mirror.com"'), false);
  assert.equal(html.includes('value="https://gh-proxy.com'), false);
  const nav = html.match(/<nav id="nav">([\s\S]*?)<\/nav>/)[1];
  const pages = [...nav.matchAll(/data-page="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(pages, ["overview", "cat", "md", "chat", "agent", "img", "vid", "settings"]);
  assert.equal(nav.includes("监测"), false);
  assert.match(html, /不会全盘搜索/);
  assert.match(html, /不会自动往后试别的端口/);
  assert.match(html, /顶部还不能改用这些接口/);
  assert.match(html, /不会自动搬家/);
  assert.match(main, /set_model_dir/);
  assert.match(main, /网页预览打不开系统文件夹对话框/);
});
