// 下载前把要落盘的文件合成一套：分卷算整套，画图再带上编码器和 VAE。
// 只做清单和字节合计。真正拦不拦，由桌面端按目标盘的可用空间决定。
(function (root) {
  function fileName(path) {
    var norm = String(path || "").replace(/\\/g, "/");
    var parts = norm.split("/");
    return parts[parts.length - 1] || norm;
  }

  function splitOf(path) {
    var norm = String(path || "").replace(/\\/g, "/");
    var name = fileName(norm);
    var m = name.match(/^(.*?)-(\d+)-of-(\d+)\.gguf$/i);
    if (!m) return null;
    var count = parseInt(m[3], 10);
    var index = parseInt(m[2], 10);
    if (!(count > 1) || !(index >= 1)) return null;
    var dir = norm.slice(0, norm.length - name.length).toLowerCase();
    return { key: dir + m[1].toLowerCase() + "#" + count, index: index, count: count };
  }

  function sizeOf(file) {
    var n = file && (file.size_bytes != null ? file.size_bytes : file.bytes);
    n = Number(n);
    return isFinite(n) && n > 0 ? n : 0;
  }

  function isCompanion(path) {
    var name = fileName(path).toLowerCase();
    if (name.indexOf("mmproj") === 0) return false;
    return /vae|text[_-]?encoder|clip[_-]?l|t5xxl|t5[_-]xxl/.test(name);
  }

  function isImageWeight(path) {
    var name = fileName(path);
    return /\.(safetensors|ckpt)$/i.test(name);
  }

  function bundleFor(chosenPath, siblings) {
    var files = Array.isArray(siblings) ? siblings : [];
    var chosen = null;
    for (var i = 0; i < files.length; i++) {
      if (files[i] && files[i].path === chosenPath) chosen = files[i];
    }
    if (!chosen && chosenPath) {
      chosen = { path: chosenPath, size_bytes: 0 };
    }
    if (!chosen || !chosen.path) {
      return { error: "没有要下载的文件，这次没有开始。" };
    }
    if (!(sizeOf(chosen) > 0)) {
      return { error: "没读到「" + chosen.path + "」的大小，这次没有开始下载，避免占满磁盘。" };
    }
    var set = [chosen];
    var sp = splitOf(chosen.path);
    if (sp) {
      set = [];
      var seen = {};
      for (var j = 0; j < files.length; j++) {
        var item = files[j];
        var part = item && splitOf(item.path);
        if (!part || part.key !== sp.key) continue;
        if (!(sizeOf(item) > 0)) {
          return { error: "分卷「" + item.path + "」没有体积，整套大小不齐，这次没有开始下载。" };
        }
        if (!seen[part.index]) {
          seen[part.index] = true;
          set.push(item);
        }
      }
      var n = 0;
      for (var key in seen) if (Object.prototype.hasOwnProperty.call(seen, key)) n += 1;
      if (n !== sp.count) {
        return { error: "分卷不齐（看到 " + n + " 个，应有 " + sp.count + " 个），这次没有开始下载。" };
      }
    }
    if (isImageWeight(chosen.path)) {
      for (var k = 0; k < files.length; k++) {
        var extra = files[k];
        if (!extra || !extra.path || extra.path === chosen.path) continue;
        if (set.some(function (have) { return have.path === extra.path; })) continue;
        if (!isCompanion(extra.path)) continue;
        if (!(sizeOf(extra) > 0)) {
          return { error: "「" + extra.path + "」没有体积。主体、编码器和 VAE 要一起算，这次没有开始下载。" };
        }
        set.push(extra);
      }
    }
    var total = 0;
    for (var t = 0; t < set.length; t++) total += sizeOf(set[t]);
    return { files: set, totalBytes: total, error: "" };
  }

  root.OpenLocDownload = {
    bundleFor: bundleFor,
    isCompanion: isCompanion,
    splitOf: splitOf,
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
