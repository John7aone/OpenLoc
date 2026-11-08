// 设置页里和下载有关的纯函数：镜像、前缀、端口、第三方接口地址。
// 不访问网络，也不读写 localStorage。界面和测试都走这里。
(function (root) {
  var LLAMA_ENGINE_URL = "https://github.com/ggml-org/llama.cpp/releases/download/b12110/llama-b12110-bin-win-cpu-x64.zip";
  var SD_ENGINE_URL = "https://github.com/leejet/stable-diffusion.cpp/releases/download/master-1043/sd-master-1043-bin-win-cuda12-x64.zip";
  var PROJECT_URL = "https://github.com/John7aone/OpenLoc";
  var APP_VERSION = "0.1.0";

  function httpsOrigin(raw) {
    var s = String(raw || "").trim();
    if (!s) return "";
    var u;
    try { u = new URL(s); } catch (e) { return ""; }
    if (u.protocol !== "https:") return "";
    if (u.username || u.password) return "";
    if (u.pathname !== "/" && u.pathname !== "") return "";
    if (u.search || u.hash) return "";
    return u.origin;
  }

  function applyHfMirror(url, mirror) {
    var origin = httpsOrigin(mirror);
    var u = String(url || "");
    if (!origin) return u;
    if (u === "https://huggingface.co" || u.indexOf("https://huggingface.co/") === 0) {
      return origin + u.slice("https://huggingface.co".length);
    }
    return u;
  }

  function isGithubDownload(url) {
    return url.indexOf("https://github.com/") === 0
      || url.indexOf("https://objects.githubusercontent.com/") === 0
      || url.indexOf("https://release-assets.githubusercontent.com/") === 0;
  }

  function applyGithubPrefix(url, prefix) {
    var origin = httpsOrigin(prefix);
    var u = String(url || "");
    if (!origin || !isGithubDownload(u)) return u;
    if (u.indexOf(origin + "/") === 0) return u;
    return origin + "/" + u;
  }

  function prepareDownloadUrl(url, prefs) {
    var p = prefs || {};
    return applyGithubPrefix(applyHfMirror(url, p.hfMirror), p.githubPrefix);
  }

  function hfApiBase(mirror) {
    return httpsOrigin(mirror) || "https://huggingface.co";
  }

  function tokenHost(mirror) {
    var origin = httpsOrigin(mirror);
    if (!origin) return "";
    try { return new URL(origin).host; } catch (e) { return ""; }
  }

  function validPort(raw) {
    var text = String(raw == null ? "" : raw).trim();
    if (!/^\d+$/.test(text)) return null;
    var n = parseInt(text, 10);
    if (n < 1 || n > 65535) return null;
    return n;
  }

  function tokenShapeOk(token) {
    if (!token) return true;
    if (token.length > 512) return false;
    return !/[\s\u0000-\u001f]/.test(token);
  }

  function validatePrefs(prefs) {
    var p = prefs || {};
    var mirrorIn = String(p.hfMirror || "").trim();
    var prefixIn = String(p.githubPrefix || "").trim();
    var token = String(p.hfToken || "").trim();
    if (mirrorIn && !httpsOrigin(mirrorIn)) {
      return { error: "HuggingFace 镜像要填 https 网站根地址，不能带路径或账号。留空则走官方 huggingface.co。" };
    }
    if (prefixIn && !httpsOrigin(prefixIn)) {
      return { error: "GitHub 下载前缀要填 https 网站根地址。留空则直接从 GitHub 下载。" };
    }
    if (!tokenShapeOk(token)) {
      return { error: "HuggingFace 令牌格式不对，这次没有保存。" };
    }
    return {
      error: "",
      hfMirror: mirrorIn ? httpsOrigin(mirrorIn) : "",
      githubPrefix: prefixIn ? httpsOrigin(prefixIn) : "",
      hfToken: token,
    };
  }

  function apiBaseOk(raw) {
    var u;
    try { u = new URL(String(raw || "").trim()); } catch (e) { return false; }
    if (u.username || u.password) return false;
    if (u.protocol === "https:") return true;
    if (u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "localhost")) return true;
    return false;
  }

  function normalizeApiDraft(raw) {
    var d = raw || {};
    var name = String(d.name || "").trim();
    var model = String(d.model || "").trim();
    var base = String(d.base || "").trim().replace(/\/+$/, "");
    var key = String(d.key || "").trim();
    if (!name || name.length > 40) return { error: "请填写 1 到 40 字的名称。" };
    if (!model || model.length > 80) return { error: "请填写模型名。" };
    if (!apiBaseOk(base)) return { error: "接口地址只接受 https，或本机的 http://127.0.0.1 / localhost。" };
    if (!tokenShapeOk(key)) return { error: "Key 格式不对，没有保存。" };
    return {
      error: "",
      entry: { id: String(d.id || ""), name: name, model: model, base: base, key: key },
    };
  }

  root.OpenLocSettings = {
    LLAMA_ENGINE_URL: LLAMA_ENGINE_URL,
    SD_ENGINE_URL: SD_ENGINE_URL,
    PROJECT_URL: PROJECT_URL,
    APP_VERSION: APP_VERSION,
    httpsOrigin: httpsOrigin,
    applyHfMirror: applyHfMirror,
    applyGithubPrefix: applyGithubPrefix,
    prepareDownloadUrl: prepareDownloadUrl,
    hfApiBase: hfApiBase,
    tokenHost: tokenHost,
    validPort: validPort,
    validatePrefs: validatePrefs,
    apiBaseOk: apiBaseOk,
    normalizeApiDraft: normalizeApiDraft,
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
