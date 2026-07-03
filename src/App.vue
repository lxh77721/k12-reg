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
        <button class="ghost" @click="exportData">导出数据</button>
        <button class="ghost" :disabled="importingData" @click="triggerDataImport">
          {{ importingData ? "导入中..." : "导入数据" }}
        </button>
        <input ref="dataImportInput" class="hidden-file-input" type="file" accept="application/json,.json" @change="importDataFile" />
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
        <small>可用 {{ summary.emails.free }} / 失败 {{ summary.emails.failed }} / GPT封号 {{ summary.emails.banned }}</small>
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
      <article class="stat-card refill-card">
        <span>自动补号</span>
        <strong>{{ sub2apiRefillStatus.lastResult?.normalAccounts ?? "-" }}</strong>
        <small>{{ refillSummaryText }}</small>
      </article>
      <article class="stat-card smsbower-card">
        <span>SMSBower</span>
        <strong>{{ smsBowerBalanceText }}</strong>
        <small>{{ smsBowerSpendText }}</small>
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
          <button class="ghost" :disabled="!selectedCheckableTaskIds.length || checkingTasks" @click="checkSelectedTasks">
            {{ checkingTasks ? "测活中..." : `测活选中 ${selectedCheckableTaskIds.length}` }}
          </button>
          <button class="ghost" :disabled="!selectedTaskIds.length" @click="repairSelectedTasks">
            修复AT {{ selectedTaskIds.length }}
          </button>
          <button class="ghost" :disabled="checkingTasks" @click="loadInactiveTaskData">
            一键失活数据
          </button>
          <button class="ghost" :disabled="startingSub2apiRefill || sub2apiRefillStatus.running" @click="startSub2apiRefill">
            {{ startingSub2apiRefill || sub2apiRefillStatus.running ? "补号检测中..." : "启动补号" }}
          </button>
          <button class="ghost" @click="openSub2apiRefillHistory">
            补号日志
          </button>
          <button class="ghost" :disabled="!inactiveMarkedTasks.length" @click="selectInactiveMarkedTasks">
            勾选失活 {{ inactiveMarkedTasks.length }}
          </button>
          <button class="danger" :disabled="!summary.tasks.failed" @click="clearFailedTasks">
            清理失败 {{ summary.tasks.failed }}
          </button>
          <label class="field run-count-field">
            <span>本次处理数量</span>
            <input v-model.number="runCount" type="number" min="1" />
          </label>
          <button class="ghost" @click="openEmailImport">邮箱导入</button>
          <button class="ghost" @click="openEmailPool">邮箱池</button>
          <button class="primary" :disabled="startTasksDisabled" @click="startTasks">
            {{ busy ? "运行中" : `启动 ${launchTaskCount} 个任务` }}
          </button>
          <span v-if="form.smsBowerMailEnabled" class="launch-mode-badge">
            {{ form.gmailMailProvider === "emailnator" ? "Emailnator Gmail" : "SMSBower Gmail" }} 动态模式，不占用邮箱池
          </span>
        </div>
      </div>

      <div class="table-wrap task-table-wrap">
        <table class="task-table">
          <thead>
            <tr>
              <th class="select-col">
                <input type="checkbox" :checked="allCheckableTasksSelected" @change="toggleAllCheckableTasks" />
              </th>
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
              v-for="task in pagedTasks"
              :key="task.id"
              :class="['task-row', { active: selectedTask?.id === task.id, selected: selectedTaskIds.includes(task.id) }]"
              @click="openTaskLog(task)"
            >
              <td class="select-col" @click.stop>
                <input type="checkbox" :checked="selectedTaskIds.includes(task.id)" @change="toggleTaskSelection(task.id)" />
              </td>
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
                  <span v-if="task.accessTokenLiveness" :class="['liveness-badge', task.accessTokenLiveness]" :title="task.accessTokenLivenessMessage || ''">
                    {{ livenessText(task.accessTokenLiveness) }}
                  </span>
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
                    class="ghost small"
                    :disabled="!canCheckTaskAt(task) || checkingTaskAtId === task.id"
                    @click.stop="checkTaskAccessToken(task)"
                  >
                    {{ checkingTaskAtId === task.id ? "测活中" : "测活" }}
                  </button>
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
              <td colspan="8" class="empty">暂无任务。导入邮箱后可从上方启动流程。</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-if="tasks.length" class="pagination-bar">
        <span>
          共 {{ sortedTasks.length }} 个任务，当前 {{ taskPageStart + 1 }}-{{ taskPageEnd }}
        </span>
        <div class="pagination-actions">
          <button class="ghost small" :disabled="taskPage <= 1" @click="taskPage = 1">首页</button>
          <button class="ghost small" :disabled="taskPage <= 1" @click="taskPage -= 1">上一页</button>
          <strong>{{ taskPage }} / {{ taskTotalPages }}</strong>
          <button class="ghost small" :disabled="taskPage >= taskTotalPages" @click="taskPage += 1">下一页</button>
          <button class="ghost small" :disabled="taskPage >= taskTotalPages" @click="taskPage = taskTotalPages">末页</button>
        </div>
      </div>
      <pre v-if="taskCheckResult" class="check-result task-check-result">{{ taskCheckResult }}</pre>
    </section>

    <div v-if="toast" class="toast">{{ toast }}</div>

    <Teleport to="body">
      <div v-if="showSettingsModal" class="modal-backdrop">
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
                <span>K12 Workspace ID（一行一个或逗号分隔；多个时每个邮箱随机选一个）</span>
                <textarea v-model="workspaceText" class="workspace-box"></textarea>
              </label>
              <div class="switch-grid">
                <label class="switch-card">
                  <input v-model="form.runWorkspaceJoin" type="checkbox" />
                  <span>
                    <strong>执行 K12 空间脚本</strong>
                    <small>多个 workspace 时，每个邮箱任务会随机抽取其中一个执行 request/accept。</small>
                  </span>
                </label>
                <label class="switch-card">
                  <input v-model="form.runSub2Api" type="checkbox" />
                  <span>
                    <strong>执行 Sub2API 入库</strong>
                    <small>只拿邮箱 OA 到 Sub2API 的流程，分组默认 k12。</small>
                  </span>
                </label>
                <label class="switch-card">
                  <input v-model="form.sub2apiNoRtMode" type="checkbox" />
                  <span>
                    <strong>noRT 直入模式</strong>
                    <small>开启后跳过 Sub2API OAuth：注册/登录 → 加入并切到 K12 → 用 K12 AT 创建或更新 --noRT 账号。</small>
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
                  <span>分组（可多个）</span>
                  <input v-model="form.sub2apiGroupName" placeholder="k12, shared-group" />
                  <small>多个分组用逗号、分号或换行分隔；账号会同时绑定这些分组。</small>
                </label>
                <label class="field">
                  <span>IP管理 / 代理</span>
                  <input v-model="form.sub2apiProxyName" placeholder="留空不绑定；可填 Sub2API 代理名称或 ID" />
                </label>
                <label class="field">
                  <span>Token 输出文件</span>
                  <input v-model="form.tokenOut" />
                </label>
                <label class="field">
                  <span>账号 JSON 类型</span>
                  <select v-model="form.jsonOutFormat">
                    <option value="sub2api">SUB2API</option>
                    <option value="cpa">CPA</option>
                  </select>
                </label>
                <label class="field">
                  <span>账号 JSON 写出目录</span>
                  <input v-model="form.jsonOutDir" placeholder="默认项目 json 文件夹" />
                </label>
              </div>
            </section>

            <section class="settings-section">
              <div class="section-head compact-head">
                <div>
                  <p class="eyebrow">Auto Refill</p>
                  <h3>Sub2API 自动补号</h3>
                </div>
                <span class="pill">{{ form.sub2apiAutoRefillEnabled ? "已启用" : "未启用" }}</span>
              </div>
              <label class="switch-card refill-switch">
                <input v-model="form.sub2apiAutoRefillEnabled" type="checkbox" />
                <span>
                  <strong>启动定时检测补号</strong>
                  <small>定时统计目标分组正常账号数；低于预警线时，从空闲邮箱池自动创建补号任务。</small>
                </span>
              </label>
              <label class="switch-card refill-switch">
                <input v-model="form.sub2apiRefillDeepCheckEnabled" type="checkbox" />
                <span>
                  <strong>开启深度测活</strong>
                  <small>检测时对账号执行一次真实模型请求；只有真实可用的账号才计入正常账号数。</small>
                </span>
              </label>
              <div class="config-grid refill-config-grid">
                <label class="field">
                  <span>检测 Sub2API 补号分组名称</span>
                  <input v-model="form.sub2apiRefillGroupName" placeholder="k12" />
                </label>
                <label class="field">
                  <span>预警线（正常账号低于多少开始补号）</span>
                  <input v-model.number="form.sub2apiRefillThreshold" type="number" min="0" />
                </label>
                <label class="field">
                  <span>补号执行的邮箱数量</span>
                  <input v-model.number="form.sub2apiRefillEmailCount" type="number" min="1" max="500" />
                </label>
                <label class="field">
                  <span>定时检测间隔 ms</span>
                  <input v-model.number="form.sub2apiRefillIntervalMs" type="number" min="10000" />
                </label>
              </div>
              <p class="hint">
                补号任务会复用当前 K12 / Sub2API 入库配置；实际执行并发按照上方“并发”设置。
                {{ sub2apiRefillStatus.nextCheckAt ? `下次检测：${fmtDateTime(sub2apiRefillStatus.nextCheckAt)}` : "" }}
              </p>
            </section>

            <section class="settings-section">
              <div class="section-head compact-head">
                <div>
                  <p class="eyebrow">SMSBower Gmail</p>
                  <h3>动态谷歌邮箱接码</h3>
                </div>
                <span class="pill">{{ form.smsBowerMailEnabled ? "已启用" : "未启用" }}</span>
              </div>
              <label class="switch-card refill-switch">
                <input v-model="form.smsBowerMailEnabled" type="checkbox" />
                <span>
                  <strong>使用动态谷歌邮箱</strong>
                  <small>开启后，未指定邮箱启动任务时按下方类型动态生成/租 Gmail 接码；关闭时仍按原来的邮箱池流程执行。</small>
                </span>
              </label>
              <div class="config-grid refill-config-grid">
                <label class="field">
                  <span>谷歌邮箱渠道类型</span>
                  <select v-model="form.gmailMailProvider">
                    <option value="smsbower">SMSBower</option>
                    <option value="emailnator">Emailnator</option>
                  </select>
                  <small>只新增 Emailnator 分支；选择 SMSBower 时原租邮箱流程不变。</small>
                </label>
                <label class="field" v-if="form.gmailMailProvider === 'emailnator'">
                  <span>Emailnator 生成类型</span>
                  <select v-model="form.emailnatorEmailType">
                    <option value="plusGmail">plusGmail（推荐，稳定 Gmail）</option>
                    <option value="googleMail">googleMail</option>
                    <option value="dotGmail">dotGmail</option>
                    <option value="domain">domain</option>
                  </select>
                  <small>按你抓包的稳定请求，默认使用 plusGmail。</small>
                </label>
                <label class="field" v-if="form.gmailMailProvider === 'emailnator'">
                  <span>Emailnator 地址</span>
                  <input v-model="form.emailnatorBaseUrl" placeholder="https://www.emailnator.com" />
                </label>
              </div>
              <p v-if="smsBowerBackendUnsupported" class="inline-alert warn">
                当前后端未返回 SMSBower 配置字段，说明服务仍在跑旧进程。请重启后端后再保存，否则开关会被旧接口丢弃。
              </p>
              <label v-if="form.gmailMailProvider === 'smsbower'" class="switch-card refill-switch">
                <input v-model="form.smsBowerGmailFissionEnabled" type="checkbox" />
                <span>
                  <strong>开启谷歌裂变</strong>
                  <small>母邮箱任务成功后，再逐个创建 +alias 子邮箱任务，避免验证码串号。</small>
                </span>
              </label>
              <div v-if="form.gmailMailProvider === 'smsbower'" class="config-grid refill-config-grid">
                <label class="field">
                  <span class="field-title-row">
                    SMSBower API Key
                    <em :class="['key-state', smsBowerApiKeySaved ? 'set' : 'unset']">
                      {{ smsBowerApiKeySaved ? "已设置 Key" : "未设置 Key" }}
                    </em>
                  </span>
                  <input v-model="form.smsBowerApiKey" type="password" :placeholder="smsBowerApiKeyPlaceholder" />
                  <small v-if="smsBowerApiKeySaved">已保存的 Key：{{ smsBowerApiKeyMasked || "已隐藏" }}，留空保存不会覆盖。</small>
                  <small v-else>还没有保存 Key，填写后点击“保存配置”才会生效。</small>
                </label>
                <label class="field">
                  <span>Mail API 地址</span>
                  <input v-model="form.smsBowerMailBaseUrl" placeholder="https://smsbower.page/api/mail" />
                </label>
                <label class="field">
                  <span>服务代码</span>
                  <input v-model="form.smsBowerMailService" placeholder="openai" />
                  <small>可填 openai；后端会自动按 SMSBower 邮件服务码 dr 请求。</small>
                </label>
                <label class="field">
                  <span>邮箱域名</span>
                  <input v-model="form.smsBowerMailDomain" placeholder="gmail.com" />
                </label>
                <label class="field">
                  <span>最高价格（可空）</span>
                  <input v-model="form.smsBowerMailMaxPrice" placeholder="留空不限制" />
                </label>
                <label class="field">
                  <span>每个母邮箱裂变子任务数</span>
                  <input v-model.number="form.smsBowerGmailFissionCount" type="number" min="1" max="100" />
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

      <div v-if="showSub2apiRefillHistoryModal" class="modal-backdrop" @click.self="closeSub2apiRefillHistory">
        <section class="panel modal-card refill-history-modal" role="dialog" aria-modal="true" aria-labelledby="refill-history-title">
          <div class="section-head">
            <div>
              <p class="eyebrow">Refill History</p>
              <h2 id="refill-history-title">补号日志 / 历史记录</h2>
            </div>
            <div class="modal-actions">
              <button class="ghost small" @click="loadSub2apiRefillHistory">刷新</button>
              <button class="ghost small" @click="closeSub2apiRefillHistory">关闭</button>
            </div>
          </div>
          <div class="modal-body">
            <div class="modal-status-grid refill-history-summary">
              <div>
                <span>最近状态</span>
                <strong>{{ sub2apiRefillStatus.lastError ? "失败" : sub2apiRefillStatus.lastResult ? "完成" : "无记录" }}</strong>
              </div>
              <div>
                <span>最近正常数</span>
                <strong>{{ sub2apiRefillStatus.lastResult?.normalAccounts ?? "-" }}</strong>
              </div>
              <div>
                <span>下次检测</span>
                <strong>{{ sub2apiRefillStatus.nextCheckAt ? fmtDateTime(sub2apiRefillStatus.nextCheckAt) : "-" }}</strong>
              </div>
            </div>
            <div class="table-wrap refill-history-table-wrap">
              <table class="task-table refill-history-table">
                <thead>
                  <tr>
                    <th>时间</th>
                    <th>来源</th>
                    <th>结果</th>
                    <th>分组</th>
                    <th>正常/预警</th>
                    <th>深度测活</th>
                    <th>创建任务</th>
                    <th>原因</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="item in sub2apiRefillHistory" :key="item.id">
                    <td>{{ fmtDateTime(item.checkedAt) }}</td>
                    <td>{{ item.source === "timer" ? "定时" : item.source === "manual" ? "手动" : "-" }}</td>
                    <td><span :class="['status', item.ok ? 'success' : 'failed']">{{ item.ok ? "成功" : "失败" }}</span></td>
                    <td>{{ item.groupName || "-" }}</td>
                    <td>{{ item.normalAccounts ?? "-" }}/{{ item.threshold ?? "-" }}</td>
                    <td>
                      <span v-if="item.deepCheckEnabled">开启 {{ item.deepOk ?? 0 }}/{{ item.deepChecked ?? 0 }}</span>
                      <span v-else>关闭</span>
                    </td>
                    <td>{{ item.createdTasks ?? 0 }}</td>
                    <td>
                      <div class="history-message">
                        <span>{{ item.message || item.error || "-" }}</span>
                        <small v-if="item.samples?.length">{{ item.samples.slice(0, 3).join("；") }}</small>
                      </div>
                    </td>
                  </tr>
                  <tr v-if="!sub2apiRefillHistory.length">
                    <td colspan="8" class="empty">暂无补号检测记录。</td>
                  </tr>
                </tbody>
              </table>
            </div>
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
            <div class="mode-toggle">
              <label :class="['mode-card', {active: emailImportMode === 'auto'}]">
                <input v-model="emailImportMode" type="radio" value="auto" />
                <span class="mode-content">
                  <span class="mode-title-row">
                    <strong>自动接码</strong>
                    <em>推荐</em>
                  </span>
                  <small>需要邮箱行包含接码 URL 或 clientId/refreshToken，适合批量自动跑。</small>
                </span>
              </label>
              <label :class="['mode-card', {active: emailImportMode === 'manual'}]">
                <input v-model="emailImportMode" type="radio" value="manual" />
                <span class="mode-content">
                  <span class="mode-title-row">
                    <strong>手动接码</strong>
                    <em>备用</em>
                  </span>
                  <small>只导入邮箱；任务需要验证码时，在任务日志里手动填写。</small>
                </span>
              </label>
            </div>
            <label class="import-file-card">
              <input class="visually-hidden-file" type="file" accept=".txt,text/plain" @change="loadEmailImportFile" />
              <span class="file-icon">TXT</span>
              <span class="file-copy">
                <strong>{{ emailImportFileName || "选择邮箱文件" }}</strong>
                <small>支持 .txt 文件，也可以直接在下方粘贴邮箱内容</small>
              </span>
              <span class="file-action">浏览</span>
            </label>
            <label class="field import-text-field">
              <span>邮箱内容</span>
              <textarea
                v-model="emailText"
                :placeholder="emailImportPlaceholder"
              ></textarea>
            </label>
            <div class="import-footer-row">
              <label v-if="emailImportMode === 'auto'" class="field import-api-field">
                <span>接码 API 域名</span>
                <input v-model="form.mailApiBaseUrl" placeholder="http://wremail.cc/" />
              </label>
              <p v-else class="hint manual-import-hint">
                手动接码模式下每行只要有邮箱即可，例如：
                <code>user@example.com</code>
              </p>
              <div class="row-actions import-actions">
                <button class="ghost" :disabled="importingEmails" @click="clearEmailImport">清空</button>
                <button class="primary" :disabled="!emailText.trim() || importingEmails" @click="importEmails">
                  {{ importingEmails ? "导入中..." : "导入邮箱" }}
                </button>
              </div>
            </div>
            <pre v-if="importResult" class="import-result">{{ importResult }}</pre>
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
              <button class="ghost small" :disabled="!selectedRepairableEmailIds.length || checkingAccessTokens" @click="checkSelectedAccessTokens">
                {{ checkingAccessTokens ? "检验中..." : `检验AT ${selectedRepairableEmailIds.length}` }}
              </button>
              <button class="ghost small" :disabled="!selectedRepairableEmailIds.length" @click="repairSelectedAccessTokens">
                修复AT {{ selectedRepairableEmailIds.length }}
              </button>
              <button class="ghost small" :disabled="!selectedEmailIds.length" @click="splitSelectedEmails">
                分裂选中 x{{ splitAliasCount || 4 }}
              </button>
              <button class="danger small" :disabled="!selectedEmailIds.length" @click="deleteSelectedEmails">
                删除选中 {{ selectedEmailIds.length }}
              </button>
              <button class="danger small" :disabled="!summary.emails.failed" @click="deleteEmailsByStatus('failed')">删除失败</button>
              <button class="danger small" :disabled="!freeChildEmails.length" @click="deleteFreeChildEmails">
                删除空闲子邮箱 {{ freeChildEmails.length }}
              </button>
              <button class="danger small" :disabled="!summary.emails.free" @click="deleteEmailsByStatus('free')">删除空闲</button>
              <button class="danger small" :disabled="!summary.emails.banned" @click="deleteEmailsByStatus('banned')">删除GPT封号</button>
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
              <div>
                <span>GPT封号</span>
                <strong>{{ summary.emails.banned }}</strong>
              </div>
              <div>
                <span>子邮箱</span>
                <strong>{{ childEmails.length }}</strong>
              </div>
              <div>
                <span>封号子邮箱</span>
                <strong>{{ bannedChildEmails.length }}</strong>
              </div>
            </div>
            <pre v-if="accessTokenCheckResult" class="check-result">{{ accessTokenCheckResult }}</pre>
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
                      <div v-if="item.parentEmail" class="email-meta-row">
                        <span :class="['child-badge', item.status === 'banned' ? 'banned' : '']">
                          {{ item.status === "banned" ? "子邮箱 · GPT封号" : "子邮箱" }}
                        </span>
                        <small class="muted">母邮箱：{{ item.parentEmail }}</small>
                      </div>
                    </td>
                    <td><span :class="['status', item.status]">{{ statusText(item.status) }}</span></td>
                    <td>
                      <span :class="['otp-mode-badge', item.otpMode === 'manual' ? 'manual' : item.otpMode === 'emailnator' ? 'emailnator' : 'auto']">
                        {{ item.otpMode === "manual" ? "手动接码" : item.otpMode === "emailnator" ? "Emailnator" : item.otpMode === "smsbower-mail" ? "SMSBower" : "自动接码" }}
                      </span>
                      <small class="muted clipped">{{ item.mailboxUrlMasked }}</small>
                    </td>
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
                <span>JSON 文件</span>
                <strong>{{ selectedTask.jsonOutFile || "-" }}</strong>
              </div>
              <div class="mini-result">
                <span>K12 成功</span>
                <strong>{{ selectedTask.workspaceResults.filter((r) => r.ok).length }}/{{ selectedTask.workspaceIds.length }}</strong>
              </div>
            </div>
            <div v-if="selectedTask.waitingOtp" class="manual-otp-panel">
              <div>
                <p class="eyebrow">Manual OTP</p>
                <h3>等待手动输入验证码</h3>
                <p class="hint">
                  {{ selectedTask.waitingOtpLabel || "邮箱" }}验证码已发送到
                  <strong>{{ selectedTask.waitingOtpEmail || selectedTask.email }}</strong>
                </p>
              </div>
              <div class="manual-otp-actions">
                <input
                  v-model="manualOtpCode"
                  class="manual-otp-input"
                  inputmode="numeric"
                  maxlength="6"
                  placeholder="6位验证码"
                  @keyup.enter="submitManualOtp"
                />
                <button class="primary" :disabled="manualOtpCode.trim().length !== 6 || submittingOtp" @click="submitManualOtp">
                  {{ submittingOtp ? "提交中..." : "提交验证码" }}
                </button>
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
import {computed, onMounted, onUnmounted, reactive, ref, watch} from "vue";

