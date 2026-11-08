// 推荐卡片上的体积、落点和 tok/s。界面和测试都走这里。
// 这是带宽公式约估，不是在这台电脑上跑出来的 tok/s。
//
// 体积（GB）≈ 总参数（十亿）× 该量化的每参数字节数。
//   Q4_K_M 0.56、Q5_K_M 0.69、Q6_K 0.82、Q8_0 1.06。
//   这是 GGUF 的常见体积量级，不是 Hugging Face 上的精确字节。
// 运行体积 ≈ 权重体积 + 0.8 GB（上下文和计算缓冲的固定余量）。
// 可用显存 ≈ 显存 × 0.85。运行体积不超过可用显存才标「流畅」，
//   并写「全部放进显卡」。不超过内存 × 0.75 标「能跑」，否则「较慢」。
// 每 token 读取量 ≈ 激活参数 × 每参数字节数。
//   稠密模型的激活参数就是总参数。混合专家用「约 N B 激活」。
// tok/s ≈ 有效带宽（GB/s）÷ 每 token 读取量（GB）。
// 有效带宽：
//   整份放进显存：显卡标称显存带宽 × 0.35（解码吃不满标称带宽）。
//   名字对上公开规格表就用那一档；对不上但有显存，按显存容量取保守档，并写明。
//   混合专家整份放不进、但激活部分放得进：上面的显卡带宽再 × 0.5
//     （专家仍可能从内存换入，所以不按满速）。
//   稠密模型要分到内存：显存占比和内存占比做调和平均，
//     内存那段按 12 GB/s（保守的搬运带宽，不是测到的 PCIe）。
//   没有独立显存：内存带宽档 × 0.18。内存 ≥32 GB 按 64 GB/s，否则按 42 GB/s。
// 没有硬件、或参数规模和文件大小都不知道时，不给 tok/s。
// 调用方如果已经知道真实体积，可以同时给 model.bytesPerParam（GB/参数）。
// 搜索页用「文件字节 ÷ 总参数」填这个数，避免把 BF16 当成 Q4 的默认档。
// 没填时仍用下面的量化表，推荐卡片和已安装列表的数字不变。
(function (root) {
  var OVERHEAD_GB = 0.8;
  var VRAM_USABLE = 0.85;
  var RAM_FIT = 0.75;
  var GPU_EFF = 0.35;
  var MOE_SPILL_FACTOR = 0.5;
  var OFFLOAD_GBPS = 12;
  var RAM_CPU_EFF = 0.18;
  var RAM_BW_LARGE = 64;
  var RAM_BW_SMALL = 42;

  var QUANTS = [
    { id: "Q4_K_M", label: "Q4_K_M（常用）", bytes: 0.56 },
    { id: "Q5_K_M", label: "Q5_K_M", bytes: 0.69 },
    { id: "Q6_K", label: "Q6_K", bytes: 0.82 },
    { id: "Q8_0", label: "Q8_0", bytes: 1.06 }
  ];

  // 公开规格里的显存带宽（GB/s），只用于约估。匹配时按名字长短优先，避免 3070 吃掉 3070 Ti。
  var GPU_BANDWIDTH = [
    ["rtx 4070 ti super", 672],
    ["rtx 4070 ti", 504],
    ["rtx 4070 super", 504],
    ["rtx 4070", 504],
    ["rtx 4080 super", 736],
    ["rtx 4080", 717],
    ["rtx 4060 ti", 288],
    ["rtx 4060", 272],
    ["rtx 4090", 1008],
    ["rtx 3090 ti", 1008],
    ["rtx 3090", 936],
    ["rtx 3080 ti", 912],
    ["rtx 3080", 760],
    ["rtx 3070 ti", 608],
    ["rtx 3070", 448],
    ["rtx 3060 ti", 448],
    ["rtx 3060", 360],
    ["rtx 3050", 224],
    ["rtx 2080 ti", 616],
    ["rtx 2080 super", 496],
    ["rtx 2080", 448],
    ["rtx 2070 super", 448],
    ["rtx 2070", 448],
    ["rtx 2060 super", 448],
    ["rtx 2060", 336],
    ["gtx 1660 super", 336],
    ["gtx 1660 ti", 288],
    ["gtx 1660", 192],
    ["gtx 1080 ti", 484],
    ["gtx 1080", 320],
    ["rtx 5090", 1792],
    ["rtx 5080", 960],
    ["rtx 5070 ti", 896],
    ["rtx 5070", 672],
    ["rtx a6000", 768],
    ["rtx a5000", 768],
    ["rtx a4000", 448],
    ["a100", 1555],
    ["h100", 3350],
    ["l40s", 864],
    ["tesla t4", 320],
    [" t4", 320]
  ].sort(function (a, b) { return b[0].length - a[0].length; });

  function isNum(n) {
    return typeof n === "number" && isFinite(n);
  }

  function round1(n) {
    return (Math.round(n * 10) / 10).toFixed(1);
  }

  function knownQuantId(value) {
    var raw = String(value || "").replace("（常用）", "").replace("（推荐）", "").trim().toUpperCase();
    if (raw.indexOf("Q8") === 0) return "Q8_0";
    if (raw.indexOf("Q6") === 0) return "Q6_K";
    if (raw.indexOf("Q5") === 0) return "Q5_K_M";
    if (raw.indexOf("Q4") === 0) return "Q4_K_M";
    return "";
  }

  function normalizeQuant(value) {
    return knownQuantId(value) || "Q4_K_M";
  }

  function quantBytes(quant) {
    var id = normalizeQuant(quant);
    for (var i = 0; i < QUANTS.length; i++) {
      if (QUANTS[i].id === id) return QUANTS[i].bytes;
    }
    return QUANTS[0].bytes;
  }

  function inferQuant(name) {
    var u = String(name || "").toUpperCase();
    if (u.indexOf("Q8") >= 0) return "Q8_0";
    if (u.indexOf("Q6") >= 0) return "Q6_K";
    if (u.indexOf("Q5") >= 0) return "Q5_K_M";
    if (u.indexOf("Q4") >= 0) return "Q4_K_M";
    return "";
  }

  function scaleOf(params) {
    var text = String(params || "");
    if (!text || text.indexOf("见仓库") >= 0) {
      return { totalB: null, activeB: null, moe: false, arch: "参数规模见仓库，这里不猜", known: false };
    }
    var re = /([\d.]+)\s*B/gi;
    var match;
    var nums = [];
    while ((match = re.exec(text))) {
      var value = parseFloat(match[1]);
      if (!isFinite(value)) continue;
      var after = text.slice(match.index, match.index + match[0].length + 8);
      nums.push({ value: value, active: after.indexOf("激活") >= 0 });
    }
    if (!nums.length) {
      return { totalB: null, activeB: null, moe: false, arch: "参数规模见仓库，这里不猜", known: false };
    }
    var totalB = nums[0].value;
    var activeB = null;
    for (var i = 0; i < nums.length; i++) {
      if (nums[i].value > totalB) totalB = nums[i].value;
      if (nums[i].active) activeB = nums[i].value;
    }
    if (activeB == null) activeB = totalB;
    var moe = activeB + 0.05 < totalB;
    var arch = moe
      ? ("混合专家：总量约 " + totalB + "B，每次约激活 " + activeB + "B")
      : ("稠密：约 " + totalB + "B 参数");
    return { totalB: totalB, activeB: activeB, moe: moe, arch: arch, known: true };
  }

  function vramClassGbps(vramGb) {
    if (vramGb >= 24) return 700;
    if (vramGb >= 16) return 448;
    if (vramGb >= 12) return 360;
    if (vramGb >= 8) return 256;
    if (vramGb >= 6) return 192;
    if (vramGb > 0) return 112;
    return 0;
  }

  function gpuBandwidth(gpuName, vramGb) {
    var name = String(gpuName || "").toLowerCase().replace(/\s+/g, " ");
    var vram = isNum(vramGb) ? vramGb : 0;
    if (name.indexOf("a100") >= 0 && vram >= 70) {
      return { gbps: 1935, source: "spec", matched: "A100 80GB", laptop: false };
    }
    for (var i = 0; i < GPU_BANDWIDTH.length; i++) {
      if (name.indexOf(GPU_BANDWIDTH[i][0]) >= 0) {
        return {
          gbps: GPU_BANDWIDTH[i][1],
          source: "spec",
          matched: GPU_BANDWIDTH[i][0],
          laptop: name.indexOf("laptop") >= 0
        };
      }
    }
    if (vram > 0) {
      return { gbps: vramClassGbps(vram), source: "vram-class", matched: "", laptop: false };
    }
    return { gbps: 0, source: "none", matched: "", laptop: false };
  }

  function ramClass(memoryTotalGb) {
    if (!(memoryTotalGb > 0)) return { gbps: 0, label: "没有内存数据" };
    if (memoryTotalGb >= 32) return { gbps: RAM_BW_LARGE, label: "内存 ≥32GB，按双通道 DDR5 一类 " + RAM_BW_LARGE + " GB/s" };
    return { gbps: RAM_BW_SMALL, label: "按双通道 DDR4 一类 " + RAM_BW_SMALL + " GB/s" };
  }

  function presentTok(raw) {
    if (!(raw > 0) || !isFinite(raw)) return { tokPerSec: null, speedText: "" };
    if (raw < 1) return { tokPerSec: 0, speedText: "约 <1 tok/s" };
    var tokPerSec = raw >= 10 ? Math.round(raw) : Math.round(raw * 10) / 10;
    return { tokPerSec: tokPerSec, speedText: "约 " + tokPerSec + " tok/s" };
  }

  function emptyHardware(preview) {
    return {
      detected: false,
      preview: !!preview,
      gpu: "",
      vramGb: 0,
      memoryTotalGb: 0,
      memoryAvailGb: 0,
      cpuCount: 0
    };
  }

  function assess(model, hardware, quant) {
    var hw = hardware || emptyHardware(true);
    var scale = scaleOf(model && model.params);
    var namedQuant = knownQuantId(quant) || inferQuant(model && model.name);
    var quantId = namedQuant || "Q4_K_M";
    var explicitBytes = !!(model && isNum(model.bytesPerParam) && model.bytesPerParam > 0);
    var bytes = explicitBytes ? model.bytesPerParam : quantBytes(quantId);
    var sizeFromFile = !!(model && isNum(model.sizeGb) && model.sizeGb > 0);
    var sizeGb = sizeFromFile ? model.sizeGb : (scale.known ? scale.totalB * bytes : null);
    var runtime = sizeGb != null ? sizeGb + OVERHEAD_GB : null;
    var vram = isNum(hw.vramGb) ? hw.vramGb : 0;
    var mem = isNum(hw.memoryTotalGb) ? hw.memoryTotalGb : 0;
    var usable = vram * VRAM_USABLE;
    var gpu = gpuBandwidth(hw.gpu, vram);
    var ram = ramClass(mem);
    var shown = sizeGb != null ? round1(sizeGb) : "";
    var sizeText = sizeGb == null ? "体积见仓库" : (sizeFromFile ? (shown + " GB") : ("约 " + shown + " GB"));
    var downloadText = sizeGb == null ? "下载" : (sizeFromFile ? ("下载 " + shown + " GB") : ("下载 约 " + shown + " GB"));

    var fit = "待检测";
    var place = "还不知道落在哪";
    var placeDetail = "";
    var moeSpill = false;
    if (!hw.detected) {
      placeDetail = hw.preview
        ? "网页预览读不到显卡和内存，不能判断权重落在显存还是内存，也不会编一个 tok/s。"
        : "还没有读到这台电脑的硬件，不能判断落在哪，约估也不可用。";
    } else if (runtime == null) {
      place = "参数规模见仓库";
      placeDetail = "目录里没有能用的参数量，体积和 tok/s 都不猜。";
    } else if (vram > 0 && runtime <= usable) {
      fit = "流畅";
      place = "全部放进显卡";
      placeDetail = "主要落在显存里。tok/s 按标称带宽估算，不是这台电脑实测。";
    } else if (mem > 0 && runtime <= mem * RAM_FIT) {
      fit = "能跑";
      moeSpill = !!(scale.moe && vram > 0 && (scale.activeB * bytes + OVERHEAD_GB) <= usable);
      if (vram <= 0) {
        place = "没有独立显存，放在内存";
        placeDetail = "没检测到独立显存，权重放在内存里用 CPU。tok/s 是约估，不是实测。";
      } else if (moeSpill) {
        place = "整份不在显存，会用到内存";
        placeDetail = "整份权重放不进显存。混合专家每次只算激活的那一部分，速度按显卡带宽再打折约估，不是实测。";
      } else {
        place = "放不进显存，主要在内存";
        placeDetail = "放不进显存的部分在内存里，会更慢。tok/s 是约估，不是实测。";
      }
    } else {
      fit = "较慢";
      place = "内存也可能不够";
      placeDetail = "按这个体积，内存也可能放不下整份权重。速度数字只是硬搬时的带宽约估，不代表已经能跑。";
    }
    if (hw.detected && runtime != null && isNum(hw.memoryAvailGb) && hw.memoryAvailGb > 0 && runtime > hw.memoryAvailGb) {
      placeDetail += " 当前可用内存低于这份体积，加载时可能不够。";
    }

    var readGb = null;
    var readNote = "";
    if (scale.known) {
      readGb = scale.activeB * bytes;
      readNote = scale.moe ? "混合专家每 token 只读激活参数" : "稠密模型每 token 读全部参数";
    } else if (sizeFromFile) {
      readGb = sizeGb;
      readNote = "不知道参数规模，按整份文件每 token 读一遍";
    }

    var bw = 0;
    var bwNote = "";
    if (hw.detected && runtime != null && readGb > 0) {
      if (vram > 0 && runtime <= usable && gpu.gbps > 0) {
        bw = gpu.gbps * GPU_EFF;
        bwNote = gpu.source === "spec"
          ? ("显卡「" + gpu.matched + "」标称显存带宽 " + gpu.gbps + " GB/s × " + GPU_EFF)
          : ("显卡名未收录，按 " + vram + " GB 显存档 " + gpu.gbps + " GB/s × " + GPU_EFF);
        if (gpu.laptop) bwNote += "。名字里有 Laptop，用的仍是桌面同名规格，笔记本可能更低";
      } else if (moeSpill && gpu.gbps > 0) {
        bw = gpu.gbps * GPU_EFF * MOE_SPILL_FACTOR;
        bwNote = "整份权重不在显存里，激活参数仍按显卡带宽 × " + GPU_EFF + " × " + MOE_SPILL_FACTOR;
      } else if (vram > 0 && gpu.gbps > 0 && mem > 0) {
        var inVram = Math.min(runtime, usable);
        var vramFrac = inVram / runtime;
        var ramFrac = 1 - vramFrac;
        var gpuEff = gpu.gbps * GPU_EFF;
        bw = 1 / (vramFrac / gpuEff + ramFrac / OFFLOAD_GBPS);
        bwNote = "约 " + Math.round(vramFrac * 100) + "% 体积能放进可用显存，其余按 " + OFFLOAD_GBPS + " GB/s 做调和平均";
      } else if (ram.gbps > 0) {
        bw = ram.gbps * RAM_CPU_EFF;
        bwNote = ram.label + " × " + RAM_CPU_EFF + "（CPU 解码吃不满内存带宽）";
      }
    }

    var speedText = !hw.detected
      ? (hw.preview ? "待检测 / 网页预览" : "约估不可用")
      : "约估不可用";
    var tokPerSec = null;
    var formula = placeDetail;
    if (bw > 0 && readGb > 0) {
      var presented = presentTok(bw / readGb);
      tokPerSec = presented.tokPerSec;
      speedText = presented.speedText;
      var quantLead = explicitBytes
        ? ("按文件体积换算，每参数约 " + bytes.toFixed(3) + " GB。")
        : ("量化 " + quantId + "。");
      formula = quantLead + "每 token 约读 " + readGb.toFixed(2) + " GB（" + readNote + "）。有效带宽 " + bw.toFixed(1) + " GB/s：" + bwNote + "。tok/s ≈ 带宽 ÷ 读取量。不是实测。";
    } else if (!hw.detected && hw.preview) {
      formula = "网页预览没有显存、内存和显卡名，不能约估 tok/s。";
    } else if (!hw.detected) {
      formula = "硬件没读到，约估不可用，不会填一个 tok/s。";
    } else if (runtime == null) {
      formula = "参数规模见仓库，不能从参数量推出体积和 tok/s。";
    }

    var barPct = 0;
    var barTitle = hw.detected ? "没有独立显存，这条不表示显存占用" : "还没有硬件数据，不画占用比例";
    if (hw.detected && runtime != null && vram > 0) {
      barPct = Math.max(0, Math.min(100, Math.round(usable / runtime * 100)));
      barTitle = "可用显存大约盖住这份体积的 " + barPct + "%（可用按显存 × " + VRAM_USABLE + "）";
    }

    return {
      fit: fit,
      place: place,
      placeDetail: placeDetail,
      arch: scale.arch,
      quant: quantId,
      bytes: bytes,
      sizeGb: sizeGb,
      sizeText: sizeText,
      downloadText: downloadText,
      sizeFromFile: sizeFromFile,
      tokPerSec: tokPerSec,
      speedText: speedText,
      formula: formula,
      barPct: barPct,
      barTitle: barTitle,
      moe: scale.moe
    };
  }

  function matchCatalog(fileName, catalog) {
    var base = String(fileName || "").replace(/\\/g, "/").split("/").pop().toLowerCase();
    var best = null;
    var bestLen = 0;
    var list = catalog || [];
    for (var i = 0; i < list.length; i++) {
      var repo = String(list[i].repo || "");
      var slug = repo.split("/").pop().replace(/-gguf$/i, "").toLowerCase();
      if (slug && base.indexOf(slug) >= 0 && slug.length > bestLen) {
        best = list[i];
        bestLen = slug.length;
      }
    }
    return best;
  }

  root.OpenLocRecommend = {
    OVERHEAD_GB: OVERHEAD_GB,
    VRAM_USABLE: VRAM_USABLE,
    RAM_FIT: RAM_FIT,
    GPU_EFF: GPU_EFF,
    MOE_SPILL_FACTOR: MOE_SPILL_FACTOR,
    OFFLOAD_GBPS: OFFLOAD_GBPS,
    RAM_CPU_EFF: RAM_CPU_EFF,
    QUANTS: QUANTS,
    normalizeQuant: normalizeQuant,
    inferQuant: inferQuant,
    scaleOf: scaleOf,
    gpuBandwidth: gpuBandwidth,
    assess: assess,
    matchCatalog: matchCatalog,
    emptyHardware: emptyHardware
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
