"use strict";

(() => {
  const REGISTERED_CALLBACK = "https://127.0.0.1";
  const elements = Object.fromEntries(
    Array.from(document.querySelectorAll("[id]"), (element) => [element.id, element]),
  );
  const state = {
    loaded: false,
    busy: false,
    configured: false,
    authenticated: false,
    csrfToken: "",
    expiresAt: null,
    editingCredentials: false,
    hasResults: false,
    supportsProxyComparison: false,
    proxyAvailable: false,
    proxyLabel: "",
    benchmarkControlsInitialized: false,
  };

  function showMessage(text, kind = "info") {
    elements.message.textContent = text;
    elements.message.dataset.kind = kind;
    elements.message.setAttribute("role", kind === "error" ? "alert" : "status");
    elements.message.hidden = false;
  }

  function clearMessage() {
    elements.message.hidden = true;
    elements.message.textContent = "";
  }

  function updateExpiry() {
    if (!state.authenticated) {
      elements["expiry-status"].textContent = "—";
      return;
    }
    if (state.expiresAt === null) {
      elements["expiry-status"].textContent = "有效期未提供";
      return;
    }
    const seconds = Math.max(0, Math.ceil((state.expiresAt - Date.now()) / 1000));
    elements["expiry-status"].textContent = seconds > 0
      ? seconds < 60 ? `剩余约 ${seconds} 秒` : `剩余约 ${Math.ceil(seconds / 60)} 分钟`
      : "访问令牌待服务校验";
  }

  function renderState() {
    const ready = state.loaded && !state.busy;
    elements["config-status"].textContent = state.loaded ? state.configured ? "已配置" : "尚未配置" : "状态未读取";
    elements["config-status"].dataset.state = state.configured ? "good" : "pending";
    elements["auth-status"].textContent = state.loaded ? state.authenticated ? "已授权" : "尚未授权" : "状态未读取";
    elements["auth-status"].dataset.state = state.authenticated ? "good" : "pending";
    elements["refresh-status"].disabled = state.busy;
    elements.logout.hidden = !state.authenticated;
    elements.logout.disabled = !ready;
    elements["save-config"].disabled = !ready;
    elements["start-auth"].disabled = !ready || !state.configured;
    elements["complete-auth"].disabled = !ready || !state.configured;
    elements["run-benchmark"].disabled = !ready || !state.authenticated;
    elements["run-history-probe"].disabled = !ready || !state.authenticated;
    elements["edit-credentials"].disabled = !ready;
    elements["cancel-config"].disabled = state.busy;
    elements["client-id"].disabled = state.busy;
    elements["client-secret"].disabled = state.busy;
    elements["callback-url"].disabled = state.busy || !state.configured;
    elements.samples.disabled = state.busy;
    elements.route.disabled = state.busy || !state.loaded;
    elements["proxy-route-option"].disabled = !state.supportsProxyComparison || !state.proxyAvailable;
    elements["compare-route-option"].disabled = !state.supportsProxyComparison || !state.proxyAvailable;
    elements["extended-samples-option"].disabled = !state.supportsProxyComparison;
    elements["include-quotes"].disabled = state.busy;
    elements["configured-summary"].hidden = !state.configured || state.editingCredentials;
    elements["config-form"].hidden = state.configured && !state.editingCredentials;
    elements["cancel-config"].hidden = !state.configured;
    if (!state.busy) {
      elements["benchmark-state"].textContent = state.authenticated ? "可开始测速" : "等待账户授权";
      elements["empty-title"].textContent = state.authenticated ? "连接已就绪，开始一次只读测速" : "完成账户授权后，即可开始测速";
      elements["empty-description"].textContent = "这里将显示各线路的中位耗时、P95、慢请求与单次请求明细。";
    }
    updateBenchmarkPlan();
    updateExpiry();
  }

  function benchmarkPlan() {
    const endpointCount = elements["include-quotes"].checked ? 2 : 1;
    const routeCount = elements.route.value === "compare" ? 2 : 1;
    const groups = endpointCount * routeCount;
    const requests = Number(elements.samples.value) * groups;
    const warmups = state.supportsProxyComparison ? groups : 0;
    return { groups, requests, warmups };
  }

  function updateBenchmarkPlan() {
    if (!state.loaded) return;
    if (!state.supportsProxyComparison) {
      elements["route-description"].textContent = "当前服务支持直连与最多 10 次请求，代理对比暂不可用；现有授权仍可用于直连测速。";
    } else if (!state.proxyAvailable) {
      elements["route-description"].textContent = "当前未配置可用代理，可先测试直连。";
    } else {
      elements["route-description"].textContent = `已配置代理：${state.proxyLabel || "当前代理"}。对比模式交替测试两条线路，并分别复用各自的连接。`;
    }
    const { requests, warmups } = benchmarkPlan();
    elements["benchmark-plan"].textContent = `共 ${requests} 次统计请求${warmups ? `，另有 ${warmups} 次预热请求（不计入统计）` : ""}。${requests >= 80 ? "通常约需 2–4 分钟，网络波动时可能更久。" : "请保持页面打开，等待本组请求完成。"}`;
  }

  async function request(path, payload, timeoutMs = 45000) {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
      const options = {
        method: payload === undefined ? "GET" : "POST",
        cache: "no-store",
        credentials: "same-origin",
        redirect: "error",
        signal: controller.signal,
        headers: { Accept: "application/json" },
      };
      if (payload !== undefined) {
        if (!state.csrfToken) throw new Error("请先刷新本地服务状态，再重试。");
        options.headers["Content-Type"] = "application/json";
        options.headers["X-CSRF-Token"] = state.csrfToken;
        options.body = JSON.stringify(payload);
      }
      const response = await fetch(path, options);
      let data;
      try {
        data = await response.json();
      } catch {
        throw new Error("本地服务没有返回有效结果，请确认连接助手正在运行。");
      }
      if (!response.ok) {
        throw new Error(typeof data?.error === "string" ? data.error : `请求未成功（HTTP ${response.status}）。`);
      }
      return data;
    } catch (error) {
      if (error.name === "AbortError") throw new Error("请求超时，请检查连接后重试。");
      if (error instanceof TypeError) throw new Error("无法连接本地服务，请确认连接助手正在运行后刷新状态。");
      throw error;
    } finally {
      window.clearTimeout(timeout);
    }
  }

  async function refreshStatus() {
    const data = await request("/api/status");
    if (!data || typeof data.csrfToken !== "string" || !data.csrfToken) {
      throw new Error("本地服务状态缺少必要信息，请重启连接助手后重试。");
    }
    if (data.callbackUrl !== REGISTERED_CALLBACK) {
      throw new Error("本地服务的回调地址与本页面不一致，请检查连接助手配置。");
    }
    state.csrfToken = data.csrfToken;
    state.configured = data.configured === true;
    state.authenticated = data.authenticated === true;
    state.supportsProxyComparison = data.supportsProxyComparison === true;
    state.proxyAvailable = data.proxyAvailable === true;
    state.proxyLabel = typeof data.proxyLabel === "string" ? data.proxyLabel : "";
    if (!state.benchmarkControlsInitialized) {
      if (state.supportsProxyComparison && state.proxyAvailable) {
        elements.route.value = "compare";
        elements.samples.value = "20";
      }
      state.benchmarkControlsInitialized = true;
    }
    if (!state.supportsProxyComparison || !state.proxyAvailable) elements.route.value = "direct";
    if (!state.supportsProxyComparison && Number(elements.samples.value) > 10) elements.samples.value = "10";
    state.expiresAt = typeof data.expiresInSeconds === "number" && Number.isFinite(data.expiresInSeconds)
      ? Date.now() + Math.max(0, data.expiresInSeconds) * 1000
      : null;
    state.loaded = true;
    renderState();
  }

  async function runAction(action) {
    if (state.busy) return;
    clearMessage();
    state.busy = true;
    renderState();
    try {
      await action();
    } catch (error) {
      showMessage(error.message || "操作未成功，请重试。", "error");
    } finally {
      state.busy = false;
      renderState();
    }
  }

  function clearAuthorizationLink() {
    elements["auth-link"].removeAttribute("href");
    elements["auth-link-wrap"].hidden = true;
  }

  function clearResults() {
    state.hasResults = false;
    elements.results.hidden = true;
    elements["results-empty"].hidden = false;
    elements["results-body"].replaceChildren();
    elements["sample-details"].replaceChildren();
    elements["results-summary"].textContent = "";
    elements["results-method"].textContent = "";
    elements["measured-at"].textContent = "";
  }

  function numberText(value, suffix = "") {
    return typeof value === "number" && Number.isFinite(value) && value >= 0
      ? `${value.toLocaleString("zh-CN", { maximumFractionDigits: 1 })}${suffix}`
      : "—";
  }

  function addCell(row, text, className = "") {
    const cell = document.createElement("td");
    cell.textContent = text;
    if (className) cell.className = className;
    row.append(cell);
  }

  function successfulSample(sample) {
    return Number.isInteger(sample?.status) && sample.status >= 200 && sample.status < 300 && sample.validData !== false && sample.transportError !== true;
  }

  function sampleStatus(sample) {
    if (sample?.transportError === true) return "连接失败";
    if (!Number.isInteger(sample?.status)) return "—";
    return `${sample.status}${sample.status >= 200 && sample.status < 300 && sample.validData === false ? " · 无有效数据" : ""}`;
  }

  function renderResults(data) {
    if (!Array.isArray(data?.results) || data.results.length === 0) {
      throw new Error("测速没有返回接口结果，请重试。");
    }
    const summaryRows = document.createDocumentFragment();
    const detailRows = document.createDocumentFragment();
    let total = 0;
    let successful = 0;
    let warmupCount = 0;
    for (const [index, result] of data.results.entries()) {
      if (!result || !Array.isArray(result.samples)) throw new Error("测速结果格式无效，请重试。");
      const endpointLabel = typeof result.label === "string" ? result.label : `接口 ${index + 1}`;
      const routeLabel = typeof result.routeLabel === "string" ? result.routeLabel : result.route === "proxy" ? "当前代理" : "直连";
      const label = `${endpointLabel} · ${routeLabel}`;
      const count = result.samples.length;
      const successfulCount = Number.isInteger(result.successfulCount) && result.successfulCount >= 0 && result.successfulCount <= count
        ? result.successfulCount
        : result.samples.filter(successfulSample).length;
      const failureCount = Number.isInteger(result.failureCount) && result.failureCount >= 0 && result.failureCount <= count ? result.failureCount : count - successfulCount;
      total += count;
      successful += successfulCount;
      const row = document.createElement("tr");
      addCell(row, label);
      addCell(row, `${successfulCount} / ${count}${successfulCount === 0 ? " · 失败" : ""}`, successfulCount === count && count > 0 ? "status-success" : "status-failure");
      addCell(row, numberText(result.medianMs, " ms"), "metric-primary");
      addCell(row, numberText(result.p95Ms, " ms"));
      addCell(row, numberText(result.maxMs, " ms"));
      addCell(row, numberText(result.stddevMs, " ms"));
      addCell(row, numberText(result.over1000msCount), result.over1000msCount > 0 ? "status-failure" : "");
      addCell(row, numberText(failureCount), failureCount > 0 ? "status-failure" : "");
      addCell(row, `${numberText(result.reusedCount)} / ${count}`);
      summaryRows.append(row);

      const details = document.createElement("details");
      details.className = "sample-detail";
      const summary = document.createElement("summary");
      summary.textContent = `${label} · 查看 ${count} 次请求明细`;
      const warmup = document.createElement("div");
      warmup.className = "warmup-summary";
      if (result.warmup && typeof result.warmup === "object") {
        warmupCount += 1;
        const title = document.createElement("span");
        title.textContent = "预热请求";
        const elapsed = document.createElement("strong");
        elapsed.textContent = numberText(result.warmup.totalMs, " ms");
        const status = document.createElement("span");
        status.textContent = `${sampleStatus(result.warmup)} · 不计入统计`;
        status.className = successfulSample(result.warmup) ? "status-success" : "status-failure";
        warmup.append(title, elapsed, status);
      } else {
        warmup.textContent = Object.hasOwn(result, "warmup")
          ? "预热请求：未返回可用记录。"
          : "当前服务未单独提供预热记录；首个正式请求可能包含新建连接耗时。";
      }
      const scroll = document.createElement("div");
      scroll.className = "table-scroll";
      scroll.setAttribute("role", "region");
      scroll.setAttribute("aria-label", `${label}单次请求明细`);
      scroll.tabIndex = 0;
      const table = document.createElement("table");
      const head = document.createElement("thead");
      const headRow = document.createElement("tr");
      for (const title of ["请求", "HTTP 状态", "总耗时", "首字节", "连接", "响应字节数"]) {
        const th = document.createElement("th");
        th.scope = "col";
        th.textContent = title;
        headRow.append(th);
      }
      head.append(headRow);
      const body = document.createElement("tbody");
      result.samples.forEach((sample, sampleIndex) => {
        const sampleRow = document.createElement("tr");
        addCell(sampleRow, String(sampleIndex + 1));
        addCell(sampleRow, sampleStatus(sample), successfulSample(sample) ? "status-success" : "status-failure");
        addCell(sampleRow, numberText(sample?.totalMs, " ms"));
        addCell(sampleRow, numberText(sample?.firstByteMs, " ms"));
        addCell(sampleRow, sample?.reusedConnection === true ? "复用" : sample?.reusedConnection === false ? "新建" : "未知");
        addCell(sampleRow, numberText(sample?.bytes));
        body.append(sampleRow);
      });
      table.append(head, body);
      scroll.append(table);
      details.append(summary, warmup, scroll);
      detailRows.append(details);
    }
    elements["results-body"].replaceChildren(summaryRows);
    elements["sample-details"].replaceChildren(detailRows);
    const measuredAt = new Date(data.measuredAt);
    elements["measured-at"].textContent = Number.isNaN(measuredAt.getTime()) ? "" : `测试时间：${measuredAt.toLocaleString("zh-CN", { hour12: false })}`;
    elements["results-summary"].textContent = `${data.results.length} 组接口与线路 · ${total} 次统计请求 · ${successful} 次成功${warmupCount ? ` · 另有 ${warmupCount} 次预热` : ""}${successful < total ? "。未成功的请求请展开查看状态。" : "。"}`;
    elements["results-method"].textContent = data.results.every((result) => Object.hasOwn(result, "warmup"))
      ? "每组首个请求作为预热单独展示，已从上方汇总排除；预热也可能复用已有连接。耗时与标准差仅统计成功的业务响应。"
      : "当前结果未单独区分预热，首个请求可能包含新建连接耗时；旧服务未提供的统计项显示为 —。";
    elements.results.hidden = false;
    elements["results-empty"].hidden = true;
    state.hasResults = true;
    return { successful, total };
  }

  elements["refresh-status"].addEventListener("click", () => runAction(async () => {
    await refreshStatus();
    showMessage("本地服务状态已更新。", "success");
  }));

  elements["copy-callback"].addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(REGISTERED_CALLBACK);
      showMessage("已复制回调地址：请在 Schwab 开发者页面中替换原来的示例地址。", "success");
    } catch {
      showMessage(`浏览器未允许自动复制，请手动复制：${REGISTERED_CALLBACK}`);
    }
  });

  elements["edit-credentials"].addEventListener("click", () => {
    state.editingCredentials = true;
    renderState();
    elements["client-id"].focus();
  });

  elements["cancel-config"].addEventListener("click", () => {
    elements["config-form"].reset();
    state.editingCredentials = false;
    renderState();
  });

  elements["config-form"].addEventListener("submit", (event) => {
    event.preventDefault();
    if (state.busy) return;
    const clientId = elements["client-id"].value.trim();
    const clientSecret = elements["client-secret"].value.trim();
    elements["client-secret"].value = "";
    if (!clientId || !clientSecret) {
      showMessage("请完整填写 Client ID 与 Client Secret。", "error");
      return;
    }
    runAction(async () => {
      await request("/api/config", { clientId, clientSecret });
      elements["config-form"].reset();
      state.editingCredentials = false;
      clearAuthorizationLink();
      clearResults();
      await refreshStatus();
      showMessage("本地配置已保存。确认开发者页面的回调地址已更新，然后打开官方授权页。", "success");
    });
  });

  elements["start-auth"].addEventListener("click", () => runAction(async () => {
    clearAuthorizationLink();
    const data = await request("/api/auth/start", {});
    let authorizationUrl;
    try {
      authorizationUrl = new URL(data.authorizationUrl);
    } catch {
      throw new Error("服务返回的授权地址无效，未打开登录页面。");
    }
    if (authorizationUrl.origin !== "https://api.schwabapi.com" || authorizationUrl.pathname !== "/v1/oauth/authorize" || authorizationUrl.username || authorizationUrl.password) {
      throw new Error("服务返回的地址不是预期的 Schwab 官方授权页面，未打开登录页面。");
    }
    elements["auth-link"].href = authorizationUrl.href;
    elements["auth-link-wrap"].hidden = false;
    window.open(authorizationUrl.href, "_blank", "noopener,noreferrer");
    showMessage("请在 Schwab 官方页面完成登录，再把最终回调地址粘贴回来。若新标签页没有打开，可点击按钮下方的授权链接。");
  }));

  elements["callback-form"].addEventListener("submit", (event) => {
    event.preventDefault();
    if (state.busy) return;
    const callbackUrl = elements["callback-url"].value.trim();
    elements["callback-url"].value = "";
    if (!callbackUrl) {
      showMessage("请先粘贴授权完成后的完整回调地址。", "error");
      return;
    }
    runAction(async () => {
      await request("/api/auth/complete", { callbackUrl });
      clearAuthorizationLink();
      await refreshStatus();
      showMessage("账户授权成功。现在可以测试读取账户与持仓的实际耗时。", "success");
    });
  });

  elements["benchmark-form"].addEventListener("submit", (event) => {
    event.preventDefault();
    if (state.busy) return;
    const samples = Number(elements.samples.value);
    const includeQuotes = elements["include-quotes"].checked;
    const route = elements.route.value;
    const maxSamples = state.supportsProxyComparison ? 20 : 10;
    if (!Number.isInteger(samples) || samples < 1 || samples > maxSamples) {
      showMessage(`每个接口、每条线路的请求次数必须在 1 到 ${maxSamples} 之间。`, "error");
      return;
    }
    if (!["direct", "proxy", "compare"].includes(route) || (route !== "direct" && (!state.supportsProxyComparison || !state.proxyAvailable))) {
      showMessage("当前服务无法使用所选线路，请刷新状态后重试。", "error");
      return;
    }
    runAction(async () => {
      const card = elements["benchmark-form"].closest(".measurement-card");
      card.setAttribute("aria-busy", "true");
      elements["benchmark-state"].textContent = "正在测速…";
      elements["run-benchmark"].textContent = "正在测速…";
      elements["results-empty"].hidden = false;
      elements.results.hidden = true;
      elements["empty-title"].textContent = route === "compare" ? "正在交替测试直连与代理…" : "正在发送只读请求…";
      const { requests, warmups } = benchmarkPlan();
      const startedAt = Date.now();
      const updateProgress = () => {
        const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000);
        const elapsed = `${Math.floor(elapsedSeconds / 60)}:${String(elapsedSeconds % 60).padStart(2, "0")}`;
        elements["benchmark-state"].textContent = `正在${route === "compare" ? "对比" : "测速"} · ${elapsed}`;
        elements["empty-description"].textContent = `本组 ${requests} 次统计请求${warmups ? ` + ${warmups} 次预热` : ""}，已等待 ${elapsed}。${requests >= 80 ? "通常约需 2–4 分钟；" : ""}请保持页面打开，最长等待 10 分钟。`;
      };
      updateProgress();
      const progressTimer = window.setInterval(updateProgress, 1000);
      try {
        const payload = { samples, includeQuotes };
        if (state.supportsProxyComparison) payload.route = route;
        const data = await request("/api/benchmark", payload, 600000);
        const { successful, total } = renderResults(data);
        await refreshStatus();
        showMessage(successful === total
          ? "测速完成。结果反映本机读取接口的耗时，可展开查看每次请求。"
          : "测速已结束，部分请求未成功。请结合 HTTP 状态判断，失败请求不代表成功读取业务数据的延迟。", successful === total ? "success" : "info");
      } finally {
        window.clearInterval(progressTimer);
        card.setAttribute("aria-busy", "false");
        elements["run-benchmark"].textContent = "开始只读测速";
        elements.results.hidden = !state.hasResults;
        elements["results-empty"].hidden = state.hasResults;
      }
    });
  });

  elements["run-history-probe"].addEventListener("click", () => runAction(async () => {
    elements["history-probe-result"].textContent = "正在读取原始分钟行情…";
    const data = await request("/api/history-probe", {}, 90000);
    elements["history-probe-result"].textContent = data.results.map((r) => {
      const title = `${r.symbol} · ${r.mode} · HTTP ${r.httpStatus}`;
      if (!r.valid) return `${title}\n响应未通过数据验证，不能判断夜盘覆盖。`;
      return `${title}\n共 ${r.total} 根（美东时间）\n` + r.days.map((d) =>
        `${d.date} ${d.first}–${d.last}\n夜盘 ${d.夜盘} / 盘前 ${d.盘前} / 盘中 ${d.盘中} / 盘后 ${d.盘后}`).join("\n");
    }).join("\n\n");
    showMessage("原始数据诊断完成；夜盘为美东 20:00–04:00。", "success");
  }));

  elements.route.addEventListener("change", () => {
    if (elements.route.value === "compare" && state.supportsProxyComparison && state.proxyAvailable) elements.samples.value = "20";
    updateBenchmarkPlan();
  });
  elements.samples.addEventListener("change", updateBenchmarkPlan);
  elements["include-quotes"].addEventListener("change", updateBenchmarkPlan);

  elements.logout.addEventListener("click", () => runAction(async () => {
    await request("/api/logout", {});
    elements["callback-url"].value = "";
    clearAuthorizationLink();
    clearResults();
    await refreshStatus();
    showMessage("已清除本地授权。再次测速前需要重新登录授权。", "success");
  }));

  window.setInterval(updateExpiry, 10000);
  runAction(refreshStatus);
})();
