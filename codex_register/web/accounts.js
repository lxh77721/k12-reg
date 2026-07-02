const state = {
  accounts: [],
  workflows: [],
  filter: '',
  typeFilter: 'all',
};

const TYPE_FILTERS = [
  {key: 'all', label: '全部'},
  {key: 'at', label: 'AT号'},
  {key: 'rt', label: 'RT号'},
  {key: 'free', label: 'Free'},
  {key: 'plus', label: 'Plus'},
];

const $ = (selector) => document.querySelector(selector);

function toast(message, type = 'info') {
  const el = $('#toast');
  if (!el) return;
  el.textContent = message;
  el.className = `toast show ${type}`;
  setTimeout(() => el.className = 'toast', 2600);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: {'Content-Type': 'application/json', ...(options.headers || {})},
    ...options,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function fmt(value) {
  return value == null || value === '' ? '-' : String(value);
}

function shortHash(value) {
  if (!value) return '-';
  const text = String(value);
  return text.length > 18 ? `${text.slice(0, 10)}...${text.slice(-6)}` : text;
}

function fmtTime(value) {
  if (!value) return '-';
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

function statusBadge(status) {
  const value = status || 'unknown';
  const ok = ['free', 'at_ready', 'plus_success', 'email_bound', 'oa_success', 'success'].includes(value);
  const bad = ['failed', 'plus_failed', 'oa_failed'].includes(value);
  const wait = ['registered', 'plus_pending', 'oa_pending', 'queued', 'running', 'awaiting_plus_otp'].includes(value);
  const cls = bad ? 'bad' : ok ? 'ok' : wait ? 'wait' : '';
  return `<span class="badge ${cls}">${value}</span>`;
}

function renderSummary(summary = {}) {
  const free = summary.statuses?.free || 0;
  $('#account-summary').innerHTML = `
    <div class="stat"><div class="label">账号</div><div class="value">${summary.total || 0}</div></div>
    <div class="stat"><div class="label">Free 完成</div><div class="value">${free}</div></div>
    <div class="stat"><div class="label">带手机号</div><div class="value">${summary.withPhone || 0}</div></div>
    <div class="stat"><div class="label">有 AT</div><div class="value">${summary.withAccessToken || 0}</div></div>
    <div class="stat"><div class="label">Plus 成功</div><div class="value">${summary.plusSuccess || 0}</div></div>
    <div class="stat"><div class="label">OA 成功</div><div class="value">${summary.oaSuccess || 0}</div></div>
  `;
}

function isEmptyRegisterFailure(account) {
  const registerStatus = account.register?.status;
  const terminalRegisterFailed = registerStatus === 'failed'
    || registerStatus === 'canceled'
    || account.status === 'failed';
  return terminalRegisterFailed
    && !account.phone
    && !account.accessToken?.hash
    && !account.plus
    && !account.emailBinding?.email
    && !account.oa;
}

function ledgerAccounts() {
  return state.accounts.filter((account) => !isEmptyRegisterFailure(account));
}

function summaryFor(accounts) {
  const statuses = {};
  for (const account of accounts) {
    statuses[account.status] = (statuses[account.status] || 0) + 1;
  }
  return {
    total: accounts.length,
    statuses,
    withPhone: accounts.filter((account) => Boolean(account.phone)).length,
    withAccessToken: accounts.filter((account) => Boolean(account.accessToken?.hash)).length,
    plusSuccess: accounts.filter((account) =>
      account.plus?.status?.toLowerCase() === 'success'
      || account.plus?.resultCode?.toUpperCase() === 'SUCCESS'
    ).length,
    oaSuccess: accounts.filter((account) => account.oa?.status === 'success').length,
  };
}

function isPlusAccount(account) {
  return account.status === 'plus_success'
    || account.status === 'plus_pending'
    || account.status === 'plus_failed'
    || Boolean(account.plus);
}

function hasBoundEmail(account) {
  return account.emailBinding?.status === 'bound'
    || account.oa?.status === 'success';
}

function isFreeAccount(account) {
  return account.status === 'free'
    || (account.free && !isPlusAccount(account));
}

function isRtAccount(account) {
  return Boolean(account.phone && hasBoundEmail(account));
}

function isAtAccount(account) {
  return Boolean(account.accessToken?.hash && !hasBoundEmail(account));
}

function matchesTypeFilter(account, key) {
  if (key === 'at') return isAtAccount(account);
  if (key === 'rt') return isRtAccount(account);
  if (key === 'free') return isFreeAccount(account);
  if (key === 'plus') return isPlusAccount(account);
  return true;
}

function countType(accounts, key) {
  if (key === 'all') return accounts.length;
  return accounts.filter((account) => matchesTypeFilter(account, key)).length;
}

function renderTypeFilter(accounts) {
  const el = $('#account-type-filter');
  if (!el) return;
  el.innerHTML = TYPE_FILTERS.map((item) => `
    <button type="button" data-account-type="${item.key}" class="${state.typeFilter === item.key ? 'active' : ''}">
      ${item.label}<b>${countType(accounts, item.key)}</b>
    </button>
  `).join('');
  el.querySelectorAll('[data-account-type]').forEach((button) => {
    button.addEventListener('click', () => {
      state.typeFilter = button.dataset.accountType || 'all';
      renderAccounts();
      renderTypeFilter(ledgerAccounts());
    });
  });
}

function accountSearchText(account) {
  return [
    account.id,
    account.status,
    account.phone,
    account.accessToken?.hash,
    account.accessToken?.preview,
    account.emailBinding?.email,
    account.oa?.account,
    account.oa?.sub2apiAccount,
    account.oa?.cpaAccount,
    account.plus?.localId,
    account.plus?.remoteJobId,
  ].filter(Boolean).join(' ').toLowerCase();
}

function filteredAccounts() {
  const filter = state.filter.trim().toLowerCase();
  const accounts = ledgerAccounts().filter((account) => matchesTypeFilter(account, state.typeFilter));
  if (!filter) return accounts;
  return accounts.filter((account) => accountSearchText(account).includes(filter));
}

function renderAccessTokenState(at) {
  if (!at?.hash) return '';
  if (at.active === false) return '已移除';
  if (at.expired) return '已过期';
  return 'active';
}

function renderAccounts() {
  const rows = filteredAccounts();
  $('#accounts').innerHTML = rows.length ? rows.map((account) => {
    const at = account.accessToken;
    const plus = account.plus;
    const email = account.emailBinding;
    const oa = account.oa;
    return `
      <tr class="clickable-row" data-id="${account.id}">
        <td>${statusBadge(account.status)}<div class="muted mono tiny">${account.id}</div></td>
        <td class="mono">${fmt(account.phone)}</td>
        <td>
          <div class="mono">${shortHash(at?.hash)}</div>
          <div class="muted tiny">${renderAccessTokenState(at)}</div>
        </td>
        <td>
          <div>${plus ? statusBadge(plus.status) : '-'}</div>
          <div class="muted tiny">${plus?.resultCode || plus?.billingStatus || plus?.localId || ''}</div>
        </td>
        <td>
          <div>${fmt(email?.email)}</div>
          <div class="muted tiny">${email?.status || ''}</div>
        </td>
        <td>
          <div>${oa ? statusBadge(oa.status) : '-'}</div>
          <div class="muted tiny">${oa?.target || ''} ${oa?.account || oa?.sub2apiAccount || oa?.cpaAccount || ''}</div>
        </td>
        <td>${fmtTime(account.updatedAt)}</td>
      </tr>
    `;
  }).join('') : `<tr><td colspan="7" class="empty-cell">暂无账户台账。点击“历史补账”生成。</td></tr>`;

  document.querySelectorAll('[data-id]').forEach((row) => {
    row.addEventListener('click', () => openAccount(row.dataset.id));
  });
}

function renderWorkflows() {
  $('#workflows').innerHTML = state.workflows.length ? state.workflows.map((wf) => `
    <div class="workflow-item">
      <div class="workflow-top">
        ${statusBadge(wf.status)}
        <span class="mono tiny">${wf.runId}</span>
      </div>
      <div class="muted tiny">step=${wf.step} target=${wf.target} phone=${wf.phone || '-'}</div>
      <div class="muted tiny">AT=${shortHash(wf.tokenHash)} email=${wf.bindEmail || '-'}</div>
      ${wf.error ? `<div class="error-text tiny">${wf.error}</div>` : ''}
    </div>
  `).join('') : '<div class="muted">暂无 workflow。</div>';
}

async function loadAccounts() {
  const data = await api('/api/accounts');
  state.accounts = data.accounts || [];
  const accounts = ledgerAccounts();
  renderSummary(summaryFor(accounts));
  renderTypeFilter(accounts);
  renderAccounts();
}

async function loadWorkflows() {
  const data = await api('/api/workflows');
  state.workflows = data.workflows || [];
  renderWorkflows();
}

async function refreshAll() {
  await Promise.all([loadAccounts(), loadWorkflows()]);
}

async function openAccount(id) {
  const data = await api(`/api/accounts/${encodeURIComponent(id)}`);
  $('#account-detail').textContent = JSON.stringify(data.account, null, 2);
  $('#account-modal').classList.remove('hidden');
}

function closeModal() {
  $('#account-modal').classList.add('hidden');
}

async function reconcile() {
  const button = $('#reconcile');
  button.disabled = true;
  button.textContent = '补账中...';
  try {
    const result = await api('/api/reconcile', {method: 'POST', body: '{}'});
    toast(`补账完成：账号 ${result.summary?.total || 0} 个`, 'ok');
    await refreshAll();
  } catch (error) {
    toast(error.message, 'bad');
  } finally {
    button.disabled = false;
    button.textContent = '历史补账';
  }
}

async function createWorkflow(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const plus = $('#plus').checked;
  const body = {
    target: form.target.value,
    plus,
    paypalPhone: form.paypalPhone.value.trim(),
    concurrency: Number(form.concurrency.value || 1),
    removeTokenOnSuccess: form.removeTokenOnSuccess.value === 'true',
  };
  if (plus && !body.paypalPhone) {
    toast('包含 Plus 升级时必须填写 PayPal 手机', 'bad');
    return;
  }
  try {
    const data = await api('/api/workflows/phone-plus-oa', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    toast(`已启动 ${data.workflow.runId}`, 'ok');
    await loadWorkflows();
  } catch (error) {
    toast(error.message, 'bad');
  }
}

function bindEvents() {
  $('#refresh').addEventListener('click', () => refreshAll().catch((error) => toast(error.message, 'bad')));
  $('#refresh-workflows').addEventListener('click', () => loadWorkflows().catch((error) => toast(error.message, 'bad')));
  $('#reconcile').addEventListener('click', reconcile);
  $('#workflow-form').addEventListener('submit', createWorkflow);
  $('#close-modal').addEventListener('click', closeModal);
  $('#account-modal').addEventListener('click', (event) => {
    if (event.target.id === 'account-modal') closeModal();
  });
  $('#account-filter').addEventListener('input', (event) => {
    state.filter = event.target.value;
    renderAccounts();
  });
}

bindEvents();
refreshAll().catch((error) => toast(error.message, 'bad'));
setInterval(() => refreshAll().catch(() => undefined), 10000);