interface EmailItem {
  id: string;
  email: string;
  parentEmail?: string;
  otpMode?: string;
  status: string;
  mailboxUrlMasked: string;
  sub2apiAccount?: string;
}

interface TaskItem {
  id: string;
  emailId?: string;
  email: string;
  status: string;
  route: string;
  accessToken?: string;
  accessTokenPreview?: string;
  accessTokenLiveness?: string;
  accessTokenLivenessStatus?: number;
  accessTokenLivenessMessage?: string;
  accessTokenLivenessCheckedAt?: string;
  sub2apiAccount?: string;
  jsonOutFile?: string;
  jsonOutFormat?: string;
  waitingOtp?: boolean;
  waitingOtpLabel?: string;
  waitingOtpEmail?: string;
  waitingOtpSince?: string;
  workspaceIds: string[];
  workspaceResults: Array<{ok: boolean}>;
  logs: Array<{at: string; level: string; message: string}>;
}

interface AccessTokenCheckItem {
  emailId?: string;
  email: string;
  accountName?: string;
  accountId?: string;
  ok: boolean;
  status: number;
  message: string;
  latencyMs: number;
}

interface Sub2ApiRefillResult {
  id?: string;
  checkedAt: string;
  source?: "manual" | "timer";
  ok?: boolean;
  groupName: string;
  groupLabel: string;
  threshold: number;
  refillEmailCount: number;
  deepCheckEnabled?: boolean;
  basicNormalAccounts?: number;
  normalAccounts: number;
  deepChecked?: number;
  deepOk?: number;
  deepFailed?: number;
  pendingTasks: number;
  availableEmails: number;
  createdTasks: number;
  shouldRefill: boolean;
  message: string;
  error?: string;
  samples?: string[];
}

