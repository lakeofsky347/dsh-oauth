const STORE_KEY = "dsh-oauth-panel-v0";

const seedStatus = () => ({
  "openai-codex": {
    loggedIn: true,
    tokenPreview: "eyJhbG…c0de",
    sourceLabel: "本机登录",
    expiresAt: Date.now() + 5 * 60 * 60 * 1000,
    error: "",
  },
});

function loadState() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    /* keep the seed */
  }
  return seedStatus();
}

let status = loadState();
let toastTimer = 0;
let pendingId = null;
let authPopup = null;
let popupWatch = 0;

function save() {
  localStorage.setItem(STORE_KEY, JSON.stringify(status));
}

function toast(message) {
  const node = document.querySelector("#toast");
  node.textContent = message;
  node.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    node.hidden = true;
  }, 2400);
}

function expiresLabel(at) {
  if (!at) return "";
  const diff = at - Date.now();
  if (diff < 0) return "expired";
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins} 分钟后过期`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} 小时后过期`;
  return `${Math.floor(hours / 24)} 天后过期`;
}

function shield(on) {
  const stroke = "currentColor";
  if (on) {
    return `<svg class="mark on" viewBox="0 0 24 24" fill="none" stroke="${stroke}" stroke-width="1.8"><path d="M12 3 5 6v6c0 4.2 2.8 7.4 7 9 4.2-1.6 7-4.8 7-9V6l-7-3Z"/><path d="m9 12 2 2 4-4"/></svg>`;
  }
  return `<svg class="mark off" viewBox="0 0 24 24" fill="none" stroke="${stroke}" stroke-width="1.8"><path d="M12 3 5 6v6c0 4.2 2.8 7.4 7 9 4.2-1.6 7-4.8 7-9V6l-7-3Z"/><path d="m9.5 9.5 5 5M14.5 9.5l-5 5"/></svg>`;
}

function connectedCount() {
  return PROVIDERS.filter((provider) => status[provider.id]?.loggedIn).length;
}

let remote = null;

async function refreshRemote() {
  try {
    const response = await fetch("/oauth/api/providers");
    if (!response.ok) return;
    const body = await response.json();
    if (!Array.isArray(body.providers) || body.providers.length === 0) return;
    remote = body.providers;
    status = {};
    for (const provider of remote) {
      if (!provider.loggedIn) continue;
      status[provider.id] = {
        loggedIn: true,
        tokenPreview: provider.tokenPreview || "",
        sourceLabel: provider.sourceLabel || "本机登录",
        expiresAt: provider.expiresAt,
        error: provider.error || "",
      };
    }
    renderList();
  } catch {
    /* Standalone preview has no harness API. */
  }
}

function pullSummary(pulled) {
  const chat = pulled.filter((model) => model.role !== "image" && model.role !== "video");
  const media = pulled.filter((model) => model.role === "image" || model.role === "video");
  if (chat.length === 0 && media.length === 0) return "还没有从该 OAuth 账号拉取模型。适配器默认目录不会写入。";
  const lines = [];
  if (chat.length > 0) lines.push(`对话模型 ${chat.map((model) => escapeHtml(model.name || model.id)).join("、")}`);
  if (media.length > 0) lines.push(`生图和生视频自动使用 ${media.map((model) => escapeHtml(model.name || model.id)).join("、")}，当前对话模型保持不变`);
  return lines.join("。");
}

function shownProviders() {
  if (remote === null) return PROVIDERS;
  return remote;
}

