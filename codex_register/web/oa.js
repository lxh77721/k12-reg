const $ = (selector) => document.querySelector(selector);

let emails = [];
let ats = [];
let tasks = [];
let selectedTaskId = "";
let configCache = null;
let selectedEmailSet = new Set();
let selectedAtSet = new Set();
let atBatchInputCache = "";
let atBatchResult = "";
let emailBatchInputCache = "";
let emailBatchResult = "";

function toast(message) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 2800);
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

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function badge(status) {
  const cls = String(status || "").toLowerCase();
  const map = {
    queued: "排队",
    running: "运行",
    success: "成功",
    failed: "失败",
    canceled: "已取消",
  };
  return `<span class="badge ${cls}">${map[cls] || escapeHtml(status || "-")}</span>`;
}

function fmtTime(value) {
  if (!value) return "-";
  return new Date(value).toLocaleString();
}

function maskSecret(value, head = 8, tail = 8) {
  const text = String(value || "");
  if (!text) return "";
  if (text.length <= head + tail + 3) return `${text.slice(0, 2)}***`;
  return `${text.slice(0, head)}...${text.slice(-tail)}`;
}

function uniqueList(items) {
  return [...new Set(items.filter(Boolean))];
}

function parseBulkPhones(value) {
  const candidates = String(value || "").match(/\+?\d[\d ().-]{6,}\d/g) || [];
  return uniqueList(candidates.map(normalizePhoneInput));
}

function parseBulkEmails(value) {
  const candidates = String(value || "").match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
  return uniqueList(candidates.map((item) => item.toLowerCase()));
}

function shortHash(hash) {
  return hash ? hash.slice(0, 10) : "";
}

function taskName(task) {
  return task.title || task.id.replace(/^oa_/, "");
}

function oaTargetText(value) {
  return value === "cpa" ? "CPA" : "SUB2API";
}

function mailboxPreview(url) {
  if (!url) return "本地 Hotmail refresh_token";
  try {
    const parsed = new URL(maskMailboxUrl(url));
    return `${parsed.origin}${parsed.pathname}${parsed.search ? "?..." : ""}`;
  } catch {
    const text = String(url);
    return text.length > 80 ? `${text.slice(0, 64)}...` : text;
  }
}

function maskMailboxUrl(value) {
  const text = String(value || "");
  if (!text) return "";
  try {
    const url = new URL(text);
    for (const [key, current] of url.searchParams.entries()) {
      if (/token|secret|password|pass|key/i.test(key) || current.length > 48) {
        url.searchParams.set(key, maskSecret(current, 12, 8));
      }
    }
    return url.toString();
  } catch {
    return text.length > 160 ? maskSecret(text, 80, 40) : text;
  }
}

function emailParts(item) {
  if (item.mailboxUrl) {
    try {
      const url = new URL(item.mailboxUrl);
      return {
        password: "",
        clientId: url.searchParams.get("clientId") || "",
        refreshToken: url.searchParams.get("refreshToken") || "",
      };
    } catch {
      return {password: "", clientId: "", refreshToken: ""};
    }
  }
  const raw = String(item.raw || "");
  const parts = raw.split(/\s*-{4,}\s*|\t|,/).map((part) => part.trim()).filter(Boolean);
  const emailIndex = parts.findIndex((part) => part.toLowerCase() === String(item.email || "").toLowerCase());
  const tail = emailIndex >= 0 ? parts.slice(emailIndex + 1) : parts.slice(1);
  return {
    password: tail[0] || "",
    clientId: tail[1] || "",
    refreshToken: tail.slice(2).join("----"),
  };
}

function emailStatus(item) {
  if (item.assignedTaskId) {
    const status = item.assignedTaskStatus === "running" ? "运行占用" : "排队占用";
    return {cls: "queued", text: status};
  }
  if (item.available) return {cls: "success", text: "空闲"};
  if (item.bindStatus === "bound") return {cls: "success", text: "已接入"};
  if (item.bindStatus === "reserved") return {cls: "queued", text: "已预占"};
  if (item.bindStatus === "failed") return {cls: "warn", text: "失败可重试"};
  if (item.bindStatus === "canceled") return {cls: "warn", text: "已取消可重试"};
  if (item.bindStatus === "disabled") return {cls: "failed", text: "停用"};
  if (item.kind === "hotmail") return {cls: "warn", text: "不可用"};
  if (isPlaceholderMailboxUrl(item.mailboxUrl)) return {cls: "warn", text: "接码域名占位"};
  return {cls: "warn", text: "不可用"};
}

function emailStatusBadge(item) {
  const status = emailStatus(item);
  return `<span class="badge ${status.cls}">${escapeHtml(status.text)}</span>`;
}

function isPlaceholderMailboxUrl(value) {
  if (!value) return false;
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host === "mail-api.example" || host.endsWith(".example") || host === "example.com" || host.endsWith(".example.com");
  } catch {
    return false;
  }
}

function emailTypeText(item) {
  if (item.kind === "hotmail") return "Hotmail refresh_token";
  return "HTTP 接码 URL";
}

function emailTypeShort(item) {
  return item.kind === "hotmail" ? "HM" : "URL";
}

function emailStatusOption(value, label, current) {
  return `<option value="${value}" ${current === value ? "selected" : ""}>${label}</option>`;
}

function syncSelectedEmailsWithPool() {
  const available = new Set(emails.filter((item) => item.available).map((item) => item.email.toLowerCase()));
  selectedEmailSet = new Set([...selectedEmailSet].filter((email) => available.has(email.toLowerCase())));
}

function selectedEmailItems() {
  const selected = new Set([...selectedEmailSet].map((email) => email.toLowerCase()));
  return emails.filter((item) => selected.has(item.email.toLowerCase()));
}

function renderSelectedEmailSummary() {
  syncSelectedEmailsWithPool();
  const items = selectedEmailItems();
  const summary = $("#selected-email-summary");
  if (summary) {
    summary.textContent = items.length
      ? `已选择 ${items.length} 个邮箱：${items.slice(0, 3).map((item) => item.email).join(", ")}${items.length > 3 ? " ..." : ""}`
      : "未指定，按邮箱池顺序自动分配。";
  }
  $("#clear-selected-emails")?.classList.toggle("hidden", !items.length);
  if (items.length && $("#count")) {
    $("#count").value = String(items.length);
  }
}

function atUsableForOa(item) {
  return Boolean(item?.phone) && item?.oa?.eligible !== false;
}

function syncSelectedAtsWithPool() {
  const usable = new Set(ats.filter(atUsableForOa).map((item) => item.hash));
  selectedAtSet = new Set([...selectedAtSet].filter((hash) => usable.has(hash)));
}

function selectedAtItems() {
  const selected = new Set(selectedAtSet);
  return ats.filter((item) => selected.has(item.hash));
}

function renderSelectedAtSummary() {
  syncSelectedAtsWithPool();
  const items = selectedAtItems();
  const summary = $("#selected-at-summary");
  if (summary) {
    summary.textContent = items.length
      ? `已选择 ${items.length} 个号码：${items.slice(0, 3).map((item) => item.phone || shortHash(item.hash)).join(", ")}${items.length > 3 ? " ..." : ""}`
      : "未指定，按 AT 池顺序自动取带手机号的账号。";
  }
  $("#clear-selected-ats")?.classList.toggle("hidden", !items.length);
  if (items.length && $("#count")) {
    $("#count").value = String(items.length);
  }
}

function emailCard(item) {
  return `
    <div class="email-row" data-email-index="${item.index}" title="点击查看邮箱详情">
      <span class="email-index">${item.index + 1}</span>
      <strong class="email-main mono truncate">${escapeHtml(item.email)}</strong>
      <span class="email-row-meta">
        <span class="badge" title="${escapeHtml(emailTypeText(item))}">${escapeHtml(emailTypeShort(item))}</span>
        <button class="ghost small email-delete" type="button" title="删除邮箱" aria-label="删除邮箱" data-delete-email="${encodeURIComponent(item.email)}">×</button>
      </span>
    </div>
  `;
}