interface Sub2ApiRefillStatus {
  enabled: boolean;
  running: boolean;
  nextCheckAt: string;
  lastCheckedAt: string;
  lastError: string;
  lastResult: Sub2ApiRefillResult | null;
  history?: Sub2ApiRefillResult[];
}

interface SmsBowerAccountStatus {
  enabled: boolean;
  apiKeyPresent: boolean;
  apiKeyMasked: string;
  ok: boolean;
  balance?: number;
  currency: string;
  localSpend: number;
  rentedCount: number;
  closedCount: number;
  fetchedAt: string;
  error?: string;
}

const defaultSummary = {
  emails: {total: 0, free: 0, running: 0, success: 0, failed: 0, banned: 0},
  tasks: {total: 0, queued: 0, running: 0, success: 0, failed: 0, canceled: 0},
};

const summary = reactive(JSON.parse(JSON.stringify(defaultSummary)));
const sub2apiRefillStatus = reactive<Sub2ApiRefillStatus>({
  enabled: false,
  running: false,
  nextCheckAt: "",
  lastCheckedAt: "",
  lastError: "",
  lastResult: null,
  history: [],
});
const sub2apiRefillHistory = ref<Sub2ApiRefillResult[]>([]);
const emails = ref<EmailItem[]>([]);
const tasks = ref<TaskItem[]>([]);
const selectedTask = ref<TaskItem | null>(null);
const emailText = ref("");
const emailImportMode = ref<"auto" | "manual">("auto");
const emailImportFileName = ref("");
const importResult = ref("");
const manualOtpCode = ref("");
const submittingOtp = ref(false);
const importingEmails = ref(false);
const checkingAccessTokens = ref(false);
const checkingTasks = ref(false);
const checkingTaskAtId = ref("");
const accessTokenCheckResult = ref("");
const taskCheckResult = ref("");
const selectedEmailIds = ref<string[]>([]);
const selectedTaskIds = ref<string[]>([]);
const taskPageSize = 50;
const taskPage = ref(1);
const dataImportInput = ref<HTMLInputElement | null>(null);
const splitAliasCount = ref(4);
const workspaceText = ref("");
const runCount = ref(1);
const toast = ref("");
const savingConfig = ref(false);
const importingData = ref(false);
const startingSub2apiRefill = ref(false);
const smsBowerApiKeySaved = ref(false);
const smsBowerApiKeyMasked = ref("");
const smsBowerBackendUnsupported = ref(false);
const smsBowerAccount = reactive<SmsBowerAccountStatus>({
  enabled: false,
  apiKeyPresent: false,
  apiKeyMasked: "",
  ok: false,
  currency: "USD",
  localSpend: 0,
  rentedCount: 0,
  closedCount: 0,
  fetchedAt: "",
});
const showSettingsModal = ref(false);
const showEmailImportModal = ref(false);
const showEmailPoolModal = ref(false);
const showTaskLogModal = ref(false);
const showSub2apiRefillHistoryModal = ref(false);
let timer: number | undefined;
let smsBowerAccountTimer: number | undefined;

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
  sub2apiNoRtMode: false,
  sub2apiUrl: "",
  sub2apiEmail: "",
  sub2apiPassword: "",
  sub2apiGroupName: "k12",
  sub2apiProxyName: "",
  sub2apiAccountPriority: 1,
  sub2apiConcurrency: 10,
  sub2apiAutoRefillEnabled: false,
  sub2apiRefillGroupName: "k12",
  sub2apiRefillThreshold: 5,
  sub2apiRefillEmailCount: 5,
  sub2apiRefillIntervalMs: 300000,
  sub2apiRefillDeepCheckEnabled: false,
  gmailMailProvider: "smsbower",
  smsBowerMailEnabled: false,
  smsBowerApiKey: "",
  smsBowerMailBaseUrl: "https://smsbower.page/api/mail",
  smsBowerMailService: "openai",
  smsBowerMailDomain: "gmail.com",
  smsBowerMailMaxPrice: "",
  smsBowerGmailFissionEnabled: false,
  smsBowerGmailFissionCount: 1,
  emailnatorBaseUrl: "https://www.emailnator.com",
  emailnatorEmailType: "plusGmail",
  tokenOut: "",
  jsonOutDir: "",
  jsonOutFormat: "sub2api",
});

