const $ = (selector) => document.querySelector(selector);

let ats = [];
let jobs = [];
let selectedHashes = new Set();
let selectedJobId = "";
let checkingHashes = new Set();
const PLUS_JOB_DRAFT_KEY = "codex-plus-job-form:v1";
const PLUS_JOB_DRAFT_FIELDS = ["paypalPhone", "clientRef", "smsApi", "proxyJp"];

function toast(message) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 2800);
}

function setButtonBusy(button, busy, text = "") {
  if (!button) return;
  if (!button.dataset.idleText) button.dataset.idleText = button.textContent;
  button.disabled = busy;
  button.classList.toggle("busy", busy);
  button.textContent = busy ? text || "检测中..." : button.dataset.idleText;
}

function setCheckProgress(message = "") {
  const el = $("#check-progress");
  if (!el) return;
  el.textContent = message;
  el.classList.toggle("hidden", !message);
}

function readPlusJobDraft() {
  try {
    return JSON.parse(localStorage.getItem(PLUS_JOB_DRAFT_KEY) || "{}");
  } catch {
    return {};
  }
}

function savePlusJobDraft() {
  const draft = {};
  for (const id of PLUS_JOB_DRAFT_FIELDS) {
    const input = $(`#${id}`);
    if (input) draft[id] = input.value;
  }
  const removeTokenInput = $("#removeTokenOnSuccess");
  if (removeTokenInput) draft.removeTokenOnSuccess = removeTokenInput.checked;

  try {
    localStorage.setItem(PLUS_JOB_DRAFT_KEY, JSON.stringify(draft));
    setPlusJobDraftStatus("已自动缓存");
  } catch {
    // Ignore storage failures, e.g. private browsing or disabled storage.
  }
}

function restorePlusJobDraft() {
  const draft = readPlusJobDraft();
  let restored = false;
  for (const id of PLUS_JOB_DRAFT_FIELDS) {
    const input = $(`#${id}`);
    if (input && typeof draft[id] === "string") {
      input.value = draft[id];
      restored = true;
    }
  }
  const removeTokenInput = $("#removeTokenOnSuccess");
  if (removeTokenInput && typeof draft.removeTokenOnSuccess === "boolean") {
    removeTokenInput.checked = draft.removeTokenOnSuccess;
    restored = true;
  }
  if (restored) setPlusJobDraftStatus("已恢复上次填写");
}

function bindPlusJobDraftAutosave() {
  const form = $("#job-form");
  if (!form) return;
  form.addEventListener("input", savePlusJobDraft);
  form.addEventListener("change", savePlusJobDraft);
}

function setPlusJobDraftStatus(text) {
  const el = $("#plus-draft-status");
  if (el) el.textContent = text;
}

function clearPlusJobDraft() {
  try {
    localStorage.removeItem(PLUS_JOB_DRAFT_KEY);
  } catch {
    // Ignore storage failures.
  }
  for (const id of PLUS_JOB_DRAFT_FIELDS) {
    const input = $(`#${id}`);
    if (input) input.value = "";
  }
  const removeTokenInput = $("#removeTokenOnSuccess");
  if (removeTokenInput) removeTokenInput.checked = false;
  const otpInput = $("#otp");
  if (otpInput) otpInput.value = "";
  setPlusJobDraftStatus("缓存已清空");
  toast("创建任务表单缓存已清空");
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
  const cls = String(status || "").toLowerCase();
  const map = {
    queued: "排队",
    running: "运行",
    otp_pending: "等 OTP",
    success: "成功",
    failed: "失败",
    expired: "过期",
    eligible: "可试用",
    no_trial: "无试用",
  };
  return `<span class="badge ${cls}">${map[cls] || status || "-"}</span>`;
}

function fmtTime(value) {
  if (!value) return "-";
  return new Date(value).toLocaleString();
}