function renderList() {
  const providers = shownProviders();
  const connected = providers.filter((provider) => status[provider.id]?.loggedIn).length;
  document.querySelector("#count").textContent =
    `已连接 ${connected}/${providers.length} 个 OAuth 提供商。点「登录」会弹出该提供商的认证页。`;
  document.querySelector("#rows").innerHTML = providers.map((provider) => {
    const row = status[provider.id] || {};
    const loggedIn = Boolean(provider.loggedIn || row.loggedIn);
    const pullExpiry = provider.pullExpiresAt ? expiresLabel(provider.pullExpiresAt) : "";
    const pulled = Array.isArray(provider.pulledModels) ? provider.pulledModels : [];
    const badges = [
      `<span class="badge">${FLOW_LABEL[provider.flow] || "浏览器登录"}</span>`,
      loggedIn ? `<span class="badge ok">已连接</span>` : "",
      pullExpiry === "expired" ? `<span class="badge bad">拉取已过期</span>` : "",
      pullExpiry && pullExpiry !== "expired" ? `<span class="badge">拉取 ${pullExpiry}</span>` : "",
    ].join("");
    const detail = loggedIn
      ? `<span class="meta"><span style="color:var(--faint)">token </span><code>${row.tokenPreview || provider.tokenPreview || "••••"}</code>${row.sourceLabel || provider.sourceLabel ? ` · ${row.sourceLabel || provider.sourceLabel}` : ""}</span>
         <span class="meta">${pullSummary(pulled)}</span>`
      : `<span class="hint">未连接。使用「登录」，或在终端运行下面的命令。</span>
         <div class="cli"><code>${provider.cli}</code><button class="btn" type="button" data-copy="${provider.id}">复制</button></div>`;
    const error = row.error ? `<span class="err">${row.error}</span>` : "";
    const waiting = pendingId === provider.id;
    const action = loggedIn
      ? `<button class="btn solid" type="button" data-pull="${provider.id}">拉取模型</button><button class="btn" type="button" data-disconnect="${provider.id}">断开连接</button>`
      : `<button class="btn solid" type="button" data-login="${provider.id}" ${waiting ? "disabled" : ""}>${waiting ? "登录中" : "登录"}</button>`;
    return `<div class="row">
      <div class="identity">
        ${shield(loggedIn)}
        <div>
          <div class="name-line"><span class="name">${provider.name}</span>${badges}</div>
          ${detail}
          ${error}
        </div>
      </div>
      <div class="actions">
        ${provider.docs && provider.docs !== "#" ? `<a class="icon-btn" href="${provider.docs}" target="_blank" rel="noopener noreferrer" title="打开 ${provider.name} 文档">↗</a>` : ""}
        ${action}
      </div>
    </div>`;
  }).join("");
}

async function pollUntilSettled(id) {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    await refreshRemote();
    if (status[id]?.loggedIn) {
      pendingId = null;
      renderList();
      toast("已连接");
      return;
    }
  }
}

function defaultLoginOpener(provider) {
  const url = new URL("auth.html", location.href);
  url.searchParams.set("provider", provider.id);
  return window.open(
    url.href,
    "dsh-oauth-auth",
    "popup=yes,width=480,height=640,left=80,top=80",
  );
}

async function openLogin(id) {
  const provider = shownProviders().find((item) => item.id === id);
  if (!provider) return;
  if (authPopup && !authPopup.closed) authPopup.close();
  pendingId = id;
  renderList();
  const custom = window.DshOAuth.loginOpener();
  if (custom) {
    authPopup = custom(provider);
  } else {
    try {
      const response = await fetch("/oauth/api/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: id }),
      });
      const body = await response.json();
      if (response.ok && body.url) {
        authPopup = window.open(body.url, "dsh-oauth-auth", "popup=yes,width=520,height=720");
        pollUntilSettled(id);
      } else if (!response.ok) {
        pendingId = null;
        renderList();
        toast(body.error || "登录没有开始");
        return;
      } else {
        authPopup = defaultLoginOpener(provider);
      }
    } catch {
      authPopup = defaultLoginOpener(provider);
    }
  }
  if (!authPopup) {
    pendingId = null;
    renderList();
    toast("浏览器拦截了认证窗口");
    return;
  }
  window.clearInterval(popupWatch);
  popupWatch = window.setInterval(() => {
    if (!authPopup || authPopup.closed) {
      window.clearInterval(popupWatch);
      const closedId = id;
      window.setTimeout(() => {
        if (pendingId === closedId) {
          pendingId = null;
          renderList();
        }
      }, 300);
    }
  }, 400);
}

