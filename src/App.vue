<template>
  <main class="page">
    <div class="orb orb-one"></div>
    <div class="orb orb-two"></div>

    <header class="topbar shell">
      <div>
        <p class="eyebrow">K12 Space Automation</p>
        <h1>任务控制台</h1>
        <p class="subtitle">任务列表为主视图；配置、邮箱导入、邮箱池和任务日志都通过弹窗处理。</p>
      </div>
      <div class="top-actions">
        <button class="ghost" @click="refreshAll">刷新</button>
        <button class="ghost" @click="openSettings">设置</button>
      </div>
    </header>

    <section class="overview-grid">
      <article class="stat-card glow">
        <span>任务</span>
        <strong>{{ summary.tasks.total }}</strong>
        <small>运行 {{ summary.tasks.running }} / 队列 {{ summary.tasks.queued }}</small>
      </article>
      <article class="stat-card">
        <span>邮箱池</span>
        <strong>{{ summary.emails.total }}</strong>
        <small>可用 {{ summary.emails.free }} / 失败 {{ summary.emails.failed }}</small>
      </article>
      <article class="stat-card">
        <span>成功</span>
        <strong>{{ summary.tasks.success }}</strong>
        <small>Sub2API 分组：{{ form.sub2apiGroupName || "k12" }}</small>
      </article>
      <article class="stat-card">
        <span>K12 Space</span>
        <strong>{{ workspaceCount }}</strong>
        <small>{{ form.route === "accept" ? "Accept" : "Request" }} 模式</small>
      </article>
    </section>

    <section class="panel task-panel">
      <div class="list-toolbar">
        <div>
          <p class="eyebrow">Tasks</p>
          <h2>任务列表</h2>
          <p class="toolbar-subtitle">点击任务行打开日志弹窗。</p>
        </div>
        <div class="toolbar-actions">
          <label class="field run-count-field">
            <span>本次处理数量</span>
            <input v-model.number="runCount" type="number" min="1" />
          </label>
          <button class="ghost" @click="openEmailImport">邮箱导入</button>
          <button class="ghost" @click="openEmailPool">邮箱池</button>
          <button class="primary" :disabled="!selectedReadyCount || busy" @click="startTasks">
            {{ busy ? "运行中" : `启动 ${selectedReadyCount} 个任务` }}
          </button>
        </div>
      </div>

      <div class="table-wrap task-table-wrap">
        <table class="task-table">
          <thead>
            <tr>
              <th>状态</th>
              <th>邮箱</th>
              <th>动作</th>
              <th>AT</th>
              <th>Sub2API</th>
              <th>K12</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="task in tasks"
              :key="task.id"
              :class="['task-row', { active: selectedTask?.id === task.id }]"
              @click="openTaskLog(task)"
            >
              <td><span :class="['status', task.status]">{{ statusText(task.status) }}</span></td>
              <td>
                <div class="cell-with-action">
                  <span class="mono clipped">{{ task.email }}</span>
                  <button class="ghost tiny" @click.stop="copyText(task.email, '邮箱已复制')">复制</button>
                </div>
              </td>
              <td>{{ task.route }}</td>
              <td>
                <div class="cell-with-action">
                  <span class="mono clipped">{{ task.accessTokenPreview || "pending" }}</span>
                  <button
                    class="ghost tiny"
                    :disabled="!task.accessToken && !task.accessTokenPreview"
                    @click.stop="copyAccessToken(task)"
                  >
                    复制
                  </button>
                </div>
              </td>
              <td class="mono clipped">{{ task.sub2apiAccount || "-" }}</td>
              <td>{{ task.workspaceResults.filter((r) => r.ok).length }}/{{ task.workspaceIds.length }}</td>
              <td>
                <div class="row-actions">
                  <button class="ghost small" @click.stop="openTaskLog(task)">日志</button>
                  <button
                    v-if="task.status === 'queued' || task.status === 'running'"
                    class="danger small"
                    @click.stop="cancelTask(task.id)"
                  >
                    取消
                  </button>
                  <button
                    v-if="canDeleteTask(task)"
                    class="ghost small"
                    @click.stop="retryTask(task.id)"
                  >
                    重试
                  </button>
                  <button
                    v-if="canDeleteTask(task)"
                    class="danger small"
                    @click.stop="deleteTask(task.id)"
                  >
                    删除
                  </button>
                </div>
              </td>
            </tr>
            <tr v-if="!tasks.length">
              <td colspan="7" class="empty">暂无任务。导入邮箱后可从上方启动流程。</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <div v-if="toast" class="toast">{{ toast }}</div>

    <Teleport to="body">
      <div v-if="showSettingsModal" class="modal-backdrop" @click.self="closeSettings">
        <section class="panel modal-card settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title">
          <div class="section-head">
            <div>
              <p class="eyebrow">Settings</p>
              <h2 id="settings-title">Sub2API 和 K12 配置</h2>
            </div>
            <button class="ghost small" @click="closeSettings">关闭</button>
          </div>

          <div class="modal-body settings-body">
            <section class="settings-section">
              <div class="section-head compact-head">
                <div>
                  <p class="eyebrow">K12</p>
                  <h3>K12 空间脚本</h3>
                </div>
                <span class="pill">{{ workspaceCount }} 个 workspace</span>
              </div>
              <label class="field">
                <span>K12 Workspace ID（一行一个或逗号分隔）</span>
                <textarea v-model="workspaceText" class="workspace-box"></textarea>
              </label>
              <div class="switch-grid">
                <label class="switch-card">
                  <input v-model="form.runWorkspaceJoin" type="checkbox" />
                  <span>
                    <strong>执行 K12 空间脚本</strong>
                    <small>使用获取到的 AT 调用 workspace request/accept。</small>
                  </span>
                </label>
                <label class="switch-card">
                  <input v-model="form.runSub2Api" type="checkbox" />
                  <span>
                    <strong>执行 Sub2API 入库</strong>
                    <small>只拿邮箱 OA 到 Sub2API 的流程，分组默认 k12。</small>
                  </span>
                </label>
              </div>
              <div class="compact-grid">
                <label class="field">
                  <span>动作</span>
                  <select v-model="form.route">
                    <option value="request">Request 申请加入</option>
                    <option value="accept">Accept 接受邀请</option>
                  </select>
                </label>
                <label class="field">
                  <span>并发</span>
                  <input v-model.number="form.taskConcurrency" type="number" min="1" max="10" />
                </label>
                <label class="field">
                  <span>间隔 ms</span>
                  <input v-model.number="form.joinIntervalMs" type="number" min="0" />
                </label>
              </div>
              <label class="field">
                <span>默认 OpenAI 代理</span>
                <input v-model="form.defaultProxyUrl" placeholder="direct 或 http://127.0.0.1:7897" />
              </label>
            </section>

            <section class="settings-section">
              <div class="section-head compact-head">
                <div>
                  <p class="eyebrow">Sub2API</p>
                  <h3>入库配置</h3>
                </div>
              </div>
              <div class="config-grid">
                <label class="field">
                  <span>Sub2API 地址</span>
                  <input v-model="form.sub2apiUrl" placeholder="https://your-sub2api" />
                </label>
                <label class="field">
                  <span>账号</span>
                  <input v-model="form.sub2apiEmail" placeholder="admin@example.com" />
                </label>
                <label class="field">
                  <span>密码</span>
                  <input v-model="form.sub2apiPassword" type="password" :placeholder="passwordPlaceholder" />
                </label>
                <label class="field">
                  <span>分组</span>
                  <input v-model="form.sub2apiGroupName" placeholder="k12" />
                </label>
                <label class="field">
                  <span>Token 输出文件</span>
                  <input v-model="form.tokenOut" />
                </label>
              </div>
            </section>
          </div>

          <div class="modal-footer">
            <p class="hint">配置默认从本项目 <code>codex_register/config.json</code> 读取，保存后写入本项目 <code>data/config.json</code>。</p>
            <button class="primary" :disabled="savingConfig" @click="saveConfig">
              {{ savingConfig ? "保存中..." : "保存配置" }}
            </button>
          </div>
        </section>
      </div>

      <div v-if="showEmailImportModal" class="modal-backdrop" @click.self="closeEmailImport">
        <section class="panel modal-card import-modal" role="dialog" aria-modal="true" aria-labelledby="email-import-title">
          <div class="section-head">
            <div>
              <p class="eyebrow">Import</p>
              <h2 id="email-import-title">邮箱导入</h2>
            </div>
            <div class="modal-actions">
              <button class="ghost small" @click="sampleEmails">示例</button>
              <button class="ghost small" @click="closeEmailImport">关闭</button>
            </div>
          </div>
          <div class="modal-body import-body">
            <label class="field">
              <span>选择邮箱文件（txt）</span>
              <input type="file" accept=".txt,text/plain" @change="loadEmailImportFile" />
            </label>
            <textarea
              v-model="emailText"
              placeholder="支持：