function renderEmails() {
  const availableCount = emails.filter((item) => item.available).length;
  const assignedCount = emails.filter((item) => item.assignedTaskId).length;
  const hotmailCount = emails.filter((item) => item.kind === "hotmail").length;
  const preview = [
    ...emails.filter((item) => item.available),
    ...emails.filter((item) => !item.available),
  ].slice(0, 4);
  $("#email-count").textContent = emails.length;
  $("#emails").innerHTML = emails.length
    ? `
      <div class="email-mini-summary" data-open-email-pool>
        <span>可用 <strong>${availableCount}</strong></span>
        <span>占用 <strong>${assignedCount}</strong></span>
        <span>HM <strong>${hotmailCount}</strong></span>
      </div>
      ${preview.map(emailCard).join("")}
      <button class="wide small" type="button" data-open-email-pool>查看邮箱池全部 ${emails.length} 个</button>
    `
    : `<div class="empty">暂无邮箱池，先导入“邮箱----密码----clientId----refreshToken”。</div>`;
  if (!$("#email-list-modal").classList.contains("hidden")) renderEmailPoolModal();
  renderSelectedEmailSummary();
}

function openEmailModal(item) {
  const parts = emailParts(item);
  const status = emailStatus(item);
  const bindStatus = item.bindStatus || "free";
  const currentPhone = item.assignedPhone || (["reserved", "bound"].includes(bindStatus) ? item.bindPhone : "");
  const relatedPhone = item.bindPhone || item.assignedPhone || "";
  const mailbox = item.mailboxUrl
    ? maskMailboxUrl(item.mailboxUrl)
    : "本地 Hotmail Provider：使用 clientId + refresh_token 直接读取 Outlook 收件箱";
  $("#email-modal-title").textContent = item.email;
  $("#email-modal-subtitle").textContent = `#${item.index + 1} / ${emailTypeText(item)} / ${status.text}`;
  $("#email-detail").innerHTML = `
    <div class="email-detail-grid">
    <div class="email-detail-item wide">
      <span class="label">邮箱</span>
      <strong>${escapeHtml(item.email)}</strong>
    </div>
    <div class="email-detail-item">
      <span class="label">状态</span>
      <strong>${escapeHtml(status.text)}${currentPhone ? ` · ${escapeHtml(currentPhone)}` : ""}</strong>
    </div>
    <div class="email-detail-item">
      <span class="label">${["reserved", "bound"].includes(bindStatus) ? "接入手机号" : "相关手机号"}</span>
      <strong>${escapeHtml(relatedPhone || "-")}</strong>
    </div>
    <div class="email-detail-item">
      <span class="label">接入状态</span>
      <strong>${escapeHtml(bindStatus)}</strong>
    </div>
    ${item.bindTarget ? `<div class="email-detail-item"><span class="label">接入目标</span><strong>${escapeHtml(oaTargetText(item.bindTarget))}</strong></div>` : ""}
    ${item.bindSub2ApiAccount ? `<div class="email-detail-item"><span class="label">SUB2API 账号</span><div class="mono wrap">${escapeHtml(item.bindSub2ApiAccount)}</div></div>` : ""}
    ${item.bindCpaAccount ? `<div class="email-detail-item"><span class="label">CPA auth 文件</span><div class="mono wrap">${escapeHtml(item.bindCpaAccount)}</div></div>` : ""}
    ${item.bindAccessTokenHash ? `<div class="email-detail-item"><span class="label">AT hash</span><div class="mono wrap">${escapeHtml(item.bindAccessTokenHash)}</div></div>` : ""}
    ${item.bindUpdatedAt ? `<div class="email-detail-item"><span class="label">状态更新时间</span><div class="mono wrap">${escapeHtml(fmtTime(item.bindUpdatedAt))}</div></div>` : ""}
    ${item.bindError ? `<div class="email-detail-item wide"><span class="label">错误</span><div class="mono wrap error-text">${escapeHtml(item.bindError)}</div></div>` : ""}
    <div class="email-detail-item">
      <span class="label">接码方式</span>
      <strong>${escapeHtml(emailTypeText(item))}</strong>
    </div>
    <div class="email-detail-item wide">
      <span class="label">接码地址 / 来源</span>
      <div class="mono wrap">${escapeHtml(mailbox)}</div>
    </div>
    ${parts.password ? `<div class="email-detail-item"><span class="label">邮箱密码</span><div class="mono wrap">${escapeHtml(maskSecret(parts.password, 3, 3))}</div></div>` : ""}
    ${parts.clientId ? `<div class="email-detail-item"><span class="label">clientId</span><div class="mono wrap">${escapeHtml(parts.clientId)}</div></div>` : ""}
    ${parts.refreshToken ? `<div class="email-detail-item wide"><span class="label">refreshToken</span><div class="mono wrap">${escapeHtml(maskSecret(parts.refreshToken, 16, 12))}</div></div>` : ""}
    ${item.assignedTaskId ? `<div class="email-detail-item wide"><span class="label">当前任务</span><div class="mono wrap">${escapeHtml(item.assignedTaskId)}</div></div>` : ""}
    <div class="email-detail-item wide">
      <span class="label">原始行预览</span>
      <div class="mono wrap">${escapeHtml(maskSecret(item.raw || item.preview || "", 48, 36))}</div>
    </div>
    <form class="email-detail-item wide email-status-form" data-email-status-form data-email="${encodeURIComponent(item.email)}">
      <span class="label">手动设置邮箱接入状态</span>
      <div class="split">
        <div class="field">
          <label>状态</label>
          <select name="status">
            ${emailStatusOption("free", "空闲", bindStatus)}
            ${emailStatusOption("reserved", "预占", bindStatus)}
            ${emailStatusOption("bound", "已接入", bindStatus)}
            ${emailStatusOption("failed", "失败可重试", bindStatus)}
            ${emailStatusOption("canceled", "已取消可重试", bindStatus)}
            ${emailStatusOption("disabled", "停用", bindStatus)}
          </select>
        </div>
        <div class="field">
          <label>接入手机号</label>
          <input name="phone" value="${escapeHtml(relatedPhone)}" placeholder="+123456789">
        </div>
      </div>
      <div class="split">
        <div class="field">
          <label>任务 ID</label>
          <input name="taskId" value="${escapeHtml(item.bindTaskId || item.assignedTaskId || "")}">
        </div>
        <div class="field">
          <label>SUB2API 账号</label>
          <input name="sub2apiAccount" value="${escapeHtml(item.bindSub2ApiAccount || "")}">
        </div>
      </div>
      <div class="split">
        <div class="field">
          <label>接入目标</label>
          <select name="target">
            <option value="sub2api" ${(item.bindTarget || "sub2api") === "sub2api" ? "selected" : ""}>SUB2API</option>
            <option value="cpa" ${item.bindTarget === "cpa" ? "selected" : ""}>CPA</option>
          </select>
        </div>
        <div class="field">
          <label>CPA auth 文件</label>
          <input name="cpaAccount" value="${escapeHtml(item.bindCpaAccount || "")}">
        </div>
      </div>
      <div class="field">
        <label>备注/错误</label>
        <input name="note" value="${escapeHtml(item.bindNote || item.bindError || "")}">
      </div>
      <button class="primary" type="submit">保存邮箱状态</button>
    </form>
    </div>
  `;
  $("#email-modal").classList.remove("hidden");
  bindEmailStatusForm();
}

function closeEmailModal() {
  $("#email-modal").classList.add("hidden");
}

