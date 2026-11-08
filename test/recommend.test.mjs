import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const root = new URL("..", import.meta.url);
const code = fs.readFileSync(new URL("src/recommend.js", root), "utf8");
const context = {};
vm.createContext(context);
vm.runInContext(code, context);
const rec = context.OpenLocRecommend;

const gpu8 = {
  detected: true,
  preview: false,
  gpu: "NVIDIA GeForce RTX 3070 Ti",
  vramGb: 8,
  memoryTotalGb: 32,
  memoryAvailGb: 21,
  cpuCount: 16,
};

function model(params, extra) {
  return Object.assign({
    name: "示例",
    repo: "unsloth/example-GGUF",
    params: params,
    desc: "说明",
    cat: "对话",
  }, extra || {});
}

test("参数规模：混合专家用激活参数，E4B 按 4B，见仓库不猜", () => {
  const moe = rec.scaleOf("35B 总量 / 约 3B 激活");
  assert.equal(moe.totalB, 35);
  assert.equal(moe.activeB, 3);
  assert.equal(moe.moe, true);
  assert.match(moe.arch, /混合专家/);
  assert.match(moe.arch, /3B/);

  const small = rec.scaleOf("E4B（高效小模型）");
  assert.equal(small.totalB, 4);
  assert.equal(small.activeB, 4);
  assert.equal(small.moe, false);

  const dense = rec.scaleOf("12B");
  assert.equal(dense.totalB, 12);
  assert.equal(dense.moe, false);

  const unknown = rec.scaleOf("见仓库（Flash 系列）");
  assert.equal(unknown.known, false);
  assert.equal(unknown.totalB, null);
  assert.match(unknown.arch, /见仓库/);
});

test("显卡带宽：3070 Ti 用 608，不会被 3070 截走；未知卡按显存档", () => {
  const ti = rec.gpuBandwidth("NVIDIA GeForce RTX 3070 Ti", 8);
  assert.equal(ti.gbps, 608);
  assert.equal(ti.source, "spec");
  assert.equal(ti.matched, "rtx 3070 ti");

  const plain = rec.gpuBandwidth("NVIDIA GeForce RTX 3070", 8);
  assert.equal(plain.gbps, 448);
  assert.equal(plain.matched, "rtx 3070");

  const superTi = rec.gpuBandwidth("NVIDIA GeForce RTX 4070 Ti Super", 16);
  assert.equal(superTi.gbps, 672);
  assert.equal(superTi.matched, "rtx 4070 ti super");

  const a100 = rec.gpuBandwidth("NVIDIA A100-SXM4-80GB", 80);
  assert.equal(a100.gbps, 1935);
  assert.equal(a100.matched, "A100 80GB");

  const arc = rec.gpuBandwidth("Intel Arc A770", 16);
  assert.equal(arc.source, "vram-class");
  assert.equal(arc.gbps, 448);

  const laptop = rec.gpuBandwidth("NVIDIA GeForce RTX 3070 Ti Laptop GPU", 8);
  assert.equal(laptop.gbps, 608);
  assert.equal(laptop.laptop, true);
});

test("网页预览不编 tok/s，体积仍按参数量约出", () => {
  const view = rec.assess(model("4B"), rec.emptyHardware(true), "Q4_K_M");
  assert.equal(view.fit, "待检测");
  assert.equal(view.speedText, "待检测 / 网页预览");
  assert.equal(view.tokPerSec, null);
  assert.equal(view.sizeText, "约 2.2 GB");
  assert.equal(view.downloadText, "下载 约 2.2 GB");
  assert.equal(view.place, "还不知道落在哪");
  assert.match(view.formula, /不会编|不能约估/);
  assert.match(view.arch, /4B/);
});

test("硬件读失败时标约估不可用，不写成网页预览", () => {
  const view = rec.assess(model("4B"), rec.emptyHardware(false), "Q4_K_M");
  assert.equal(view.speedText, "约估不可用");
  assert.equal(view.tokPerSec, null);
  assert.match(view.placeDetail, /约估也不可用/);
});