email----password----clientId----refreshToken
email-----http://mail-api/api/GetLastEmails?email=..."
            ></textarea>
            <div class="row spread">
              <label class="field inline">
                <span>接码 API 域名</span>
                <input v-model="form.mailApiBaseUrl" placeholder="http://wremail.cc/" />
              </label>
              <div class="row-actions">
                <button class="ghost" :disabled="importingEmails" @click="emailText = ''; importResult = ''">清空</button>
                <button class="primary" :disabled="!emailText.trim() || importingEmails" @click="importEmails">
                  {{ importingEmails ? "导入中..." : "导入邮箱" }}
                </button>
              </div>
            </div>
            <pre v-if="importResult">{{ importResult }}</pre>
          </div>
        </section>
      </div>

      <div v-if="showEmailPoolModal" class="modal-backdrop" @click.self="closeEmailPool">
        <section class="panel modal-card email-pool-modal" role="dialog" aria-modal="true" aria-labelledby="email-pool-title">
          <div class="section-head">
            <div>
              <p class="eyebrow">Pool List</p>
              <h2 id="email-pool-title">邮箱池列表</h2>
            </div>
            <div class="modal-actions">
              <label class="field split-count-field">
                <span>每个分裂</span>
                <input v-model.number="splitAliasCount" type="number" min="1" max="50" />
              </label>
              <button class="ghost small" :disabled="!selectableParentEmails.length" @click="selectParentEmails">
                只选母邮箱 {{ selectableParentEmails.length }}
              </button>
              <button class="primary small" :disabled="!selectedRunnableEmailIds.length" @click="startSelectedEmailTasks">
                启动选中 {{ selectedRunnableEmailIds.length }}
              </button>
              <button class="ghost small" :disabled="!selectedEmailIds.length" @click="splitSelectedEmails">
                分裂选中 x{{ splitAliasCount || 4 }}
              </button>
              <button class="danger small" :disabled="!selectedEmailIds.length" @click="deleteSelectedEmails">
                删除选中 {{ selectedEmailIds.length }}
              </button>
              <button class="danger small" :disabled="!summary.emails.failed" @click="deleteEmailsByStatus('failed')">删除失败</button>
              <button class="danger small" :disabled="!summary.emails.free" @click="deleteEmailsByStatus('free')">删除空闲</button>
              <button class="ghost small" @click="loadEmails">刷新邮箱</button>
              <button class="ghost small" @click="closeEmailPool">关闭</button>
            </div>
          </div>
          <div class="modal-body">
            <div class="pool-status-grid modal-status-grid">
              <div>
                <span>空闲</span>
                <strong>{{ summary.emails.free }}</strong>
              </div>
              <div>
                <span>运行中</span>
                <strong>{{ summary.emails.running }}</strong>
              </div>
              <div>
                <span>成功</span>
                <strong>{{ summary.emails.success }}</strong>
              </div>
              <div>
                <span>失败</span>
                <strong>{{ summary.emails.failed }}</strong>
              </div>
            </div>
            <div class="table-wrap modal-table">
              <table>
                <thead>
                  <tr>
                    <th>
                      <input
                        type="checkbox"
                        :checked="allVisibleEmailsSelected"
                        :disabled="!deletableEmails.length"
                        @change="toggleAllEmails"
                      />
                    </th>
                    <th>邮箱</th>
                    <th>状态</th>
                    <th>接码</th>
                    <th>Sub2API</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="item in emails" :key="item.id">
                    <td>
                      <input
                        type="checkbox"
                        :checked="selectedEmailIds.includes(item.id)"
                        :disabled="item.status === 'running'"
                        @change="toggleEmailSelection(item.id)"
                      />
                    </td>
                    <td>
                      <div class="cell-with-action">
                        <span class="mono clipped">{{ item.email }}</span>
                        <button class="ghost tiny" @click="copyText(item.email, '邮箱已复制')">复制</button>
                      </div>
                      <small v-if="item.parentEmail" class="muted">母邮箱：{{ item.parentEmail }}</small>
                    </td>
                    <td><span :class="['status', item.status]">{{ statusText(item.status) }}</span></td>
                    <td class="muted clipped">{{ item.mailboxUrlMasked }}</td>
                    <td class="mono clipped">{{ item.sub2apiAccount || "-" }}</td>
                    <td><button class="danger small" :disabled="item.status === 'running'" @click="deleteEmail(item.id, item.email)">删除</button></td>
                  </tr>
                  <tr v-if="!emails.length">
                    <td colspan="6" class="empty">还没有邮箱，先在上方导入。</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </section>
      </div>

      <div v-if="showTaskLogModal && selectedTask" class="modal-backdrop" @click.self="closeTaskLog">
        <section class="panel modal-card log-modal" role="dialog" aria-modal="true" aria-labelledby="task-log-title">
          <div class="section-head">
            <div>
              <p class="eyebrow">Logs</p>
              <h2 id="task-log-title">{{ selectedTask.email }}</h2>
            </div>
            <div class="modal-actions">
              <button
                v-if="selectedTask.status === 'queued' || selectedTask.status === 'running'"
                class="danger small"
                @click="cancelTask(selectedTask.id)"
              >
                取消任务
              </button>
              <button
                v-if="canDeleteTask(selectedTask)"
                class="ghost small"
                @click="retryTask(selectedTask.id)"
              >
                重试任务
              </button>
              <button
                v-if="canDeleteTask(selectedTask)"
                class="danger small"
                @click="deleteTask(selectedTask.id)"
              >
                删除任务
              </button>
              <button class="ghost small" @click="closeTaskLog">关闭</button>
            </div>
          </div>
          <div class="modal-body">
            <div class="result-grid">
              <div class="mini-result">
                <span>状态</span>
                <strong>{{ statusText(selectedTask.status) }}</strong>
              </div>
              <div class="mini-result">
                <span>邮箱</span>
                <strong>{{ selectedTask.email }}</strong>
                <button class="ghost tiny" @click="copyText(selectedTask.email, '邮箱已复制')">复制邮箱</button>
              </div>
              <div class="mini-result">
                <span>AT</span>
                <strong>{{ selectedTask.accessTokenPreview || "-" }}</strong>
                <button
                  class="ghost tiny"
                  :disabled="!selectedTask.accessToken && !selectedTask.accessTokenPreview"
                  @click="copyAccessToken(selectedTask)"
                >
                  复制 AT
                </button>
              </div>
              <div class="mini-result">
                <span>Sub2API</span>
                <strong>{{ selectedTask.sub2apiAccount || "-" }}</strong>
              </div>
              <div class="mini-result">
                <span>K12 成功</span>
                <strong>{{ selectedTask.workspaceResults.filter((r) => r.ok).length }}/{{ selectedTask.workspaceIds.length }}</strong>
              </div>
            </div>
            <ol class="logs">
              <li v-for="(log, index) in selectedTask.logs" :key="index" :class="log.level">
                <time>{{ fmtTime(log.at) }}</time>
                <span>{{ log.message }}</span>
              </li>
              <li v-if="!selectedTask.logs.length" class="empty-log">
                <span>暂无日志。</span>
              </li>
            </ol>
          </div>
        </section>
      </div>
    </Teleport>
  </main>