function emailPoolTableRow(item) {
  const assigned = item.assignedTaskId
    ? `<div class="muted mono">${escapeHtml(item.assignedTaskId)}</div>`
    : "";
  const phone = item.bindPhone || item.assignedPhone || "";
  const encodedEmail = encodeURIComponent(item.email);
  const checked = selectedEmailSet.has(item.email.toLowerCase()) ? "checked" : "";
  const disabled = item.available ? "" : "disabled";
  return `
    <tr class="selectable ${checked ? "selected" : ""}" data-email-index="${item.index}">
      <td>
        <input class="email-pick-check" type="checkbox" data-pick-email="${encodedEmail}" ${checked} ${disabled} title="${item.available ? "选择这个邮箱" : "该邮箱当前不可用"}">
        <span class="email-index">${item.index + 1}</span>
      </td>
      <td>
        <div class="mono">${escapeHtml(item.email)}</div>
        ${assigned}
      </td>
      <td><div class="mono">${escapeHtml(phone || "-")}</div></td>
      <td>${emailStatusBadge(item)}</td>
      <td><span class="badge">${escapeHtml(emailTypeText(item))}</span></td>
      <td><div class="mono wrap">${escapeHtml(mailboxPreview(item.mailboxUrl))}</div></td>
      <td>
        <div class="row actions email-quick-actions">
          <button class="small" type="button" data-email-status="${encodedEmail}" data-status="bound">设已接入</button>
          <button class="ghost small" type="button" data-email-status="${encodedEmail}" data-status="free">释放</button>
          <button class="ghost small" type="button" data-email-status="${encodedEmail}" data-status="disabled">停用</button>
          <button class="danger small" type="button" data-delete-email="${encodedEmail}">删除</button>
        </div>
      </td>
    </tr>
  `;
}

function renderEmailPoolModal() {
  const availableCount = emails.filter((item) => item.available).length;
  const assignedCount = emails.filter((item) => item.assignedTaskId).length;
  const hotmailCount = emails.filter((item) => item.kind === "hotmail").length;
  const urlCount = emails.filter((item) => item.kind !== "hotmail").length;
  $("#email-list-modal-subtitle").textContent = `共 ${emails.length} 个；空闲 ${availableCount} 个；任务占用 ${assignedCount} 个；Hotmail ${hotmailCount} 个；URL ${urlCount} 个`;
  $("#email-pool-list").innerHTML = emails.length
    ? `
      <div class="row spread email-picker-toolbar">
        <span class="muted">已选择 <strong id="email-picker-selected-count">${selectedEmailSet.size}</strong> 个邮箱用于下一次 OA 任务。</span>
        <div class="row">
          <button class="small" type="button" data-pick-all-emails>全选可用</button>
          <button class="ghost small" type="button" data-clear-picked-emails>清空</button>
          <button class="primary small" type="button" data-confirm-picked-emails>确认选择</button>
        </div>
      </div>
      <div class="bulk-picker">
        <label for="email-bulk-input">批量搜索邮箱</label>
        <textarea id="email-bulk-input" class="bulk-picker-input" placeholder="每行一个邮箱，或直接粘贴带邮箱的文本">${escapeHtml(emailBatchInputCache)}</textarea>
        <div class="row spread">
          <span id="email-bulk-result" class="muted">${escapeHtml(emailBatchResult || "粘贴邮箱后点“匹配并勾选”。")}</span>
          <div class="row">
            <button class="small" type="button" data-bulk-pick-emails>匹配并勾选</button>
            <button class="ghost small" type="button" data-clear-email-bulk-input>清空输入</button>
          </div>
        </div>
      </div>
      <div class="table-wrap email-pool-table-wrap">
        <table class="email-pool-table">
          <thead>
            <tr>
              <th>#</th>
              <th>邮箱</th>
              <th>接入号码</th>
              <th>状态</th>
              <th>类型</th>
              <th>接码地址</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>${emails.map(emailPoolTableRow).join("")}</tbody>
        </table>
      </div>
    `
    : `<div class="empty">暂无邮箱池。</div>`;
  bindEmailActions($("#email-list-modal"));
}

function openEmailListModal() {
  renderEmailPoolModal();
  $("#email-list-modal").classList.remove("hidden");
  bindEmailActions($("#email-list-modal"));
}

function closeEmailListModal() {
  $("#email-list-modal").classList.add("hidden");
}

function findEmailByEncoded(encodedEmail) {
  return emails.find((entry) => encodeURIComponent(entry.email) === encodedEmail);
}

function normalizePhoneInput(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const compact = text.replace(/[\s()-]/g, "");
  if (compact.startsWith("+")) {
    const digits = compact.slice(1).replace(/[^\d]/g, "");
    return digits ? `+${digits}` : "";
  }
  const digits = compact.replace(/[^\d]/g, "");
  return digits ? `+${digits}` : "";
}

function promptBoundPhone(item) {
  const current = item?.bindPhone || item?.assignedPhone || "";
  const value = window.prompt("设置为已接入，请填写接入手机号（带国家码，例如 +49123456789）：", current);
  if (value === null) return null;
  const phone = normalizePhoneInput(value);
  if (!phone) {
    toast("设置已接入必须填写手机号");
    return null;
  }
  return phone;
}

function bulkPickEmailsFromInput() {
  const input = $("#email-bulk-input");
  emailBatchInputCache = input?.value || "";
  const wanted = parseBulkEmails(emailBatchInputCache);
  if (!wanted.length) {
    emailBatchResult = "未识别到邮箱。";
    renderEmailPoolModal();
    return;
  }

  const availableByEmail = new Map(emails.filter((item) => item.available).map((item) => [item.email.toLowerCase(), item]));
  const matched = [];
  const missing = [];
  for (const email of wanted) {
    const item = availableByEmail.get(email);
    if (item) {
      selectedEmailSet.add(item.email.toLowerCase());
      matched.push(item.email);
    } else {
      missing.push(email);
    }
  }
  emailBatchResult = `识别 ${wanted.length} 个，匹配并勾选 ${matched.length} 个${missing.length ? `，未找到/不可用 ${missing.length} 个：${missing.slice(0, 5).join(", ")}${missing.length > 5 ? " ..." : ""}` : ""}`;
  renderSelectedEmailSummary();
  renderEmailPoolModal();
}

function bindEmailStatusForm() {
  const form = document.querySelector("[data-email-status-form]");
  if (!form || form.dataset.boundStatusForm === "1") return;
  form.dataset.boundStatusForm = "1";
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(form).entries());
    if (data.status === "bound") {
      data.phone = normalizePhoneInput(data.phone);
      if (!data.phone) {
        toast("设置已接入必须填写手机号");
        form.querySelector("[name=phone]")?.focus();
        return;
      }
    }
    try {
      await api(`/api/oa/emails/${form.dataset.email}`, {
        method: "PATCH",
        body: JSON.stringify(data),
      });
      toast("邮箱状态已保存");
      await loadEmails();
      const item = emails.find((entry) => encodeURIComponent(entry.email) === form.dataset.email);
      if (item) openEmailModal(item);
    } catch (error) {
      toast(error.message);
    }
  });
}

