// 搜索 Hugging Face 之后，每个可下载文件要能在点下载之前看到三件事：
// 体积、仓库下载次数、本机 tok/s 估算。
//
// 体积：模型接口 siblings.size（或 lfs.size），按字节换算。没有字节就写「体积未知」。
// 下载：模型接口的 downloads。Hugging Face 网页把这个字段标成 Downloads last month，
//   所以这里叫「近 30 天仓库下载」。公开接口没有单个文件的下载次数。
// tok/s：交给 OpenLocRecommend.assess，和推荐卡片同一套带宽公式。
//   分卷（00001-of-00008）用整套字节，不用单独那一小卷，否则第一卷会显得快得不像话。
//   仓库在 OpenLoc 目录里时，用目录上的激活参数。
//   不在目录里时，用 GGUF 元数据的总参数，并写明没有激活参数。
//   没有硬件、分卷不齐、或只是 MTP 附加文件时，不编一个 tok/s。
(function (root) {
  // 整份权重大约每参数 0.18–4.5 GB/十亿参数（约 IQ1 到 FP32）。
  // 比这更小的文件不像整份模型，多半是对不上的单卷或附加文件，不能拿去估 tok/s。
  var MIN_BYTES_PER_PARAM = 0.18;
  var MAX_BYTES_PER_PARAM = 4.5;

  function isNum(n) {
    return typeof n === "number" && isFinite(n);
  }

  function asCount(value) {
    if (isNum(value) && value >= 0) return value;
    if (typeof value === "string" && value.trim() !== "" && isFinite(Number(value))) {
      var n = Number(value);
      if (n >= 0) return n;
    }
    return null;
  }

  function formatByteSize(bytes) {
    var n = asCount(bytes);
    if (!(n > 0)) return "体积未知";
    var gb = n / 1e9;
    if (gb >= 1) return (Math.round(gb * 10) / 10).toFixed(1) + " GB";
    var mb = n / 1e6;
    if (mb >= 1) return (Math.round(mb * 10) / 10).toFixed(1) + " MB";
    var kb = n / 1e3;
    if (kb >= 1) return (Math.round(kb * 10) / 10).toFixed(1) + " KB";
    return Math.round(n) + " B";
  }

  function formatDownloads(value) {
    var n = asCount(value);
    if (n == null) return "未提供";
    return Math.round(n).toLocaleString("en-US");
  }

  function fileName(path) {
    var norm = String(path || "").replace(/\\/g, "/");
    var parts = norm.split("/");
    return parts[parts.length - 1] || norm;
  }

  function isModelFile(path) {
    var name = fileName(path).toLowerCase();
    return name.endsWith(".gguf") && name.indexOf("mmproj") !== 0;
  }

  function isAuxiliary(path) {
    var norm = String(path || "").replace(/\\/g, "/").toLowerCase();
    var name = fileName(norm);
    if (name.indexOf("mmproj") === 0) return true;
    if (norm.indexOf("/mtp/") >= 0 || name.indexOf("mtp-") === 0 || name.indexOf("mtp.") === 0) return true;
    return false;
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
    return {
      key: dir + m[1].toLowerCase() + "#" + count,
      index: index,
      count: count
    };
  }

  function hitsFromApi(payload) {
    var list = Array.isArray(payload) ? payload : [];
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var item = list[i] || {};
      var id = item.id || item.modelId || "";
      if (!id) continue;
      out.push({ id: String(id), downloads: asCount(item.downloads) });
    }
    return out;
  }

  function detailFromApi(repo, payload) {
    var api = payload || {};
    var siblings = Array.isArray(api.siblings) ? api.siblings : [];
    var files = [];
    for (var i = 0; i < siblings.length; i++) {
      var sib = siblings[i] || {};
      var path = sib.rfilename || sib.path || "";
      if (!isModelFile(path)) continue;
      var size = asCount(sib.size);
      if (size == null && sib.lfs) size = asCount(sib.lfs.size);
      files.push({ path: String(path), size_bytes: size });
    }
    var total = api.gguf ? asCount(api.gguf.total) : null;
    return {
      repo: String(repo || api.id || api.modelId || ""),
      downloads: asCount(api.downloads),
      total_params: total,
      files: files
    };
  }

  function paramsFor(repo, totalParams, catalog) {
    var list = catalog || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].repo === repo && list[i].params) {
        return { params: list[i].params, source: "catalog", name: list[i].name || "" };
      }
    }
    var n = asCount(totalParams);
    if (n > 0) {
      var b = n / 1e9;
      var shown = b >= 10 ? String(Math.round(b)) : (Math.round(b * 10) / 10).toFixed(1);
      return { params: "约 " + shown + "B", source: "hf", name: "" };
    }
    return { params: "", source: "none", name: "" };
  }

  function hardwareText(hw) {
    if (hw && hw.detected) return null;
    if (hw && hw.preview) return "待检测 / 网页预览";
    return "约估不可用";
  }

  function hardwareFormula(hw) {
    if (hw && hw.detected) return "";
    if (hw && hw.preview) return "网页预览没有显存、内存和显卡名，不能约估 tok/s。";
    return "硬件没读到，约估不可用，不会填一个 tok/s。";
  }

  function groupWeight(files) {
    var groups = {};
    for (var i = 0; i < files.length; i++) {
      var sp = splitOf(files[i].path);
      if (!sp) continue;
      if (!groups[sp.key]) groups[sp.key] = { count: sp.count, items: [] };
      groups[sp.key].items.push(files[i]);
    }
    var out = {};
    for (var key in groups) {
      if (!Object.prototype.hasOwnProperty.call(groups, key)) continue;
      var g = groups[key];
      var seen = {};
      var bytes = 0;
      var complete = g.items.length === g.count;
      for (var j = 0; j < g.items.length; j++) {
        var info = splitOf(g.items[j].path);
        seen[info.index] = true;
        if (!(g.items[j].size_bytes > 0)) complete = false;
        else bytes += g.items[j].size_bytes;
      }
      var nSeen = 0;
      for (var idx in seen) if (Object.prototype.hasOwnProperty.call(seen, idx)) nSeen += 1;
      if (nSeen !== g.count) complete = false;
      out[key] = { complete: complete && bytes > 0, bytes: bytes };
    }
    return out;
  }

  function presentDetail(detail, hardware, catalog) {
    var rec = root.OpenLocRecommend;
    var hw = hardware || (rec ? rec.emptyHardware(true) : { detected: false, preview: true });
    var info = detail || { repo: "", downloads: null, total_params: null, files: [] };
    var files = info.files || [];
    var weights = groupWeight(files);
    var meta = paramsFor(info.repo, info.total_params, catalog);
    var downloadsText = formatDownloads(info.downloads);
    var rows = [];
    for (var i = 0; i < files.length; i++) {
      rows.push(presentFile(files[i], info, hw, meta, weights));
    }
    return {
      repo: info.repo || "",
      downloadsText: downloadsText,
      files: rows
    };
  }

  function presentFile(file, info, hw, meta, weights) {
    var rec = root.OpenLocRecommend;
    var path = file.path;
    var ownSize = asCount(file.size_bytes);
    var sizeText = formatByteSize(ownSize);
    var sp = splitOf(path);
    var weightBytes = null;
    var sizeExtra = "";
    var scope = "";
    var blocked = "";
    if (isAuxiliary(path)) {
      blocked = "这是 MTP 或附加文件，不按整份对话模型估算 tok/s。";
    } else if (sp) {
      var g = weights[sp.key];
      if (g && g.complete) {
        weightBytes = g.bytes;
        sizeExtra = "整套 " + formatByteSize(g.bytes);
        scope = "分卷按整套 " + formatByteSize(g.bytes) + " 计算，不是这一卷单独的速度。";
      } else {
        blocked = "这是分卷，整套大小还不齐，不按单卷编 tok/s。";
      }
    } else if (ownSize > 0) {
      weightBytes = ownSize;
      scope = "按这个文件的体积计算。";
    }

    var quant = rec ? rec.inferQuant(path) : "";
    var view = null;
    var scale = rec ? rec.scaleOf(meta.params) : { known: false, totalB: null };
    if (!blocked && weightBytes > 0 && scale.known && scale.totalB > 0) {
      var bpp = (weightBytes / 1e9) / scale.totalB;
      if (bpp < MIN_BYTES_PER_PARAM || bpp > MAX_BYTES_PER_PARAM) {
        blocked = "文件体积和参数规模对不上，不像整份权重，不按它编 tok/s。";
        weightBytes = null;
      }
    }
    if (!blocked && !(weightBytes > 0)) {
      if (quant && meta.params) {
        view = rec.assess({
          name: path,
          repo: info.repo,
          params: meta.params
        }, hw, quant);
        scope = "没有文件字节，速度按参数规模和文件名里的量化档估算。";
      } else {
        blocked = "没有文件体积，文件名里也没有认得出的量化，不编 tok/s。";
      }
    } else if (!blocked) {
      var model = {
        name: path,
        repo: info.repo,
        params: meta.params,
        sizeGb: weightBytes / 1e9
      };
      if (scale.known && scale.totalB > 0) model.bytesPerParam = model.sizeGb / scale.totalB;
      view = rec.assess(model, hw, quant || "");
    }

    var speedText;
    var formula;
    var place = "";
    if (blocked && !view) {
      var hwLine = hardwareText(hw);
      if (hwLine && (blocked.indexOf("分卷") >= 0 || blocked.indexOf("没有文件体积") >= 0)) {
        speedText = hwLine;
        formula = hardwareFormula(hw) || blocked;
      } else {
        speedText = "约估不可用";
        formula = blocked;
      }
    } else {
      speedText = view.speedText;
      formula = view.formula;
      place = view.place || "";
    }

    var estimated = /tok\/s/.test(speedText);
    var bits = [];
    if (estimated) {
      if (scope) bits.push(scope);
      if (place && place !== "还不知道落在哪") bits.push(place + "。");
      if (meta.source === "catalog") bits.push("参数规模用的是 OpenLoc 目录，体积用的是仓库字节。");
      else if (meta.source === "hf") bits.push("总参数来自 Hugging Face 的 GGUF 元数据。没有激活参数，按整份权重估算。");
      else if (!(weightBytes > 0)) bits.push("不知道参数规模。");
    } else if (blocked) {
      bits.push(blocked);
      var hwFormula = hardwareFormula(hw);
      if (hwFormula && speedText !== "约估不可用") bits.push(hwFormula);
    } else if (view) {
      if (scope) bits.push(scope);
      if (view.formula) bits.push(view.formula);
    }
    return {
      path: path,
      sizeText: sizeText,
      sizeExtra: sizeExtra,
      downloadsText: formatDownloads(info.downloads),
      speedText: speedText,
      speedCaption: estimated ? "估算" : "",
      formula: formula || "",
      detail: bits.join("")
    };
  }

  function searchPublic(query) {
    var url = "https://huggingface.co/api/models?search=" + encodeURIComponent(query || "") + "&limit=20&filter=gguf";
    return fetch(url, { headers: { Accept: "application/json" } }).then(function (res) {
      if (!res.ok) throw new Error("Hugging Face 返回 HTTP " + res.status);
      return res.json();
    }).then(hitsFromApi);
  }

  function detailPublic(repo) {
    var path = String(repo || "").split("/").map(function (part) { return encodeURIComponent(part); }).join("/");
    var url = "https://huggingface.co/api/models/" + path + "?blobs=true";
    return fetch(url, { headers: { Accept: "application/json" } }).then(function (res) {
      if (!res.ok) throw new Error("Hugging Face 返回 HTTP " + res.status);
      return res.json();
    }).then(function (api) { return detailFromApi(repo, api); });
  }

  root.OpenLocHf = {
    formatByteSize: formatByteSize,
    formatDownloads: formatDownloads,
    isModelFile: isModelFile,
    isAuxiliary: isAuxiliary,
    splitOf: splitOf,
    hitsFromApi: hitsFromApi,
    detailFromApi: detailFromApi,
    paramsFor: paramsFor,
    presentDetail: presentDetail,
    searchPublic: searchPublic,
    detailPublic: detailPublic
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
