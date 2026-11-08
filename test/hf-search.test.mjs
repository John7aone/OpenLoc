import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const root = new URL("..", import.meta.url);
const context = {};
vm.createContext(context);
vm.runInContext(fs.readFileSync(new URL("src/recommend.js", root), "utf8"), context);
vm.runInContext(fs.readFileSync(new URL("src/hf-search.js", root), "utf8"), context);
const hf = context.OpenLocHf;

const gpu8 = {
  detected: true,
  preview: false,
  gpu: "NVIDIA GeForce RTX 3070 Ti",
  vramGb: 8,
  memoryTotalGb: 32,
  memoryAvailGb: 21,
  cpuCount: 16,
};

const previewHw = { detected: false, preview: true, gpu: "", vramGb: 0, memoryTotalGb: 0, memoryAvailGb: 0, cpuCount: 0 };
const blindHw = { detected: false, preview: false, gpu: "", vramGb: 0, memoryTotalGb: 0, memoryAvailGb: 0, cpuCount: 0 };

const catalog = [
  { name: "Qwen3.8 Flash Next", repo: "unsloth/Qwen3.8-Flash-Next-GGUF", params: "180B 总量 / 约 6B 激活" },
  { name: "Qwen3.5 4B", repo: "unsloth/Qwen3.5-4B-GGUF", params: "4B" },
];

test("字节和下载次数按仓库数据排版，缺了就明说", () => {
  assert.equal(hf.formatByteSize(10_946_368), "10.9 MB");
  assert.equal(hf.formatByteSize(10_447_201_664), "10.4 GB");
  assert.equal(hf.formatByteSize(102_400_491_712), "102.4 GB");
  assert.equal(hf.formatByteSize(null), "体积未知");
  assert.equal(hf.formatByteSize(0), "体积未知");
  assert.equal(hf.formatDownloads(1_423_501), "1,423,501");
  assert.equal(hf.formatDownloads(0), "0");
  assert.equal(hf.formatDownloads(null), "未提供");
  assert.equal(hf.formatDownloads(undefined), "未提供");
});

test("接口结果只留下可下载的 GGUF，并读出体积、月下载和总参数", () => {
  const hits = hf.hitsFromApi([
    { id: "unsloth/Qwen3.5-4B-GGUF", downloads: 1540644 },
    { modelId: "only-model-id" },
    { downloads: 3 },
  ]);
  assert.equal(hits.length, 2);
  assert.equal(hits[0].id, "unsloth/Qwen3.5-4B-GGUF");
  assert.equal(hits[0].downloads, 1540644);
  assert.equal(hits[1].id, "only-model-id");
  assert.equal(hits[1].downloads, null);

  const detail = hf.detailFromApi("unsloth/Qwen3.5-4B-GGUF", {
    downloads: 1540644,
    gguf: { total: 4_000_000_000, totalFileSize: 9_999 },
    siblings: [
      { rfilename: "mmproj-BF16.gguf", size: 100 },
      { rfilename: "Q4_K_M/model-Q4_K_M.gguf", size: 2_200_000_000 },
      { rfilename: "BF16/a-00001-of-00002.gguf", lfs: { size: 11 } },
      { rfilename: "README.md", size: 12 },
    ],
  });
  assert.equal(detail.downloads, 1540644);
  assert.equal(detail.total_params, 4_000_000_000);
  assert.equal(detail.files.length, 2);
  assert.equal(detail.files[0].size_bytes, 2_200_000_000);
  assert.equal(detail.files[1].size_bytes, 11);
});

test("单个 Q4 文件用仓库字节和目录参数估算，网页预览不编 tok/s", () => {
  const detail = {
    repo: "unsloth/Qwen3.5-4B-GGUF",
    downloads: 1540644,
    total_params: 4_205_751_296,
    files: [{ path: "qwen3.5-4b-Q4_K_M.gguf", size_bytes: 2_200_000_000 }],
  };
  const shown = hf.presentDetail(detail, gpu8, catalog);
  const row = shown.files[0];
  assert.equal(row.sizeText, "2.2 GB");
  assert.equal(row.sizeExtra, "");
  assert.equal(row.downloadsText, "1,540,644");
  assert.equal(row.speedText, "约 97 tok/s");
  assert.equal(row.speedCaption, "估算");
  assert.match(row.detail, /全部放进显卡/);
  assert.match(row.detail, /OpenLoc 目录/);
  assert.match(row.formula, /不是实测/);
  assert.match(row.formula, /每参数约 0\.550 GB/);

  const preview = hf.presentDetail(detail, previewHw, catalog).files[0];
  assert.equal(preview.sizeText, "2.2 GB");
  assert.equal(preview.downloadsText, "1,540,644");
  assert.equal(preview.speedText, "待检测 / 网页预览");
  assert.equal(preview.speedCaption, "");
  assert.match(preview.detail, /不能约估/);

  const blind = hf.presentDetail(detail, blindHw, catalog).files[0];
  assert.equal(blind.speedText, "约估不可用");
  assert.equal(blind.speedCaption, "");
  assert.match(blind.formula, /不会填一个 tok\/s/);
});

