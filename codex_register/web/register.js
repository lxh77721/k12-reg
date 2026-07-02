const $ = (selector) => document.querySelector(selector);

let tasksCache = [];
let selectedTaskId = "";
let selectedBatchTaskId = "";
let configCache = null;
let platformPriceItems = [];
let smsCountriesByProvider = {};
let smsCountryFilter = "";
let successSummaryCache = null;
let registerPasswordCache = "";
let taskStatusFilter = "all";
let agentSummaryCache = null;
let registerBatchesCache = [];
let registerView = "tasks";
const MAX_TASK_CONCURRENCY = 20;

const SMS_COUNTRY_FALLBACK = [
  {code: 33, nameZh: "哥伦比亚", nameEn: "Colombia"},
  {code: 151, nameZh: "智利", nameEn: "Chile"},
  {code: 187, nameZh: "美国", nameEn: "United States"},
  {code: 6, nameZh: "印度尼西亚", nameEn: "Indonesia"},
  {code: 73, nameZh: "巴西", nameEn: "Brazil"},
  {code: 16, nameZh: "英国", nameEn: "United Kingdom"},
  {code: 39, nameZh: "阿根廷", nameEn: "Argentina"},
  {code: 36, nameZh: "加拿大", nameEn: "Canada"},
  {code: 31, nameZh: "南非", nameEn: "South Africa"},
  {code: 58, nameZh: "阿尔及利亚", nameEn: "Algeria"},
  {code: 22, nameZh: "印度", nameEn: "India"},
  {code: 48, nameZh: "荷兰", nameEn: "Netherlands"},
  {code: 76, nameZh: "安哥拉", nameEn: "Angola"},
];

function toast(message) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 2600);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function badge(status) {
  const label = {
    queued: "排队中",
    running: "运行中",
    success: "成功",
    failed: "失败",
    canceled: "已取消",
  }[status] || status;
  return `<span class="badge ${status}">${label}</span>`;
}

function flowBadge(task) {
  const mode = task.flowMode || (task.workflowMode === "free" ? "free" : task.workflowRunId ? "phone-plus-oa" : "phone-register");
  const label = task.flowLabel || {
    free: "完全 free",
    "phone-plus-oa": "手机号+Plus+OA",
    "oa-only": "OA 绑定",
    "phone-register": "手机号注册",
  }[mode] || mode;
  const cls = mode === "free" ? "flow-free" : mode === "phone-register" ? "flow-phone" : "flow-oa";
  return `<span class="badge ${cls}">${escapeHtml(label)}</span>`;
}

function relatedOaNote(task) {
  const email = task.relatedOaEmail || task.bindEmail;
  if (!email && !task.relatedOaStatus && task.flowMode !== "free") return "";
  const target = (task.relatedOaTarget || task.oaTarget || "sub2api").toUpperCase();
  const status = task.relatedOaStatus || (task.workflowStatus === "success" ? "success" : task.workflowStatus);
  const account = task.relatedSub2ApiAccount || task.relatedCpaAccount || task.sub2apiAccount || task.cpaAccount || "";
  const parts = [
    email ? `邮箱 ${email}` : "",
    status ? `OA ${status}` : "",
    account ? `${target} ${account}` : "",
    task.relatedOaError ? `错误 ${task.relatedOaError}` : "",
  ].filter(Boolean);
  if (!parts.length) return "";
  return `<div class="task-note flow-note">${escapeHtml(parts.join(" · "))}</div>`;
}

function fmtTime(value) {
  if (!value) return "-";
  return new Date(value).toLocaleString();
}

function listText(value) {
  return Array.isArray(value) && value.length ? value.join(", ") : "-";
}

function parseCountryInput() {
  return $("#smsCountries").value
    .split(/[\s,，;；]+/)
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isFinite(item));
}