const busy = computed(() => summary.tasks.running > 0 || summary.tasks.queued > 0);
const workspaceCount = computed(() => parseWorkspaceIds(workspaceText.value).length);
const launchTaskCount = computed(() => {
  const count = Math.max(1, Number(runCount.value) || 1);
  return form.smsBowerMailEnabled ? count : Math.min(count, emails.value.filter((item) => item.status === "free").length);
});
const startTasksDisabled = computed(() => busy.value || (!form.smsBowerMailEnabled && launchTaskCount.value <= 0));
const selectedRunnableEmailIds = computed(() => emails.value
  .filter((item) => selectedEmailIds.value.includes(item.id) && item.status !== "running" && item.status !== "banned")
  .map((item) => item.id));
const selectedRepairableEmailIds = computed(() => emails.value
  .filter((item) => selectedEmailIds.value.includes(item.id) && item.status !== "running" && item.status !== "banned")
  .map((item) => item.id));
const checkableTasks = computed(() => tasks.value.filter((item) => canCheckTaskAt(item)));
const selectedCheckableTaskIds = computed(() => checkableTasks.value
  .filter((item) => selectedTaskIds.value.includes(item.id))
  .map((item) => item.id));
const allCheckableTasksSelected = computed(() => checkableTasks.value.length > 0 && checkableTasks.value.every((item) => selectedTaskIds.value.includes(item.id)));
const inactiveMarkedTasks = computed(() => tasks.value.filter((item) => item.accessTokenLiveness === "inactive" || item.accessTokenLiveness === "banned"));
const sortedTasks = computed(() => {
  const rank = (status: string) => status === "running" ? 0 : status === "queued" ? 1 : 2;
  return tasks.value
    .map((task, index) => ({task, index}))
    .sort((a, b) => rank(a.task.status) - rank(b.task.status) || a.index - b.index)
    .map((item) => item.task);
});
const taskTotalPages = computed(() => Math.max(1, Math.ceil(sortedTasks.value.length / taskPageSize)));
const taskPageStart = computed(() => (taskPage.value - 1) * taskPageSize);
const taskPageEnd = computed(() => Math.min(sortedTasks.value.length, taskPageStart.value + taskPageSize));
const pagedTasks = computed(() => sortedTasks.value.slice(taskPageStart.value, taskPageEnd.value));
const selectableParentEmails = computed(() => emails.value.filter((item) => !item.parentEmail && item.status !== "running"));
const passwordPlaceholder = computed(() => form.sub2apiPassword ? "已填写" : "留空则不修改已保存密码");
const smsBowerApiKeyPlaceholder = computed(() => form.smsBowerApiKey || smsBowerApiKeySaved.value ? "已设置 Key，留空则不修改" : "填写 SMSBower API Key");
const smsBowerBalanceText = computed(() => {
  if (!form.smsBowerMailEnabled) return "未启用";
  if (form.gmailMailProvider === "emailnator") return "Emailnator";
  if (!smsBowerAccount.apiKeyPresent) return "未设置Key";
  if (smsBowerAccount.ok && smsBowerAccount.balance !== undefined) return `${formatMoney(smsBowerAccount.balance)} ${smsBowerAccount.currency || "USD"}`;
  return "获取失败";
});
const smsBowerSpendText = computed(() => {
  if (!form.smsBowerMailEnabled) return "动态 Gmail 未启用";
  if (form.gmailMailProvider === "emailnator") return `免费生成 Gmail：${form.emailnatorEmailType || "plusGmail"}`;
  if (!smsBowerAccount.apiKeyPresent) return "设置页填写 Key 后显示余额";
  const base = `本地花费 ${formatMoney(smsBowerAccount.localSpend)} / 租号 ${smsBowerAccount.rentedCount}`;
  if (!smsBowerAccount.ok && smsBowerAccount.error) return `${base}，${smsBowerAccount.error}`;
  return base;
});
const deletableEmails = computed(() => emails.value.filter((item) => item.status !== "running"));
const childEmails = computed(() => emails.value.filter((item) => Boolean(item.parentEmail)));
const bannedChildEmails = computed(() => childEmails.value.filter((item) => item.status === "banned"));
const freeChildEmails = computed(() => emails.value.filter((item) => Boolean(item.parentEmail) && item.status === "free"));
const allVisibleEmailsSelected = computed(() => deletableEmails.value.length > 0 && deletableEmails.value.every((item) => selectedEmailIds.value.includes(item.id)));
const refillSummaryText = computed(() => {
  const result = sub2apiRefillStatus.lastResult;
  if (sub2apiRefillStatus.running) return "检测中";
  if (sub2apiRefillStatus.lastError) return `错误：${sub2apiRefillStatus.lastError}`;
  if (!result) return sub2apiRefillStatus.enabled ? "等待首次检测" : "未启用";
  return `${result.groupName} / 预警 ${result.threshold} / 已补 ${result.createdTasks}`;
});
const emailImportPlaceholder = computed(() => emailImportMode.value === "manual"
  ? "手动接码模式：\nuser1@example.com\nuser2@example.com"
  : "支持：\nemail----password----clientId----refreshToken\nemail-----http://mail-api/api/GetLastEmails?email=...");