function bindEmailActions(root = document) {
  root.querySelectorAll("[data-pick-email]").forEach((checkbox) => {
    if (checkbox.dataset.boundPickEmail === "1") return;
    checkbox.dataset.boundPickEmail = "1";
    checkbox.addEventListener("click", (event) => event.stopPropagation());
    checkbox.addEventListener("change", () => {
      const item = findEmailByEncoded(checkbox.dataset.pickEmail);
      if (!item || !item.available) return;
      if (checkbox.checked) selectedEmailSet.add(item.email.toLowerCase());
      else selectedEmailSet.delete(item.email.toLowerCase());
      renderSelectedEmailSummary();
      const count = $("#email-picker-selected-count");
      if (count) count.textContent = String(selectedEmailSet.size);
      checkbox.closest("tr")?.classList.toggle("selected", checkbox.checked);
    });
  });

  root.querySelectorAll("[data-bulk-pick-emails]").forEach((btn) => {
    if (btn.dataset.boundBulkPickEmails === "1") return;
    btn.dataset.boundBulkPickEmails = "1";
    btn.addEventListener("click", bulkPickEmailsFromInput);
  });

  root.querySelectorAll("[data-clear-email-bulk-input]").forEach((btn) => {
    if (btn.dataset.boundClearEmailBulk === "1") return;
    btn.dataset.boundClearEmailBulk = "1";
    btn.addEventListener("click", () => {
      emailBatchInputCache = "";
      emailBatchResult = "";
      renderEmailPoolModal();
    });
  });

  root.querySelectorAll("[data-pick-all-emails]").forEach((btn) => {
    if (btn.dataset.boundPickAllEmails === "1") return;
    btn.dataset.boundPickAllEmails = "1";
    btn.addEventListener("click", () => {
      emails.filter((item) => item.available).forEach((item) => selectedEmailSet.add(item.email.toLowerCase()));
      renderSelectedEmailSummary();
      renderEmailPoolModal();
    });
  });

  root.querySelectorAll("[data-clear-picked-emails]").forEach((btn) => {
    if (btn.dataset.boundClearPickedEmails === "1") return;
    btn.dataset.boundClearPickedEmails = "1";
    btn.addEventListener("click", () => {
      selectedEmailSet.clear();
      renderSelectedEmailSummary();
      renderEmailPoolModal();
    });
  });

  root.querySelectorAll("[data-confirm-picked-emails]").forEach((btn) => {
    if (btn.dataset.boundConfirmPickedEmails === "1") return;
    btn.dataset.boundConfirmPickedEmails = "1";
    btn.addEventListener("click", () => {
      renderSelectedEmailSummary();
      closeEmailListModal();
      toast(selectedEmailSet.size ? `已选择 ${selectedEmailSet.size} 个邮箱` : "已清空邮箱选择，将自动分配");
    });
  });

  root.querySelectorAll("[data-open-email-pool]").forEach((el) => {
    if (el.dataset.boundEmailPool === "1") return;
    el.dataset.boundEmailPool = "1";
    el.addEventListener("click", openEmailListModal);
  });

  root.querySelectorAll("[data-delete-email]").forEach((btn) => {
    if (btn.dataset.boundDeleteEmail === "1") return;
    btn.dataset.boundDeleteEmail = "1";
    btn.addEventListener("click", async (event) => {
      event.stopPropagation();
      await api(`/api/oa/emails/${btn.dataset.deleteEmail}`, {method: "DELETE"});
      toast("邮箱已删除");
      await loadEmails();
    });
  });

  root.querySelectorAll("[data-email-status]").forEach((btn) => {
    if (btn.dataset.boundEmailStatus === "1") return;
    btn.dataset.boundEmailStatus = "1";
    btn.addEventListener("click", async (event) => {
      event.stopPropagation();
      const status = btn.dataset.status || "free";
      const body = {status};
      if (status === "bound") {
        const item = findEmailByEncoded(btn.dataset.emailStatus);
        const phone = promptBoundPhone(item);
        if (!phone) return;
        body.phone = phone;
      }
      await api(`/api/oa/emails/${btn.dataset.emailStatus}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      toast(status === "bound" ? "邮箱已标记为已接入" : status === "free" ? "邮箱已释放为可用" : "邮箱已停用");
      await loadEmails();
      if (!$("#email-list-modal").classList.contains("hidden")) renderEmailPoolModal();
    });
  });

  root.querySelectorAll("[data-email-index]").forEach((row) => {
    if (row.dataset.boundEmailOpen === "1") return;
    row.dataset.boundEmailOpen = "1";
    row.addEventListener("click", (event) => {
      if (event.target.closest("button")) return;
      const item = emails.find((entry) => String(entry.index) === row.dataset.emailIndex);
      if (item) openEmailModal(item);
    });
  });
}

async function loadEmails() {
  const data = await api("/api/oa/emails");
  emails = data.items || [];
  $("#email-file").textContent = data.file || "";
  renderEmails();
  bindEmailActions();
}

function oaAtModeText(item) {
  const mode = item.oa?.mode || "auto";
  if (mode === "enabled") return "手动接入";
  if (mode === "disabled") return "不接入";
  return item.phone ? "自动接入" : "无手机号";
}

function oaAtModeClass(item) {
  if (!item.phone) return "failed";
  if (item.oa?.mode === "disabled") return "warn";
  if (item.expired) return "warn";
  return "success";
}

function oaAtStatusText(item) {
  if (!item.phone) return "无手机号";
  if (item.expired) return "AT 已过期 / 可 OA";
  return oaAtModeText(item);
}

function oaAtRow(item) {
  return `
    <div class="oa-at-row ${item.oa?.eligible ? "eligible" : "disabled"}">
      <div class="oa-at-main">
        <div class="mono truncate">${escapeHtml(item.phone || item.email || item.preview)}</div>
        <div class="muted mono truncate">${escapeHtml(shortHash(item.hash))} · ${escapeHtml(item.plan || "-")}</div>
      </div>
      <span class="badge ${oaAtModeClass(item)}">${escapeHtml(oaAtStatusText(item))}</span>
      <select class="oa-at-select" data-at-oa="${escapeHtml(item.hash)}">
        <option value="auto" ${item.oa?.mode === "auto" ? "selected" : ""}>自动</option>
        <option value="true" ${item.oa?.mode === "enabled" ? "selected" : ""}>接入</option>
        <option value="false" ${item.oa?.mode === "disabled" ? "selected" : ""}>不接入</option>
      </select>
    </div>
  `;
}

function renderOaAts() {
  const el = $("#oa-at-list");
  if (!el) return;
  const phoneAts = ats.filter((item) => item.phone);
  const enabledCount = ats.filter(atUsableForOa).length;
  const preview = [
    ...ats.filter(atUsableForOa),
    ...ats.filter((item) => !atUsableForOa(item)),
  ].slice(0, 4);
  el.innerHTML = ats.length
    ? `
      <div class="oa-at-summary">
        <span>AT ${ats.length}</span>
        <span>带手机号 ${phoneAts.length}</span>
        <span>可接入 ${enabledCount}</span>
      </div>
      ${preview.map(oaAtRow).join("")}
      <button class="wide small" type="button" data-open-at-pool>查看号码池全部 ${ats.length} 个</button>
    `
    : `<div class="empty">暂无 AT，先在 AT 池导入</div>`;
  bindOaAtActions();
  bindAtPoolOpenActions();
  if (!$("#at-list-modal").classList.contains("hidden")) renderAtPoolModal();
  renderSelectedAtSummary();
}

function atPoolTableRow(item) {
  const checked = selectedAtSet.has(item.hash) ? "checked" : "";
  const usable = atUsableForOa(item);
  const disabled = usable ? "" : "disabled";
  return `
    <tr class="selectable ${selectedAtSet.has(item.hash) ? "selected" : ""}" data-at-row="${escapeHtml(item.hash)}">
      <td>
        <input class="at-pick-check" type="checkbox" data-pick-at="${escapeHtml(item.hash)}" ${checked} ${disabled} title="${usable ? "选择这个号码" : "该号码当前不可用"}">
        <span class="email-index">${item.index + 1}</span>
      </td>
      <td>
        <div class="mono">${escapeHtml(item.phone || "-")}</div>
        <div class="muted mono truncate">${escapeHtml(item.email || item.preview || "")}</div>
      </td>
      <td><span class="badge ${oaAtModeClass(item)}">${escapeHtml(oaAtStatusText(item))}</span></td>
      <td><div class="mono">${escapeHtml(item.expiresAt ? fmtTime(item.expiresAt) : "-")}</div></td>
      <td><div class="mono truncate">${escapeHtml(item.plan || "-")}</div></td>
      <td><div class="mono">${escapeHtml(shortHash(item.hash))}</div></td>
    </tr>
  `;
}

function renderAtPoolModal() {
  const phoneCount = ats.filter((item) => item.phone).length;
  const usableCount = ats.filter(atUsableForOa).length;
  const expiredCount = ats.filter((item) => item.expired).length;
  const disabledCount = ats.filter((item) => item.phone && item.oa?.eligible === false).length;
  $("#at-list-modal-subtitle").textContent = `共 ${ats.length} 个；带手机号 ${phoneCount} 个；可接入 ${usableCount} 个；已过期 ${expiredCount} 个；停用 ${disabledCount} 个`;
  $("#at-pool-list").innerHTML = ats.length
    ? `
      <div class="row spread at-picker-toolbar">
        <span class="muted">已选择 <strong id="at-picker-selected-count">${selectedAtSet.size}</strong> 个号码用于下一次 OA 任务。</span>
        <div class="row">
          <button class="small" type="button" data-pick-all-ats>全选可接入</button>
          <button class="ghost small" type="button" data-clear-picked-ats>清空</button>
          <button class="primary small" type="button" data-confirm-picked-ats>确认选择</button>
        </div>
      </div>
      <div class="bulk-picker">
        <label for="at-bulk-input">批量搜索号码</label>
        <textarea id="at-bulk-input" class="bulk-picker-input" placeholder="+573004789726&#10;+573234874194&#10;+573137916814">${escapeHtml(atBatchInputCache)}</textarea>
        <div class="row spread">
          <span id="at-bulk-result" class="muted">${escapeHtml(atBatchResult || "粘贴号码后点“匹配并勾选”。")}</span>
          <div class="row">
            <button class="small" type="button" data-bulk-pick-ats>匹配并勾选</button>
            <button class="ghost small" type="button" data-clear-at-bulk-input>清空输入</button>
          </div>
        </div>
      </div>
      <div class="table-wrap at-pool-table-wrap">
        <table class="at-pool-table">
          <thead>
            <tr>
              <th>#</th>
              <th>号码 / 账号</th>
              <th>状态</th>
              <th>过期时间</th>
              <th>套餐</th>
              <th>AT hash</th>
            </tr>
          </thead>
          <tbody>${ats.map(atPoolTableRow).join("")}</tbody>
        </table>
      </div>
    `
    : `<div class="empty">暂无 AT，先在 AT 池导入。</div>`;
  bindAtPoolActions($("#at-list-modal"));
}

function openAtListModal() {
  renderAtPoolModal();
  $("#at-list-modal").classList.remove("hidden");
  bindAtPoolActions($("#at-list-modal"));
}

function closeAtListModal() {
  $("#at-list-modal").classList.add("hidden");
}

function bindAtPoolOpenActions(root = document) {
  root.querySelectorAll("[data-open-at-pool]").forEach((el) => {
    if (el.dataset.boundAtPool === "1") return;
    el.dataset.boundAtPool = "1";
    el.addEventListener("click", openAtListModal);
  });
}

function findAtByHash(hash) {
  return ats.find((entry) => entry.hash === hash);
}

function bulkPickAtsFromInput() {
  const input = $("#at-bulk-input");
  atBatchInputCache = input?.value || "";
  const wanted = parseBulkPhones(atBatchInputCache);
  if (!wanted.length) {
    atBatchResult = "未识别到手机号。";
    renderAtPoolModal();
    return;
  }

  const usableByPhone = new Map();
  ats.filter(atUsableForOa).forEach((item) => {
    if (item.phone) usableByPhone.set(normalizePhoneInput(item.phone), item);
  });
  const matched = [];
  const missing = [];
  for (const phone of wanted) {
    const item = usableByPhone.get(phone);
    if (item) {
      selectedAtSet.add(item.hash);
      matched.push(item.phone || phone);
    } else {
      missing.push(phone);
    }
  }
  atBatchResult = `识别 ${wanted.length} 个，匹配并勾选 ${matched.length} 个${missing.length ? `，未找到/不可用 ${missing.length} 个：${missing.slice(0, 5).join(", ")}${missing.length > 5 ? " ..." : ""}` : ""}`;
  renderSelectedAtSummary();
  renderAtPoolModal();
}

function bindAtPoolActions(root = document) {
  root.querySelectorAll("[data-pick-at]").forEach((checkbox) => {
    if (checkbox.dataset.boundPickAt === "1") return;
    checkbox.dataset.boundPickAt = "1";
    checkbox.addEventListener("click", (event) => event.stopPropagation());
    checkbox.addEventListener("change", () => {
      const item = findAtByHash(checkbox.dataset.pickAt);
      if (!item || !atUsableForOa(item)) return;
      if (checkbox.checked) selectedAtSet.add(item.hash);
      else selectedAtSet.delete(item.hash);
      renderSelectedAtSummary();
      const count = $("#at-picker-selected-count");
      if (count) count.textContent = String(selectedAtSet.size);
      checkbox.closest("tr")?.classList.toggle("selected", checkbox.checked);
    });
  });

  root.querySelectorAll("[data-bulk-pick-ats]").forEach((btn) => {
    if (btn.dataset.boundBulkPickAts === "1") return;
    btn.dataset.boundBulkPickAts = "1";
    btn.addEventListener("click", bulkPickAtsFromInput);
  });

  root.querySelectorAll("[data-clear-at-bulk-input]").forEach((btn) => {
    if (btn.dataset.boundClearAtBulk === "1") return;
    btn.dataset.boundClearAtBulk = "1";
    btn.addEventListener("click", () => {
      atBatchInputCache = "";
      atBatchResult = "";
      renderAtPoolModal();
    });
  });

  root.querySelectorAll("[data-pick-all-ats]").forEach((btn) => {
    if (btn.dataset.boundPickAllAts === "1") return;
    btn.dataset.boundPickAllAts = "1";
    btn.addEventListener("click", () => {
      ats.filter(atUsableForOa).forEach((item) => selectedAtSet.add(item.hash));
      renderSelectedAtSummary();
      renderAtPoolModal();
    });
  });

  root.querySelectorAll("[data-clear-picked-ats]").forEach((btn) => {
    if (btn.dataset.boundClearPickedAts === "1") return;
    btn.dataset.boundClearPickedAts = "1";
    btn.addEventListener("click", () => {
      selectedAtSet.clear();
      renderSelectedAtSummary();
      renderAtPoolModal();
    });
  });

  root.querySelectorAll("[data-confirm-picked-ats]").forEach((btn) => {
    if (btn.dataset.boundConfirmPickedAts === "1") return;
    btn.dataset.boundConfirmPickedAts = "1";
    btn.addEventListener("click", () => {
      renderSelectedAtSummary();
      closeAtListModal();
      toast(selectedAtSet.size ? `已选择 ${selectedAtSet.size} 个号码` : "已清空号码选择，将自动分配");
    });
  });

  root.querySelectorAll("[data-at-row]").forEach((row) => {
    if (row.dataset.boundAtRowPick === "1") return;
    row.dataset.boundAtRowPick = "1";
    row.addEventListener("click", (event) => {
      if (event.target.closest("button, select, input")) return;
      const checkbox = row.querySelector("[data-pick-at]");
      if (!checkbox || checkbox.disabled) return;
      checkbox.checked = !checkbox.checked;
      checkbox.dispatchEvent(new Event("change", {bubbles: true}));
    });
  });
}

function bindOaAtActions() {
  document.querySelectorAll("[data-at-oa]").forEach((select) => {
    if (select.dataset.boundAtOa === "1") return;
    select.dataset.boundAtOa = "1";
    select.addEventListener("change", async () => {
      try {
        await api(`/api/ats/${select.dataset.atOa}`, {
          method: "PATCH",
          body: JSON.stringify({enabled: select.value}),
        });
        toast("AT 的 OA 接入标识已保存");
        await loadAts();
      } catch (error) {
        toast(error.message);
      }
    });
  });
}

async function loadAts() {
  const data = await api("/api/ats");
  ats = data.items || [];
  const phoneAts = ats.filter((item) => item.phone && item.oa?.eligible);
  $("#phone-at-count").textContent = phoneAts.length;
  renderOaAts();
}

function taskRow(task) {
  const phone = task.phone ? `<span class="mono">${escapeHtml(task.phone)}</span>` : '<span class="muted">-</span>';
  const email = task.bindEmail ? `<span class="mono">${escapeHtml(task.bindEmail)}</span>` : '<span class="muted">-</span>';
  const result = task.oaTarget === "cpa"
    ? (task.cpaAccount
      ? `<span class="mono token-pill">${escapeHtml(task.cpaAccount)}</span>`
      : `<span class="muted">CPA</span>`)
    : (task.sub2apiAccount
      ? `<span class="mono token-pill">${escapeHtml(task.sub2apiAccount)}</span>`
      : `<span class="muted">${escapeHtml(task.sub2apiGroup || "SUB2API")}</span>`);
  const cancel = ["queued", "running"].includes(task.status)
    ? `<button class="danger small" type="button" data-cancel="${task.id}">取消</button>`
    : "";
  const retry = ["failed", "canceled"].includes(task.status)
    ? `<button class="small" type="button" data-retry="${task.id}">重试</button>`
    : "";
  const del = ["failed", "canceled"].includes(task.status)
    ? `<button class="ghost small" type="button" data-delete="${task.id}">删除</button>`
    : "";
  const note = task.error
    ? `<div class="task-note error-text">${escapeHtml(task.error)}</div>`
    : `<div class="task-note">更新 ${fmtTime(task.updatedAt)}</div>`;
  return `
    <tr class="selectable ${task.id === selectedTaskId ? "selected" : ""}" data-id="${task.id}">
      <td>${badge(task.status)}</td>
      <td>
        <div class="task-main mono">${escapeHtml(taskName(task))}</div>
        ${note}
      </td>
      <td>${phone}</td>
      <td>${email}</td>
      <td>${result}</td>
      <td><div class="row actions"><button class="small" type="button" data-open="${task.id}">日志</button>${retry}${cancel}${del}</div></td>
    </tr>
  `;
}

function renderTasks() {
  $("#tasks").innerHTML = tasks.length
    ? tasks.map(taskRow).join("")
    : `<tr><td colspan="6"><div class="empty">暂无 OA 接入任务。</div></td></tr>`;
  bindTaskActions();
}

async function loadTasks() {
  const data = await api("/api/oa/tasks");
  tasks = data.tasks || [];
  renderTasks();

  if (!$("#task-modal").classList.contains("hidden") && selectedTaskId) {
    const task = tasks.find((item) => item.id === selectedTaskId);
    if (task) renderTaskDetail(task);
  }
}

function renderTaskDetail(task) {
  if (!task) return;
  selectedTaskId = task.id;
  $("#task-modal-title").textContent = `任务日志 · ${taskName(task)}`;
  $("#task-modal-subtitle").textContent = `${oaTargetText(task.oaTarget)} / ${task.status} / ${fmtTime(task.updatedAt)}`;
  $("#task-detail").textContent = (task.logs || []).join("\n") || "暂无日志";
  $("#task-modal").classList.remove("hidden");
  $("#task-detail").scrollTop = $("#task-detail").scrollHeight;
}

function closeTaskModal() {
  $("#task-modal").classList.add("hidden");
  selectedTaskId = "";
}

function bindTaskActions() {
  document.querySelectorAll("tr[data-id]").forEach((row) => {
    row.addEventListener("click", (event) => {
      if (event.target.closest("button")) return;
      const task = tasks.find((item) => item.id === row.dataset.id);
      renderTaskDetail(task);
      renderTasks();
    });
  });

  document.querySelectorAll("[data-open]").forEach((btn) => {
    btn.addEventListener("click", (event) => {
      event.stopPropagation();
      const task = tasks.find((item) => item.id === btn.dataset.open);
      renderTaskDetail(task);
      renderTasks();
    });
  });

  document.querySelectorAll("[data-cancel]").forEach((btn) => {
    btn.addEventListener("click", async (event) => {
      event.stopPropagation();
      await api(`/api/tasks/${btn.dataset.cancel}/cancel`, {method: "POST", body: "{}"});
      toast("已请求取消任务");
      await loadTasks();
    });
  });

  document.querySelectorAll("[data-retry]").forEach((btn) => {
    btn.addEventListener("click", async (event) => {
      event.stopPropagation();
      const data = await api(`/api/tasks/${btn.dataset.retry}/retry`, {method: "POST", body: "{}"});
      toast(`OA 重试任务已创建：${data.task?.id || ""}`);
      await Promise.all([loadTasks(), loadEmails(), loadAts()]);
      const task = data.task?.id ? tasks.find((item) => item.id === data.task.id) : null;
      if (task) renderTaskDetail(task);
    });
  });

  document.querySelectorAll("[data-delete]").forEach((btn) => {
    btn.addEventListener("click", async (event) => {
      event.stopPropagation();
      await api(`/api/tasks/${btn.dataset.delete}`, {method: "DELETE"});
      if (selectedTaskId === btn.dataset.delete) closeTaskModal();
      toast("任务已删除");
      await loadTasks();
    });
  });
}

function openImportModal() {
  $("#import-modal").classList.remove("hidden");
  $("#import-text").focus();
}

function closeImportModal() {
  $("#import-modal").classList.add("hidden");
}

function syncDuckModePanels() {
  const mode = $("#duckMode")?.value || "cf";
  $("#duck-cf-panel")?.classList.toggle("hidden", mode !== "cf");
  $("#duck-imap-panel")?.classList.toggle("hidden", mode !== "imap");
}

function openDuckMailModal() {
  syncDuckModePanels();
  $("#duck-mail-modal")?.classList.remove("hidden");
  $("#duckToken")?.focus();
}

function closeDuckMailModal() {
  $("#duck-mail-modal")?.classList.add("hidden");
}

function collectDuckMailBody() {
  const form = $("#duck-mail-form");
  const body = Object.fromEntries(new FormData(form).entries());
  body.ddgEnabled = $("#duckEnabled")?.checked || false;
  body.count = Number(body.count || 1);
  body.ddgImapPort = Number(body.ddgImapPort || 993);
  body.ddgImapSearchLimit = Number(body.ddgImapSearchLimit || 30);
  body.ddgPollIntervalMs = Number(body.ddgPollIntervalMs || 5000);
  return body;
}

async function saveDuckMailConfig(event) {
  event?.preventDefault();
  const data = await api("/api/config/ddg-mail", {
    method: "PATCH",
    body: JSON.stringify(collectDuckMailBody()),
  });
  configCache = data;
  renderTargetConfig(data);
  toast("Duck 邮箱配置已保存");
  return data;
}

async function generateDuckMailEmails() {
  const btn = $("#generate-duck-mail");
  const output = $("#duck-mail-result");
  btn.disabled = true;
  output.classList.remove("hidden");
  output.textContent = "正在保存配置并生成 Duck 邮箱...";
  try {
    await saveDuckMailConfig();
    const body = collectDuckMailBody();
    const result = await api("/api/oa/emails/duck/generate", {
      method: "POST",
      body: JSON.stringify({mode: body.mode, count: body.count}),
    });
    output.textContent = JSON.stringify(result, null, 2);
    toast(`Duck 邮箱已生成并导入：新增 ${result.added || 0}，更新 ${result.updated || 0}，跳过 ${result.skipped || 0}`);
    await loadEmails();
  } finally {
    btn.disabled = false;
  }
}

function openTargetSettingsModal() {
  renderTargetPanels();
  $("#target-settings-modal").classList.remove("hidden");
}

function closeTargetSettingsModal() {
  $("#target-settings-modal").classList.add("hidden");
}

function sub2apiGroupText(sub2api) {
  const groups = Array.isArray(sub2api?.groupNames) && sub2api.groupNames.length
    ? sub2api.groupNames
    : [sub2api?.groupName || "codex"];
  return groups.filter(Boolean).join(",");
}

function renderTargetPanels() {
  const target = $("#oaTarget")?.value || "sub2api";
  $("#sub2api-panel")?.classList.toggle("hidden", target !== "sub2api");
  $("#cpa-panel")?.classList.toggle("hidden", target !== "cpa");
  if ($("#target-settings-title")) {
    $("#target-settings-title").textContent = target === "cpa" ? "CPA 接入设置" : "SUB2API 接入设置";
  }
  if ($("#target-settings-subtitle")) {
    $("#target-settings-subtitle").textContent = target === "cpa"
      ? "保存 CPA 地址和 Management Key，新 OA 任务会走 CPA 兼容入库。"
      : "保存 SUB2API 地址、账号、密码和导入分组，新 OA 任务会创建中转站账号。";
  }
}

function renderTargetConfig(data) {
  const sub2api = data.sub2api || {};
  const cpa = data.cpa || {};
  const mailApi = data.mailApi || {};
  const ddgMail = data.ddgMail || {};
  const ddgCf = ddgMail.cf || {};
  const ddgImap = ddgMail.imap || {};
  const register = data.register || {};
  if ($("#sub2api-config")) $("#sub2api-config").textContent = JSON.stringify(sub2api, null, 2);
  if ($("#cpa-config")) $("#cpa-config").textContent = JSON.stringify(cpa, null, 2);
  if ($("#sub2api-form")) {
    $("#sub2apiUrl").value = sub2api.url || "";
    $("#sub2apiEmail").value = sub2api.email || "";
    $("#sub2apiPassword").value = "";
    $("#sub2apiPassword").placeholder = sub2api.passwordPresent ? "已配置，留空不修改" : "必填";
    $("#sub2apiGroupNames").value = sub2apiGroupText(sub2api);
    $("#sub2apiProxyName").value = sub2api.proxyName || "";
    $("#sub2apiAccountPriority").value = sub2api.accountPriority || 1;
    $("#sub2apiConcurrency").value = sub2api.concurrency || 10;
  }
  if ($("#cpa-form")) {
    $("#cpaBaseUrl").value = cpa.baseUrl || "";
    $("#cpaManagementKey").value = "";
    $("#cpaManagementKey").placeholder = cpa.managementKeyPresent ? "已配置，留空不修改" : "必填";
    $("#cpaAutoUploadAuth").checked = Boolean(cpa.autoUploadAuth);
  }
  if ($("#mail-api-base-url")) {
    $("#mail-api-base-url").value = mailApi.baseUrl || "";
  }
  if ($("#duck-mail-form")) {
    $("#duckEnabled").checked = Boolean(ddgMail.enabled);
    $("#duckToken").value = "";
    $("#duckToken").placeholder = ddgMail.tokenPresent ? "已配置，留空不修改" : "Authorization: Bearer ...";
    $("#duckAliasDomain").value = ddgMail.aliasDomain || "duck.com";
    $("#duckAddressPrefix").value = ddgMail.addressPrefix || "";
    $("#duckProxyUrl").value = ddgMail.proxyUrl || "";
    $("#duckCfApiBaseUrl").value = ddgCf.apiBaseUrl || "";
    $("#duckCfInboxJwt").value = "";
    $("#duckCfInboxJwt").placeholder = ddgCf.inboxJwtPresent ? "已配置，留空不修改" : "";
    $("#duckCfApiKey").value = "";
    $("#duckCfApiKey").placeholder = ddgCf.apiKeyPresent ? "已配置，留空不修改" : "";
    $("#duckCfAuthMode").value = ddgCf.authMode || "none";
    $("#duckCfMessagesPath").value = ddgCf.messagesPath || "/api/mails";
    $("#duckImapEmail").value = ddgImap.email || "";
    $("#duckImapPassword").value = "";
    $("#duckImapPassword").placeholder = ddgImap.passwordPresent ? "已配置，留空不修改" : "";
    $("#duckImapHost").value = ddgImap.host || "imap.qq.com";
    $("#duckImapPort").value = ddgImap.port || 993;
    $("#duckImapMailbox").value = ddgImap.mailbox || "INBOX";
    $("#duckImapSearchLimit").value = ddgImap.searchLimit || 30;
    $("#duckPollIntervalMs").value = ddgMail.pollIntervalMs || 5000;
    $("#duck-mail-summary").textContent = `启用：${ddgMail.enabled ? "是" : "否"}；DDG Token：${ddgMail.tokenPresent ? "已配置" : "未配置"}；CF：${ddgCf.apiBaseUrl ? "已配置" : "未配置"}；IMAP：${ddgImap.email || "未配置"}`;
    syncDuckModePanels();
  }
  if ($("#oa-proxy-current")) {
      $("#oa-proxy-current").textContent = `当前默认代理：${register.oaProxyUrl || register.defaultProxyUrl || "直连"}`;
  }
  renderTargetPanels();
}

async function loadConfig() {
  configCache = await api("/api/config");
  renderTargetConfig(configCache);
}

async function saveSub2ApiConfig(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const body = Object.fromEntries(form.entries());
  body.accountPriority = Number(body.accountPriority || 1);
  body.concurrency = Number(body.concurrency || 10);
  const data = await api("/api/config/sub2api", {
    method: "PATCH",
    body: JSON.stringify(body),
  });
  configCache = data;
  renderTargetConfig(data);
  toast("SUB2API 配置已保存");
}

async function saveCpaConfig(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const body = Object.fromEntries(form.entries());
  body.autoUploadAuth = $("#cpaAutoUploadAuth").checked;
  const data = await api("/api/config/cpa", {
    method: "PATCH",
    body: JSON.stringify(body),
  });
  configCache = data;
  renderTargetConfig(data);
  toast("CPA 配置已保存");
}

async function probeOaProxy() {
  const btn = $("#probe-oa-proxy");
  const output = $("#oa-probe-result");
  const proxyUrl = ($("#oaProxyUrl")?.value || "").trim();
  btn.disabled = true;
  output.classList.remove("hidden");
  output.textContent = "正在测试 auth.openai.com 网络...";
  try {
    const query = proxyUrl.toLowerCase() === "direct"
      ? "?target=oauth&direct=1"
      : (proxyUrl ? `?target=oauth&proxyUrl=${encodeURIComponent(proxyUrl)}` : "?target=oauth");
    const result = await api(`/api/oa/probe${query}`);
    output.textContent = JSON.stringify(result, null, 2);
    toast(result.ok ? `OAuth 网络可访问，耗时 ${result.elapsedMs}ms` : `OAuth 网络不可用：${result.error || "unknown"}`);
  } finally {
    btn.disabled = false;
  }
}

async function probeOaDirect() {
  const output = $("#oa-probe-result");
  output.classList.remove("hidden");
  output.textContent = "正在直连测试 auth.openai.com 网络...";
  const result = await api("/api/oa/probe?target=oauth&direct=1");
  output.textContent = JSON.stringify(result, null, 2);
  toast(result.ok ? `直连可访问，耗时 ${result.elapsedMs}ms` : `直连不可用：${result.error || "unknown"}`);
}

function buildOaProbeQuery(proxyUrl) {
  const value = String(proxyUrl || "").trim();
  if (value.toLowerCase() === "direct") return "?target=oauth&direct=1";
  return value
    ? `?target=oauth&proxyUrl=${encodeURIComponent(value)}`
    : "?target=oauth";
}

async function assertOaNetworkReady(proxyUrl) {
  const output = $("#oa-probe-result");
  output.classList.remove("hidden");
  output.textContent = "创建任务前正在检测 auth.openai.com 网络...";
  const result = await api(`/api/oa/probe${buildOaProbeQuery(proxyUrl)}`);
  output.textContent = JSON.stringify(result, null, 2);
  if (!result.ok) {
    const reason = result.timedOut
      ? `当前代理连接 OAuth 超时（${result.elapsedMs}ms）`
      : (result.status === 403 || result.blocked ? "OAuth 返回 403，当前网络/代理被拒绝" : (result.error || `HTTP ${result.status || "unknown"}`));
    throw new Error(`${reason}，已阻止创建任务，请更换 OA 登录代理后再试`);
  }
  return result;
}

async function saveOaProxy() {
  const proxyUrl = ($("#oaProxyUrl")?.value || "").trim();
  const data = await api("/api/config/oa-proxy", {
    method: "PATCH",
    body: JSON.stringify({proxyUrl}),
  });
  configCache = data;
  renderTargetConfig(data);
  toast(proxyUrl ? "OA 默认代理已保存" : "OA 默认代理已清空，将直连");
}

$("#open-import").addEventListener("click", openImportModal);
$("#open-email-pool").addEventListener("click", openEmailListModal);
$("#open-duck-mail")?.addEventListener("click", openDuckMailModal);
$("#open-at-pool")?.addEventListener("click", openAtListModal);
$("#open-email-picker")?.addEventListener("click", openEmailListModal);
$("#open-at-picker")?.addEventListener("click", openAtListModal);
$("#email-pool-stat").addEventListener("click", openEmailListModal);
$("#email-pool-stat").addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    openEmailListModal();
  }
});
$("#at-pool-stat")?.addEventListener("click", openAtListModal);
$("#at-pool-stat")?.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    openAtListModal();
  }
});
$("#reload-emails").addEventListener("click", () => loadEmails().catch((error) => toast(error.message)));
$("#reload-ats").addEventListener("click", () => loadAts().catch((error) => toast(error.message)));
$("#refresh-tasks").addEventListener("click", () => loadTasks().catch((error) => toast(error.message)));
$("#probe-oa-proxy").addEventListener("click", () => probeOaProxy().catch((error) => toast(error.message)));
$("#probe-oa-direct").addEventListener("click", () => probeOaDirect().catch((error) => toast(error.message)));
$("#save-oa-proxy").addEventListener("click", () => saveOaProxy().catch((error) => toast(error.message)));
$("#oaTarget")?.addEventListener("change", renderTargetPanels);
$("#open-target-settings")?.addEventListener("click", openTargetSettingsModal);
$("#duckMode")?.addEventListener("change", syncDuckModePanels);
$("#duck-mail-form")?.addEventListener("submit", (event) => saveDuckMailConfig(event).catch((error) => toast(error.message)));
$("#generate-duck-mail")?.addEventListener("click", () => generateDuckMailEmails().catch((error) => toast(error.message)));
$("#clear-selected-emails")?.addEventListener("click", () => {
  selectedEmailSet.clear();
  renderSelectedEmailSummary();
  toast("已清空邮箱选择，将自动分配");
});
$("#clear-selected-ats")?.addEventListener("click", () => {
  selectedAtSet.clear();
  renderSelectedAtSummary();
  toast("已清空号码选择，将自动分配");
});

document.querySelectorAll("[data-close-target-settings]").forEach((el) => el.addEventListener("click", closeTargetSettingsModal));
document.querySelectorAll("[data-close-import]").forEach((el) => el.addEventListener("click", closeImportModal));
document.querySelectorAll("[data-close-duck-mail]").forEach((el) => el.addEventListener("click", closeDuckMailModal));
document.querySelectorAll("[data-close-task]").forEach((el) => el.addEventListener("click", closeTaskModal));
document.querySelectorAll("[data-close-email]").forEach((el) => el.addEventListener("click", closeEmailModal));
document.querySelectorAll("[data-close-email-list]").forEach((el) => el.addEventListener("click", closeEmailListModal));
document.querySelectorAll("[data-close-at-list]").forEach((el) => el.addEventListener("click", closeAtListModal));

$("#import-btn").addEventListener("click", async () => {
  const text = $("#import-text").value;
  const filePath = $("#import-file-path")?.value || "";
  const mailApiBaseUrl = $("#mail-api-base-url")?.value || "";
  try {
    const result = await api("/api/oa/emails/import", {
      method: "POST",
      body: JSON.stringify({text, filePath, mailApiBaseUrl}),
    });
    const invalid = Number(result.invalid || 0);
    const updated = Number(result.updated || 0);
    const needsBase = result.needsMailApiBaseUrl ? "；四段邮箱未组装，请填写接码 API 域名后点“按域名修复现有邮箱池”" : "";
    const message = invalid
      ? `导入完成：新增 ${result.added}，更新 ${updated}，跳过 ${result.skipped}，无效 ${invalid}${needsBase}。${(result.invalidSamples || [])[0] || ""}`
      : `导入完成：新增 ${result.added}，更新 ${updated}，跳过 ${result.skipped}${needsBase}`;
    toast(message);
    if (result.added > 0 || updated > 0 || result.skipped > 0) {
      if ($("#import-file-path")) $("#import-file-path").value = "";
      $("#import-text").value = "";
      closeImportModal();
    }
    await Promise.all([loadEmails(), loadConfig()]);
  } catch (error) {
    toast(error.message);
  }
});

$("#rebase-btn").addEventListener("click", async () => {
  const mailApiBaseUrl = $("#mail-api-base-url")?.value || "";
  try {
    const result = await api("/api/oa/emails/rebase", {
      method: "POST",
      body: JSON.stringify({mailApiBaseUrl}),
    });
    toast(`修复完成：更新 ${result.updated}，跳过 ${result.skipped}，无效 ${result.invalid}`);
    await Promise.all([loadEmails(), loadConfig()]);
  } catch (error) {
    toast(error.message);
  }
});

$("#task-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const body = Object.fromEntries(form.entries());
  body.count = Number(body.count || 1);
  body.concurrency = Number(body.concurrency || 1);
  body.removeTokenOnSuccess = $("#removeTokenOnSuccess").checked;
  const selectedAts = selectedAtItems().map((item) => item.hash);
  const selectedEmails = selectedEmailItems().map((item) => item.email);
  if (selectedAts.length && selectedEmails.length && selectedAts.length !== selectedEmails.length) {
    toast(`已选号码 ${selectedAts.length} 个、邮箱 ${selectedEmails.length} 个，数量需要一致`);
    return;
  }
  if (selectedAts.length) {
    body.tokenHashes = selectedAts;
    body.count = selectedAts.length;
  }
  if (selectedEmails.length) {
    body.emails = selectedEmails;
    body.count = selectedEmails.length;
  }
  try {
    await assertOaNetworkReady(body.oaProxyUrl || "");
  } catch (error) {
    toast(error.message);
    return;
  }
  const result = await api("/api/oa/tasks", {
    method: "POST",
    body: JSON.stringify(body),
  });
  toast(`已创建 ${result.tasks?.length || 0} 个 OA 接入任务`);
  selectedAtSet.clear();
  selectedEmailSet.clear();
  await Promise.all([loadEmails(), loadAts(), loadTasks()]);
});

if ($("#sub2api-form")) {
  $("#sub2api-form").addEventListener("submit", (event) => saveSub2ApiConfig(event).catch((error) => toast(error.message)));
}

if ($("#cpa-form")) {
  $("#cpa-form").addEventListener("submit", (event) => saveCpaConfig(event).catch((error) => toast(error.message)));
}

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  closeTargetSettingsModal();
  closeImportModal();
  closeDuckMailModal();
  closeTaskModal();
  closeEmailModal();
  closeEmailListModal();
  closeAtListModal();
});

async function init() {
  await Promise.all([loadEmails(), loadAts(), loadTasks(), loadConfig()]);
}

init().catch((error) => toast(error.message));
setInterval(() => loadTasks().catch(() => undefined), 3000);
setInterval(() => loadAts().catch(() => undefined), 10000);