async function markConnected(provider) {
  if (remote !== null) {
    pendingId = null;
    await refreshRemote();
    return;
  }
  const allowed = await window.DshOAuth.runAuthorizeHooks(provider);
  pendingId = null;
  window.clearInterval(popupWatch);
  if (!allowed) {
    renderList();
    toast(`${provider.name} 未写入登录`);
    return;
  }
  status[provider.id] = {
    loggedIn: true,
    tokenPreview: `${provider.id.slice(0, 4)}…${Math.random().toString(36).slice(2, 6)}`,
    sourceLabel: "浏览器授权",
    expiresAt: Date.now() + 60 * 60 * 1000,
    error: "",
  };
  save();
  renderList();
  toast(`${provider.name} 已连接`);
}

window.addEventListener("message", (event) => {
  if (event.origin !== location.origin) return;
  const data = event.data;
  if (!data || data.type !== "dsh-oauth") return;
  const provider = PROVIDERS.find((item) => item.id === data.provider);
  if (!provider || pendingId !== provider.id) return;
  if (data.ok) void markConnected(provider);
  else {
    pendingId = null;
    renderList();
  }
});

let pendingDisconnect = null;

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  })[ch]);
}

function localStamp(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function renderPull(provider, models, error) {
  const root = document.querySelector("#modal");
  root.hidden = false;
  const chat = models.filter((model) => (model.role || "chat") === "chat");
  const media = models.filter((model) => model.role === "image" || model.role === "video");
  const selected = new Set((provider.pulledModels || []).filter((model) => model.role !== "image" && model.role !== "video").map((model) => model.id));
  const includeNewFast = chat.some((model) => model.id === "grok-4.7-build-fast") && !selected.has("grok-4.7-build-fast");
  const choices = error ? "" : chat.map((model) => `
    <label class="choice">
      <input type="checkbox" value="${escapeHtml(model.id)}" ${selected.size === 0 || includeNewFast || selected.has(model.id) ? "checked" : ""} />
      <span>${escapeHtml(model.name)}</span>
      <code>${escapeHtml(model.id)}</code>
    </label>`).join("");
  const mediaNote = media.length === 0
    ? ""
    : `<p class="hint">生图和生视频会自动使用 ${media.map((model) => escapeHtml(model.name || model.id)).join("、")}。请求留在当前对话里，不会改成这些模型。</p>`;
  root.innerHTML = `<div class="overlay" data-backdrop="1">
    <div class="dialog pull-dialog" role="dialog" aria-modal="true">
      <h2>从 ${provider.name} 拉取模型</h2>
      <p class="hint">对话模型只来自这次 OAuth 账号的订阅目录。适配器自带目录不会被填进来。</p>
      ${mediaNote}
      ${error ? `<p class="err">${error}</p>` : `<div class="choices">${choices}</div>`}
      <label class="expiry-label" for="pull-expiry">过期时间</label>
      <input class="field" id="pull-expiry" type="datetime-local" required />
      <div class="chips">
        <button class="btn" type="button" data-hours="1">1 小时</button>
        <button class="btn" type="button" data-hours="8">8 小时</button>
        <button class="btn" type="button" data-hours="24">1 天</button>
        <button class="btn" type="button" data-hours="168">7 天</button>
        <button class="btn" type="button" data-hours="720">30 天</button>
      </div>
      <div class="row-actions">
        <button class="btn" type="button" id="cancel-pull">取消</button>
        <button class="btn solid" type="button" id="confirm-pull" ${error ? "disabled" : ""}>写入所选模型</button>
      </div>
    </div>
  </div>`;
  const field = document.querySelector("#pull-expiry");
  const existing = provider.pullExpiresAt && provider.pullExpiresAt > Date.now() ? new Date(provider.pullExpiresAt) : null;
  field.value = localStamp(existing ?? new Date(Date.now() + 24 * 60 * 60 * 1000));
}

async function openPull(id) {
  const provider = shownProviders().find((item) => item.id === id);
  if (!provider) return;
  const root = document.querySelector("#modal");
  root.hidden = false;
  root.innerHTML = `<div class="overlay"><div class="dialog"><h2>正在拉取 ${provider.name}</h2><p class="hint">向该 OAuth 账号请求模型列表。</p></div></div>`;
  let models = [];
  let error = "";
  try {
    const response = await fetch("/oauth/api/models", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: id }),
    });
    const body = await response.json();
    if (!response.ok) error = body.error || "拉取失败";
    else models = body.models || [];
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  }
  renderPull(provider, models, error);
}