watch(taskTotalPages, (pages) => {
  if (taskPage.value > pages) taskPage.value = pages;
  if (taskPage.value < 1) taskPage.value = 1;
}, {immediate: true});

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
  Object.assign(sub2apiRefillStatus, {
    ...sub2apiRefillStatus,
    ...(data.sub2apiRefill || {}),
    lastResult: data.sub2apiRefill?.lastResult || null,
  });
  if (Array.isArray(data.sub2apiRefill?.history)) {
    sub2apiRefillHistory.value = data.sub2apiRefill.history;
  }
}

async function loadConfig() {
  const data = await api<any>("/api/config");
  const config = data.config || {};
  smsBowerBackendUnsupported.value = !("smsBowerMailEnabled" in config);
  Object.assign(form, {
    defaultProxyUrl: config.defaultProxyUrl || "",
    mailApiBaseUrl: config.mailApiBaseUrl || "",
    workspaceIds: config.workspaceIds || [],
    route: config.route || "request",
    joinIntervalMs: config.joinIntervalMs || 1500,
    taskConcurrency: config.taskConcurrency || 1,
    runWorkspaceJoin: config.runWorkspaceJoin !== false,
    runSub2Api: config.runSub2Api !== false,
    sub2apiNoRtMode: config.sub2apiNoRtMode === true,
    sub2apiUrl: config.sub2apiUrl || "",
    sub2apiEmail: config.sub2apiEmail || "",
    sub2apiPassword: "",
    sub2apiGroupName: config.sub2apiGroupName || "k12",
    sub2apiProxyName: config.sub2apiProxyName || "",
    sub2apiAccountPriority: config.sub2apiAccountPriority || 1,
    sub2apiConcurrency: config.sub2apiConcurrency || 10,
    sub2apiAutoRefillEnabled: config.sub2apiAutoRefillEnabled === true,
    sub2apiRefillGroupName: config.sub2apiRefillGroupName || config.sub2apiGroupName || "k12",
    sub2apiRefillThreshold: config.sub2apiRefillThreshold ?? 5,
    sub2apiRefillEmailCount: config.sub2apiRefillEmailCount ?? 5,
    sub2apiRefillIntervalMs: config.sub2apiRefillIntervalMs ?? 300000,
    sub2apiRefillDeepCheckEnabled: config.sub2apiRefillDeepCheckEnabled === true,
    gmailMailProvider: config.gmailMailProvider === "emailnator" ? "emailnator" : "smsbower",
    smsBowerMailEnabled: config.smsBowerMailEnabled === true,
    smsBowerApiKey: "",
    smsBowerMailBaseUrl: config.smsBowerMailBaseUrl || "https://smsbower.page/api/mail",
    smsBowerMailService: config.smsBowerMailService || "openai",
    smsBowerMailDomain: config.smsBowerMailDomain || "gmail.com",
    smsBowerMailMaxPrice: config.smsBowerMailMaxPrice || "",
    smsBowerGmailFissionEnabled: config.smsBowerGmailFissionEnabled === true,
    smsBowerGmailFissionCount: config.smsBowerGmailFissionCount ?? 1,
    emailnatorBaseUrl: config.emailnatorBaseUrl || "https://www.emailnator.com",
    emailnatorEmailType: config.emailnatorEmailType || "plusGmail",
    tokenOut: config.tokenOut || "",
    jsonOutDir: config.jsonOutDir || "",
    jsonOutFormat: config.jsonOutFormat === "cpa" ? "cpa" : "sub2api",
  });
  smsBowerApiKeySaved.value = Boolean(config.smsBowerApiKeyPresent);
  smsBowerApiKeyMasked.value = config.smsBowerApiKeyMasked || "";
  workspaceText.value = (config.workspaceIds || []).join("\n");
}