</template>

<script setup lang="ts">
import {computed, onMounted, onUnmounted, reactive, ref} from "vue";

interface EmailItem {
  id: string;
  email: string;
  parentEmail?: string;
  status: string;
  mailboxUrlMasked: string;
  sub2apiAccount?: string;
}

interface TaskItem {
  id: string;
  email: string;
  status: string;
  route: string;
  accessToken?: string;
  accessTokenPreview?: string;
  sub2apiAccount?: string;
  workspaceIds: string[];
  workspaceResults: Array<{ok: boolean}>;
  logs: Array<{at: string; level: string; message: string}>;
}

const defaultSummary = {
  emails: {total: 0, free: 0, running: 0, success: 0, failed: 0},
  tasks: {total: 0, queued: 0, running: 0, success: 0, failed: 0, canceled: 0},
};

const summary = reactive(JSON.parse(JSON.stringify(defaultSummary)));
const emails = ref<EmailItem[]>([]);
const tasks = ref<TaskItem[]>([]);
const selectedTask = ref<TaskItem | null>(null);
const emailText = ref("");
const importResult = ref("");
const importingEmails = ref(false);
const selectedEmailIds = ref<string[]>([]);
const splitAliasCount = ref(4);
const workspaceText = ref("");
const runCount = ref(1);
const toast = ref("");
const savingConfig = ref(false);
const showSettingsModal = ref(false);
const showEmailImportModal = ref(false);
const showEmailPoolModal = ref(false);
const showTaskLogModal = ref(false);
let timer: number | undefined;