async function confirmPull(id) {
  const provider = shownProviders().find((item) => item.id === id);
  const picked = [...document.querySelectorAll(".choice input:checked")].map((input) => input.value);
  const raw = document.querySelector("#pull-expiry")?.value;
  const expiresAt = raw ? new Date(raw).getTime() : NaN;
  if (!Number.isFinite(expiresAt)) {
    toast("请选择过期时间");
    return;
  }
  const response = await fetch("/oauth/api/pull", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider: id, models: picked, expiresAt }),
  });
  const body = await response.json();
  if (!response.ok) {
    toast(body.error || "没有写入");
    return;
  }
  document.querySelector("#modal").hidden = true;
  pullTarget = null;
  await refreshRemote();
  toast(`${provider?.name || id} 已写入 ${body.models?.length || picked.length} 个模型`);
}

let pullTarget = null;

function disconnect(id) {
  pendingDisconnect = shownProviders().find((item) => item.id === id);
  const root = document.querySelector("#modal");
  root.hidden = false;
  root.innerHTML = `<div class="overlay" data-backdrop="1">
    <div class="dialog" role="dialog" aria-modal="true">
      <h2>断开 ${pendingDisconnect.name}？</h2>
      <p class="hint">这会删掉面板里保存的登录记录。之后需要重新认证才能再用这个提供商。</p>
      <div class="row-actions">
        <button class="btn" type="button" id="cancel-disconnect">取消</button>
        <button class="btn solid" type="button" id="confirm-disconnect">断开连接</button>
      </div>
    </div>
  </div>`;
}

document.querySelector("#refresh").addEventListener("click", () => {
  status = loadState();
  renderList();
});

document.querySelector("#reset").addEventListener("click", () => {
  status = seedStatus();
  save();
  renderList();
  toast("已恢复示例数据");
});

document.querySelector("#rows").addEventListener("click", async (event) => {
  const target = event.target.closest("button");
  if (!target) return;
  if (target.dataset.login) openLogin(target.dataset.login);
  if (target.dataset.pull) {
    pullTarget = target.dataset.pull;
    void openPull(target.dataset.pull);
  }
  if (target.dataset.disconnect) disconnect(target.dataset.disconnect);
  if (target.dataset.copy) {
    const provider = PROVIDERS.find((item) => item.id === target.dataset.copy);
    await navigator.clipboard.writeText(provider.cli);
    toast("已复制");
  }
});

document.querySelector("#modal").addEventListener("click", async (event) => {
  const hours = event.target.dataset?.hours;
  if (hours) {
    const field = document.querySelector("#pull-expiry");
    if (field) field.value = localStamp(new Date(Date.now() + Number(hours) * 60 * 60 * 1000));
    return;
  }
  if (event.target.id === "cancel-pull" || (event.target.dataset.backdrop && pullTarget && !pendingDisconnect)) {
    pullTarget = null;
    document.querySelector("#modal").hidden = true;
    return;
  }
  if (event.target.id === "confirm-pull" && pullTarget) {
    await confirmPull(pullTarget);
    return;
  }
  if (event.target.id === "cancel-disconnect" || (event.target.dataset.backdrop && pendingDisconnect)) {
    pendingDisconnect = null;
    document.querySelector("#modal").hidden = true;
    return;
  }
  if (event.target.id === "confirm-disconnect" && pendingDisconnect) {
    const provider = pendingDisconnect;
    pendingDisconnect = null;
    delete status[provider.id];
    save();
    if (remote !== null) {
      void fetch("/oauth/api/logout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: provider.id }),
      }).then(() => refreshRemote());
    }
    document.querySelector("#modal").hidden = true;
    renderList();
    toast(`${provider.name} 已断开`);
  }
});

document.addEventListener("dsh-oauth-providers", () => renderList());

renderList();
void refreshRemote();