async function loadSmsBowerAccount() {
  const data = await api<SmsBowerAccountStatus>("/api/smsbower/account");
  Object.assign(smsBowerAccount, {
    enabled: data.enabled === true,
    apiKeyPresent: data.apiKeyPresent === true,
    apiKeyMasked: data.apiKeyMasked || "",
    ok: data.ok === true,
    balance: data.balance,
    currency: data.currency || "USD",
    localSpend: Number(data.localSpend || 0),
    rentedCount: Number(data.rentedCount || 0),
    closedCount: Number(data.closedCount || 0),
    fetchedAt: data.fetchedAt || "",
    error: data.error || "",
  });
  smsBowerApiKeySaved.value = data.apiKeyPresent === true;
  smsBowerApiKeyMasked.value = data.apiKeyMasked || smsBowerApiKeyMasked.value;
}

async function saveConfig() {
  if (savingConfig.value) return false;
  savingConfig.value = true;
  try {
    const requestedSmsBowerEnabled = form.smsBowerMailEnabled === true;
    const payload = {
      ...form,
      workspaceIds: parseWorkspaceIds(workspaceText.value),
    };
    const saved = await api<any>("/api/config", {method: "PATCH", body: JSON.stringify(payload)});
    const savedConfig = saved.config || {};
    if (requestedSmsBowerEnabled && !("smsBowerMailEnabled" in savedConfig)) {
      smsBowerBackendUnsupported.value = true;
      throw new Error("当前后端仍是旧版本，未识别 SMSBower 配置字段。请重启服务后再保存。");
    }
    await Promise.all([loadConfig(), loadSummary(), loadSmsBowerAccount()]);
    if (requestedSmsBowerEnabled && !form.smsBowerMailEnabled) {
      throw new Error("SMSBower Gmail 开关未保存成功，请重启后端后重试。");
    }
    showSettingsModal.value = false;
    showToast(`配置已保存${form.smsBowerMailEnabled ? `：${form.gmailMailProvider === "emailnator" ? "Emailnator Gmail" : "SMSBower Gmail"} 已启用` : ""}`);
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

async function loadSub2apiRefillHistory() {
  const data = await api<any>("/api/sub2api/refill/history?limit=100");
  sub2apiRefillHistory.value = data.items || [];
}

async function openSub2apiRefillHistory() {
  showSub2apiRefillHistoryModal.value = true;
  await Promise.all([loadSummary(), loadSub2apiRefillHistory()]);
}

function closeSub2apiRefillHistory() {
  showSub2apiRefillHistoryModal.value = false;
}

async function loadTasks() {
  const data = await api<any>("/api/tasks");
  tasks.value = data.items || [];
  const existing = new Set(tasks.value.map((item) => item.id));
  selectedTaskIds.value = selectedTaskIds.value.filter((id) => existing.has(id));
  if (selectedTask.value) {
    selectedTask.value = tasks.value.find((item) => item.id === selectedTask.value?.id) || selectedTask.value;
  } else if (tasks.value.length) {
    selectedTask.value = sortedTasks.value[0];
  }
}

async function refreshAll() {
  await Promise.all([loadSummary(), loadEmails(), loadTasks()]);
}

async function refreshSmsBowerAccountQuietly() {
  try {
    await loadSmsBowerAccount();
  } catch {
    Object.assign(smsBowerAccount, {
      ...smsBowerAccount,
      ok: false,
      error: "余额接口请求失败",
      fetchedAt: new Date().toISOString(),
    });
  }
}

async function exportData() {
  try {
    const response = await fetch("/api/data/export");
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${response.status}`);
    }
    const blob = await response.blob();
    const disposition = response.headers.get("content-disposition") || "";
    const matched = disposition.match(/filename="?([^"]+)"?/i);
    const filename = matched?.[1] || `gpt-k12-data-${new Date().toISOString().slice(0, 10)}.json`;
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    showToast("数据导出已开始下载");
  } catch (error) {
    showToast(`导出数据失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

function triggerDataImport() {
  dataImportInput.value?.click();
}

async function importDataFile(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  const ok = window.confirm("导入会覆盖当前配置、邮箱池、任务和 pool_tokens。系统会先自动备份当前数据。确认继续？");
  if (!ok) {
    input.value = "";
    return;
  }
  importingData.value = true;
  try {
    const text = await file.text();
    JSON.parse(text);
    const result = await api<any>("/api/data/import", {method: "POST", body: text});
    selectedEmailIds.value = [];
    selectedTaskIds.value = [];
    selectedTask.value = null;
    showTaskLogModal.value = false;
    await loadConfig();
    await refreshAll();
    showToast(`导入完成：邮箱 ${result.emails ?? 0}，任务 ${result.tasks ?? 0}`);
  } catch (error) {
    showToast(`导入数据失败：${error instanceof Error ? error.message : String(error)}`);
  } finally {
    importingData.value = false;
    input.value = "";
  }
}

async function loadEmailImportFile(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  try {
    emailText.value = await file.text();
    emailImportFileName.value = file.name;
    importResult.value = "";
    const lineCount = emailText.value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).length;
    showToast(`已读取文件：${file.name}，${lineCount} 行`);
  } catch (error) {
    showToast(`读取文件失败：${error instanceof Error ? error.message : String(error)}`);
  } finally {
    input.value = "";
  }
}

function clearEmailImport() {
  emailText.value = "";
  emailImportFileName.value = "";
  importResult.value = "";
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
      body: JSON.stringify({text, mailApiBaseUrl: form.mailApiBaseUrl, otpMode: emailImportMode.value}),
    });
    importResult.value = [
      `接码模式：${emailImportMode.value === "manual" ? "手动接码" : "自动接码"}`,
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

async function deleteEmailsByStatus(status: "free" | "failed" | "success" | "banned") {
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

async function deleteFreeChildEmails() {
  const items = freeChildEmails.value;
  if (!items.length) return;
  const ok = window.confirm(`确认删除 ${items.length} 个空闲子邮箱？母邮箱、运行中、成功、失败和GPT封号邮箱不会删除。`);
  if (!ok) return;
  const ids = items.map((item) => item.id);
  const result = await api<any>("/api/emails/delete", {
    method: "POST",
    body: JSON.stringify({ids}),
  });
  const removedIds = new Set(ids);
  selectedEmailIds.value = selectedEmailIds.value.filter((id) => !removedIds.has(id));
  showToast(`删除空闲子邮箱完成：删除 ${result.removed ?? 0} 个${result.skippedRunning ? `，跳过运行中 ${result.skippedRunning} 个` : ""}`);
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
      sub2apiNoRtMode: form.sub2apiNoRtMode,
      sub2apiGroupName: form.sub2apiGroupName || "k12",
    }),
  });
  selectedEmailIds.value = [];
  const skipped = Number(data.skippedRunning || 0) + Number(data.missing || 0);
  showToast(`已用选中邮箱创建 ${data.tasks?.length || 0} 个任务${skipped ? `，跳过 ${skipped} 个` : ""}`);
  await refreshAll();
}

