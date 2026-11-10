// 有服务端给出的 token 数才写「实测」。没有计数时保持约估，不换算字符。
(function (root) {
  function measuredText(sample) {
    var tokens = sample && Number(sample.tokens);
    var ms = sample && Number(sample.ms);
    if (!(tokens > 0) || !(ms >= 200)) return null;
    var secs = ms / 1000;
    var rate = tokens / secs;
    if (!isFinite(rate) || rate <= 0) return null;
    var shown = rate >= 10 ? String(Math.round(rate)) : (Math.round(rate * 10) / 10).toFixed(1);
    var model = sample.model ? String(sample.model) : "当前模型";
    var ctx = sample.ctx ? String(sample.ctx) : "未记录";
    var offload = sample.offload ? String(sample.offload) : "";
    return {
      speedText: "实测约 " + shown + " tok/s",
      note: "本机刚才实测（" + tokens + " token，生成 " + secs.toFixed(1) + " 秒，从首个字开始计）。模型 " + model + "，上下文 " + ctx + "。" + offload + "这不是公式约估。",
    };
  }

  root.OpenLocSpeed = { measuredText: measuredText };
})(typeof globalThis !== "undefined" ? globalThis : this);