test("分卷按整套体积估算，第一小卷不会单独快出天际", () => {
  const detail = {
    repo: "unsloth/Qwen3.8-Flash-Next-GGUF",
    downloads: 1423501,
    total_params: 176_943_899_520,
    files: [
      { path: "BF16/Qwen3.8-Flash-Next-BF16-00001-of-00002.gguf", size_bytes: 10_946_368 },
      { path: "BF16/Qwen3.8-Flash-Next-BF16-00002-of-00002.gguf", size_bytes: 353_000_000_000 },
      { path: "MTP/mtp-Qwen3.8-Flash-Next-BF16.gguf", size_bytes: 2_000_000_000 },
    ],
  };
  const rows = hf.presentDetail(detail, gpu8, catalog).files;
  assert.equal(rows[0].sizeText, "10.9 MB");
  assert.equal(rows[1].sizeText, "353.0 GB");
  assert.match(rows[0].sizeExtra, /整套/);
  assert.equal(rows[0].speedText, rows[1].speedText);
  assert.equal(rows[0].speedCaption, "估算");
  assert.match(rows[0].detail, /不是这一卷单独的速度/);
  assert.match(rows[0].detail, /OpenLoc 目录/);
  const tiny = context.OpenLocRecommend.assess(
    { name: rows[0].path, params: "", sizeGb: 10_946_368 / 1e9 },
    gpu8,
    ""
  );
  assert.notEqual(rows[0].speedText, tiny.speedText);
  assert.equal(rows[2].sizeText, "2.0 GB");
  assert.equal(rows[2].downloadsText, "1,423,501");
  assert.equal(rows[2].speedText, "约估不可用");
  assert.match(rows[2].detail, /MTP/);

  const noCatalog = hf.presentDetail(detail, gpu8, []).files[0];
  assert.match(noCatalog.detail, /没有激活参数/);
  assert.notEqual(noCatalog.speedText, rows[0].speedText);
});

test("分卷缺大小时不按单卷编速度，下载次数仍在", () => {
  const detail = {
    repo: "org/partial",
    downloads: null,
    total_params: 4_000_000_000,
    files: [
      { path: "Q4/model-Q4_K_M-00001-of-00002.gguf", size_bytes: 1_000_000_000 },
      { path: "Q4/model-Q4_K_M-00002-of-00002.gguf", size_bytes: null },
    ],
  };
  const rows = hf.presentDetail(detail, gpu8, []).files;
  assert.equal(rows[0].sizeText, "1.0 GB");
  assert.equal(rows[0].downloadsText, "未提供");
  assert.equal(rows[0].speedText, "约估不可用");
  assert.equal(rows[0].speedCaption, "");
  assert.match(rows[0].detail, /不按单卷/);
  assert.equal(rows[1].sizeText, "体积未知");
  assert.equal(rows[1].speedText, "约估不可用");

  const preview = hf.presentDetail(detail, previewHw, []).files[0];
  assert.equal(preview.speedText, "待检测 / 网页预览");
  assert.match(preview.detail, /不按单卷/);
  assert.match(preview.detail, /不能约估/);
});

test("体积小到不像整份权重时，不拿目录参数编一个很快的 tok/s", () => {
  const detail = {
    repo: "unsloth/Qwen3.8-Flash-Next-GGUF",
    downloads: 1423501,
    total_params: 176_943_899_520,
    files: [{ path: "Q4_K_M/tiny-Q4_K_M.gguf", size_bytes: 2_200_000_000 }],
  };
  const row = hf.presentDetail(detail, gpu8, catalog).files[0];
  assert.equal(row.sizeText, "2.2 GB");
  assert.equal(row.downloadsText, "1,423,501");
  assert.equal(row.speedText, "约估不可用");
  assert.equal(row.speedCaption, "");
  assert.match(row.detail, /对不上/);
});

test("没有字节但文件名能认出 Q4 时，速度仍按量化档估算，体积保持未知", () => {
  const detail = {
    repo: "unsloth/Qwen3.5-4B-GGUF",
    downloads: 12,
    total_params: null,
    files: [{ path: "qwen3.5-4b-Q4_K_M.gguf", size_bytes: null }],
  };
  const row = hf.presentDetail(detail, gpu8, catalog).files[0];
  assert.equal(row.sizeText, "体积未知");
  assert.equal(row.downloadsText, "12");
  assert.equal(row.speedText, "约 95 tok/s");
  assert.equal(row.speedCaption, "估算");
  assert.match(row.detail, /没有文件字节/);
});

test("界面把体积、下载次数和估算接到搜索页，下载按钮还在", () => {
  const html = fs.readFileSync(new URL("src/index.html", root), "utf8");
  const main = fs.readFileSync(new URL("src/main.js", root), "utf8");
  const css = fs.readFileSync(new URL("src/styles.css", root), "utf8");
  assert.match(html, /hf-search\.js/);
  assert.match(html, /近 30 天仓库下载次数/);
  assert.match(main, /OpenLocHf\.presentDetail/);
  assert.match(main, /hf_repo_detail/);
  assert.match(main, /search_hf/);
  assert.match(main, /查看文件并下载/);
  assert.match(main, />下载</);
  assert.match(main, /网页预览不会下载/);
  assert.match(css, /\.hf-file/);
  assert.match(css, /#2563eb/);
  assert.equal((html + main + css).includes("开通加速"), false);
});
