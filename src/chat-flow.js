// 对话发送前的判断、流式事件归并。界面和测试都走这里，避免两套说法。
(function (root) {
  function defaultWebOn() {
    return false;
  }

  function attachmentNote(names) {
    return "（本机附件：" + names + "。只留在这条对话里，没有上传。这一版还不能识图，纯文本模型看不到图片和文件内容。）";
  }

  function notRunningReply() {
    return "聊天服务还没启动。下一步：打开「运行」页，选择已下载的 GGUF，点「启动模型」，等到健康检查通过、状态变成运行中，再回到对话发送。";
  }

  function planSend(input) {
    const raw = String((input && input.raw) || "").trim();
    const names = (input && input.attachmentNames) || [];
    const webOn = !!(input && input.webOn);
    const hasTauri = !!(input && input.hasTauri);
    if (!raw && !names.length) return { kind: "empty" };
    const note = names.length ? attachmentNote(names.join("、")) : "";
    const shown = raw ? (note ? raw + "\n" + note : raw) : note;
    if (!raw) {
      return {
        kind: "attachment-only",
        shown: shown,
        reply: "附件已记在上面。没有文字问题，这次没有发给模型，也没有把图片当成已识别的内容。",
        search: false,
      };
    }
    const modelText = names.length
      ? raw + "\n（用户在本机附了文件。这一版还不能识图，当前接口只接收文字，你看不到文件内容：" + names.join("、") + "）"
      : raw;
    if (!hasTauri) {
      const preview = "网页预览没有本地模型。请在桌面版的「运行」页启动后再发。这次没有生成回复。";
      const reply = webOn
        ? "已记录「允许联网」。网页预览没有接上联网检索，本次没有搜索结果，也不会编造。\n" + preview
        : preview;
      return { kind: "preview", shown: shown, modelText: modelText, reply: reply, search: false };
    }
    if (webOn) {
      if (input && input.searchPlugin === false) {
        return {
          kind: "check-service",
          shown: shown,
          modelText: modelText,
          search: false,
          note: "网络搜索插件没有启用。到对话的「工具」里安装并打开后再查。这次没有访问网络，也不会编造搜索结果。",
        };
      }
      return { kind: "search", shown: shown, modelText: modelText, query: raw, search: true };
    }
    return { kind: "check-service", shown: shown, modelText: modelText, search: false };
  }

  function afterSearch(modelText, search) {
    if (!search || !search.ok) {
      return {
        note: "联网检索没有接上（" + ((search && search.error) || "没有返回") + "）。已记录「允许联网」偏好，本次不附带搜索结果。",
        modelText: modelText,
      };
    }
    const text = String(search.text || "");
    if (!text || text.indexOf("没搜到") === 0) {
      return {
        note: "联网检索没有返回可用结果。本次只把原问题发给本地模型，不附带搜索摘要。",
        modelText: modelText,
      };
    }
    return {
      note: "联网检索结果（下面是检索返回的内容，不是模型编造）：\n" + text,
      modelText: "联网搜索结果（仅供参考，回答时以这些结果为准，不要编造更新的信息）：\n" + text + "\n\n用户问题：" + modelText,
    };
  }

  function gateService(status) {
    if (status && status.running) return { ok: true };
    if (status && status.detail && String(status.detail).indexOf("下一步") >= 0) {
      return { ok: false, reply: String(status.detail) };
    }
    return { ok: false, reply: notRunningReply() };
  }

  function eventOf(ev) {
    if (!ev) return { kind: "", text: "" };
    if (ev.kind) return { kind: ev.kind, text: ev.text || "" };
    if (ev.payload && ev.payload.kind) return { kind: ev.payload.kind, text: ev.payload.text || "" };
    return { kind: "", text: "" };
  }

  function reduceStream(state, ev) {
    const next = {
      text: (state && state.text) || "",
      reasoning: (state && state.reasoning) || "",
      status: (state && state.status) || "",
      done: !!(state && state.done),
      cancelled: !!(state && state.cancelled),
      error: (state && state.error) || "",
    };
    const item = eventOf(ev);
    if (item.kind === "delta") next.text += item.text;
    else if (item.kind === "reasoning") next.reasoning += item.text;
    else if (item.kind === "status") next.status = item.text;
    else if (item.kind === "done") next.done = true;
    else if (item.kind === "cancelled") {
      next.cancelled = true;
      next.status = item.text || next.status;
    } else if (item.kind === "error") next.error = item.text;
    return next;
  }

  function renderAi(state) {
    const current = state || {};
    let body = "";
    if (current.status && String(current.status).indexOf("思考开关") >= 0) {
      body += current.status + "\n\n";
    }
    if (current.reasoning) body += "思考过程（引擎实际返回）：\n" + current.reasoning + "\n\n";
    body += current.text || "";
    if (current.cancelled) {
      const line = current.status && String(current.status).indexOf("已停止") >= 0
        ? current.status
        : "已停止生成。已收到的内容保留，没有继续向本机服务要后续文字。";
      if (body.indexOf("已停止生成") < 0) body += (body ? "\n\n" : "") + line;
    } else if (current.error) {
      if (body.indexOf(current.error) < 0) body += (body ? "\n\n" : "") + current.error;
    } else if (!current.done && !body) {
      body = "正在生成本机回复…";
    } else if (current.done && !current.text && !current.reasoning && !current.error) {
      body = "（本地模型返回了空内容）";
    }
    return "AI：" + body;
  }

  function loopbackUrl(port) {
    return "http://127.0.0.1:" + String(port) + "/v1";
  }

  function errText(error) {
    if (error == null) return "未知错误";
    if (typeof error === "string") return error;
    if (error.message) return String(error.message);
    return String(error);
  }

  root.OpenLocChat = {
    defaultWebOn: defaultWebOn,
    attachmentNote: attachmentNote,
    notRunningReply: notRunningReply,
    planSend: planSend,
    afterSearch: afterSearch,
    gateService: gateService,
    reduceStream: reduceStream,
    renderAi: renderAi,
    loopbackUrl: loopbackUrl,
    errText: errText,
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