test("4B Q4 放进 3070 Ti 8GB：流畅，约 95 tok/s", () => {
  const view = rec.assess(model("4B"), gpu8, "Q4_K_M（常用）");
  assert.equal(view.quant, "Q4_K_M");
  assert.equal(view.fit, "流畅");
  assert.equal(view.place, "全部放进显卡");
  assert.equal(view.sizeText, "约 2.2 GB");
  assert.equal(view.speedText, "约 95 tok/s");
  assert.equal(view.tokPerSec, 95);
  assert.equal(view.barPct, 100);
  assert.match(view.formula, /608 GB\/s × 0\.35/);
  assert.match(view.formula, /不是实测/);
  assert.match(view.placeDetail, /显存/);
});

test("同一台机器上，Q8 比 Q4 更大也更慢", () => {
  const q4 = rec.assess(model("4B"), gpu8, "Q4_K_M");
  const q8 = rec.assess(model("4B"), gpu8, "Q8_0");
  assert.equal(q8.sizeText, "约 4.2 GB");
  assert.equal(q8.fit, "流畅");
  assert.equal(q8.speedText, "约 50 tok/s");
  assert.ok(q8.tokPerSec < q4.tokPerSec);
  assert.ok(q8.sizeGb > q4.sizeGb);
});

test("35B 激活 3B 放不进 8GB，但比同体积稠密模型快", () => {
  const moe = rec.assess(model("35B 总量 / 约 3B 激活"), gpu8, "Q4_K_M");
  const dense = rec.assess(model("35B"), gpu8, "Q4_K_M");
  assert.equal(moe.fit, "能跑");
  assert.match(moe.place, /内存/);
  assert.equal(moe.sizeText, "约 19.6 GB");
  assert.equal(moe.speedText, "约 63 tok/s");
  assert.match(moe.formula, /0\.5/);
  assert.match(moe.placeDetail, /混合专家/);
  assert.equal(dense.fit, "能跑");
  assert.equal(dense.speedText, "约 <1 tok/s");
  assert.ok(moe.tokPerSec > 30);
});

test("12B 在 8GB 上放不进显存，速度按搬运带宽打折", () => {
  const view = rec.assess(model("12B"), gpu8, "Q4_K_M");
  assert.equal(view.fit, "能跑");
  assert.equal(view.place, "放不进显存，主要在内存");
  assert.equal(view.speedText, "约 12 tok/s");
  assert.match(view.formula, /12 GB\/s/);
});

test("120B 在 32GB 内存上标较慢，不假装能流畅跑", () => {
  const view = rec.assess(model("120B"), gpu8, "Q4_K_M");
  assert.equal(view.fit, "较慢");
  assert.equal(view.place, "内存也可能不够");
  assert.match(view.placeDetail, /不代表已经能跑/);
  assert.equal(view.speedText, "约 <1 tok/s");
});

test("没有显卡时 4B 标能跑，并按内存带宽约估", () => {
  const hw = {
    detected: true,
    preview: false,
    gpu: "未检测到 NVIDIA 显卡（CPU 模式可用）",
    vramGb: 0,
    memoryTotalGb: 16,
    memoryAvailGb: 10,
    cpuCount: 8,
  };
  const view = rec.assess(model("4B"), hw, "Q4_K_M");
  assert.equal(view.fit, "能跑");
  assert.equal(view.place, "没有独立显存，放在内存");
  assert.equal(view.speedText, "约 3.4 tok/s");
  assert.match(view.formula, /42 GB\/s × 0\.18/);
  assert.equal(view.barPct, 0);
});