function parsePriceInput() {
  return $("#smsPriceTiers").value
    .split(/[\s,，;；]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizePriceText(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return String(value);
  return String(number);
}

function shortId(id) {
  return id.replace(/^reg_/, "");
}

function taskName(task) {
  if (task.title && !task.title.startsWith("phone register")) return task.title;
  return shortId(task.id);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function primarySuccessFile() {
  const primary = successSummaryCache?.primary || {};
  return successSummaryPath(primary);
}

function successSummaryPath(primary) {
  if (!primary) return "";
  if (Number(primary.phoneCount || 0) > 0 || primary.phoneFileExists) return primary.phoneFile || "";
  if (Number(primary.tokenCount || 0) > 0 || primary.tokenFileExists) return primary.tokenFile || "";
  return "";
}

function successTextFileForTask(task) {
  if (task.successTextFile) return task.successTextFile;
  if (!task.tokenOut) return "";
  const slash = task.tokenOut.includes("\\") ? "\\" : "/";
  return task.tokenOut.replace(/[\\/][^\\/]+$/, `${slash}pool_phones.txt`);
}

function renderAgentDashboard(summary, batches) {
  agentSummaryCache = summary || null;
  registerBatchesCache = batches || [];
  if (!$("#agent-dashboard")) return;

  const register = summary?.register || {};
  const at = summary?.at || {};
  const oa = summary?.oa || {};
  const plus = summary?.plus || {};
  $("#agent-register-running").textContent = `${Number(register.running || 0)} / ${Number(register.queued || 0)}`;
  $("#agent-register-success-today").textContent = String(Number(register.successToday || 0));
  $("#agent-at-plus").textContent = `${Number(at.usableForPlus || 0)} / ${Number(at.total || 0)}`;
  $("#agent-oa-emails").textContent = String(Number(oa.availableEmails || 0));
  $("#agent-plus-otp").textContent = String(Number(plus.otpPending || 0));

  const wrap = $("#batch-list");
  if (!wrap) return;
  wrap.innerHTML = registerBatchesCache.length
    ? registerBatchesCache.slice(0, 8).map((batch) => {
        const target = batch.targetSuccess ? `\u76ee\u6807 ${batch.success || 0}/${batch.targetSuccess}` : `${batch.success || 0} \u6210\u529f`;
        const statusClass = batch.targetReached ? "success" : batch.done ? "done" : "running";
        const batchId = batch.batchId || "legacy";
        const canceledByUser = batch.canceledByUser || batch.freeAutoStatus === "canceled";
        const canCancel = Number(batch.running || 0) > 0
          || Number(batch.queued || 0) > 0
          || (batch.targetSuccess && !batch.targetReached && !batch.done && !canceledByUser);
        const statusLabel = canceledByUser ? "\u5df2\u53d6\u6d88" : (batch.done ? "\u5df2\u7ed3\u675f" : "\u8fdb\u884c\u4e2d");
        return `
          <div class="batch-item ${statusClass}">
            <div class="batch-main">
              <strong class="mono">${escapeHtml(batchId)}</strong>
              <span>${escapeHtml(target)} &middot; ${Number(batch.failed || 0)} \u5931\u8d25 &middot; ${Number(batch.running || 0)} \u8fd0\u884c &middot; ${Number(batch.queued || 0)} \u6392\u961f</span>
            </div>
            <div class="batch-actions">
              <small>${statusLabel}</small>
              <button class="small" type="button" data-batch-filter="${escapeHtml(batchId)}">\u770b\u4efb\u52a1</button>
              ${canCancel ? `<button class="danger small" type="button" data-batch-cancel="${escapeHtml(batchId)}">\u53d6\u6d88</button>` : ""}
            </div>
          </div>
        `;
      }).join("")
    : `<div class="empty compact">\u8fd8\u6ca1\u6709\u6279\u6b21\u6570\u636e</div>`;

  document.querySelectorAll("[data-batch-filter]").forEach((button) => {
    button.addEventListener("click", () => {
      const batchId = button.dataset.batchFilter;
      renderBatchTaskModal(batchId);
    });
  });
  document.querySelectorAll("[data-batch-cancel]").forEach((button) => {
    button.addEventListener("click", () => cancelBatch(button.dataset.batchCancel).catch((error) => toast(error.message)));
  });
}

async function loadAgentDashboard() {
  const [summary, batchData] = await Promise.all([
    api("/api/summary"),
    api("/api/register/batches"),
  ]);
  renderAgentDashboard(summary, batchData.batches || []);
}

async function cancelBatch(batchId) {
  const normalizedBatchId = batchId || "legacy";
  const batch = registerBatchesCache.find((item) => (item.batchId || "legacy") === normalizedBatchId);
  const activeCount = Number(batch?.running || 0) + Number(batch?.queued || 0);
  const ok = window.confirm(`确认取消批次 ${normalizedBatchId}？\n\n将取消 ${activeCount} 个排队/运行中的任务；自动补位批次会停止继续补任务。`);
  if (!ok) return;

  const isFreeAuto = normalizedBatchId.startsWith("free_auto");
  const path = isFreeAuto
    ? `/api/workflows/free-auto/${encodeURIComponent(normalizedBatchId)}/cancel`
    : `/api/register/batches/${encodeURIComponent(normalizedBatchId)}/cancel`;
  const data = await api(path, {method: "POST", body: "{}"});
  const canceled = data.result?.canceled ?? data.batch?.canceledCount ?? 0;
  toast(`批次已取消，已请求取消 ${canceled} 个任务`);
  await loadTasks();
}

function renderSuccessSummary(data) {
  successSummaryCache = data || null;
  const card = $("#success-summary");
  if (!card) return;

  const primary = data?.primary || {};
  const smsCost = data?.smsCost || {};
  const phoneCount = Number(primary.phoneCount || 0);
  const tokenCount = Number(primary.tokenCount || 0);
  const successSmsCost = Number(smsCost.success || 0);
  const totalSmsCost = Number(smsCost.total || 0);
  const filePath = successSummaryPath(primary);
  const successTasks = Number(data?.successfulTasks || 0);
  const failedTasks = Number(data?.failedTasks || 0);
  const running = Number(data?.running || 0);
  const queued = Number(data?.queued || 0);

  $("#success-phone-count").textContent = String(phoneCount);
  $("#success-token-count").textContent = String(tokenCount);
  $("#sms-cost-total").textContent = `$${successSmsCost.toFixed(4)}`;
  $("#sms-cost-total").title = `成功累计 $${successSmsCost.toFixed(6)} / 已取号累计 $${totalSmsCost.toFixed(6)}`;
  $("#success-task-count").textContent = `${successTasks} 成功 / ${failedTasks} 失败 / ${running} 运行 / ${queued} 排队`;
  $("#success-file-path").textContent = filePath || "还没有成功结果文件";
  $("#success-file-path").title = filePath || "";
  $("#copy-success-path").disabled = !filePath;
  $("#export-success").disabled = !phoneCount && !tokenCount;
  card.classList.toggle("has-success", phoneCount > 0 || tokenCount > 0 || successTasks > 0);
  updateTaskFilterCounts();
}

async function loadSuccessSummary() {
  const data = await api("/api/register/success");
  renderSuccessSummary(data);
}

function formatSmsBalance(item) {
  const value = Number(item.balance);
  if (!Number.isFinite(value)) return "-";
  const currency = item.currency || "USD";
  const prefix = currency === "USD" ? "$" : `${currency} `;
  return `${prefix}${value.toFixed(4)}`;
}

function renderSmsBalances(data) {
  const wrap = $("#sms-balance-bar");
  if (!wrap) return;
  const items = data?.items || [];
  wrap.innerHTML = items.length
    ? items.map((item) => {
        const label = escapeHtml(item.providerLabel || item.provider || "SMS");
        const title = escapeHtml(item.ok ? `${item.providerLabel || item.provider || "SMS"} 余额` : (item.error || "余额读取失败"));
        return `
          <div class="sms-balance-card ${item.ok ? "" : "error"}" title="${title}">
            <span>${label}</span>
            <strong>${item.ok ? escapeHtml(formatSmsBalance(item)) : "读取失败"}</strong>
          </div>
        `;
      }).join("")
    : "";
}

async function loadSmsBalances() {
  const data = await api("/api/sms/balances");
  renderSmsBalances(data);
}

function taskRow(task) {
  const token = task.accessTokenPreview
    ? `<span class="mono token-pill">${escapeHtml(task.accessTokenPreview)}</span>`
    : task.status === "success" && task.missingAccessToken
      ? '<span class="muted">无 AT</span>'
    : '<span class="muted">-</span>';
  const phone = task.phone ? `<span class="mono">${escapeHtml(task.phone)}</span>` : '<span class="muted">-</span>';
  const cancel = ["queued", "running"].includes(task.status)
    ? `<button class="danger small" data-cancel="${task.id}">取消</button>`
    : "";
  const del = ["failed", "canceled"].includes(task.status)
    ? `<button class="ghost small" data-delete="${task.id}">删除</button>`
    : "";
  const open = `<button class="small" data-open="${task.id}">日志</button>`;
  const diagnosis = `<button class="ghost small" data-diagnosis="${task.id}">诊断</button>`;
  const successFile = successTextFileForTask(task);
  const successNote = task.status === "success"
    ? `<div class="task-note success-text">${task.missingAccessToken ? "注册成功，未记录 AT" : `成功结果：${escapeHtml(successFile || task.tokenOut || "")}`}</div>`
    : "";
  const note = task.error && !(task.status === "success" && task.missingAccessToken)
    ? `<div class="task-note error-text">${escapeHtml(task.error)}</div>`
    : `<div class="task-note">${escapeHtml(task.title || "")}</div>`;
  const flow = flowBadge(task);
  const oaNote = relatedOaNote(task);

  return `
    <tr class="selectable ${task.id === selectedTaskId ? "selected" : ""}" data-id="${task.id}">
      <td>${badge(task.status)}</td>
      <td>
        <div class="task-main mono">${escapeHtml(taskName(task))} ${flow}</div>
        ${note}
        ${oaNote}
        ${successNote}
      </td>
      <td>${phone}</td>
      <td>${token}</td>
      <td>
        <div>创建 ${fmtTime(task.createdAt)}</div>
        <div class="muted">更新 ${fmtTime(task.updatedAt)}</div>
      </td>
      <td><div class="row actions">${open}${diagnosis}${cancel}${del}</div></td>
    </tr>
  `;
}

function taskStatusCounts(items) {
  return {
    total: items.length,
    running: items.filter((task) => ["queued", "running"].includes(task.status)).length,
    failed: items.filter((task) => task.status === "failed").length,
    success: items.filter((task) => task.status === "success").length,
    canceled: items.filter((task) => task.status === "canceled").length,
  };
}

function renderBatchTaskModal(batchId) {
  const modal = $("#batch-task-modal");
  if (!modal) return;
  const normalizedBatchId = batchId || "legacy";
  const batch = registerBatchesCache.find((item) => (item.batchId || "legacy") === normalizedBatchId);
  const items = tasksCache.filter((task) => (task.batchId || "legacy") === normalizedBatchId);
  const counts = taskStatusCounts(items);
  const statusText = [
    `全部 ${counts.total}`,
    `运行中 ${counts.running}`,
    `失败 ${counts.failed}`,
    `成功 ${counts.success}`,
    counts.canceled ? `取消 ${counts.canceled}` : "",
  ].filter(Boolean).join(" / ");

  selectedBatchTaskId = normalizedBatchId;
  $("#batch-task-modal-title").textContent = `批次任务 · ${normalizedBatchId}`;
  $("#batch-task-modal-subtitle").textContent = batch
    ? `${batch.done ? "已结束" : "进行中"} / ${statusText}`
    : statusText;
  $("#batch-task-modal-list").innerHTML = items.length
    ? items.map(taskRow).join("")
    : `<tr><td colspan="6"><div class="empty">这个批次暂无任务</div></td></tr>`;
  const cancelButton = $("#batch-task-cancel");
  if (cancelButton) {
    const canceledByUser = batch?.canceledByUser || batch?.freeAutoStatus === "canceled";
    const canCancel = counts.running > 0
      || (batch?.targetSuccess && !batch?.targetReached && !batch?.done && !canceledByUser);
    cancelButton.disabled = !canCancel;
    cancelButton.dataset.batchCancelModal = normalizedBatchId;
  }
  modal.classList.remove("hidden");
  bindTableActions($("#batch-task-modal-list"));
}

function closeBatchTaskModal() {
  selectedBatchTaskId = "";
  $("#batch-task-modal")?.classList.add("hidden");
}

function renderDiagnosis(task, diagnosis) {
  selectedTaskId = task?.id || diagnosis?.id || "";
  $("#modal-title").textContent = `\u4efb\u52a1\u8bca\u65ad - ${task ? taskName(task) : diagnosis?.id || ""}`;
  $("#modal-subtitle").textContent = `${diagnosis?.status || task?.status || ""} / ${diagnosis?.errorType || "\u65e0\u9519\u8bef\u7c7b\u578b"}`;
  $("#logs").textContent = JSON.stringify(diagnosis, null, 2);
  $("#log-modal").classList.remove("hidden");
  $("#logs").scrollTop = 0;
}

function renderLogs(task) {
  if (!task) return;
  selectedTaskId = task.id;
  $("#modal-title").textContent = `任务日志 · ${taskName(task)}`;
  $("#modal-subtitle").textContent = `${task.status} / ${fmtTime(task.updatedAt)}`;
  $("#logs").textContent = (task.logs || []).join("\n") || "暂无日志";
  $("#log-modal").classList.remove("hidden");
  $("#logs").scrollTop = $("#logs").scrollHeight;
}

function closeModal() {
  $("#log-modal").classList.add("hidden");
}

function openSettingsModal() {
  loadConfig()
    .then(() => {
      $("#settings-modal").classList.remove("hidden");
      $("#smsProvider").focus();
    })
    .catch((error) => toast(error.message));
}

function closeSettingsModal() {
  $("#settings-modal").classList.add("hidden");
}

async function openPasswordModal() {
  $("#password-modal").classList.remove("hidden");
  $("#register-password-value").type = "password";
  $("#toggle-register-password").textContent = "显示";
  $("#register-password-value").value = "";
  $("#register-password-new").value = "";
  $("#register-password-modal-status").textContent = "正在读取 defaultPassword...";
  try {
    const data = await api("/api/register/password");
    registerPasswordCache = data.password || "";
    $("#register-password-value").value = registerPasswordCache;
    $("#copy-register-password").disabled = !registerPasswordCache;
    $("#toggle-register-password").disabled = !registerPasswordCache;
    $("#register-password-modal-status").textContent = data.configured
      ? "已读取，默认隐藏；可以点击显示或复制。"
      : "config.json 里还没有配置 defaultPassword。";
  } catch (error) {
    $("#register-password-modal-status").textContent = error.message;
    $("#copy-register-password").disabled = true;
    $("#toggle-register-password").disabled = true;
  }
}

function closePasswordModal() {
  $("#password-modal").classList.add("hidden");
  $("#register-password-value").value = "";
  $("#register-password-new").value = "";
}

function toggleRegisterPassword() {
  const input = $("#register-password-value");
  const hidden = input.type === "password";
  input.type = hidden ? "text" : "password";
  $("#toggle-register-password").textContent = hidden ? "隐藏" : "显示";
}

async function copyRegisterPassword() {
  if (!registerPasswordCache) return toast("还没有读取到默认密码");
  await navigator.clipboard.writeText(registerPasswordCache);
  toast("默认密码已复制");
}

async function saveRegisterPassword(event) {
  event.preventDefault();
  const password = $("#register-password-new").value;
  if (!password.trim()) return toast("请输入新默认密码");
  if (password.length < 8) return toast("默认密码至少 8 位");
  const button = $("#save-register-password");
  button.disabled = true;
  try {
    const data = await api("/api/register/password", {
      method: "PATCH",
      body: JSON.stringify({password}),
    });
    registerPasswordCache = data.password || "";
    $("#register-password-value").value = registerPasswordCache;
    $("#register-password-new").value = "";
    $("#copy-register-password").disabled = !registerPasswordCache;
    $("#toggle-register-password").disabled = !registerPasswordCache;
    $("#register-password-modal-status").textContent = "默认密码已更新，新注册任务会使用新密码。";
    await loadConfig();
    toast("默认密码已保存");
  } finally {
    button.disabled = false;
  }
}

function bindTableActions(root = document) {
  root.querySelectorAll("tr[data-id]").forEach((row) => {
    row.addEventListener("click", (event) => {
      if (event.target.closest("button")) return;
      const task = tasksCache.find((item) => item.id === row.dataset.id);
      renderLogs(task);
      renderTable();
    });
  });

  root.querySelectorAll("[data-open]").forEach((btn) => {
    btn.addEventListener("click", (event) => {
      event.stopPropagation();
      const task = tasksCache.find((item) => item.id === btn.dataset.open);
      renderLogs(task);
      renderTable();
    });
  });

  root.querySelectorAll("[data-diagnosis]").forEach((btn) => {
    btn.addEventListener("click", async (event) => {
      event.stopPropagation();
      const task = tasksCache.find((item) => item.id === btn.dataset.diagnosis);
      const data = await api(`/api/tasks/${btn.dataset.diagnosis}/diagnosis`);
      renderDiagnosis(task, data.diagnosis);
      renderTable();
    });
  });

  root.querySelectorAll("[data-cancel]").forEach((btn) => {
    btn.addEventListener("click", async (event) => {
      event.stopPropagation();
      await api(`/api/tasks/${btn.dataset.cancel}/cancel`, {method: "POST", body: "{}"});
      toast("已发送取消请求");
      await loadTasks();
    });
  });

  root.querySelectorAll("[data-delete]").forEach((btn) => {
    btn.addEventListener("click", async (event) => {
      event.stopPropagation();
      await api(`/api/tasks/${btn.dataset.delete}`, {method: "DELETE"});
      if (selectedTaskId === btn.dataset.delete) {
        selectedTaskId = "";
        closeModal();
      }
      toast("任务已删除");
      await loadTasks();
    });
  });
}

function taskMatchesFilter(task) {
  if (taskStatusFilter === "all") return true;
  if (taskStatusFilter === "running") return ["queued", "running"].includes(task.status);
  return task.status === taskStatusFilter;
}

function filteredTasks(batchId = "") {
  return tasksCache
    .filter(taskMatchesFilter)
    .filter((task) => !batchId || (task.batchId || "legacy") === batchId);
}

function updateTaskFilterCounts() {
  const root = $("#task-status-filter");
  if (!root) return;
  const counts = {
    all: tasksCache.length,
    running: tasksCache.filter((task) => ["queued", "running"].includes(task.status)).length,
    failed: tasksCache.filter((task) => task.status === "failed").length,
    success: tasksCache.filter((task) => task.status === "success").length,
  };
  root.querySelectorAll("[data-task-filter]").forEach((button) => {
    const key = button.dataset.taskFilter;
    button.classList.toggle("active", key === taskStatusFilter);
    const count = button.querySelector("b");
    if (count) count.textContent = String(counts[key] ?? 0);
  });
}

function renderTable(batchId = "") {
  const visibleTasks = filteredTasks(registerView === "batches" ? batchId : "");
  $("#tasks").innerHTML = visibleTasks.length
    ? visibleTasks.map(taskRow).join("")
    : `<tr><td colspan="6"><div class="empty">当前筛选下暂无任务</div></td></tr>`;
  updateBulkDeleteButtons();
  updateTaskFilterCounts();
  bindTableActions($("#tasks"));
}

function deletableTasksByStatuses(statuses) {
  const wanted = new Set(statuses);
  return tasksCache.filter((task) => wanted.has(task.status) && task.status !== "running");
}

function updateBulkDeleteButtons() {
  const failed = deletableTasksByStatuses(["failed"]);
  const finished = deletableTasksByStatuses(["failed", "canceled"]);
  $("#delete-failed").textContent = `删除失败(${failed.length})`;
  $("#delete-failed").disabled = failed.length === 0;
  $("#delete-finished").textContent = `删除失败/取消(${finished.length})`;
  $("#delete-finished").disabled = finished.length === 0;
}

async function bulkDeleteTasks(mode) {
  const statuses = mode === "failed" ? ["failed"] : ["failed", "canceled"];
  const targets = deletableTasksByStatuses(statuses);
  if (!targets.length) return toast(mode === "failed" ? "没有失败任务可删除" : "没有失败/取消任务可删除");
  const label = mode === "failed" ? "失败任务" : "失败/取消任务";
  const ok = window.confirm(`确认删除 ${targets.length} 个${label}？\n\n此操作会删除任务记录和对应日志，不会删除已导出的成功 txt 或 AT 文件。`);
  if (!ok) return;
  const result = await api("/api/register/tasks/cleanup", {
    method: "POST",
    body: JSON.stringify({status: statuses, dryRun: false}),
  });
  if (selectedTaskId && targets.some((task) => task.id === selectedTaskId)) {
    selectedTaskId = "";
    closeModal();
  }
  toast(`已删除 ${result.deleted || 0} 个任务`);
  await loadTasks();
}

async function loadTasks() {
  const data = await api("/api/register/tasks");
  tasksCache = data.tasks || [];
  $("#summary").textContent = `运行 ${data.running} / 排队 ${data.queued} / 并发 ${data.concurrency}`;
  renderTable();
  await loadSuccessSummary().catch(() => undefined);
  await loadAgentDashboard().catch(() => undefined);

  if (!$("#log-modal").classList.contains("hidden") && selectedTaskId) {
    const selected = tasksCache.find((task) => task.id === selectedTaskId);
    if (selected) renderLogs(selected);
  }

  if (!$("#batch-task-modal")?.classList.contains("hidden") && selectedBatchTaskId) {
    renderBatchTaskModal(selectedBatchTaskId);
  }
}

async function copySuccessPath() {
  const filePath = primarySuccessFile();
  if (!filePath) return toast("还没有成功结果文件");
  await navigator.clipboard.writeText(filePath);
  toast("已复制成功结果 txt 路径");
}

function exportSuccessFile() {
  window.location.href = "/api/register/success/export";
}

async function loadConfig() {
  const data = await api("/api/config");
  configCache = data;
  renderConfig(data);
  if (data.runtime?.sentinelBrowserProxy && !$("#sentinelBrowserProxy").value) {
    $("#sentinelBrowserProxy").placeholder = data.runtime.sentinelBrowserProxy;
  }
  if (data.runtime?.sentinelBrowserPath && !$("#sentinelBrowserPath").value) {
    $("#sentinelBrowserPath").placeholder = data.runtime.sentinelBrowserPath;
  }
}

function renderConfig(data) {
  const sms = data.register?.sms || {};
  const active = sms.active || {};
  const passwordConfigured = data.register?.defaultPassword === "configured";
  $("#register-password-preview").value = passwordConfigured ? "********" : "未配置";
  $("#register-password-status").textContent = passwordConfigured
    ? "已配置，点击“查看/复制”后在弹窗中显示。"
    : "未配置，请在 config.json 里设置 defaultPassword。";
  $("#sms-active-provider").textContent = active.providerLabel || active.provider || "-";
  $("#sms-active-countries").textContent = listText(active.countries);
  $("#sms-active-prices").textContent = listText(active.priceTiers);
  const proxy = data.register?.defaultProxyUrl || "";
  if ($("#proxy-active-value")) $("#proxy-active-value").textContent = proxy || "直连";
  if ($("#defaultProxyUrl")) {
    $("#defaultProxyUrl").placeholder = proxy || "当前直连；填写 http://user:pass@host:port";
    $("#default-proxy-status").textContent = `当前默认代理：${proxy || "直连"}`;
  }
  syncSettingsForm(sms.provider || "smsbower");
}

function providerConfig(provider) {
  const sms = configCache?.register?.sms || {};
  return provider === "hero-sms" ? sms.heroSMS : sms.smsbower;
}

function countryLabel(country) {
  const zh = country.nameZh || country.chn || "";
  const en = country.nameEn || country.eng || "";
  const name = zh && en ? `${zh} / ${en}` : zh || en || "国家";
  return `${name} (${country.code})`;
}

function getVisibleCountryItems(provider) {
  const items = smsCountriesByProvider[provider] || SMS_COUNTRY_FALLBACK;
  const query = smsCountryFilter.trim().toLowerCase();
  if (!query) return items;
  const filtered = items.filter((item) => {
    const searchable = [
      item.code,
      item.nameZh,
      item.nameEn,
      item.chn,
      item.eng,
    ].join(" ").toLowerCase();
    return searchable.includes(query);
  });
  return filtered.length ? filtered : items;
}

function countryByCode(code) {
  const provider = $("#smsProvider").value || "smsbower";
  const items = smsCountriesByProvider[provider] || SMS_COUNTRY_FALLBACK;
  return items.find((item) => Number(item.code) === Number(code))
    || SMS_COUNTRY_FALLBACK.find((item) => Number(item.code) === Number(code))
    || {code, nameZh: "国家", nameEn: ""};
}

function renderCountrySelect(items) {
  const select = $("#smsCountrySelect");
  select.innerHTML = "";
  const provider = $("#smsProvider").value || "smsbower";
  const countries = (items && items.length ? items : getVisibleCountryItems(provider));
  for (const item of countries) {
    const option = document.createElement("option");
    option.value = String(item.code);
    option.textContent = countryLabel(item);
    select.appendChild(option);
  }
  syncCountrySelectFromInput();
}

function renderSelectedCountries() {
  const selected = parseCountryInput();
  const wrap = $("#smsCountrySelected");
  wrap.innerHTML = "";

  if (!selected.length) {
    const empty = document.createElement("span");
    empty.className = "muted";
    empty.textContent = "还没有选择国家";
    wrap.appendChild(empty);
    return;
  }

  selected.forEach((code, index) => {
    const chip = document.createElement("span");
    chip.className = "country-chip";
    const text = document.createElement("span");
    text.textContent = `${index === 0 ? "主用 " : "备用 "}${countryLabel(countryByCode(code))}`;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "country-remove";
    remove.textContent = "×";
    remove.title = "移除";
    remove.addEventListener("click", () => {
      setSelectedCountries(selected.filter((item) => item !== code));
    });
    chip.append(text, remove);
    wrap.appendChild(chip);
  });
}

function syncCountrySelectFromInput() {
  const selected = parseCountryInput();
  const select = $("#smsCountrySelect");
  if (!select.options.length) return;
  const current = selected[0];
  if (current && Array.from(select.options).some((option) => Number(option.value) === current)) {
    select.value = String(current);
  }
  renderSelectedCountries();
}

function setSelectedCountries(countries) {
  const unique = Array.from(new Set(countries.map(Number).filter((item) => Number.isFinite(item))));
  $("#smsCountries").value = unique.join(",");
  syncCountrySelectFromInput();
}

function useSelectedCountry() {
  const code = Number($("#smsCountrySelect").value);
  if (!Number.isFinite(code)) return toast("请先选择国家");
  setSelectedCountries([code]);
}

function addSelectedCountry() {
  const code = Number($("#smsCountrySelect").value);
  if (!Number.isFinite(code)) return toast("请先选择国家");
  setSelectedCountries([...parseCountryInput(), code]);
}

async function loadSmsCountries(provider) {
  const normalizedProvider = provider || "smsbower";
  if (smsCountriesByProvider[normalizedProvider]) {
    renderCountrySelect(getVisibleCountryItems(normalizedProvider));
    return;
  }

  $("#sms-country-status").textContent = "正在从 SMS 平台加载国家列表...";
  renderCountrySelect(SMS_COUNTRY_FALLBACK);
  try {
    const params = new URLSearchParams({provider: normalizedProvider});
    const data = await api(`/api/sms/countries?${params.toString()}`);
    const countries = (data.items || [])
      .map((item) => ({
        code: Number(item.code),
        nameZh: item.nameZh || item.chn || "",
        nameEn: item.nameEn || item.eng || "",
      }))
      .filter((item) => Number.isFinite(item.code));
    smsCountriesByProvider[normalizedProvider] = countries.length ? countries : SMS_COUNTRY_FALLBACK;
    renderCountrySelect(getVisibleCountryItems(normalizedProvider));
    $("#sms-country-status").textContent = "选择国家后点“使用”；需要多个国家时点“加备用”，任务会按顺序重试。";
  } catch (error) {
    smsCountriesByProvider[normalizedProvider] = SMS_COUNTRY_FALLBACK;
    renderCountrySelect(SMS_COUNTRY_FALLBACK);
    $("#sms-country-status").textContent = `国家列表加载失败，已使用常用国家列表：${error.message}`;
  }
}

function syncSettingsForm(provider) {
  const source = providerConfig(provider) || {};
  platformPriceItems = [];
  $("#smsProvider").value = provider;
  $("#smsService").value = source.service || "dr";
  $("#smsApiKey").value = "";
  $("#smsApiKey").placeholder = source.apiKeyPresent
    ? `已配置：${source.apiKeyMasked || "******"}，留空不修改`
    : "请填写当前平台 API Key";
  $("#smsBaseUrl").value = source.baseUrl || (provider === "smsbower"
    ? "https://smsbower.online/stubs/handler_api.php"
    : "https://hero-sms.com/stubs/handler_api.php");
  $("#smsCountries").value = Array.isArray(source.countries) ? source.countries.join(",") : "";
  $("#smsPriceTiers").value = Array.isArray(source.priceTiers) ? source.priceTiers.join(",") : "";
  renderSelectedCountries();
  loadSmsCountries(provider).catch((error) => toast(error.message));
  renderPriceList([]);
  $("#sms-price-status").textContent = "点击“查询当前国家价格”从 SMS 平台实时拉取当前国家可用价格。";

  const label = provider === "hero-sms" ? "HeroSMS" : "SmsBower";
  const keyText = source.apiKeyPresent
    ? `${label} API Key 已配置：${source.apiKeyMasked || "******"}`
    : `${label} API Key 未配置，请先在 config.json 中补齐密钥。`;
  $("#sms-key-status").textContent = keyText;
  $("#sms-key-status").classList.toggle("warn", !source.apiKeyPresent);
}

function renderPriceList(prices) {
  const selected = new Set(parsePriceInput().map(normalizePriceText));
  const normalizedItems = (prices || []).map((item) => {
    if (typeof item === "object" && item !== null) {
      return {
        price: normalizePriceText(item.price),
        count: Number(item.count || 0),
        providerIds: item.providerIds || [],
      };
    }
    return {price: normalizePriceText(item), count: 0, providerIds: []};
  });
  const uniqueItems = Array.from(
    normalizedItems.reduce((map, item) => {
      const existing = map.get(item.price) || {price: item.price, count: 0, providerIds: []};
      existing.count += item.count;
      existing.providerIds = Array.from(new Set([...existing.providerIds, ...item.providerIds]));
      map.set(item.price, existing);
      return map;
    }, new Map()).values(),
  ).sort((a, b) => Number(a.price) - Number(b.price));

  $("#smsPriceList").innerHTML = uniqueItems.length
    ? uniqueItems.map((item) => `
        <button class="price-chip ${selected.has(item.price) ? "selected" : ""}" type="button" data-price="${item.price}" title="库存 ${item.count}">
          <span>${item.price}</span>
          <em>${item.count}</em>
        </button>
      `).join("")
    : `<span class="muted">还没有查询平台价格。</span>`;

  document.querySelectorAll("[data-price]").forEach((button) => {
    button.addEventListener("click", () => togglePrice(button.dataset.price));
  });
}

function togglePrice(price) {
  const current = parsePriceInput().map(normalizePriceText);
  const set = new Set(current);
  if (set.has(price)) set.delete(price);
  else set.add(price);
  const next = Array.from(set).sort((a, b) => Number(a) - Number(b));
  $("#smsPriceTiers").value = next.join(",");
  renderPriceList(platformPriceItems);
}

async function fetchSmsPrices() {
  const countries = $("#smsCountries").value
    .split(/[\s,，;；]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  const country = countries[0];
  if (!country) return toast("先填写国家代码");

  const button = $("#fetch-sms-prices");
  button.disabled = true;
  $("#sms-price-status").textContent = "正在从 SMS 平台查询价格...";
  try {
    const params = new URLSearchParams({
      provider: $("#smsProvider").value,
      country,
      service: $("#smsService").value || "dr",
    });
    const data = await api(`/api/sms/prices?${params.toString()}`);
    platformPriceItems = data.items || [];
    renderPriceList(platformPriceItems);
    $("#sms-price-status").textContent = platformPriceItems.length
      ? `已查询 ${data.provider} / 国家 ${data.country} / 服务 ${data.service}，共 ${platformPriceItems.length} 个价格，数字角标是库存。`
      : `未查到可用价格：${data.error || "平台没有返回当前国家价格"}`;
  } finally {
    button.disabled = false;
  }
}

async function saveSettings(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const body = Object.fromEntries(form.entries());
  const data = await api("/api/config/sms", {
    method: "PATCH",
    body: JSON.stringify(body),
  });
  configCache = data;
  renderConfig(data);
  await loadSmsBalances().catch(() => undefined);
  toast("SMS 接码配置已保存，新注册任务会使用新配置");
  closeSettingsModal();
}

function buildProxyProbeQuery(proxyUrl) {
  const normalized = String(proxyUrl || "").trim();
  if (!normalized || normalized.toLowerCase() === "direct") return "?target=oauth&direct=1";
  return `?target=oauth&proxyUrl=${encodeURIComponent(normalized)}`;
}

async function testDefaultProxy() {
  const btn = $("#test-default-proxy");
  const output = $("#default-proxy-result");
  const proxyUrl = $("#defaultProxyUrl").value.trim();
  btn.disabled = true;
  output.classList.remove("hidden");
  output.textContent = "正在测试 OpenAI OAuth 网络...";
  try {
    const result = await api(`/api/oa/probe${buildProxyProbeQuery(proxyUrl || configCache?.register?.defaultProxyUrl || "")}`);
    output.textContent = JSON.stringify(result, null, 2);
    toast(result.ok ? `OAuth 网络可用，耗时 ${result.elapsedMs}ms` : `OAuth 网络不可用：${result.error || result.statusText || "blocked"}`);
  } finally {
    btn.disabled = false;
  }
}

async function saveDefaultProxy(proxyUrl) {
  const data = await api("/api/config/oa-proxy", {
    method: "PATCH",
    body: JSON.stringify({proxyUrl}),
  });
  configCache = data;
  renderConfig(data);
  toast(proxyUrl && proxyUrl.toLowerCase() !== "direct" ? "默认代理已保存" : "默认代理已清空，当前直连");
}

function switchRegisterView(view) {
  registerView = view === "batches" ? "batches" : "tasks";
  $(".list-card")?.classList.toggle("showing-batches", registerView === "batches");
  document.querySelectorAll("[data-register-view]").forEach((button) => {
    button.classList.toggle("active", button.dataset.registerView === registerView);
  });
  document.querySelectorAll("[data-view-panel]").forEach((panel) => {
    panel.classList.toggle("hidden", panel.dataset.viewPanel !== registerView);
  });
  renderTable();
  if (registerView === "batches") loadAgentDashboard().catch((error) => toast(error.message));
}

async function startAutoRegister(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const body = Object.fromEntries(form.entries());
  body.targetSuccess = Number(body.targetSuccess || 10);
  body.maxAttempts = Number(body.maxAttempts || Math.max(body.targetSuccess * 2, body.targetSuccess));
  body.count = Number(body.count || body.targetSuccess);
  body.concurrency = Number(body.concurrency || 10);
  const freeFlowMode = Boolean($("#autoFreeFlowMode")?.checked);
  const data = await api(freeFlowMode ? "/api/workflows/free-auto" : "/api/register/auto", {
    method: "POST",
    body: JSON.stringify(freeFlowMode ? {
      ...body,
      target: "sub2api",
      plus: false,
      freeMode: true,
      mode: "free",
      registerConcurrency: body.concurrency,
      oaConcurrency: Math.max(1, Math.min(MAX_TASK_CONCURRENCY, body.concurrency)),
      tokenOut: $("#tokenOut")?.value?.trim() || body.tokenOut,
      sentinelBrowserProxy: $("#sentinelBrowserProxy")?.value?.trim() || body.sentinelBrowserProxy,
      sentinelBrowserPath: $("#sentinelBrowserPath")?.value?.trim() || body.sentinelBrowserPath,
    } : body),
  });
  toast(freeFlowMode ? `\u5b8c\u5168 free \u81ea\u52a8\u8865\u4f4d\u5df2\u5f00\u542f\uff1a${data.batchId}` : `\u81ea\u52a8\u8865\u4f4d\u5df2\u5f00\u542f\uff1a${data.batchId}`);
  await loadTasks();
  if (freeFlowMode) await loadAgentDashboard().catch(() => undefined);
}

async function cleanupFailedTasks(dryRun) {
  const result = await api("/api/register/tasks/cleanup", {
    method: "POST",
    body: JSON.stringify({status: "failed", dryRun}),
  });
  if (dryRun) {
    toast(`\u53ef\u6e05\u7406\u5931\u8d25\u4efb\u52a1 ${result.matched || 0} \u4e2a`);
    return;
  }
  toast(`\u5df2\u6e05\u7406\u5931\u8d25\u4efb\u52a1 ${result.deleted || 0} \u4e2a`);
  if (selectedTaskId && (result.ids || []).includes(selectedTaskId)) {
    selectedTaskId = "";
    closeModal();
  }
  await loadTasks();
}

document.querySelectorAll("[data-register-view]").forEach((button) => {
  button.addEventListener("click", () => switchRegisterView(button.dataset.registerView));
});
$("#start-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const body = Object.fromEntries(form.entries());
  body.count = Number(body.count || 1);
  body.concurrency = Number(body.concurrency || 1);
  const freeFlowMode = Boolean($("#freeFlowMode")?.checked);
  if (freeFlowMode) {
    const total = Math.max(1, Math.min(100, body.count));
    const data = await api("/api/workflows/free", {
      method: "POST",
      body: JSON.stringify({
        count: total,
        target: "sub2api",
        plus: false,
        freeMode: true,
        mode: "free",
        concurrency: body.concurrency,
        registerConcurrency: body.concurrency,
        oaConcurrency: Math.max(1, Math.min(MAX_TASK_CONCURRENCY, body.concurrency)),
        tokenOut: body.tokenOut,
        sentinelBrowserProxy: body.sentinelBrowserProxy,
        sentinelBrowserPath: body.sentinelBrowserPath,
      }),
    });
    toast(`完全 free 流程已加入队列：${data.workflows?.length || total} 个`);
    await loadTasks();
    await loadAgentDashboard().catch(() => undefined);
    return;
  }
  await api("/api/register/tasks", {
    method: "POST",
    body: JSON.stringify(body),
  });
  toast("注册任务已加入队列");
  await loadTasks();
});

$("#auto-register-form").addEventListener("submit", (event) => startAutoRegister(event).catch((error) => toast(error.message)));
$("#refresh").addEventListener("click", () => loadTasks().catch((error) => toast(error.message)));
$("#delete-failed").addEventListener("click", () => bulkDeleteTasks("failed").catch((error) => toast(error.message)));
$("#delete-finished").addEventListener("click", () => bulkDeleteTasks("finished").catch((error) => toast(error.message)));
$("#cleanup-failed-dryrun").addEventListener("click", () => cleanupFailedTasks(true).catch((error) => toast(error.message)));
$("#cleanup-failed-now").addEventListener("click", async () => {
  const ok = window.confirm("\u786e\u8ba4\u6e05\u7406\u6240\u6709\u5931\u8d25\u6ce8\u518c\u4efb\u52a1\uff1f\u4f1a\u5220\u9664\u4efb\u52a1\u8bb0\u5f55\u548c\u65e5\u5fd7\uff0c\u4e0d\u5f71\u54cd\u6210\u529f\u7ed3\u679c\u6587\u4ef6\u3002");
  if (!ok) return;
  await cleanupFailedTasks(false).catch((error) => toast(error.message));
});
$("#copy-success-path").addEventListener("click", () => copySuccessPath().catch((error) => toast(error.message)));
$("#export-success").addEventListener("click", exportSuccessFile);
document.querySelectorAll("[data-task-filter]").forEach((button) => {
  button.addEventListener("click", () => {
    taskStatusFilter = button.dataset.taskFilter || "all";
    renderTable();
  });
});
$("#open-settings").addEventListener("click", openSettingsModal);
$("#open-password-modal").addEventListener("click", () => openPasswordModal().catch((error) => toast(error.message)));
$("#toggle-register-password").addEventListener("click", toggleRegisterPassword);
$("#copy-register-password").addEventListener("click", () => copyRegisterPassword().catch((error) => toast(error.message)));
$("#register-password-form").addEventListener("submit", (event) => saveRegisterPassword(event).catch((error) => toast(error.message)));
$("#clear-register-password-new").addEventListener("click", () => {
  $("#register-password-new").value = "";
});
$("#smsProvider").addEventListener("change", (event) => syncSettingsForm(event.currentTarget.value));
$("#smsCountryFilter").addEventListener("input", (event) => {
  smsCountryFilter = event.currentTarget.value;
  renderCountrySelect(getVisibleCountryItems($("#smsProvider").value || "smsbower"));
});
$("#use-sms-country").addEventListener("click", useSelectedCountry);
$("#add-sms-country").addEventListener("click", addSelectedCountry);
$("#smsPriceTiers").addEventListener("input", () => {
  renderPriceList(platformPriceItems);
});
$("#fetch-sms-prices").addEventListener("click", () => fetchSmsPrices().catch((error) => toast(error.message)));
$("#settings-form").addEventListener("submit", (event) => saveSettings(event).catch((error) => toast(error.message)));
$("#test-default-proxy").addEventListener("click", () => testDefaultProxy().catch((error) => toast(error.message)));
$("#save-default-proxy").addEventListener("click", () => saveDefaultProxy($("#defaultProxyUrl").value.trim()).catch((error) => toast(error.message)));
$("#clear-default-proxy").addEventListener("click", () => {
  $("#defaultProxyUrl").value = "";
  saveDefaultProxy("").catch((error) => toast(error.message));
});
document.querySelectorAll("[data-close-modal]").forEach((el) => {
  el.addEventListener("click", closeModal);
});
document.querySelectorAll("[data-close-batch-task]").forEach((el) => {
  el.addEventListener("click", closeBatchTaskModal);
});
$("#batch-task-cancel")?.addEventListener("click", (event) => {
  const batchId = event.currentTarget.dataset.batchCancelModal || selectedBatchTaskId;
  cancelBatch(batchId).catch((error) => toast(error.message));
});
document.querySelectorAll("[data-close-settings]").forEach((el) => {
  el.addEventListener("click", closeSettingsModal);
});
document.querySelectorAll("[data-close-password]").forEach((el) => {
  el.addEventListener("click", closePasswordModal);
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  closeModal();
  closeBatchTaskModal();
  closeSettingsModal();
  closePasswordModal();
});

switchRegisterView("tasks");
Promise.all([loadTasks(), loadConfig(), loadSuccessSummary(), loadSmsBalances(), loadAgentDashboard()]).catch((error) => toast(error.message));
setInterval(() => loadTasks().catch(() => undefined), 3000);
setInterval(() => loadSmsBalances().catch(() => undefined), 60000);
