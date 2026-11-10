// 对话只存在这台电脑的本地存储里。列表用真实会话，不放示例「你好」。
(function (root) {
  var KEY = "openloc-sessions";

  function titleFrom(turns) {
    var list = Array.isArray(turns) ? turns : [];
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].role === "user" && String(list[i].content || "").trim()) {
        var text = String(list[i].content).trim().replace(/\s+/g, " ");
        return text.length > 18 ? text.slice(0, 18) : text;
      }
    }
    return "新对话";
  }

  function load(raw) {
    var parsed;
    try { parsed = JSON.parse(raw || "[]"); } catch (e) { parsed = []; }
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(function (item) {
      return item && item.id && Array.isArray(item.turns);
    }).map(function (item) {
      return {
        id: String(item.id),
        title: titleFrom(item.turns),
        turns: item.turns.filter(function (turn) {
          return turn && (turn.role === "user" || turn.role === "assistant") && String(turn.content || "").trim();
        }).map(function (turn) {
          return { role: turn.role, content: String(turn.content) };
        }),
        updated: Number(item.updated) || 0,
      };
    });
  }

  function save(list) {
    var clean = load(JSON.stringify(list || []));
    clean.sort(function (a, b) { return b.updated - a.updated; });
    return JSON.stringify(clean.slice(0, 40));
  }

  function upsert(list, session) {
    var next = load(JSON.stringify(list || []));
    if (!session || !session.id) return next;
    var turns = session.turns || [];
    if (!turns.length) {
      return next.filter(function (item) { return item.id !== session.id; });
    }
    var row = { id: String(session.id), title: titleFrom(turns), turns: turns, updated: Date.now() };
    var found = false;
    next = next.map(function (item) {
      if (item.id === row.id) { found = true; return row; }
      return item;
    });
    if (!found) next.unshift(row);
    return load(save(next));
  }

  function remove(list, id) {
    return load(JSON.stringify(list || [])).filter(function (item) { return item.id !== String(id); });
  }

  root.OpenLocSessions = {
    key: KEY,
    titleFrom: titleFrom,
    load: load,
    save: save,
    upsert: upsert,
    remove: remove,
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
