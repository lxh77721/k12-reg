(function () {
  const quickPath = "D:\\ai-work\\gpt-k12\\AGENT-QUICK-UNDERSTANDING.md";
  const fullPath = "D:\\ai-work\\gpt-k12\\AGENT-INTEGRATION.md";

  function ensureAgentModal() {
    if (document.querySelector("#agent-modal")) return;
    const modal = document.createElement("div");
    modal.id = "agent-modal";
    modal.className = "modal hidden";
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.innerHTML = `
      <div class="modal-backdrop" data-close-agent></div>
      <div class="modal-panel agent-modal-panel">
        <div class="modal-head">
          <div>
            <h2>AI 接入</h2>
            <p class="muted">让智能体先读快速接入，再读完整能力文档，即可直接调用本地 API 操作全部功能。</p>
          </div>
          <button class="ghost icon-btn" type="button" data-close-agent>×</button>
        </div>
        <div class="modal-body agent-body">
          <div class="agent-steps">
            <div class="agent-step">
              <span class="agent-step-num">1</span>
              <div>
                <strong>先读：AI 快速接入阅读文档</strong>
                <div class="mono wrap" id="agent-quick-path">${quickPath}</div>
              </div>
            </div>
            <div class="agent-step">
              <span class="agent-step-num">2</span>
              <div>
                <strong>再读：完整能力接入手册</strong>
                <div class="mono wrap" id="agent-full-path">${fullPath}</div>
              </div>
            </div>
          </div>

          <div class="agent-copy-grid">
            <button id="copy-agent-prompt" class="primary" type="button">复制 AI 接入提示词</button>
            <button id="copy-agent-paths" type="button">复制两个 MD 地址</button>
            <button id="reload-agent-docs" type="button">重新加载 MD</button>
          </div>

          <div class="field">
            <label>给智能体的接入提示词</label>
            <textarea id="agent-prompt" class="agent-prompt" readonly></textarea>
          </div>

          <div class="agent-tabs">
            <button class="small active" type="button" data-agent-tab="quick">快速接入 MD</button>
            <button class="small" type="button" data-agent-tab="full">完整能力 MD</button>
          </div>
          <pre id="agent-doc-content" class="agent-doc-content">加载中...</pre>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    bindAgentModal();
  }

  function fallbackPrompt() {
    return [
      "你是接入本系统的自动化智能体。",
      `第一步读取快速接入文档：${quickPath}`,
      `第二步读取完整能力文档：${fullPath}`,
      "先理解健康检查、任务状态、手机号注册、AT 升级、OA 接入的 API，再按用户目标调用本地 Web API 操作。",
    ].join("\n");
  }

  async function loadAgentDocs() {
    ensureAgentModal();
    const prompt = document.querySelector("#agent-prompt");
    const content = document.querySelector("#agent-doc-content");
    prompt.value = fallbackPrompt();
    content.textContent = "加载中...";
    try {
      const res = await fetch("/api/agent/docs");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      window.__agentDocs = data;
      document.querySelector("#agent-quick-path").textContent = data.quick?.path || quickPath;
      document.querySelector("#agent-full-path").textContent = data.full?.path || fullPath;
      prompt.value = fallbackPrompt();
      renderAgentDoc("quick");
    } catch (error) {
      content.textContent = `加载失败：${error.message}\n\n请让智能体直接读取：\n${quickPath}\n${fullPath}`;
    }
  }

  function renderAgentDoc(type) {
    const docs = window.__agentDocs || {};
    const doc = type === "full" ? docs.full : docs.quick;
    document.querySelectorAll("[data-agent-tab]").forEach((button) => {
      button.classList.toggle("active", button.dataset.agentTab === type);
    });
    document.querySelector("#agent-doc-content").textContent = doc?.content || "文档未加载";
  }

  async function copyText(text) {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
  }

  function notify(message) {
    const toast = document.querySelector("#toast");
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add("show");
    setTimeout(() => toast.classList.remove("show"), 2200);
  }

  function closeAgentModal() {
    document.querySelector("#agent-modal")?.classList.add("hidden");
  }

  function bindAgentModal() {
    document.querySelectorAll("[data-close-agent]").forEach((item) => {
      item.addEventListener("click", closeAgentModal);
    });
    document.querySelector("#reload-agent-docs")?.addEventListener("click", () => loadAgentDocs());
    document.querySelector("#copy-agent-prompt")?.addEventListener("click", async () => {
      await copyText(document.querySelector("#agent-prompt").value);
      notify("AI 接入提示词已复制");
    });
    document.querySelector("#copy-agent-paths")?.addEventListener("click", async () => {
      const docs = window.__agentDocs || {};
      await copyText([
        docs.quick?.path || quickPath,
        docs.full?.path || fullPath,
      ].join("\n"));
      notify("MD 地址已复制");
    });
    document.querySelectorAll("[data-agent-tab]").forEach((button) => {
      button.addEventListener("click", () => renderAgentDoc(button.dataset.agentTab));
    });
  }

  window.openAgentIntegration = async function () {
    ensureAgentModal();
    document.querySelector("#agent-modal").classList.remove("hidden");
    await loadAgentDocs();
  };

  document.addEventListener("click", (event) => {
    const target = event.target.closest("[data-agent-open]");
    if (!target) return;
    window.openAgentIntegration();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeAgentModal();
  });
})();
