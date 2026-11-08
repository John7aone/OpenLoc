import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const root = new URL("..", import.meta.url);
const read = (rel) => fs.readFileSync(new URL(rel, root), "utf8");

test("侧栏没有截屏保存，对话截图只接受选区", () => {
  const html = read("src/index.html");
  const main = read("src/main.js");
  const rust = read("src-tauri/src/main.rs");
  const region = read("src-tauri/src/region_shot.rs");
  const cargo = read("src-tauri/Cargo.toml");
  assert.equal(html.includes("截屏保存"), false);
  assert.equal(html.includes("takeShot"), false);
  assert.equal(main.includes("takeShot"), false);
  assert.equal(main.includes("take_screenshot"), false);
  assert.match(html, /id="themeBtn"/);
  assert.match(html, /id="shotBtn"[^>]*title="框选一块区域/);
  assert.match(main, /shot\.mode !== "region"/);
  assert.match(main, /已把选区截图加入当前对话附件/);
  assert.equal(main.includes("整屏截图"), false);
  assert.equal(rust.includes("save_fullscreen"), false);
  assert.equal(rust.includes("take_screenshot"), false);
  assert.match(rust, /region_shot::capture_region_file/);
  assert.match(rust, /mode: "region"/);
  assert.equal(cargo.includes("screenshots"), false);
  assert.equal(region.includes("hide_on_close"), false);
  const script = region.slice(region.indexOf("const WINDOWS_REGION_PS1"), region.indexOf('"#;'));
  assert.match(script, /Keys\]::Escape/);
  assert.match(script, /\$crop\.Save/);
  assert.equal(script.includes("$full.Save"), false);
  assert.match(script, /exit 2/);
  assert.match(script, /CopyFromScreen/);
});
