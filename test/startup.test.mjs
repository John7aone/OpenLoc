import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const root = new URL("..", import.meta.url);
const read = (rel) => fs.readFileSync(new URL(rel, root), "utf8");

test("首屏脚本先交还绘制，硬件和引擎扫描不挡在启动函数里", () => {
  const main = read("src/main.js");
  const boot = main.slice(main.indexOf("const startShellWork"));
  assert.match(boot, /requestAnimationFrame\(function\(\) \{ requestAnimationFrame\(startShellWork\); \}\)/);
  assert.match(boot, /setTimeout\(startShellWork, 0\)/);
  assert.equal(boot.includes("\n  loadHw("), false);
  assert.equal(boot.includes("\n  loadModels("), false);
  assert.equal(boot.includes("\n  loadEngineStatus("), false);
  assert.match(boot, /function\(\) \{\s*loadImgModels\(\);\s*loadHw\(\);\s*loadModels\(\);\s*loadEngineStatus\(\);/);
});

test("推荐和模型页用目录本身，适合与否仍由页面上的估算决定", () => {
  const main = read("src/main.js");
  assert.match(main, /invoke\("get_catalog"\)/);
  assert.equal(main.includes('invoke("get_catalog_with_fit")'), false);
  assert.match(main, /OpenLocRecommend\.assess/);
  assert.match(main, /if \(catalogIsOpen\(\) && catalogCache\.length\) renderCatalog\(\)/);
  const rust = read("src-tauri/src/main.rs");
  assert.match(rust, /async fn get_hardware\(\)/);
  assert.match(rust, /async fn engine_status\(\)/);
  assert.match(rust, /async fn list_local_models\(\)/);
  assert.match(rust, /async fn list_local_model_info\(\)/);
  assert.match(rust, /async fn get_chat_status\(/);
  assert.match(rust, /fn hardware_refresh_kind\(\)/);
  const reader = rust.slice(rust.indexOf("fn read_host_machine"), rust.indexOf("fn parse_nvidia_smi_csv"));
  assert.equal(reader.includes("new_all"), false);
  assert.equal(reader.includes("refresh_all"), false);
  assert.match(rust, /未检测到 NVIDIA 显卡（CPU 模式可用）/);
});
