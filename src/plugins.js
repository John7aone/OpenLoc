// 插件清单和对话里要不要调用。桌面端真正读写在 Rust；这里把话说死，测试也走这里。
(function (root) {
  var CATALOG = [
    {
      id: "web-search",
      name: "网络搜索",
      permission: "network",
      entry: "search",
      blurb: "用 DuckDuckGo 的公开网页搜索，不需要 API Key。",
      permissionText: "会访问网络：用 DuckDuckGo 的公开网页搜索，不需要 API Key，也不会把对话发到别的云端模型。",
    },
    {
      id: "read-files",
      name: "读本地文件",
      permission: "read_files",
      entry: "read_files",
      blurb: "只读你选中的文件或文件夹里的文本。",
      permissionText: "会读取你这次选中的文件或文件夹。不会静默扫描整盘，也不会读取你没选的位置。",
    },
  ];

  function catalog() {
    return CATALOG.map(function (item) {
      return {
        id: item.id,
        name: item.name,
        permission: item.permission,
        entry: item.entry,
        blurb: item.blurb,
        permissionText: item.permissionText,
      };
    });
  }

  function byId(id) {
    for (var i = 0; i < CATALOG.length; i++) {
      if (CATALOG[i].id === id) return CATALOG[i];
    }
    return null;
  }

  function permissionText(permission) {
    if (permission === "network") return CATALOG[0].permissionText;
    if (permission === "read_files") return CATALOG[1].permissionText;
    return "这个权限不认识，不会安装。";
  }

  function validateManifest(raw) {
    var item = raw || {};
    var id = String(item.id || "").trim();
    var name = String(item.name || "").trim();
    var permission = String(item.permission || "").trim();
    var entry = String(item.entry || "").trim();
    if (!/^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/.test(id) && !/^[a-z0-9]{2}$/.test(id)) {
      return { ok: false, error: "插件 id 不对。这次没有安装，也没有执行任何脚本。" };
    }
    if (!name || name.length > 40) return { ok: false, error: "插件名称不对。这次没有安装。" };
    if (permission !== "network" && permission !== "read_files") {
      return { ok: false, error: "权限只能是访问网络或读取你选的文件。不会安装，也不会执行脚本。" };
    }
    if (entry !== "search" && entry !== "read_files") {
      return { ok: false, error: "这个仓库的入口不是 OpenLoc 内置的搜索或读文件。不会执行它的脚本，这次没有安装。" };
    }
    if ((entry === "search" && permission !== "network") || (entry === "read_files" && permission !== "read_files")) {
      return { ok: false, error: "入口和权限对不上。这次没有安装。" };
    }
    return { ok: true, plugin: { id: id, name: name, permission: permission, entry: entry }, error: "" };
  }

  function parseRepo(input) {
    var raw = String(input || "").trim().replace(/\/+$/, "").replace(/\.git$/, "");
    var rest = raw.replace(/^https:\/\/github\.com\//, "").replace(/^http:\/\/github\.com\//, "");
    if (!raw || raw.indexOf("..") >= 0 || /:\/\//.test(rest)) {
      return { ok: false, error: "只接受 GitHub 上的公开仓库，例如 owner/repo。这次没有安装。" };
    }
    var parts = rest.split("/").filter(Boolean);
    if (parts.length !== 2) {
      return { ok: false, error: "仓库地址应是 owner/repo，或 https://github.com/owner/repo。这次没有安装。" };
    }
    return { ok: true, owner: parts[0], repo: parts[1], error: "" };
  }

  function searchDecision(input) {
    var webOn = !!(input && input.webOn);
    var enabled = !!(input && input.enabled);
    if (!webOn) return { action: "none" };
    if (!enabled) {
      return {
        action: "disabled",
        note: "网络搜索插件没有启用。到对话的「工具」里安装并打开后再查。这次没有访问网络，也不会编造搜索结果。",
      };
    }
    return { action: "search" };
  }

  function toolCall(text) {
    var raw = String(text || "").trim();
    var matched = raw.match(/^\[\[search:\s*([^\]]+?)\s*\]\]$/);
    if (!matched) return null;
    var query = matched[1].trim();
    if (!query) return null;
    return { tool: "search", query: query };
  }

  function readPlan(input) {
    var enabled = !!(input && input.enabled);
    var paths = ((input && input.paths) || []).map(function (p) { return String(p || "").trim(); }).filter(Boolean);
    if (!paths.length) {
      return { shouldRead: false, paths: [], note: "" };
    }
    if (!enabled) {
      return {
        shouldRead: false,
        paths: [],
        note: "读文件插件没有启用，没有读取正文。到「工具」里安装并打开后，才会读你选中的文件。",
      };
    }
    return { shouldRead: true, paths: paths, note: "" };
  }

  root.OpenLocPlugins = {
    catalog: catalog,
    byId: byId,
    permissionText: permissionText,
    validateManifest: validateManifest,
    parseRepo: parseRepo,
    searchDecision: searchDecision,
    toolCall: toolCall,
    readPlan: readPlan,
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