const form = reactive({
  defaultPassword: "",
  defaultProxyUrl: "",
  mailApiBaseUrl: "",
  workspaceIds: [] as string[],
  route: "request",
  joinIntervalMs: 1500,
  taskConcurrency: 1,
  runWorkspaceJoin: true,
  runSub2Api: true,
  sub2apiUrl: "",
  sub2apiEmail: "",
  sub2apiPassword: "",
  sub2apiGroupName: "k12",
  sub2apiProxyName: "",
  sub2apiAccountPriority: 1,
  sub2apiConcurrency: 10,
  tokenOut: "",
});

const busy = computed(() => summary.tasks.running > 0 || summary.tasks.queued > 0);
const workspaceCount = computed(() => parseWorkspaceIds(workspaceText.value).length);
const selectedReadyCount = computed(() => Math.min(Math.max(1, Number(runCount.value) || 1), emails.value.filter((item) => item.status === "free").length));
const selectedRunnableEmailIds = computed(() => emails.value
  .filter((item) => selectedEmailIds.value.includes(item.id) && item.status !== "running")
  .map((item) => item.id));
const selectableParentEmails = computed(() => emails.value.filter((item) => !item.parentEmail && item.status !== "running"));
const passwordPlaceholder = computed(() => form.sub2apiPassword ? "已填写" : "留空则不修改已保存密码");
const deletableEmails = computed(() => emails.value.filter((item) => item.status !== "running"));
const allVisibleEmailsSelected = computed(() => deletableEmails.value.length > 0 && deletableEmails.value.every((item) => selectedEmailIds.value.includes(item.id)));

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers || {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

function showToast(message: string) {
  toast.value = message;
  window.setTimeout(() => {
    if (toast.value === message) toast.value = "";
  }, 2600);
}

function parseWorkspaceIds(value: string): string[] {
  return String(value || "")
    .split(/[\n,;，；]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

async function loadSummary() {
  const data = await api<any>("/api/summary");
  Object.assign(summary.emails, data.emails || defaultSummary.emails);
  Object.assign(summary.tasks, data.tasks || defaultSummary.tasks);
}

async function loadConfig() {
  const data = await api<any>("/api/config");
  const config = data.config || {};
  Object.assign(form, {
    defaultProxyUrl: config.defaultProxyUrl || "",
    mailApiBaseUrl: config.mailApiBaseUrl || "",
    workspaceIds: config.workspaceIds || [],
    route: config.route || "request",
    joinIntervalMs: config.joinIntervalMs || 1500,
    taskConcurrency: config.taskConcurrency || 1,
    runWorkspaceJoin: config.runWorkspaceJoin !== false,
    runSub2Api: config.runSub2Api !== false,
    sub2apiUrl: config.sub2apiUrl || "",
    sub2apiEmail: config.sub2apiEmail || "",
    sub2apiPassword: "",
    sub2apiGroupName: config.sub2apiGroupName || "k12",
    sub2apiProxyName: config.sub2apiProxyName || "",
    sub2apiAccountPriority: config.sub2apiAccountPriority || 1,
    sub2apiConcurrency: config.sub2apiConcurrency || 10,
    tokenOut: config.tokenOut || "",
  });
  workspaceText.value = (config.workspaceIds || []).join("\n");
}

async function saveConfig() {
  if (savingConfig.value) return false;
  savingConfig.value = true;
  try {
    const payload = {
      ...form,
      workspaceIds: parseWorkspaceIds(workspaceText.value),
    };
    await api("/api/config", {method: "PATCH", body: JSON.stringify(payload)});
    await Promise.all([loadConfig(), loadSummary()]);
    showSettingsModal.value = false;
    showToast("配置已保存");
    return true;
  } catch (error) {
    showToast(`保存配置失败：${error instanceof Error ? error.message : String(error)}`);
    return false;
  } finally {
    savingConfig.value = false;
  }
}

async function loadEmails() {
  const data = await api<any>("/api/emails");
  emails.value = data.items || [];
  const existingIds = new Set(emails.value.map((item) => item.id));
  selectedEmailIds.value = selectedEmailIds.value.filter((id) => existingIds.has(id));
}

function openSettings() {
  showSettingsModal.value = true;
}

function closeSettings() {
  showSettingsModal.value = false;
}

function openEmailImport() {
  showEmailImportModal.value = true;
}

function closeEmailImport() {
  showEmailImportModal.value = false;
}

async function openEmailPool() {
  showEmailPoolModal.value = true;
  await Promise.all([loadSummary(), loadEmails()]);
}

function closeEmailPool() {
  showEmailPoolModal.value = false;
  selectedEmailIds.value = [];
}

async function loadTasks() {
  const data = await api<any>("/api/tasks");
  tasks.value = data.items || [];
  if (selectedTask.value) {
    selectedTask.value = tasks.value.find((item) => item.id === selectedTask.value?.id) || selectedTask.value;
  } else if (tasks.value.length) {
    selectedTask.value = tasks.value[0];
  }
}

async function refreshAll() {
  await Promise.all([loadSummary(), loadEmails(), loadTasks()]);
}

async function loadEmailImportFile(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  try {
    emailText.value = await file.text();
    importResult.value = "";
    const lineCount = emailText.value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).length;
    showToast(`已读取文件：${file.name}，${lineCount} 行`);
  } catch (error) {
    showToast(`读取文件失败：${error instanceof Error ? error.message : String(error)}`);
  } finally {
    input.value = "";
  }
}

async function importEmails() {
  if (importingEmails.value) return;
  const text = emailText.value.trim();
  if (!text) {
    showToast("请先粘贴邮箱内容或选择 txt 文件");
    return;
  }
  importingEmails.value = true;
  importResult.value = "";
  try {
    const data = await api<any>("/api/emails/import", {
      method: "POST",
      body: JSON.stringify({text, mailApiBaseUrl: form.mailApiBaseUrl}),
    });
    importResult.value = [
      `读取行数：${data.inputLines ?? "-"}`,
      `新增：${data.added ?? 0}`,
      `更新：${data.updated ?? 0}`,
      `本次重复跳过：${data.skipped ?? 0}`,
      `无效：${data.invalid ?? 0}`,
      `邮箱池总数：${data.total ?? 0}`,
      data.invalidSamples?.length ? `无效示例：\n${data.invalidSamples.map((item: string) => `- ${item}`).join("\n")}` : "",
    ].filter(Boolean).join("\n");
    showToast(`导入完成：新增 ${data.added ?? 0}，更新 ${data.updated ?? 0}，无效 ${data.invalid ?? 0}`);
    await refreshAll();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    importResult.value = `导入失败：${message}`;
    showToast(`导入失败：${message}`);
  } finally {
    importingEmails.value = false;
  }
}

function toggleEmailSelection(id: string) {
  selectedEmailIds.value = selectedEmailIds.value.includes(id)
    ? selectedEmailIds.value.filter((item) => item !== id)
    : [...selectedEmailIds.value, id];
}

function toggleAllEmails(event: Event) {
  const checked = (event.target as HTMLInputElement).checked;
  selectedEmailIds.value = checked ? deletableEmails.value.map((item) => item.id) : [];
}

function selectParentEmails() {
  selectedEmailIds.value = selectableParentEmails.value.map((item) => item.id);
  showToast(`已选择母邮箱 ${selectedEmailIds.value.length} 个`);
}

async function splitSelectedEmails() {
  if (!selectedEmailIds.value.length) return;
  const count = Math.max(1, Math.min(50, Number(splitAliasCount.value) || 4));
  const ok = window.confirm(`确认将选中的 ${selectedEmailIds.value.length} 个邮箱按每个 ${count} 个子邮箱分裂？子邮箱会复用母邮箱接码地址。`);
  if (!ok) return;
  const result = await api<any>("/api/emails/split", {
    method: "POST",
    body: JSON.stringify({ids: selectedEmailIds.value, count}),
  });
  selectedEmailIds.value = [];
  showToast(`分裂完成：新增 ${result.created ?? 0} 个子邮箱${result.skipped ? `，跳过 ${result.skipped} 个` : ""}`);
  await refreshAll();
}

async function deleteEmail(id: string, email = "") {
  const ok = window.confirm(`确认删除邮箱 ${email || id}？`);
  if (!ok) return;
  const result = await api<any>(`/api/emails/${encodeURIComponent(id)}`, {method: "DELETE"});
  showToast(`删除完成：删除 ${result.removed ?? 0} 个${result.skippedRunning ? `，跳过运行中 ${result.skippedRunning} 个` : ""}`);
  selectedEmailIds.value = selectedEmailIds.value.filter((item) => item !== id);
  await refreshAll();
}

async function deleteSelectedEmails() {
  if (!selectedEmailIds.value.length) return;
  const ok = window.confirm(`确认删除选中的 ${selectedEmailIds.value.length} 个邮箱？运行中的邮箱会跳过。`);
  if (!ok) return;
  const result = await api<any>("/api/emails/delete", {
    method: "POST",
    body: JSON.stringify({ids: selectedEmailIds.value}),
  });
  selectedEmailIds.value = [];
  showToast(`批量删除完成：删除 ${result.removed ?? 0} 个${result.skippedRunning ? `，跳过运行中 ${result.skippedRunning} 个` : ""}`);
  await refreshAll();
}

async function deleteEmailsByStatus(status: "free" | "failed" | "success") {
  const label = statusText(status);
  const ok = window.confirm(`确认删除所有${label}邮箱？`);
  if (!ok) return;
  const result = await api<any>("/api/emails/delete", {
    method: "POST",
    body: JSON.stringify({status}),
  });
  selectedEmailIds.value = [];
  showToast(`删除${label}邮箱完成：删除 ${result.removed ?? 0} 个`);
  await refreshAll();
}

async function startSelectedEmailTasks() {
  const emailIds = selectedRunnableEmailIds.value;
  if (!emailIds.length) {
    showToast("请选择非运行中的邮箱");
    return;
  }
  const saved = await saveConfig();
  if (!saved) return;
  const data = await api<any>("/api/tasks", {
    method: "POST",
    body: JSON.stringify({
      emailIds,
      count: emailIds.length,
      concurrency: form.taskConcurrency,
      workspaceIds: parseWorkspaceIds(workspaceText.value),
      route: form.route,
      runWorkspaceJoin: form.runWorkspaceJoin,
      runSub2Api: form.runSub2Api,
      sub2apiGroupName: form.sub2apiGroupName || "k12",
    }),
  });
  selectedEmailIds.value = [];
  const skipped = Number(data.skippedRunning || 0) + Number(data.missing || 0);
  showToast(`已用选中邮箱创建 ${data.tasks?.length || 0} 个任务${skipped ? `，跳过 ${skipped} 个` : ""}`);
  await refreshAll();
}

async function startTasks() {
  const saved = await saveConfig();
  if (!saved) return;
  const data = await api<any>("/api/tasks", {
    method: "POST",
    body: JSON.stringify({
      count: selectedReadyCount.value,
      concurrency: form.taskConcurrency,
      workspaceIds: parseWorkspaceIds(workspaceText.value),
      route: form.route,
      runWorkspaceJoin: form.runWorkspaceJoin,
      runSub2Api: form.runSub2Api,
      sub2apiGroupName: form.sub2apiGroupName || "k12",
    }),
  });
  showToast(`已创建 ${data.tasks?.length || 0} 个任务`);
  await refreshAll();
}

async function cancelTask(id: string) {
  await api(`/api/tasks/${encodeURIComponent(id)}/cancel`, {method: "POST", body: "{}"});
  await refreshAll();
}

function canDeleteTask(task: TaskItem) {
  return task.status === "failed" || task.status === "canceled";
}

async function retryTask(id: string) {
  const data = await api<any>(`/api/tasks/${encodeURIComponent(id)}/retry`, {method: "POST", body: "{}"});
  if (data.task) {
    selectedTask.value = data.task;
    showTaskLogModal.value = true;
  }
  showToast("已创建重试任务");
  await refreshAll();
}

async function deleteTask(id: string) {
  await api(`/api/tasks/${encodeURIComponent(id)}`, {method: "DELETE"});
  if (selectedTask.value?.id === id) {
    selectedTask.value = null;
    showTaskLogModal.value = false;
  }
  showToast("任务已删除");
  await refreshAll();
}

async function copyText(value: string, message: string) {
  const text = String(value || "");
  if (!text) return;
  await navigator.clipboard.writeText(text);
  showToast(message);
}

async function copyAccessToken(task: TaskItem) {
  if (task.accessToken) {
    await copyText(task.accessToken, "完整 AT 已复制");
    return;
  }
  await copyText(task.accessTokenPreview || "", "当前只复制了 AT 预览值，刷新后可尝试复制完整 AT");
}

function selectTask(task: TaskItem) {
  selectedTask.value = task;
}

function openTaskLog(task: TaskItem) {
  selectedTask.value = task;
  showTaskLogModal.value = true;
}

function closeTaskLog() {
  showTaskLogModal.value = false;
}

function sampleEmails() {
  emailText.value = [
    "user1@example.com----password----client-id----refresh-token",
    "user2@example.com-----http://wremail.cc/api/GetLastEmails?email=user2@example.com&clientId=xxx&refreshToken=yyy&num=2&boxType=1",
  ].join("\n");
}

function statusText(status: string) {
  return ({
    free: "空闲",
    running: "运行中",
    success: "成功",
    failed: "失败",
    queued: "队列",
    canceled: "已取消",
  } as Record<string, string>)[status] || status;
}

function fmtTime(value: string) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString();
}

onMounted(async () => {
  await loadConfig();
  await refreshAll();
  timer = window.setInterval(refreshAll, 2500);
});

onUnmounted(() => {
  if (timer) window.clearInterval(timer);
});
</script>