test("参数未知时即使有显卡也不编数字；有文件大小则按整份文件估", () => {
  const unknown = rec.assess(model("见仓库（Flash 系列）"), gpu8, "Q4_K_M");
  assert.equal(unknown.fit, "待检测");
  assert.equal(unknown.speedText, "约估不可用");
  assert.equal(unknown.sizeText, "体积见仓库");
  assert.equal(unknown.downloadText, "下载");
  assert.equal(unknown.tokPerSec, null);

  const file = rec.assess(model("", { sizeGb: 5.1, name: "local-Q4_K_M.gguf" }), gpu8, "");
  assert.equal(file.quant, "Q4_K_M");
  assert.equal(file.sizeFromFile, true);
  assert.equal(file.sizeText, "5.1 GB");
  assert.equal(file.downloadText, "下载 5.1 GB");
  assert.equal(file.fit, "流畅");
  assert.equal(file.speedText, "约 42 tok/s");
  assert.match(file.formula, /整份文件/);
});

test("搜索页给出的每参数字节优先于量化表", () => {
  const view = rec.assess(model("4B", { sizeGb: 2.2, bytesPerParam: 2.2 / 4 }), gpu8, "Q8_0");
  assert.equal(view.fit, "流畅");
  assert.equal(view.speedText, "约 97 tok/s");
  assert.match(view.formula, /每参数约 0\.550 GB/);
  assert.match(view.formula, /不是实测/);
  assert.equal(view.formula.includes("量化 Q8_0"), false);
});

test("文件大小优先决定能不能放进显存", () => {
  const view = rec.assess(model("4B", { sizeGb: 20 }), gpu8, "Q4_K_M");
  assert.equal(view.fit, "能跑");
  assert.equal(view.sizeText, "20.0 GB");
  assert.match(view.place, /显存|内存/);
});

test("量化字符串和已安装文件名能对上目录", () => {
  assert.equal(rec.normalizeQuant("Q5_K_M"), "Q5_K_M");
  assert.equal(rec.normalizeQuant("Q4_K_M（常用）"), "Q4_K_M");
  assert.equal(rec.inferQuant("gemma-4-E4B-it-Q8_0.gguf"), "Q8_0");
  assert.equal(rec.inferQuant("notes.txt"), "");
  const catalog = [
    { name: "Gemma 4 E4B", repo: "unsloth/gemma-4-E4B-it-GGUF", params: "E4B（高效小模型）" },
    { name: "Gemma 4 12B", repo: "unsloth/gemma-4-12b-it-GGUF", params: "12B" },
    { name: "GPT-OSS 20B", repo: "unsloth/gpt-oss-20b-GGUF", params: "20B" },
    { name: "GPT-OSS 120B", repo: "unsloth/gpt-oss-120b-GGUF", params: "120B" },
  ];
  const e4 = rec.matchCatalog("C:\\Models\\gemma-4-E4B-it-Q4_K_M.gguf", catalog);
  assert.equal(e4.params, "E4B（高效小模型）");
  const b12 = rec.matchCatalog("gemma-4-12b-it-Q4_K_M.gguf", catalog);
  assert.equal(b12.name, "Gemma 4 12B");
  const oss = rec.matchCatalog("gpt-oss-120b-Q4_K_M.gguf", catalog);
  assert.equal(oss.name, "GPT-OSS 120B");
  const small = rec.matchCatalog("gpt-oss-20b-Q4_K_M.gguf", catalog);
  assert.equal(small.name, "GPT-OSS 20B");
});

test("界面脚本接的是这套估算，侧栏仍是八项，没有付费加速", () => {
  const html = fs.readFileSync(new URL("src/index.html", root), "utf8");
  const main = fs.readFileSync(new URL("src/main.js", root), "utf8");
  const css = fs.readFileSync(new URL("src/styles.css", root), "utf8");
  assert.match(html, /recommend\.js/);
  assert.match(main, /OpenLocRecommend\.assess/);
  assert.match(html, /id="est-speed"/);
  const nav = html.match(/<nav id="nav">([\s\S]*?)<\/nav>/)[1];
  const pages = [...nav.matchAll(/data-page="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(pages, ["overview", "cat", "md", "chat", "agent", "img", "vid", "settings"]);
  assert.equal((html + main + css).includes("开通加速"), false);
  assert.equal(css.includes("#ff7a45"), false);
  assert.match(css, /#2563eb/);
});
