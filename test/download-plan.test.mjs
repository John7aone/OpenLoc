import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const root = new URL("..", import.meta.url);
const code = fs.readFileSync(new URL("src/download-plan.js", root), "utf8");
const context = {};
vm.createContext(context);
vm.runInContext(code, context);
const plan = context.OpenLocDownload;

test("单个 GGUF 只算自己，没有大小就不开下", () => {
  const one = plan.bundleFor("a.Q4_K_M.gguf", [{ path: "a.Q4_K_M.gguf", size_bytes: 1200 }, { path: "readme.md", size_bytes: 10 }]);
  assert.equal(one.error, "");
  assert.equal(one.files.length, 1);
  assert.equal(one.totalBytes, 1200);
  const missing = plan.bundleFor("a.gguf", [{ path: "a.gguf", size_bytes: 0 }]);
  assert.match(missing.error, /没有开始下载/);
  assert.match(missing.error, /a\.gguf/);
});

test("分卷按整套合计，缺一卷就不开下", () => {
  const files = [
    { path: "m-00001-of-00002.gguf", size_bytes: 10 },
    { path: "m-00002-of-00002.gguf", size_bytes: 15 },
  ];
  const all = plan.bundleFor(files[0].path, files);
  assert.equal(all.error, "");
  assert.equal(all.totalBytes, 25);
  assert.equal(all.files.length, 2);
  const short = plan.bundleFor(files[0].path, [files[0]]);
  assert.match(short.error, /分卷不齐/);
  assert.match(short.error, /没有开始下载/);
});

test("画图权重要带上有体积的编码器和 VAE，mmproj 不算进去", () => {
  const files = [
    { path: "flux.safetensors", size_bytes: 100 },
    { path: "vae.safetensors", size_bytes: 20 },
    { path: "clip_l.safetensors", size_bytes: 30 },
    { path: "mmproj-model.gguf", size_bytes: 40 },
  ];
  const pack = plan.bundleFor("flux.safetensors", files);
  assert.equal(pack.error, "");
  assert.equal(pack.totalBytes, 150);
  assert.equal(pack.files.some((f) => f.path.indexOf("mmproj") === 0), false);
  const blind = plan.bundleFor("flux.safetensors", [
    files[0],
    { path: "vae.safetensors", size_bytes: 0 },
  ]);
  assert.match(blind.error, /VAE|编码器|vae/i);
  assert.match(blind.error, /没有开始下载/);
});

test("页面下载走同一条带进度的命令，不说已经开始，也不说续传", () => {
  const html = fs.readFileSync(new URL("src/index.html", root), "utf8");
  const main = fs.readFileSync(new URL("src/main.js", root), "utf8");
  assert.match(html, /id="dl-dock"/);
  assert.match(html, /download-plan\.js/);
  assert.match(main, /start_download/);
  assert.match(main, /cancel_download/);
  assert.match(main, /openloc-download/);
  assert.equal(main.includes("已开始下载"), false);
  assert.equal((html + main).includes("断点续传"), false);
});