function shortHash(hash) {
  return hash ? hash.slice(0, 10) : "";
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function findAtForJob(job) {
  if (!job?.tokenHash) return null;
  return ats.find((item) => item.hash === job.tokenHash) || null;
}

function isJobSuccess(job) {
  return String(job?.status || "").toLowerCase() === "success"
    || String(job?.resultCode || "").toUpperCase() === "SUCCESS"
    || Boolean(job?.latest?.result?.success);
}

function plusJobForAt(hash) {
  if (!hash) return null;
  return jobs.find((job) => job.tokenHash === hash && isJobSuccess(job))
    || jobs.find((job) => job.tokenHash === hash)
    || null;
}

function atStatusLabel(item, checking) {
  if (checking) return badge("running");
  const plusJob = plusJobForAt(item.hash);
  if (plusJob && isJobSuccess(plusJob)) return badge("success");
  if (item.expired) return badge("expired");
  return trialLabel(item.trial);
}

function jobAtCell(job) {
  const at = findAtForJob(job);
  const hash = job.tokenHash || at?.hash || "";
  const hashLabel = shortHash(hash);
  const phone = at?.phone || job.tokenPhone || "";
  const email = at?.email || job.tokenEmail || "";
  const title = phone || email || (hashLabel ? `AT #${hashLabel}` : "AT unknown");
  const poolState = at ? "in AT pool" : "not in current AT pool";
  const tooltip = [
    title,
    hash ? `hash=${hash}` : "",
    poolState,
  ].filter(Boolean).join("\n");

  return `
    <div class="at-token-cell ${at ? "" : "missing"}" title="${escapeHtml(tooltip)}">
      <div class="mono at-token-title">${escapeHtml(title)}</div>
    </div>
  `;
}

function trialLabel(trial) {
  if (!trial) return '<span class="muted">未检测</span>';
  const checkedAt = trial.checkedAt ? fmtTime(trial.checkedAt) : "";
  if (trial.error) {
    return `<span class="badge error" title="${trial.error}">检测失败</span>${checkedAt ? `<span class="muted">${checkedAt.split(" ")[1] || checkedAt}</span>` : ""}`;
  }
  const label = trial.eligible === true ? "可试用" : trial.eligible === false ? "无试用" : trial.ok === false ? "不可用" : "已检测";
  const cls = trial.eligible === true ? "ok" : trial.eligible === false || trial.ok === false ? "warn" : "running";
  const detail = trial.message || trial.result_code || trial.status || "";
  return `<span class="badge ${cls}" title="${detail}">${label}</span>${checkedAt ? `<span class="muted">${checkedAt.split(" ")[1] || checkedAt}</span>` : ""}`;
}

function atCard(item) {
  const checked = selectedHashes.has(item.hash) ? "checked" : "";
  const checking = checkingHashes.has(item.hash);
  const title = item.phone || item.email || `AT #${shortHash(item.hash)}`;
  return `
    <label class="at-card ${checked ? "selected" : ""} ${checking ? "checking" : ""}">
      <input type="checkbox" data-hash="${item.hash}" ${checked}>
      <div class="at-card-body">
        <div class="at-card-main">
          <strong class="mono at-phone-value">${escapeHtml(title || "未知账号")}</strong>
        </div>
        <div class="at-meta">
          <span class="mono">${shortHash(item.hash)}</span>
          <span>${item.expiresAt ? fmtTime(item.expiresAt).split(" ")[0] : ""}</span>
          ${atStatusLabel(item, checking)}
        </div>
      </div>
    </label>
  `;
}

function renderAts() {
  $("#at-count").textContent = ats.length;
  $("#selected-count").textContent = selectedHashes.size;
  $("#ats").innerHTML = ats.length
    ? ats.map(atCard).join("")
    : `<div class="empty">AT 池为空，点击“导入”添加 AT。</div>`;

  document.querySelectorAll("#ats input[type=checkbox]").forEach((box) => {
    box.addEventListener("change", () => {
      if (box.checked) selectedHashes.add(box.dataset.hash);
      else selectedHashes.delete(box.dataset.hash);
      renderAts();
    });
  });
}

async function loadAts() {
  const data = await api("/api/ats");
  ats = data.items || [];
  $("#token-file").textContent = data.tokenFile || "";
  selectedHashes = new Set([...selectedHashes].filter((hash) => ats.some((item) => item.hash === hash)));
  renderAts();
  if (jobs.length) renderJobs();
}

async function copyText(text, label = "内容") {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
  } else {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.left = "-9999px";
    document.body.appendChild(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  }
  toast(`${label}已复制`);
}

function renderAtFullList(items) {
  $("#at-full-count").textContent = String(items.length);
  $("#at-full-list").innerHTML = items.length
    ? items.map((item) => `
      <div class="at-full-row">
        <div class="at-full-main">
          <div class="row spread">
            <strong>${escapeHtml(item.phone || item.email || `AT #${shortHash(item.hash)}`)}</strong>
            ${atStatusLabel(item, checkingHashes.has(item.hash))}
          </div>
          <div class="at-full-meta">
            <span class="mono">#${escapeHtml(shortHash(item.hash))}</span>
            <span>${item.expiresAt ? escapeHtml(fmtTime(item.expiresAt)) : "-"}</span>
            <span class="mono truncate">${escapeHtml(item.preview || "")}</span>
          </div>
          <textarea class="at-token-text mono" readonly>${escapeHtml(item.token || "")}</textarea>
        </div>
        <div class="at-full-actions">
          <button class="small" type="button" data-copy-at="${escapeHtml(item.hash)}">复制 AT</button>
          <button class="small" type="button" data-select-at="${escapeHtml(item.hash)}">选中</button>
        </div>
      </div>
    `).join("")
    : `<div class="empty">AT 池为空</div>`;

  document.querySelectorAll("[data-copy-at]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const item = items.find((entry) => entry.hash === btn.dataset.copyAt);
      if (item?.token) await copyText(item.token, "AT");
    });
  });

  document.querySelectorAll("[data-select-at]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const hash = btn.dataset.selectAt;
      if (hash) selectedHashes.add(hash);
      renderAts();
      renderJobs();
      toast("已在左侧选中该 AT");
    });
  });
}

async function openAtListModal() {
  $("#at-list-modal").classList.remove("hidden");
  $("#at-full-list").innerHTML = `<div class="empty">正在加载 AT...</div>`;
  const data = await api("/api/ats/full");
  $("#at-full-token-file").textContent = data.tokenFile || "";
  $("#copy-all-ats").dataset.tokens = (data.items || []).map((item) => item.token).filter(Boolean).join("\n");
  renderAtFullList(data.items || []);
}

function closeAtListModal() {
  $("#at-list-modal").classList.add("hidden");
}

function jobRow(job) {
  const action = job.otpPending
    ? `<div class="row otp-row"><input class="otp-input" data-otp-for="${job.localId}" placeholder="OTP"><button class="small" data-submit-otp="${job.localId}">提交</button></div>`
    : "";
  const del = isJobSuccess(job)
    ? ""
    : `<button class="danger small" data-delete="${job.localId}">删除</button>`;
  return `
    <tr class="selectable ${job.localId === selectedJobId ? "selected" : ""}" data-job="${job.localId}">
      <td>${badge(job.status)}</td>
      <td>
        <div class="task-main mono">${job.jobId}</div>
        <div class="muted">${job.clientRef}</div>
        <div class="muted">${fmtTime(job.updatedAt)}</div>
      </td>
      <td>${job.paypalPhone}</td>
      <td>${jobAtCell(job)}</td>
      <td>
        <div>${job.resultCode || "-"}</div>
        <div class="muted">${job.billingStatus || ""}</div>
        <div class="muted error-text">${job.errorMessage || job.error || ""}</div>
      </td>
      <td>
        <div class="row actions">
          <button class="small" data-open-job="${job.localId}">详情</button>
          <button class="small" data-refresh="${job.localId}">刷新</button>
          ${del}
        </div>
        ${action}
      </td>
    </tr>
  `;
}

function renderJobs() {
  $("#jobs").innerHTML = jobs.length
    ? jobs.map(jobRow).join("")
    : `<tr><td colspan="6"><div class="empty">暂无升级任务</div></td></tr>`;
  bindJobActions();
}

async function loadJobs() {
  const data = await api("/api/plus/jobs");
  jobs = data.jobs || [];
  renderJobs();
  if (ats.length) renderAts();
  if (!$("#job-modal").classList.contains("hidden") && selectedJobId) {
    const job = jobs.find((item) => item.localId === selectedJobId);
    if (job) renderJobDetail(job);
  }
}

function renderJobDetail(job) {
  if (!job) return;
  selectedJobId = job.localId;
  $("#job-modal-title").textContent = `任务详情 · ${job.jobId}`;
  $("#job-modal-subtitle").textContent = `${job.status} / ${fmtTime(job.updatedAt)}`;
  $("#job-detail").textContent = JSON.stringify(job, null, 2);
  $("#job-modal").classList.remove("hidden");
  $("#job-detail").scrollTop = 0;
}

function bindJobActions() {
  document.querySelectorAll("tr[data-job]").forEach((row) => {
    row.addEventListener("click", (event) => {
      if (event.target.closest("button") || event.target.closest("input")) return;
      const job = jobs.find((item) => item.localId === row.dataset.job);
      renderJobDetail(job);
    });
  });

  document.querySelectorAll("[data-open-job]").forEach((btn) => {
    btn.addEventListener("click", (event) => {
      event.stopPropagation();
      const job = jobs.find((item) => item.localId === btn.dataset.openJob);
      renderJobDetail(job);
    });
  });

  document.querySelectorAll("[data-refresh]").forEach((btn) => {
    btn.addEventListener("click", async (event) => {
      event.stopPropagation();
      await api(`/api/plus/jobs/${btn.dataset.refresh}/refresh`, {method: "POST", body: "{}"});
      await loadJobs();
    });
  });

  document.querySelectorAll("[data-delete]").forEach((btn) => {
    btn.addEventListener("click", async (event) => {
      event.stopPropagation();
      await api(`/api/plus/jobs/${btn.dataset.delete}`, {method: "DELETE"});
      if (selectedJobId === btn.dataset.delete) closeJobModal();
      toast("任务已删除");
      await loadJobs();
    });
  });

  document.querySelectorAll("[data-submit-otp]").forEach((btn) => {
    btn.addEventListener("click", async (event) => {
      event.stopPropagation();
      const id = btn.dataset.submitOtp;
      const input = document.querySelector(`[data-otp-for="${id}"]`);
      await api(`/api/plus/jobs/${id}/otp`, {
        method: "POST",
        body: JSON.stringify({pin: input.value}),
      });
      toast("OTP 已提交");
      await loadJobs();
    });
  });
}

async function loadAccount() {
  try {
    const data = await api("/api/plus/account");
    const remaining = data.quota_remaining ?? "-";
    const used = data.quota_used ?? "-";
    $("#account").textContent = `额度 ${remaining} / 已用 ${used}`;
  } catch (error) {
    $("#account").textContent = `PPXY: ${error.message}`;
    $("#account").classList.add("error");
  }
}

async function loadConfig() {
  const data = await api("/api/config");
  $("#ppxy-config").textContent = JSON.stringify(data.ppxy, null, 2);
  if (data.ppxy?.proxyJp && !$("#proxyJp").value) {
    $("#proxyJp").placeholder = data.ppxy.proxyJp;
  }
}

function openImportModal() {
  $("#import-modal").classList.remove("hidden");
  $("#import-text").focus();
}

function closeImportModal() {
  $("#import-modal").classList.add("hidden");
}

function closeJobModal() {
  $("#job-modal").classList.add("hidden");
  selectedJobId = "";
}

$("#open-import").addEventListener("click", openImportModal);
$("#open-at-list").addEventListener("click", () => openAtListModal().catch((error) => toast(error.message)));
document.querySelectorAll("[data-close-import]").forEach((el) => el.addEventListener("click", closeImportModal));
document.querySelectorAll("[data-close-at-list]").forEach((el) => el.addEventListener("click", closeAtListModal));
document.querySelectorAll("[data-close-job]").forEach((el) => el.addEventListener("click", closeJobModal));

$("#copy-all-ats").addEventListener("click", async () => {
  const tokens = $("#copy-all-ats").dataset.tokens || "";
  if (!tokens.trim()) return toast("没有可复制的 AT");
  await copyText(tokens, "全部 AT");
});

$("#import-btn").addEventListener("click", async () => {
  const text = $("#import-text").value;
  const result = await api("/api/ats/import", {
    method: "POST",
    body: JSON.stringify({text}),
  });
  toast(`导入完成：新增 ${result.added}，跳过 ${result.skipped}`);
  $("#import-text").value = "";
  closeImportModal();
  await loadAts();
});

$("#reload-ats").addEventListener("click", () => loadAts().catch((error) => toast(error.message)));
$("#refresh-jobs").addEventListener("click", () => loadJobs().catch((error) => toast(error.message)));
$("#clear-plus-draft").addEventListener("click", clearPlusJobDraft);

$("#check-selected").addEventListener("click", async () => {
  if (!selectedHashes.size) return toast("先选择 AT");
  for (const hash of selectedHashes) {
    toast(`检测 ${hash.slice(0, 8)}...`);
    await api(`/api/ats/${hash}/check-trial`, {method: "POST", body: "{}"});
    await loadAts();
  }
  toast("试用检测完成");
});

$("#delete-selected").addEventListener("click", async () => {
  if (!selectedHashes.size) return toast("先选择 AT");
  for (const hash of [...selectedHashes]) {
    await api(`/api/ats/${hash}`, {method: "DELETE"});
    selectedHashes.delete(hash);
  }
  toast("已删除选中 AT");
  await loadAts();
});

$("#job-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!selectedHashes.size) return toast("先在 AT 池选择一个或多个 AT");
  const form = new FormData(event.currentTarget);
  const base = Object.fromEntries(form.entries());
  base.removeTokenOnSuccess = $("#removeTokenOnSuccess").checked;
  savePlusJobDraft();
  const hashes = [...selectedHashes];
  for (const hash of hashes) {
    const body = {...base, tokenHash: hash};
    await api("/api/plus/jobs", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }
  toast(`已创建 ${hashes.length} 个升级任务`);
  await loadJobs();
});

$("#check-selected").addEventListener("click", async (event) => {
  event.preventDefault();
  event.stopImmediatePropagation();
  if (!selectedHashes.size) return toast("先选择 AT");

  const button = $("#check-selected");
  const hashes = [...selectedHashes];
  let ok = 0;
  let failed = 0;

  setButtonBusy(button, true, `检测中 0/${hashes.length}`);
  try {
    for (const [index, hash] of hashes.entries()) {
      checkingHashes = new Set([hash]);
      setCheckProgress(`正在检测 ${index + 1}/${hashes.length}：${hash.slice(0, 10)}...`);
      renderAts();

      try {
        await api(`/api/ats/${hash}/check-trial`, {method: "POST", body: "{}"});
        ok += 1;
      } catch (error) {
        failed += 1;
        toast(`检测失败 ${hash.slice(0, 8)}：${error.message}`);
      }

      await loadAts();
      setButtonBusy(button, true, `检测中 ${index + 1}/${hashes.length}`);
    }

    const summary = failed ? `试用检测完成：成功 ${ok}，失败 ${failed}` : `试用检测完成：${ok}/${hashes.length}`;
    setCheckProgress(summary);
    toast(summary);
  } finally {
    checkingHashes = new Set();
    renderAts();
    setButtonBusy(button, false);
    setTimeout(() => {
      if (!checkingHashes.size) setCheckProgress("");
    }, 5000);
  }
}, true);

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  closeImportModal();
  closeAtListModal();
  closeJobModal();
});

async function init() {
  restorePlusJobDraft();
  bindPlusJobDraftAutosave();
  await Promise.all([loadAts(), loadJobs(), loadAccount(), loadConfig()]);
}

init().catch((error) => toast(error.message));
setInterval(() => loadJobs().catch(() => undefined), 5000);
setInterval(() => loadAts().catch(() => undefined), 10000);