async function checkSelectedAccessTokens() {
  const emailIds = selectedRepairableEmailIds.value;
  if (!emailIds.length) {
    showToast("请选择非运行中的邮箱");
    return;
  }
  checkingAccessTokens.value = true;
  accessTokenCheckResult.value = "";
  try {
    const data = await api<any>("/api/emails/check-at", {
      method: "POST",
      body: JSON.stringify({
        emailIds,
        sub2apiGroupName: form.sub2apiGroupName || "k12",
      }),
    });
    const items = (data.items || []) as AccessTokenCheckItem[];
    for (const result of items) {
      if (!result.emailId || !result.accountName) continue;
      const email = emails.value.find((item) => item.id === result.emailId);
      if (email) email.sub2apiAccount = result.accountName;
    }
    const skipped = Number(data.skippedRunning || 0) + Number(data.missing || 0);
    accessTokenCheckResult.value = [
      `AT 检验完成：通过 ${data.ok ?? 0}，失败 ${data.failed ?? 0}${skipped ? `，跳过 ${skipped}` : ""}`,
      ...items.slice(0, 20).map((item) => (
        `${item.ok ? "OK" : "FAIL"} ${item.email}${item.accountName ? ` (${item.accountName})` : ""}: ${item.message}`
      )),
      items.length > 20 ? `还有 ${items.length - 20} 条未显示` : "",
    ].filter(Boolean).join("\n");
    showToast(`AT 检验完成：通过 ${data.ok ?? 0}，失败 ${data.failed ?? 0}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    accessTokenCheckResult.value = `AT 检验失败：${message}`;
    showToast(`AT 检验失败：${message}`);
  } finally {
    checkingAccessTokens.value = false;
  }
}

async function repairSelectedAccessTokens() {
  const emailIds = selectedRepairableEmailIds.value;
  if (!emailIds.length) {
    showToast("请选择非运行中的邮箱");
    return;
  }
  const ok = window.confirm(`确认修复选中的 ${emailIds.length} 个账号 AT？会创建任务，失效时重新邮箱接码登录并更新 Sub2API 对应账号。`);
  if (!ok) return;
  const saved = await saveConfig();
  if (!saved) return;
  const data = await api<any>("/api/tasks/repair-at", {
    method: "POST",
    body: JSON.stringify({
      emailIds,
      sub2apiGroupName: form.sub2apiGroupName || "k12",
    }),
  });
  selectedEmailIds.value = [];
  const skipped = Number(data.skippedRunning || 0) + Number(data.missing || 0) + Number(data.skippedNoAccount || 0);
  if (data.tasks?.[0]) {
    selectedTask.value = data.tasks[0];
    showTaskLogModal.value = true;
  }
  showToast(`已创建 AT 修复任务 ${data.tasks?.length || 0} 个${skipped ? `，跳过 ${skipped} 个` : ""}`);
  await refreshAll();
}

async function startTasks() {
  const saved = await saveConfig();
  if (!saved) return;
  try {
    const data = await api<any>("/api/tasks", {
      method: "POST",
      body: JSON.stringify({
        count: launchTaskCount.value,
        concurrency: form.taskConcurrency,
        workspaceIds: parseWorkspaceIds(workspaceText.value),
        route: form.route,
        runWorkspaceJoin: form.runWorkspaceJoin,
        runSub2Api: form.runSub2Api,
        sub2apiNoRtMode: form.sub2apiNoRtMode,
        sub2apiGroupName: form.sub2apiGroupName || "k12",
      }),
    });
    showToast(`已创建 ${data.tasks?.length || 0} 个任务`);
    await Promise.all([refreshAll(), refreshSmsBowerAccountQuietly()]);
  } catch (error) {
    showToast(`启动任务失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

async function startSub2apiRefill() {
  if (startingSub2apiRefill.value || sub2apiRefillStatus.running) return;
  const saved = await saveConfig();
  if (!saved) return;
  startingSub2apiRefill.value = true;
  try {
    const data = await api<any>("/api/sub2api/refill/start", {method: "POST", body: "{}"});
    Object.assign(sub2apiRefillStatus, {
      ...(data.status || {}),
      lastResult: data.status?.lastResult || data.result || null,
    });
    if (Array.isArray(data.status?.history)) {
      sub2apiRefillHistory.value = data.status.history;
    }
    showToast(data.result?.message || "补号检测完成");
    await refreshAll();
  } catch (error) {
    showToast(`补号检测失败：${error instanceof Error ? error.message : String(error)}`);
    await loadSummary();
  } finally {
    startingSub2apiRefill.value = false;
  }
}

async function cancelTask(id: string) {
  await api(`/api/tasks/${encodeURIComponent(id)}/cancel`, {method: "POST", body: "{}"});
  await refreshAll();
}

function canDeleteTask(task: TaskItem) {
  return task.status === "failed" || task.status === "canceled";
}

function canCheckTaskAt(task: TaskItem) {
  return Boolean(task.accessToken || task.accessTokenPreview) && task.status !== "queued" && task.status !== "running";
}

function toggleTaskSelection(id: string) {
  selectedTaskIds.value = selectedTaskIds.value.includes(id)
    ? selectedTaskIds.value.filter((item) => item !== id)
    : [...selectedTaskIds.value, id];
}

function toggleAllCheckableTasks(event: Event) {
  const checked = (event.target as HTMLInputElement).checked;
  selectedTaskIds.value = checked ? checkableTasks.value.map((item) => item.id) : [];
}

function selectInactiveMarkedTasks() {
  selectedTaskIds.value = inactiveMarkedTasks.value.map((item) => item.id);
  showToast(`已勾选失活任务 ${selectedTaskIds.value.length} 个`);
}

function livenessText(value: string) {
  return ({
    alive: "存活",
    inactive: "失活",
    banned: "GPT封号",
    error: "错误",
    unknown: "未知",
  } as Record<string, string>)[value] || value;
}

function formatTaskCheckResult(data: any, title: string) {
  const items = (data.items || []) as Array<{email: string; ok: boolean; inactive: boolean; status: number; message: string; repairTaskId?: string; skipped?: boolean}>;
  return [
    `${title}：检查 ${data.checked ?? 0}，正常 ${data.ok ?? 0}，失活 ${data.inactive ?? 0}，修复 ${data.repaired ?? 0}，跳过 ${data.skipped ?? 0}`,
    ...items.slice(0, 80).map((item) => {
      const tag = item.skipped ? "SKIP" : item.ok ? "OK" : item.inactive ? "INACTIVE" : "FAIL";
      return `${tag} ${item.email} HTTP ${item.status || "-"}${item.repairTaskId ? ` repair=${item.repairTaskId}` : ""}: ${item.message}`;
    }),
    items.length > 80 ? `还有 ${items.length - 80} 条未显示` : "",
  ].filter(Boolean).join("\n");
}

async function checkSelectedTasks() {
  const taskIds = selectedCheckableTaskIds.value;
  if (!taskIds.length) {
    showToast("请选择有 AT 的非运行任务");
    return;
  }
  checkingTasks.value = true;
  taskCheckResult.value = "";
  try {
    const data = await api<any>("/api/tasks/check-at", {
      method: "POST",
      body: JSON.stringify({taskIds, autoRepair: false}),
    });
    taskCheckResult.value = formatTaskCheckResult(data, "任务 AT 测活完成");
    showToast(`测活完成：失活 ${data.inactive ?? 0} 个`);
    await refreshAll();
  } catch (error) {
    showToast(`批量测活失败：${error instanceof Error ? error.message : String(error)}`);
  } finally {
    checkingTasks.value = false;
  }
}

async function repairSelectedTasks() {
  if (!selectedTaskIds.value.length) {
    showToast("请选择任务");
    return;
  }
  try {
    const emailIds = Array.from(new Set(tasks.value
      .filter((task) => selectedTaskIds.value.includes(task.id))
      .map((task) => task.emailId)
      .filter(Boolean))) as string[];
    if (!emailIds.length) {
      showToast("选中任务缺少邮箱记录");
      return;
    }
    const data = await api<any>("/api/tasks/repair-at", {
      method: "POST",
      body: JSON.stringify({
        emailIds,
        sub2apiGroupName: form.sub2apiGroupName || "k12",
      }),
    });
    if (data.tasks?.[0]) {
      selectedTask.value = data.tasks[0];
      showTaskLogModal.value = true;
    }
    const skipped = Number(data.skippedRunning || 0) + Number(data.missing || 0) + Number(data.skippedNoAccount || 0);
    taskCheckResult.value = `已创建 AT 修复任务 ${data.tasks?.length || 0} 个${skipped ? `，跳过 ${skipped} 个` : ""}。Sub2API 没有账号时会自动新增账号。`;
    showToast(`已创建 AT 修复任务 ${data.tasks?.length || 0} 个`);
    await refreshAll();
  } catch (error) {
    showToast(`批量修复失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

async function loadInactiveTaskData() {
  checkingTasks.value = true;
  taskCheckResult.value = "";
  try {
    const data = await api<any>("/api/tasks/check-at", {
      method: "POST",
      body: JSON.stringify({onlyInactive: true, autoRepair: false}),
    });
    taskCheckResult.value = formatTaskCheckResult(data, "失活任务数据");
    selectedTaskIds.value = (data.items || []).map((item: any) => item.taskId).filter(Boolean);
    showToast(`已获取失活任务 ${data.inactive ?? 0} 个`);
    await refreshAll();
  } catch (error) {
    showToast(`获取失活任务失败：${error instanceof Error ? error.message : String(error)}`);
  } finally {
    checkingTasks.value = false;
  }
}

async function checkTaskAccessToken(task: TaskItem) {
  if (!canCheckTaskAt(task)) {
    showToast("该任务没有可测活的 AT");
    return;
  }
  checkingTaskAtId.value = task.id;
  try {
    const data = await api<any>(`/api/tasks/${encodeURIComponent(task.id)}/check-at`, {method: "POST", body: "{}"});
    if (data.task) selectedTask.value = data.task;
    if (data.result?.banned) {
      showToast("账号已停用，当前邮箱记录已标记为GPT封号");
    } else if (data.repairTask) {
      selectedTask.value = data.repairTask;
      showTaskLogModal.value = true;
      showToast("AT 401，已自动创建修复任务");
    } else {
      showToast(data.result?.message || "AT 测活完成");
    }
    await refreshAll();
  } catch (error) {
    showToast(`AT 测活失败：${error instanceof Error ? error.message : String(error)}`);
  } finally {
    checkingTaskAtId.value = "";
  }
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

async function clearFailedTasks() {
  if (!summary.tasks.failed) return;
  const ok = window.confirm(`确认清理 ${summary.tasks.failed} 个失败任务？`);
  if (!ok) return;
  const result = await api<any>("/api/tasks/clear-failed", {method: "POST", body: "{}"});
  selectedTaskIds.value = [];
  if (selectedTask.value?.status === "failed") {
    selectedTask.value = null;
    showTaskLogModal.value = false;
  }
  showToast(`已清理失败任务 ${result.removed ?? 0} 个`);
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

async function submitManualOtp() {
  const task = selectedTask.value;
  if (!task?.waitingOtp || submittingOtp.value) return;
  const code = manualOtpCode.value.trim();
  if (!/^\d{6}$/.test(code)) {
    showToast("请输入 6 位数字验证码");
    return;
  }
  submittingOtp.value = true;
  try {
    const data = await api<any>(`/api/tasks/${encodeURIComponent(task.id)}/otp`, {
      method: "POST",
      body: JSON.stringify({code}),
    });
    manualOtpCode.value = "";
    if (data.task) selectedTask.value = data.task;
    showToast("验证码已提交，任务继续执行");
    await refreshAll();
  } catch (error) {
    showToast(`提交验证码失败：${error instanceof Error ? error.message : String(error)}`);
  } finally {
    submittingOtp.value = false;
  }
}

function selectTask(task: TaskItem) {
  selectedTask.value = task;
}

function openTaskLog(task: TaskItem) {
  selectedTask.value = task;
  manualOtpCode.value = "";
  showTaskLogModal.value = true;
}

function closeTaskLog() {
  showTaskLogModal.value = false;
}

function sampleEmails() {
  emailText.value = emailImportMode.value === "manual"
    ? [
      "user1@example.com",
      "user2@example.com",
    ].join("\n")
    : [
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
    banned: "GPT封号",
    queued: "队列",
    canceled: "已取消",
  } as Record<string, string>)[status] || status;
}

function fmtTime(value: string) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString();
}

function fmtDateTime(value: string) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function formatMoney(value: unknown) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "-";
  return number.toFixed(3).replace(/\.?0+$/g, "");
}

onMounted(async () => {
  await loadConfig();
  await Promise.all([refreshAll(), refreshSmsBowerAccountQuietly()]);
  timer = window.setInterval(refreshAll, 2500);
  smsBowerAccountTimer = window.setInterval(refreshSmsBowerAccountQuietly, 60000);
});

onUnmounted(() => {
  if (timer) window.clearInterval(timer);
  if (smsBowerAccountTimer) window.clearInterval(smsBowerAccountTimer);
});
</script>
