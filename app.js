const STORE_KEY = "dsh-oauth-preview-v1";
let locale = "zh";
try { locale = localStorage.getItem("dsh-oauth-locale") === "en" ? "en" : "zh"; } catch { /* Optional UI preference. */ }
const tr = (zh, en) => locale === "en" ? (en || zh) : zh;
const number = (value) => {
  if (value === null || value === undefined || value === "") return tr("未知", "Unknown");
  const parsed = Number(value);
  return Number.isFinite(parsed) ? new Intl.NumberFormat(locale === "en" ? "en" : "zh-CN", { maximumFractionDigits: 6 }).format(parsed) : String(value);
};
const dateLabel = (value) => {
  const date = new Date(value);
  return value != null && Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat(locale === "en" ? "en" : "zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(date) : tr("未知", "Unknown");
};
const usageResults = new Map();
const usageBusy = new Set();
const usageOpen = new Set();
const revisions = new Map();
let connectionTarget = null;
let localTarget = null;
let pullModels = [];
let pullError = "";
let pullSaving = false;
let modalReturnFocus = null;
let modalSerial = 0;

function modalStart() {
  if (document.querySelector("#modal").hidden) modalReturnFocus = document.activeElement;
}
function focusDialog() {
  const dialog = document.querySelector("#modal .dialog");
  if (!dialog) return;
  dialog.setAttribute("tabindex", "-1");
  if (!dialog.querySelector("[data-modal-locale]")) {
    const label = document.createElement("label");
    label.className = "locale-label modal-locale";
    label.innerHTML = `${tr("语言", "Language")} <select data-modal-locale aria-label="${tr("界面语言", "Interface language")}"><option value="zh">简体中文</option><option value="en">English</option></select>`;
    label.querySelector("select").value = locale;
    dialog.append(label);
  }
  if (!dialog.contains(document.activeElement)) dialog.focus?.();
}
function closeModal() {
  const root = document.querySelector("#modal");
  root.hidden = true;
  root.innerHTML = "";
  connectionTarget = null;
  localTarget = null;
  pullTarget = null;
  pendingDisconnect = null;
  modalSerial++;
  if (modalReturnFocus?.isConnected) modalReturnFocus.focus?.();
}
function invalidateUsage(id) {
  revisions.set(id, (revisions.get(id) || 0) + 1);
  usageResults.delete(id);
  usageBusy.delete(id);
}
function requestError(body, fallback) {
  return body?.message || body?.error || fallback || tr("请求失败，请重试。", "Request failed. Please try again.");
}
async function post(path, body) {
  const response = await fetch(`/oauth/api/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  let result;
  try { result = await response.json(); } catch { throw new Error(tr("服务返回了无效响应。", "The service returned an invalid response.")); }
  if (!response.ok) throw new Error(requestError(result));
  return result;
}
function updateStaticText() {
  document.documentElement.lang = locale === "en" ? "en" : "zh-CN";
  document.title = tr("dsh-oauth · 订阅连接", "dsh-oauth · Subscription connections");
  const set = (selector, text) => { const node = document.querySelector(selector); if (node) node.textContent = text; };
  set("#page-kicker", tr("设置 · 订阅连接", "Settings · Subscriptions"));
  set("#page-title", tr("OAuth 认证", "OAuth authentication"));
  set("#providers-title", tr("提供商登录与订阅", "Provider connections & subscriptions"));
  set("#reset", tr("恢复示例", "Reset examples"));
  const nav = document.querySelectorAll(".nav button");
  [tr("密钥", "API keys"), "OAuth", tr("模型路由", "Model routing")].forEach((text, i) => { if (nav[i]) nav[i].textContent = text; });
  document.querySelector("#refresh")?.setAttribute("aria-label", tr("刷新连接状态", "Refresh connections"));
  const selector = document.querySelector("#locale");
  if (selector) selector.value = locale;
}
const hostedPanel = /^\/oauth(?:\/|$)/.test(location.pathname);
let apiMode = hostedPanel ? "checking" : "preview";

const seedStatus = () => ({
  "openai-codex": {
    loggedIn: true,
    tokenPreview: "示例，无真实凭据",
    sourceLabel: "静态预览",
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

let status = apiMode === "preview" ? loadState() : {};
let toastTimer = 0;
let pendingId = null;
let authPopup = null;
let popupWatch = 0;
let activeLogin = null;
let loginPoll = 0;
let loginRenderKey = "";
let unloaded = false;

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
  const diff = new Date(at).getTime() - Date.now();
  if (diff < 0) return "expired";
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return tr(`${number(mins)} 分钟后过期`, `expires in ${number(mins)} minutes`);
  const hours = Math.floor(mins / 60);
  if (hours < 24) return tr(`${number(hours)} 小时后过期`, `expires in ${number(hours)} hours`);
  return tr(`${number(Math.floor(hours / 24))} 天后过期`, `expires in ${number(Math.floor(hours / 24))} days`);
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
  if (!hostedPanel) return false;
  try {
    const response = await fetch("/oauth/api/providers", { cache: "no-store" });
    if (!response.ok) throw new Error(`提供商接口返回 ${response.status}`);
    const body = await response.json();
    if (!Array.isArray(body.providers)) throw new Error("提供商接口返回格式不正确");
    apiMode = "live";
    for (const previous of remote || []) {
      const next = body.providers.find((item) => item.id === previous.id);
      if (!next?.loggedIn || JSON.stringify(previous.connection) !== JSON.stringify(next.connection)) invalidateUsage(previous.id);
    }
    remote = body.providers;
    status = {};
    for (const provider of remote) {
      status[provider.id] = {
        loggedIn: Boolean(provider.loggedIn),

        sourceLabel: provider.sourceLabel || "本机登录",
        expiresAt: provider.expiresAt,
        error: provider.error || "",
      };
    }
    renderList();
    return true;
  } catch {
    apiMode = "unavailable";
    renderList();
    return false;
  }
}

function pullSummary(pulled, provider) {
  if (!pulled.length && provider?.pullable === false) return provider.supportReason === "host-oauth-model-integration-unavailable"
    ? tr("可查询套餐用量；当前宿主尚未接入此来源的模型调用。", "Plan usage can be queried; model access for this source is not integrated with the current host.")
    : tr("此来源暂不支持保存模型配置。", "Saving model configuration is not available for this source.");
  if (!pulled.length) return tr("尚未保存模型。连接后可获取模型与能力。", "No models saved. Fetch models and capabilities after connecting.");
  return tr(`已保存 ${pulled.length} 个模型：`, `Models saved: ${pulled.length} · `) + pulled.map((model) => escapeHtml(model.name || model.id)).join(locale === "en" ? ", " : "、");
}
function providerConnectionHint(provider) {
  if (provider.sourceStatus) return provider.sourceStatus === "source-reauth-required"
    ? tr("本机授权已到期，请在源 CLI 中续期。", "Local authorization expired. Renew it in the source CLI.")
    : tr("本机授权来源不可用，请重新选择或断开连接。", "Local authorization is unavailable. Select a source again or disconnect.");
  if (provider.supportReason === "gemini-consumer-retired") return tr(
    "Gemini CLI 个人订阅登录已停用。个人 Google 订阅请在 Antigravity CLI 中登录。",
    "Gemini CLI consumer sign-in ended. Use Antigravity CLI for a personal Google subscription.",
  );
  if (provider.supportReason === "qwen-legacy-oauth") return tr(
    "此入口保留已有的旧版 OAuth。新连接请使用阿里云 Token Plan。",
    "This entry retains existing legacy OAuth connections. Use Alibaba Cloud Token Plan for new connections.",
  );
  if (provider.id === "anthropic") return tr(
    "使用 Claude Console API Key 连接。Claude Code 订阅由其官方客户端管理。",
    "Connect with a Claude Console API key. The official client manages Claude Code subscriptions.",
  );
  if (provider.keyConnect) return tr("可使用套餐密钥连接。调用与用量查询可能需要不同权限。", "Connect with a plan key. Model access and usage queries may require different permissions.");
  return provider.pullable === false
    ? tr("未连接。可用功能以此来源与宿主的支持范围为准。", "Not connected. Available features depend on this source and the host integration.")
    : tr("未连接。登录后可获取模型与套餐信息。", "Not connected. Sign in to fetch models and plan information.");
}
function shownProviders() { return remote === null ? PROVIDERS : remote; }
function flowLabel(provider) {
  if (provider.authMethods?.length === 0) return tr("连接待支持", "Connection unavailable");
  if (provider.authMethods?.includes("key") && !provider.authMethods.includes("oauth")) return tr("密钥连接", "API key");
  if (provider.flow === "device_code") return tr("设备码登录", "Device code");
  if (provider.flow === "external" || provider.authMethods?.[0] === "local") return tr("本机授权", "Local authorization");
  return tr("浏览器登录", "Browser login");
}
function usageStatus(value) {
  return ({ fresh: tr("已更新", "Updated"), partial: tr("部分数据可用", "Partial data"), stale: tr("上次成功数据 · 本次更新失败", "Last successful data · refresh failed"), unsupported: tr("此来源暂不提供用量", "Usage unavailable for this source"), "reauth-required": tr("需要重新授权", "Authorization required"), "needs-permission": tr("需要查询权限", "Usage permission required"), "needs-configuration": tr("需要补充查询配置", "Usage configuration required"), "rate-limited": tr("查询被限速", "Usage query rate-limited"), unavailable: tr("暂时无法查询", "Temporarily unavailable") })[value] || tr("尚未查询", "Not queried yet");
}
function unitLabel(unit, currency) {
  return currency || ({ percent: "%", requests: tr("次请求", "requests"), tokens: "tokens", credits: tr("积分", "credits"), points: tr("积分", "points"), flows: "Flows", money: tr("金额", "amount") })[unit] || unit || "";
}
function usageNote(note) {
  const value = typeof note === "string" ? note : note.message || note.code || "";
  const labels = {
    "management-balance-has-independent-account-scope": ["管理密钥余额属于该密钥账户，可能与调用密钥范围不同。", "The management-key balance belongs to its own account and may differ from the model key's scope."],
    "account-balance-needs-permission": ["账户余额需要额外查询权限。", "Account balance requires additional permission."],
    "account-balance-unavailable": ["账户余额暂不可用。", "Account balance is unavailable."],
    "subscription-active": ["订阅有效。", "Subscription active."],
    "subscription-inactive": ["订阅未启用。", "Subscription inactive."],
    "subscription-quota-unknown": ["订阅可用额度未知。", "Available subscription quota is unknown."],
    "subscription-detail-unavailable": ["未提供订阅明细。", "Subscription details are unavailable."],
    "payg-balance-unavailable": ["按量付费余额暂不可用。", "PAYG balance is unavailable."],
    "monthly-usage-not-provided": ["未提供本月用量。", "Monthly usage was not provided."],
    "per-model-budget-details-unavailable": ["未提供逐模型预算明细。", "Per-model budget details are unavailable."],
    "workspace-wallet-not-included": ["此结果不包含工作区钱包余额。", "This result does not include the workspace wallet balance."],
    "credit-balance-unavailable": ["积分余额暂不可用。", "Credit balance is unavailable."],
    "pass-detail-unavailable": ["未提供订阅 Pass 明细。", "Subscription Pass details are unavailable."],
    "internal-billing-api": ["数据来自此平台的内部账单接口。", "Data comes from the platform's internal billing API."],
    "points-balance-not-currency": ["此余额以积分计量，并非货币余额。", "This balance is measured in points, not currency."],
    "subscription-split-and-reset-not-provided": ["未提供订阅与充值分项或重置时间。", "Subscription/top-up breakdown and reset time were not provided."],
    "incremental-regeneration-not-full-reset": ["恢复时间表示部分额度补充，并非全部重置。", "Recovery time indicates a partial refill, not a full reset."],
    "legacy-quota-schema": ["提供商返回旧版额度格式。", "The provider returned its legacy quota format."],
    "no-subscription": ["未检测到订阅。", "No subscription was reported."],
    "payg-balance-not-provided": ["未提供按量付费余额。", "PAYG balance was not provided."],
    "allowance-is-payg-equivalent-not-wallet": ["此额度按按量价格等值计量，并非钱包余额。", "This allowance uses PAYG-equivalent units; it is not a wallet balance."],
    "four-hour-fixed-server-bucket": ["此窗口按服务端固定的 4 小时时段统计。", "This window follows a fixed four-hour server interval."],
    "daily-request-quota-not-included": ["此结果不包含每日请求数额度。", "This result does not include the daily request allowance."],
    "billing-route-subscription": ["提供商建议使用订阅计费。", "The provider recommends subscription billing."],
    "billing-route-paygo": ["提供商建议使用按量计费。", "The provider recommends PAYG billing."],
    "billing-route-unavailable": ["提供商未报告可用计费路径。", "The provider reports no available billing route."],
    "The provider reports an exhausted allowance.": ["提供商报告此项额度已用尽。", "The provider reports an exhausted allowance."],
    "Extra usage amounts are converted from cents; the response did not identify a currency.": ["额外用量金额已从分换算；提供商没有返回币种。", "Extra usage amounts are converted from cents; the response did not identify a currency."],
    "Copilot reports AI-credit billing; this is not a premium-request count.": ["Copilot 返回 AI 积分账单，此数值不是高级请求次数。", "Copilot reports AI-credit billing; this is not a premium-request count."],
    "A service not included in this plan was omitted.": ["已略去此套餐不包含的服务。", "A service not included in this plan was omitted."],
    "MiniMax legacy counters are interpreted as remaining counts.": ["MiniMax 旧版计数字段按剩余次数解释。", "MiniMax legacy counters are interpreted as remaining counts."],
    "Read-only remote quota summary; no project onboarding is performed.": ["这是只读远程额度摘要，不会为项目开通服务。", "Read-only remote quota summary; no project onboarding is performed."],
    "Total usable credits overlap the component balances; do not add them together.": ["可用积分总额与分项余额重叠，请勿相加。", "Total usable credits overlap the component balances; do not add them together."],
  };
  if (labels[value]) return tr(...labels[value]);
  const limited = /^(rolling|weekly|monthly)-rate-limited$/.exec(value);
  if (limited) return tr(`${({ rolling: "滚动", weekly: "每周", monthly: "每月" })[limited[1]]}窗口已触及限额。`, `${limited[1]} window is rate-limited.`);
  const multiplier = /^Weekly allowance multiplier: ([0-9.]+)\. Percentages retain the provider's base allowance\.$/.exec(value);
  return multiplier ? tr(`每周额度倍数为 ${number(multiplier[1])}；百分比仍以提供商基础额度为基准。`, value) : value;
}
function usageHtml(provider) {
  if (!usageOpen.has(provider.id)) return "";
  const result = usageResults.get(provider.id);
  const snapshot = result?.snapshot;
  const busy = usageBusy.has(provider.id);
  const windows = Array.isArray(snapshot?.windows) ? snapshot.windows : [];
  const balances = Array.isArray(snapshot?.balances) ? snapshot.balances : [];
  const plan = typeof snapshot?.plan === "string" ? snapshot.plan : snapshot?.plan?.name || snapshot?.plan?.id;
  const source = snapshot?.source;
  const sourceText = typeof source === "string" ? source : source?.kind;
  return `<section class="usage-panel" aria-label="${tr("套餐与用量", "Plan and usage")}" data-usage-panel="${escapeHtml(provider.id)}">
    <div class="usage-heading"><strong>${escapeHtml(plan || tr("套餐信息未提供", "Plan information not provided"))}</strong><span class="badge ${result?.status === "fresh" ? "ok" : ""}">${busy ? tr("正在查询…", "Checking…") : usageStatus(result?.status)}</span></div>
    ${snapshot?.plan?.renewsAt ? `<p class="quota-foot">${tr("套餐续期", "Plan renews")}: ${escapeHtml(dateLabel(snapshot.plan.renewsAt))}</p>` : ""}
    ${windows.map((window) => {
      const percent = Number.isFinite(window.usedPercent) ? window.usedPercent : Number.isFinite(window.remainingPercent) ? 100 - window.remainingPercent : null;
      const quantities = [["used", tr("已用", "Used")], ["remaining", tr("剩余", "Remaining")], ["limit", tr("上限", "Limit")]].filter(([key]) => window[key] !== undefined && window[key] !== null).map(([key, title]) => `${title} ${number(window[key])} ${unitLabel(window.unit, window.currency)}`).join(" · ");
      const label = window.label || window.id || tr("额度", "Quota");
      const reset = window.resetAt || window.resetsAt;
      return `<div class="quota-item ${percent > 100 ? "over" : ""}" data-window-id="${escapeHtml(window.id || "")}">
        <div class="quota-line"><span>${escapeHtml(label)}</span><span>${window.unlimited ? tr("无此项上限", "No limit on this metric") : percent !== null ? escapeHtml(tr(`已用 ${number(percent)}%`, `${number(percent)}% used`)) : tr("用量比例未知", "Usage percentage unknown")}</span></div>
        ${percent !== null && !window.unlimited ? `<div class="quota-meter" role="meter" aria-label="${escapeHtml(label)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.max(0, Math.min(100, percent))}" aria-valuetext="${escapeHtml(tr(`已用 ${number(percent)}%`, `${number(percent)}% used`))}"><span style="width:${Math.max(0, Math.min(100, percent))}%"></span></div>` : ""}
        ${quantities ? `<p class="quota-foot">${escapeHtml(quantities)}</p>` : ""}
        ${window.scope ? `<p class="quota-foot">${tr("适用范围", "Scope")}: ${escapeHtml(typeof window.scope === "string" ? window.scope : JSON.stringify(window.scope))}</p>` : ""}
        ${reset ? `<p class="quota-foot">${tr("额度重置", "Quota resets")}: ${escapeHtml(dateLabel(reset))}</p>` : ""}
        ${window.nextRegenAt ? `<p class="quota-foot">${tr("下次部分恢复", "Next partial recovery")}: ${escapeHtml(dateLabel(window.nextRegenAt))}${Number.isFinite(window.nextRegenPercent) ? ` · ${number(window.nextRegenPercent)}%` : ""}</p>` : ""}
      </div>`;
    }).join("")}
    ${balances.length ? `<dl class="usage-balances">${balances.map((balance) => `<div><dt>${escapeHtml(balance.label || balance.kind || balance.id || tr("余额", "Balance"))}${balance.scope ? ` · ${escapeHtml(balance.scope)}` : ""}</dt><dd>${escapeHtml(number(balance.amount))} ${escapeHtml(unitLabel(balance.unit, balance.currency))}${balance.expiresAt ? `<p class="quota-foot">${tr("到期", "Expires")}: ${escapeHtml(dateLabel(balance.expiresAt))}</p>` : ""}</dd></div>`).join("")}</dl>` : ""}
    ${snapshot && !windows.length && !balances.length ? `<p class="hint">${tr("服务端没有提供可显示的额度或余额。", "The service did not provide quota or balance values.")}</p>` : ""}
    ${(Array.isArray(snapshot?.notes) ? snapshot.notes : []).map((note) => `<p class="hint">${escapeHtml(usageNote(note))}</p>`).join("")}
    ${result?.status === "needs-permission" || result?.status === "needs-configuration" ? `<p class="hint">${tr("请在「连接配置」中补充查询授权或账户、工作区、项目范围。调用授权仍保持连接。", "Add the usage credential or account, workspace and project scope in Connection settings. Model authorization remains connected.")}</p>` : ""}
    ${result?.message ? `<p class="hint">${escapeHtml(result.message)}</p>` : ""}
    ${snapshot ? `<p class="quota-foot">${tr("数据时间", "Observed")}: ${escapeHtml(dateLabel(snapshot.observedAt || snapshot.fetchedAt))}${sourceText ? ` · ${tr("来源", "Source")}: ${escapeHtml(sourceText)}` : ""}</p>` : ""}
    ${result?.lastAttemptAt ? `<p class="quota-foot">${tr("最近查询", "Last attempt")}: ${escapeHtml(dateLabel(result.lastAttemptAt))}${result.lastErrorStatus ? ` · ${escapeHtml(usageStatus(result.lastErrorStatus))}` : ""}</p>` : ""}
    ${result?.retryAt ? `<p class="quota-foot">${tr("可重试时间", "Retry after")}: ${escapeHtml(dateLabel(result.retryAt))}</p>` : ""}
    <button class="btn" type="button" data-usage="${escapeHtml(provider.id)}" ${busy || apiMode !== "live" ? "disabled" : ""}>${tr("刷新用量", "Refresh usage")}</button>
  </section>`;
}
function renderList() {
  const providers = shownProviders();
  const connected = providers.filter((provider) => status[provider.id]?.loggedIn).length;
  document.querySelector("#count").textContent = apiMode === "preview"
    ? tr(`静态示例 · ${connected}/${providers.length} 个示例连接。演示操作不会登录账号或保存真实凭据。`, `Static examples · ${connected}/${providers.length} connected. Demo actions do not sign in or save real credentials.`)
    : apiMode === "checking" ? tr("正在连接本机 OAuth 服务…", "Connecting to the local OAuth service…")
      : apiMode === "unavailable" ? tr("本机 OAuth 服务不可用。请检查 Harness 服务后刷新；当前显示上次读取的状态。", "Local OAuth service unavailable. Check Harness and refresh. Previously read status is shown.")
        : tr(`已连接 ${connected}/${providers.length} 个提供商。凭据由本机服务保存。`, `${connected}/${providers.length} providers connected. Credentials are stored by the local service.`);
  document.querySelector("#reset").hidden = apiMode !== "preview";
  const lead = document.querySelector(".lead");
  if (lead) lead.textContent = apiMode === "preview"
    ? tr("这是 dsh-oauth 的静态预览。示例授权和连接状态只用于查看界面，不会访问提供商或写入本机凭据。", "This is a static dsh-oauth preview. Example connections do not access providers or save credentials.")
    : tr("连接订阅账号或套餐密钥，保存可用模型与能力，并查询提供商实际返回的套餐用量。", "Connect subscription accounts or plan keys, save models and capabilities, and view usage reported by the provider.");
  document.querySelector("#rows").innerHTML = providers.map((provider) => {
    const id = escapeHtml(provider.id);
    const row = status[provider.id] || {};
    const loggedIn = Boolean(row.loggedIn);
    const browserReady = provider.id !== "xai" || apiMode === "preview" || provider.loginMethods?.includes("browser");
    const oauth = !provider.authMethods || provider.authMethods.includes("oauth");
    const pullExpiry = provider.pullExpiresAt ? expiresLabel(provider.pullExpiresAt) : "";
    const pulled = Array.isArray(provider.pulledModels) ? provider.pulledModels : [];
    const badges = [`<span class="badge">${flowLabel(provider)}</span>`, loggedIn ? `<span class="badge ok">${apiMode === "preview" ? tr("示例连接", "Example") : tr("已连接", "Connected")}</span>` : "", provider.pullPermanent && pulled.length ? `<span class="badge">${tr("模型持续启用", "Models stay enabled")}</span>` : "", pullExpiry === "expired" ? `<span class="badge bad">${tr("模型配置已到期", "Model configuration expired")}</span>` : pullExpiry ? `<span class="badge">${escapeHtml(pullExpiry)}</span>` : ""].join("");
    const connection = provider.connection || {};
    const context = [connection.label, connection.sourceLabel || provider.sourceLabel, connection.region, connection.organizationId, connection.workspaceId, connection.projectId].filter(Boolean);
    const detail = loggedIn ? `<span class="meta connection-summary">${escapeHtml(context.join(" · ") || tr("授权已保存", "Authorization saved"))}</span><span class="meta">${pullSummary(pulled, provider)}</span>`
      : `<span class="hint">${providerConnectionHint(provider)}</span>${provider.cli ? `<div class="cli"><code>${escapeHtml(provider.cli)}</code><button class="btn" type="button" data-copy="${id}">${tr("复制", "Copy")}</button></div>` : ""}`;
    const disabled = pendingId || apiMode === "checking" || apiMode === "unavailable";
    const action = loggedIn
      ? `${provider.pullable === false ? "" : `<button class="btn solid" type="button" data-pull="${id}" ${apiMode !== "live" || pendingId ? "disabled" : ""}>${tr("拉取模型", "Fetch models")}</button>`}${apiMode === "live" ? `<button class="btn" type="button" data-configure="${id}">${tr("连接配置", "Connection settings")}</button>${!usageOpen.has(provider.id) ? `<button class="btn" type="button" data-usage="${id}" ${usageBusy.has(provider.id) ? "disabled" : ""}>${tr("套餐与用量", "Plan & usage")}</button>` : ""}` : ""}<button class="btn" type="button" data-disconnect="${id}" ${disabled ? "disabled" : ""}>${apiMode === "preview" ? tr("移除示例", "Remove example") : tr("断开连接", "Disconnect")}</button>`
      : `${oauth ? `<button class="btn solid" type="button" data-login="${id}" ${disabled || !browserReady ? "disabled" : ""}>${pendingId === provider.id ? tr("登录中", "Signing in") : apiMode === "preview" ? tr("演示登录", "Demo sign-in") : provider.id === "xai" ? tr("浏览器登录", "Browser sign-in") : tr("登录", "Sign in")}</button>` : ""}${provider.keyConnect && apiMode === "live" ? `<button class="btn ${oauth ? "" : "solid"}" type="button" data-connect="${id}" ${disabled ? "disabled" : ""}>${tr("连接密钥", "Connect key")}</button>` : ""}${provider.id === "xai" && apiMode !== "preview" ? `<button class="btn" type="button" data-login="xai" data-login-method="device" ${disabled ? "disabled" : ""}>${tr("设备码备用", "Use device code")}</button>` : ""}${provider.authMethods?.includes("local") && apiMode === "live" ? `<button class="btn" type="button" data-local="${id}">${tr("复用本机授权", "Reuse local authorization")}</button>` : ""}${!oauth && !provider.keyConnect && !provider.authMethods?.includes("local") && !provider.supportReason ? `<span class="hint">${tr("此来源尚未支持连接", "Connection not available for this source")}</span>` : ""}`;
    return `<div class="row" data-provider="${id}"><div class="identity">${shield(loggedIn)}<div><div class="name-line"><span class="name">${escapeHtml(provider.name)}</span>${badges}</div>${detail}${row.error ? `<span class="err">${escapeHtml(row.error)}</span>` : ""}${!browserReady && apiMode === "live" ? `<span class="hint">${tr("当前服务尚未加载浏览器登录，请重新启动 DSH 以启用新版路线。", "Restart DSH to load browser sign-in support.")}</span>` : ""}${loggedIn ? usageHtml(provider) : ""}</div></div><div class="actions">${provider.docs && safeAuthorizationUrl(provider.docs) ? `<a class="icon-btn" href="${escapeHtml(provider.docs)}" target="_blank" rel="noopener noreferrer" aria-label="${escapeHtml(tr(`打开 ${provider.name} 文档`, `Open ${provider.name} documentation`))}">↗</a>` : ""}${action}${provider.cliCatalog && apiMode === "live" ? `<button class="btn" type="button" data-pull="${id}">${tr("查看 AGY CLI 模型", "View AGY CLI models")}</button>` : ""}${!loggedIn && provider.sourceStatus && provider.credentialConfigured ? `<button class="btn" type="button" data-disconnect="${id}">${tr("断开连接", "Disconnect")}</button>` : ""}</div></div>`;
  }).join("");
}
async function refreshUsage(id) {
  const provider = shownProviders().find((item) => item.id === id);
  if (!provider || !status[id]?.loggedIn || apiMode !== "live" || usageBusy.has(id)) return;
  usageOpen.add(id);
  if (provider.usageSupported === false) {
    usageResults.set(id, { status: "unsupported" }); renderList(); return;
  }
  const revision = revisions.get(id) || 0;
  const previous = usageResults.get(id);
  usageBusy.add(id); renderList();
  try {
    const result = await post("usage", { provider: id, force: Boolean(previous) });
    if ((revisions.get(id) || 0) !== revision || !status[id]?.loggedIn) return;
    usageResults.set(id, result);
  } catch (error) {
    if ((revisions.get(id) || 0) !== revision || !status[id]?.loggedIn) return;
    usageResults.set(id, { status: previous?.snapshot ? "stale" : "unavailable", ...(previous?.snapshot ? { snapshot: previous.snapshot } : {}), message: error.message, lastAttemptAt: new Date().toISOString() });
  } finally {
    if ((revisions.get(id) || 0) === revision) usageBusy.delete(id);
    renderList();
  }
}

function defaultLoginOpener(provider, preview = false) {
  const url = new URL("auth.html", location.href);
  url.searchParams.set("provider", provider.id);
  url.searchParams.set("locale", locale);
  if (preview) url.searchParams.set("preview", "1");
  return provider.id === "xai" && !preview
    ? window.open(url.href, "_blank")
    : window.open(url.href, "dsh-oauth-auth", "popup=yes,width=520,height=720");
}

function safeAuthorizationUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : "";
  } catch { return ""; }
}

function renderAuthorization() {
  if (!activeLogin) return;
  const { provider, snapshot = {}, uiError = "" } = activeLogin;
  const key = JSON.stringify([locale, snapshot, uiError, activeLogin.popupClosed, activeLogin.popupBlocked]);
  if (key === loginRenderKey) return;
  loginRenderKey = key;
  const root = document.querySelector("#modal");
  const oldInput = root.querySelector("#authorization-answer");
  const oldPromptId = oldInput?.dataset.promptId;
  const oldValue = oldInput?.value;
  const inputWasFocused = oldInput && document.activeElement === oldInput;
  const selection = oldInput?.selectionStart;
  const prompt = snapshot.prompt;
  const terminal = snapshot.status && snapshot.status !== "pending";
  const url = safeAuthorizationUrl(snapshot.url);
  let input = "";
  if (prompt) {
    input = `<form id="authorization-form"><label class="expiry-label" for="authorization-answer">${escapeHtml(prompt.message)}</label>`;
    if (prompt.kind === "select") {
      input += `<select class="field" id="authorization-answer" data-prompt-id="${escapeHtml(prompt.id)}">${(prompt.options || []).map((option) => `<option value="${escapeHtml(option.id)}">${escapeHtml(option.label)}${option.description ? ` · ${escapeHtml(option.description)}` : ""}</option>`).join("")}</select>`;
    } else {
      input += `<input class="field" id="authorization-answer" data-prompt-id="${escapeHtml(prompt.id)}" type="${prompt.kind === "secret" ? "password" : "text"}" autocomplete="off" spellcheck="false" placeholder="${escapeHtml(prompt.placeholder || tr("粘贴提供商返回的授权信息", "Paste authorization information from the provider"))}" />`;
    }
    input += `<div class="row-actions"><button class="btn solid" type="submit" id="submit-authorization-answer">${tr("提交授权输入", "Submit authorization input")}</button></div></form>`;
  }
  const message = snapshot.status === "authorized" ? tr("本次授权已完成，正在刷新本机凭据状态。", "Authorization completed. Refreshing locally saved credentials.")
    : snapshot.status === "cancelled" ? tr("本次登录已取消。", "This sign-in was cancelled.")
      : snapshot.status === "error" ? tr("本次登录失败。", "This sign-in failed.")
        : snapshot.message || tr("正在启动提供商登录，请稍候。", "Starting provider sign-in. Please wait.");
  modalStart();
  root.hidden = false;
  root.innerHTML = `<div class="overlay"><div class="dialog pull-dialog" role="dialog" aria-modal="true" aria-labelledby="authorization-title">
    <h2 id="authorization-title">${escapeHtml(tr(`登录 ${provider.name}`, `Sign in to ${provider.name}`))}</h2>
    <p class="hint" role="status">${escapeHtml(message)}</p>
    ${snapshot.code ? `<p class="hint">${tr("在提供商页面输入设备码：", "Enter this device code on the provider page: ")}<code style="user-select:all;font-size:18px">${escapeHtml(snapshot.code)}</code></p>` : ""}
    ${url && !terminal ? `<p><a class="btn" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${tr("打开提供商授权页", "Open provider authorization")}</a></p>` : ""}
    ${url && !terminal && provider.id === "xai" ? `<p class="hint">${activeLogin.method === "device" ? tr("正在使用设备码备用路线。若审批页无法验证浏览器，可取消后改用浏览器登录。", "Using the device-code fallback. If browser verification fails, cancel and use browser sign-in.") : tr("正在使用浏览器 PKCE 登录。若浏览器仍无法验证，可复制此链接到另一个常用浏览器中打开，完成后会自动返回本机。", "Using browser PKCE sign-in. You can copy the link into another browser; authorization will return to this local service.")}</p><p><button class="btn" type="button" id="copy-authorization-url">${tr("复制授权链接", "Copy authorization link")}</button></p>` : ""}
    ${activeLogin.popupBlocked && !terminal ? `<p class="hint">${tr("浏览器拦截了弹窗。授权链接就绪后可点上方按钮继续。", "The browser blocked the popup. Use the link above when it is ready.")}</p>` : ""}
    ${activeLogin.popupClosed && !terminal ? `<p class="hint">${tr("授权窗口已关闭。仍可在这里粘贴授权信息，或取消本次登录。", "The authorization window closed. You can still enter authorization information here or cancel.")}</p>` : ""}
    ${input}
    ${snapshot.error || uiError ? `<p class="err" role="alert">${escapeHtml(uiError || snapshot.error)}</p>` : ""}
    <div class="row-actions"><button class="btn" type="button" id="${terminal ? "close-authorization" : "cancel-authorization"}">${terminal ? tr("关闭", "Close") : tr("取消登录", "Cancel sign-in")}</button></div>
  </div></div>`;
  const newInput = root.querySelector("#authorization-answer");
  if (newInput && oldPromptId === prompt?.id && oldValue !== undefined) {
    newInput.value = oldValue;
    if (inputWasFocused) { newInput.focus?.(); if (typeof selection === "number" && newInput.type !== "select-one") newInput.setSelectionRange?.(selection, selection); }
  }
  focusDialog();
}

function cleanupLogin(closePopup = false) {
  window.clearTimeout(loginPoll);
  window.clearInterval(popupWatch);
  if (closePopup && authPopup && !authPopup.closed) authPopup.close();
  pendingId = null;
  activeLogin = null;
  loginRenderKey = "";
  renderList();
}

async function acceptLoginSnapshot(login, snapshot) {
  if (activeLogin !== login || unloaded) return;
  login.snapshot = snapshot;
  login.uiError = "";
  const url = safeAuthorizationUrl(snapshot.url);
  if (snapshot.status === "pending" && url && login.openedUrl !== url && authPopup && !authPopup.closed) {
    try {
      authPopup.location.replace(url);
      login.openedUrl = url;
    } catch { login.popupBlocked = true; }
  }
  renderAuthorization();
  if (snapshot.status === "authorized") {
    const refreshed = await refreshRemote();
    if (activeLogin !== login) return;
    if (refreshed && status[login.provider.id]?.loggedIn) {
      cleanupLogin(true);
      closeModal();
      toast(tr(`${login.provider.name} 已连接`, `${login.provider.name} connected`));
    } else {
      login.uiError = tr("授权已结束，但尚未读取到本机凭据。请刷新提供商状态确认。", "Authorization ended, but local credentials have not been confirmed. Refresh the provider status.");
      pendingId = null;
      renderAuthorization();
      renderList();
    }
    return;
  }
  if (snapshot.status && snapshot.status !== "pending") {
    pendingId = null;
    window.clearInterval(popupWatch);
    if (authPopup && !authPopup.closed) authPopup.close();
    await refreshRemote();
    renderList();
    return;
  }
  loginPoll = window.setTimeout(() => void pollLogin(login), 1000);
}

async function pollLogin(login) {
  if (activeLogin !== login || unloaded) return;
  try {
    const response = await fetch(`/oauth/api/login/status?provider=${encodeURIComponent(login.provider.id)}`, { cache: "no-store" });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || tr("无法读取登录状态", "Could not read sign-in status"));
    await acceptLoginSnapshot(login, body);
  } catch (error) {
    if (activeLogin !== login) return;
    login.uiError = `${error.message || tr("无法读取登录状态", "Could not read sign-in status")} ${tr("可稍后重试或取消。", "Retry later or cancel.")}`;
    renderAuthorization();
    loginPoll = window.setTimeout(() => void pollLogin(login), 2000);
  }
}

async function openLogin(id, method = "browser") {
  const provider = shownProviders().find((item) => item.id === id);
  if (!provider || pendingId || apiMode === "checking" || apiMode === "unavailable") return;
  if (id === "xai" && method === "browser" && apiMode === "live" && !provider.loginMethods?.includes("browser")) {
    toast(tr("请重新启动 DSH，以加载新版浏览器登录路线", "Restart DSH to load browser sign-in support"));
    return;
  }
  if (authPopup && !authPopup.closed) authPopup.close();
  const preview = apiMode === "preview";
  const custom = preview ? window.DshOAuth.loginOpener() : null;
  // This call must remain in the click stack, before any awaited API request.
  authPopup = custom ? custom(provider) : defaultLoginOpener(provider, preview);
  pendingId = id;
  renderList();
  if (preview) {
    if (!authPopup) {
      pendingId = null;
      renderList();
      toast(tr("浏览器拦截了示例窗口", "The browser blocked the example window"));
      return;
    }
    window.clearInterval(popupWatch);
    popupWatch = window.setInterval(() => {
      if (authPopup?.closed && pendingId === id) {
        window.clearInterval(popupWatch);
        pendingId = null;
        renderList();
      }
    }, 400);
    return;
  }
  const login = { provider, method, snapshot: { status: "pending" }, popupBlocked: !authPopup };
  activeLogin = login;
  renderAuthorization();
  window.clearInterval(popupWatch);
  popupWatch = window.setInterval(() => {
    if (activeLogin !== login) return window.clearInterval(popupWatch);
    if (authPopup?.closed && !login.popupClosed) {
      login.popupClosed = true;
      renderAuthorization();
    }
  }, 400);
  try {
    const response = await fetch("/oauth/api/login", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: id, ...(id === "xai" ? { method } : {}) }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || tr("登录没有开始", "Sign-in did not start"));
    await acceptLoginSnapshot(login, body);
  } catch (error) {
    if (activeLogin !== login) return;
    await acceptLoginSnapshot(login, { status: "error", error: error.message || tr("登录没有开始", "Sign-in did not start") });
  }
}

async function submitAuthorization(event) {
  if (event.target.id !== "authorization-form") return;
  event.preventDefault();
  const login = activeLogin;
  const prompt = login?.snapshot?.prompt;
  if (!prompt) return;
  const input = document.querySelector("#authorization-answer");
  const value = input.value;
  const button = document.querySelector("#submit-authorization-answer");
  button.disabled = true;
  window.clearTimeout(loginPoll);
  try {
    const response = await fetch("/oauth/api/login/answer", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: login.provider.id, attemptId: login.snapshot.attemptId, promptId: prompt.id, value }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || tr("授权输入没有提交", "Authorization input was not submitted"));
    input.value = "";
    await acceptLoginSnapshot(login, body);
  } catch (error) {
    if (activeLogin !== login) return;
    login.uiError = error.message || tr("授权输入没有提交", "Authorization input was not submitted");
    renderAuthorization();
    loginPoll = window.setTimeout(() => void pollLogin(login), 1000);
  } finally { if (button.isConnected) button.disabled = false; }
}

async function cancelAuthorization() {
  const login = activeLogin;
  if (!login) return;
  if (!login.snapshot.attemptId) {
    login.uiError = tr("登录仍在启动，请等待服务返回后再取消。", "Sign-in is still starting. Wait for the service before cancelling.");
    renderAuthorization();
    return;
  }
  window.clearTimeout(loginPoll);
  try {
    const response = await fetch("/oauth/api/login/cancel", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: login.provider.id, attemptId: login.snapshot.attemptId }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || tr("未能取消登录", "Could not cancel sign-in"));
    await acceptLoginSnapshot(login, body);
  } catch (error) {
    if (activeLogin !== login) return;
    login.uiError = error.message || tr("未能取消登录", "Could not cancel sign-in");
    renderAuthorization();
    loginPoll = window.setTimeout(() => void pollLogin(login), 1000);
  }
}

window.addEventListener("message", async (event) => {
  const sameOrigin = location.protocol === "file:" ? event.origin === "null" : event.origin === location.origin;
  if (apiMode !== "preview" || !sameOrigin || event.source !== authPopup) return;
  const data = event.data;
  if (!data || data.type !== "dsh-oauth-preview") return;
  const provider = PROVIDERS.find((item) => item.id === data.provider);
  if (!provider || pendingId !== provider.id) return;
  if (!data.ok) {
    pendingId = null;
    renderList();
    return;
  }
  const allowed = await window.DshOAuth.runAuthorizeHooks(provider);
  pendingId = null;
  window.clearInterval(popupWatch);
  if (allowed) {
    status[provider.id] = { loggedIn: true, tokenPreview: "示例，无真实凭据", sourceLabel: "静态预览", error: "" };
    save();
  }
  renderList();
  toast(allowed ? tr(`${provider.name} 示例已连接，未登录真实账号`, `${provider.name} example connected. No real account was signed in.`) : tr("示例连接未保存", "Example connection was not saved"));
});

window.addEventListener("pagehide", () => {
  unloaded = true;
  window.clearTimeout(loginPoll);
  window.clearInterval(popupWatch);
  const login = activeLogin;
  if (login?.snapshot.status === "pending" && login.snapshot.attemptId) {
    const body = JSON.stringify({ provider: login.provider.id, attemptId: login.snapshot.attemptId });
    let sent = false;
    try { sent = Boolean(navigator.sendBeacon?.("/oauth/api/login/cancel", new Blob([body], { type: "application/json" }))); } catch { /* Use keepalive when Beacon is unavailable. */ }
    if (!sent) void fetch("/oauth/api/login/cancel", { method: "POST", headers: { "content-type": "application/json" }, body, keepalive: true }).catch(() => {});
  }
});
window.addEventListener("pageshow", (event) => {
  if (event.persisted) {
    unloaded = false;
    cleanupLogin(true);
    closeModal();
    void refreshRemote();
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

function capabilitySummary(model) {
  const items = [];
  const modalities = (values) => (Array.isArray(values) ? values : []).map((value) => ({ text: tr("文本", "text"), image: tr("图像", "image"), video: tr("视频", "video"), audio: tr("音频", "audio"), file: tr("文件", "file") })[value] || value).join(" / ");
  if (model.input?.length) items.push(tr("输入", "Input") + ": " + modalities(model.input));
  if (model.output?.length) items.push(tr("输出", "Output") + ": " + modalities(model.output));
  if (typeof model.tools === "boolean") items.push(model.tools ? tr("支持工具", "Tools supported") : tr("不支持工具", "No tools"));
  if (model.contextWindow) items.push(tr("上下文", "Context") + ": " + number(model.contextWindow));
  if (model.maxTokens) items.push(tr("最大输出", "Max output") + ": " + number(model.maxTokens));
  const reasoning = Array.isArray(model.reasoningEfforts) ? model.reasoningEfforts : model.reasoningEfforts && typeof model.reasoningEfforts === "object" ? Object.keys(model.reasoningEfforts) : [];
  if (reasoning.length) items.push(tr("推理", "Reasoning") + ": " + reasoning.join(" / "));
  else if (model.reasoningEfforts === false) items.push(tr("不支持可选推理档位", "No selectable reasoning levels"));
  return items.join(" · ") || tr("能力信息未提供", "Capabilities not provided");
}
function modelEvidence(model) {
  const source = typeof model.source === "string" ? model.source : model.source?.kind;
  const entitlement = model.entitlement;
  const known = entitlement === "included" || entitlement === "verified" || entitlement === true;
  const text = entitlement === "account" ? tr("账户接口返回的目录；实际调用仍受账户权限和额度限制", "Account catalog; access remains subject to account permissions and allowance")
    : entitlement === "subscription" ? tr("订阅接口返回的目录；实际调用仍受套餐权限和额度限制", "Subscription catalog; access remains subject to plan permissions and allowance")
      : known ? tr("已由来源确认权益", "Entitlement confirmed by source") : tr("套餐权益未确认", "Plan entitlement unconfirmed");
  return (source ? `${tr("目录来源", "Catalog source")}: ${source} · ` : "") + text;
}
function renderPull(provider, models, error) {
  const root = document.querySelector("#modal");
  root.hidden = false;
  if (provider.cliCatalog) {
    root.innerHTML = `<div class="overlay" data-backdrop="1"><div class="dialog pull-dialog" role="dialog" aria-modal="true" aria-labelledby="pull-title">
      <h2 id="pull-title">${tr("AGY CLI 模型目录", "AGY CLI model catalog")}</h2>
      <p class="hint">${tr("目录由 AGY CLI 返回。通过 AGY 使用这些模型，在 CLI 中输入 /usage 查看套餐用量。", "Use these models with AGY CLI. Enter /usage there for plan quota.")}</p>
      ${error ? `<p class="err" role="alert">${escapeHtml(error)}</p>` : `<ul class="choices">${models.map(model => `<li class="choice"><span>${escapeHtml(model.name)}</span><code>${escapeHtml(model.id)}</code></li>`).join("")}</ul>`}
      <div class="row-actions"><button class="btn" type="button" id="cancel-pull">${tr("关闭", "Close")}</button></div></div></div>`;
    focusDialog();
    return;
  }
  const chat = models.filter((model) => !model.role || model.role === "chat");
  const media = models.filter((model) => model.role === "image" || model.role === "video");
  const selected = new Set((provider.pulledModels || []).map((model) => model.id));
  const choices = error ? "" : chat.map((model) => `<label class="choice"><input type="checkbox" value="${escapeHtml(model.id)}" ${selected.size === 0 || selected.has(model.id) ? "checked" : ""} /><span>${escapeHtml(model.name || model.id)}</span><code>${escapeHtml(model.id)}</code><span class="model-capabilities">${escapeHtml(capabilitySummary(model))}</span><span class="model-capabilities">${escapeHtml(modelEvidence(model))}</span></label>`).join("");
  root.innerHTML = `<div class="overlay" data-backdrop="1"><div class="dialog pull-dialog" role="dialog" aria-modal="true" aria-labelledby="pull-title">
    <h2 id="pull-title">${escapeHtml(tr(`从 ${provider.name} 拉取模型`, `Fetch models from ${provider.name}`))}</h2>
    <p class="hint">${tr("模型能力按来源返回的信息显示。公共目录不代表当前套餐已包含，也不会发推理请求来验证。", "Capabilities are shown as reported by the source. A public catalog does not confirm plan entitlement; no inference is sent to test access.")}</p>
    ${media.length ? `<p class="hint">${tr("媒体模型将自动配置：", "Media models are configured automatically: ")}${media.map((model) => escapeHtml(model.name || model.id)).join(", ")}</p>${media.map((model) => `<p class="hint">${escapeHtml(model.name || model.id)} · ${escapeHtml(capabilitySummary(model))}</p>`).join("")}` : ""}
    ${error ? `<p class="err" role="alert">${escapeHtml(error)}</p>` : `<div class="select-tools"><span class="hint">${tr(`选择对话模型（${chat.length}）`, `Select chat models (${chat.length})`)}</span><button class="btn" type="button" id="toggle-models">${tr("全选 / 清空", "Select all / clear")}</button></div><div class="choices">${choices || `<p class="hint">${tr("此来源未返回对话模型。", "This source returned no chat models.")}</p>`}</div>`}
    <label class="retention-option"><input type="radio" name="retention" value="permanent" id="pull-permanent" ${provider.pullExpiresAt && !provider.pullPermanent ? "" : "checked"} />${tr("持续启用（默认）", "Keep enabled (default)")}</label>
    <label class="retention-option"><input type="radio" name="retention" value="until" id="pull-until" ${provider.pullExpiresAt && !provider.pullPermanent ? "checked" : ""} />${tr("保留至指定时间", "Keep until a selected date")}</label>
    <label class="expiry-label" for="pull-expiry">${tr("模型配置到期时间", "Model configuration expiry")}</label><input class="field" id="pull-expiry" type="datetime-local" />
    <p class="hint">${tr("持续启用只保留本机模型配置，不保证永久免登录。凭据由本机服务保存；授权撤销或失效时仍需重新连接。", "Keeping models enabled preserves local configuration. Credentials remain in the local service; revoked or expired authorization can still require reconnecting.")}</p>
    <div class="chips"><button class="btn" type="button" data-hours="24">${tr("1 天", "1 day")}</button><button class="btn" type="button" data-hours="168">${tr("7 天", "7 days")}</button><button class="btn" type="button" data-hours="720">${tr("30 天", "30 days")}</button></div>
    <p class="err form-error" id="pull-error" role="alert"></p><div class="row-actions"><button class="btn" type="button" id="cancel-pull">${tr("取消", "Cancel")}</button><button class="btn solid" type="button" id="confirm-pull" ${error || !chat.length || pullSaving ? "disabled" : ""}>${tr("写入所选模型", "Save selected models")}</button></div>
  </div></div>`;
  const field = document.querySelector("#pull-expiry");
  field.value = localStamp(provider.pullExpiresAt ? new Date(provider.pullExpiresAt) : new Date(Date.now() + 24 * 60 * 60 * 1000));
  syncRetention(); focusDialog();
}
function syncRetention() {
  const field = document.querySelector("#pull-expiry");
  if (field) field.disabled = Boolean(document.querySelector("#pull-permanent")?.checked);
}
async function openPull(id) {
  const provider = shownProviders().find((item) => item.id === id);
  if (!provider || apiMode !== "live") return;
  modalStart();
  pullSaving = false;
  const serial = ++modalSerial;
  const root = document.querySelector("#modal");
  root.hidden = false;
  root.innerHTML = `<div class="overlay"><div class="dialog" role="dialog" aria-modal="true" aria-labelledby="loading-title"><h2 id="loading-title">${escapeHtml(tr(`正在拉取 ${provider.name}`, `Fetching ${provider.name}`))}</h2><p class="hint">${tr("正在读取模型目录与能力信息。", "Reading the model catalog and capabilities.")}</p></div></div>`;
  focusDialog();
  let models = [], error = "";
  try { const body = await post("models", { provider: id, ...(provider.cliCatalog ? { source: "agy" } : {}) }); models = Array.isArray(body.models) ? body.models : []; }
  catch (cause) { error = cause.message; }
  if (serial !== modalSerial) return;
  pullModels = models; pullError = error;
  renderPull(provider, models, error);
}
async function confirmPull(id) {
  if (pullSaving) return;
  const serial = modalSerial;
  const provider = shownProviders().find((item) => item.id === id);
  const picked = [...document.querySelectorAll(".choice input:checked")].map((input) => input.value);
  const permanent = document.querySelector("#pull-permanent")?.checked;
  const raw = document.querySelector("#pull-expiry")?.value;
  const expiresAt = permanent ? null : raw ? new Date(raw).getTime() : NaN;
  const errorNode = document.querySelector("#pull-error");
  if (!permanent && (!Number.isFinite(expiresAt) || expiresAt <= Date.now() || expiresAt > Date.now() + 366 * 24 * 60 * 60 * 1000)) { errorNode.textContent = tr("请选择未来 366 天内的到期时间。", "Choose an expiry date within the next 366 days."); return; }
  if (!picked.length) { errorNode.textContent = tr("请至少选择一个对话模型。", "Select at least one chat model."); return; }
  pullSaving = true;
  const button = document.querySelector("#confirm-pull"); button.disabled = true;
  try {
    const body = await post("pull", { provider: id, models: picked, expiresAt });
    if (serial === modalSerial) closeModal();
    await refreshRemote();
    toast(tr(`${provider?.name || id} 已写入 ${body.models?.length || picked.length} 个模型`, `Models saved for ${provider?.name || id}: ${body.models?.length || picked.length}`));
  } catch (error) { if (serial === modalSerial) document.querySelector("#pull-error").textContent = error.message; }
  finally { pullSaving = false; if (serial === modalSerial) { const current = document.querySelector("#confirm-pull"); if (current) current.disabled = false; } }
}
let pullTarget = null;

function renderConnection() {
  const { provider, configure } = connectionTarget;
  const connection = provider.connection || {};
  const field = (id, label, value = "", placeholder = "") => `<label class="expiry-label" for="connection-${id}">${label}</label><input class="field" id="connection-${id}" name="${id}" value="${escapeHtml(value)}" placeholder="${escapeHtml(placeholder)}" maxlength="200" autocomplete="off" />`;
  const root = document.querySelector("#modal"); root.hidden = false;
  root.innerHTML = `<div class="overlay" data-backdrop="1"><div class="dialog pull-dialog" role="dialog" aria-modal="true" aria-labelledby="connection-title"><h2 id="connection-title">${escapeHtml(configure ? tr(`${provider.name} 连接配置`, `${provider.name} connection settings`) : tr(`连接 ${provider.name}`, `Connect ${provider.name}`))}</h2>
  <form id="connection-form" class="connection-form">
    ${!configure ? `<label class="expiry-label" for="connection-access">${tr("调用密钥或访问令牌", "Model API key or access token")}</label><input class="field" id="connection-access" name="access" type="password" required autocomplete="new-password" spellcheck="false" /><p class="hint">${tr("只保存到本机凭据服务，不在页面或浏览器存储中保留。", "Saved in the local credential service, not in browser storage.")}</p>` : `<p class="hint">${tr("调用授权已保存。这里可补充用量查询授权和账号范围。", "Model authorization is saved. Add usage-query credentials and account scope here.")}</p>`}
    <label class="expiry-label" for="connection-billing">${tr("用量查询密钥（可选）", "Usage-query key (optional)")}</label><input class="field" id="connection-billing" name="billingAccess" type="password" autocomplete="new-password" spellcheck="false" placeholder="${provider.billingCredentialConfigured ? tr("已配置，留空保留", "Configured; leave blank to keep") : tr("仅查询接口需要独立权限时填写", "Only if usage queries need a separate credential")}" />
    <p class="hint">${tr("例如 ZenMux 需要 Management key；查询权限不代表模型调用权限。请使用同一账户或所选组织。", "For example, ZenMux requires a Management key. Usage permission and model access are separate. Use the same account or selected organization.")}</p>
    ${configure && provider.authMethods?.includes("local") ? `<button class="btn" type="button" data-local="${escapeHtml(provider.id)}">${tr("改用本机 CLI 管理的授权", "Use CLI-managed authorization")}</button>` : ""}
    ${provider.id === "new-api" ? `<label class="expiry-label" for="connection-baseURL">${tr("部署 API 地址（必填）", "Deployment API URL (required)")}</label><input class="field" id="connection-baseURL" name="baseURL" type="url" required value="${escapeHtml(connection.baseURL || "")}" placeholder="https://api.example.com/v1" autocomplete="off" spellcheck="false" /><p class="hint">${tr("填写你信任的公网 HTTPS API 根地址，包含 /v1。此地址将接收调用密钥。", "Enter the public HTTPS API root you trust, including /v1. Your model key will be sent to this host.")}</p>` : ""}
    ${field("label", tr("连接名称（可选）", "Connection label (optional)"), connection.label || "")}
    <details class="scope-fields" ${[connection.region, connection.organizationId, connection.workspaceId, connection.projectId].some(Boolean) ? "open" : ""}><summary>${tr("地区、组织与项目范围（按提供商要求）", "Region, organization and project scope (when required)")}</summary>
      <label class="expiry-label" for="connection-region">${tr("地区（与界面语言无关）", "Region (independent of interface language)")}</label><select class="field" id="connection-region" name="region"><option value="global" ${!connection.region || connection.region === "global" ? "selected" : ""}>${tr("国际 / Global（默认）", "Global (default)")}</option><option value="cn" ${connection.region === "cn" ? "selected" : ""}>${tr("中国 / China", "China")}</option>${connection.region && !["global", "cn"].includes(connection.region) ? `<option selected value="${escapeHtml(connection.region)}">${escapeHtml(connection.region)}</option>` : ""}</select>
      ${field("organizationId", tr("组织 ID", "Organization ID"), connection.organizationId || "")}
      ${field("workspaceId", tr("工作区 ID", "Workspace ID"), connection.workspaceId || "")}
      ${field("projectId", tr("项目 ID", "Project ID"), connection.projectId || "")}
    </details><p class="err form-error" id="connection-error" role="alert"></p><div class="row-actions"><button class="btn" type="button" id="cancel-connection">${tr("取消", "Cancel")}</button><button class="btn solid" type="submit" id="save-connection" ${connectionTarget.saving ? "disabled" : ""}>${configure ? tr("保存配置", "Save settings") : tr("保存并连接", "Save and connect")}</button></div>
  </form></div></div>`;
  focusDialog();
}
function openConnection(id, configure) {
  const provider = shownProviders().find((item) => item.id === id);
  if (!provider || apiMode !== "live" || pendingId) return;
  modalStart(); ++modalSerial; connectionTarget = { provider, configure }; renderConnection();
}
async function saveConnection(event) {
  if (event.target.id !== "connection-form") return;
  event.preventDefault();
  const target = connectionTarget;
  if (!target) return;
  const form = event.target;
  const data = new FormData(form);
  const body = { provider: target.provider.id };
  for (const key of ["access", "billingAccess", "label", "region", "organizationId", "workspaceId", "projectId", "baseURL"]) {
    const raw = data.get(key);
    if (typeof raw !== "string") continue;
    const value = raw.trim();
    if (["access", "billingAccess"].includes(key)) { if (value) body[key] = value; }
    else if (target.configure ? value !== (target.provider.connection?.[key] || (key === "region" ? "global" : "")) : value) body[key] = value;
  }
  if (target.provider.id === "new-api") {
    try {
      const endpoint = new URL(data.get("baseURL"));
      if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error();
    } catch { form.querySelector("#connection-error").textContent = tr("请输入不含认证信息、查询参数或片段的 HTTPS API 地址。", "Enter an HTTPS API URL without credentials, query parameters or a fragment."); return; }
  }
  if (target.provider.id === "zai" && Boolean(body.organizationId ?? target.provider.connection?.organizationId) !== Boolean(body.projectId ?? target.provider.connection?.projectId)) {
    form.querySelector("#connection-error").textContent = tr("团队查询需要同时填写组织 ID 和项目 ID。", "Team queries require both organization ID and project ID."); return;
  }
  if (target.saving) return;
  target.saving = true;
  const button = form.querySelector("#save-connection"); button.disabled = true;
  try {
    await post(target.configure ? "connection" : "connect", body);
    form.querySelectorAll('input[type="password"]').forEach((input) => { input.value = ""; });
    invalidateUsage(target.provider.id);
    if (connectionTarget === target || localTarget === target) closeModal();
    await refreshRemote();
    toast(tr("连接配置已保存。", "Connection settings saved."));
  } catch (error) {
    if (connectionTarget === target) document.querySelector("#connection-error").textContent = error.message;
  } finally { target.saving = false; if (connectionTarget === target) { const current = document.querySelector("#save-connection"); if (current) current.disabled = false; } }
}
async function openLocal(id) {
  const provider = shownProviders().find((item) => item.id === id);
  if (!provider || apiMode !== "live") return;
  modalStart(); const serial = ++modalSerial;
  connectionTarget = null; pullTarget = null;
  localTarget = { provider, sources: [], loading: true };
  renderLocal();
  try {
    const response = await fetch("/oauth/api/import/sources", { cache: "no-store" });
    const body = await response.json();
    if (!response.ok) throw new Error(requestError(body));
    if (serial !== modalSerial) return;
    localTarget.sources = Array.isArray(body.sources) ? body.sources : [];
  } catch (error) { if (serial === modalSerial) localTarget.error = error.message; }
  if (serial === modalSerial) { localTarget.loading = false; renderLocal(); }
}
function localSourceStatus(source, item) {
  if (source.available && item.available) return tr("可复用", "Available");
  if (item.reasonCode === "source-does-not-export-credentials") return tr(
    "AGY 通过系统钥匙串管理登录，暂无法在此导入。请在 agy 中输入 /usage 查看套餐用量。",
    "AGY manages sign-in in the system keyring. To view plan usage, enter /usage in agy.",
  );
  if (item.reasonCode === "ambiguous-source") return tr("源 CLI 有多个账号，请保留明确的授权来源。", "The source CLI has several accounts. Select a single authorization source.");
  if (item.reasonCode === "unsupported-provider") return tr("此授权类型与该提供商的接入方式不兼容。", "This authorization type is unsupported for the provider.");
  return tr("未找到可用授权，请先在源 CLI 登录", "No usable authorization; sign in in the source CLI first");
}
function renderLocal() {
  const { provider, sources, loading, error } = localTarget;
  const choices = sources.flatMap((source) => (source.providers || []).filter((item) => item.provider === provider.id).map((item) => ({ source, item })));
  const root = document.querySelector("#modal"); root.hidden = false;
  root.innerHTML = `<div class="overlay" data-backdrop="1"><div class="dialog" role="dialog" aria-modal="true" aria-labelledby="local-title"><h2 id="local-title">${escapeHtml(tr(`复用 ${provider.name} 本机授权`, `Reuse local ${provider.name} authorization`))}</h2><p class="hint">${tr("可复用授权的续期由源 CLI 管理。授权过期时，请在对应 CLI 中续期。", "The source CLI manages renewal for reusable credentials. Renew expired authorization in that CLI.")}</p><form id="local-form"><div class="choices">${loading ? `<p class="hint">${tr("正在检查本机来源…", "Checking local sources…")}</p>` : choices.length ? choices.map(({ source, item }) => `<label class="choice"><input type="radio" name="source" id="local-source-${escapeHtml(source.id)}" value="${escapeHtml(source.id)}" ${source.available && item.available ? "" : "disabled"} required /><span>${escapeHtml(source.label || source.id)}</span><span class="model-capabilities">${escapeHtml(localSourceStatus(source, item))}</span></label>`).join("") : `<p class="hint">${tr("没有找到此提供商支持的本机授权来源。", "No supported local authorization source was found for this provider.")}</p>`}</div><p class="err form-error" id="local-error" role="alert">${escapeHtml(error || "")}</p><div class="row-actions"><button class="btn" type="button" id="cancel-local">${tr("取消", "Cancel")}</button><button class="btn solid" id="save-local" type="submit" ${loading || localTarget.saving || !choices.some(({ source, item }) => source.available && item.available) ? "disabled" : ""}>${tr("确认复用此来源", "Use selected source")}</button></div></form></div></div>`;
  focusDialog();
}
async function saveLocal(event) {
  if (event.target.id !== "local-form") return;
  event.preventDefault();
  const target = localTarget;
  const source = new FormData(event.target).get("source");
  if (!target || !source || target.saving) return;
  target.saving = true;
  const button = document.querySelector("#save-local"); button.disabled = true;
  try {
    await post("import", { source, provider: target.provider.id });
    invalidateUsage(target.provider.id);
    if (connectionTarget === target || localTarget === target) closeModal();
    await refreshRemote();
    toast(tr("已连接本机 CLI 管理的授权。", "Connected using CLI-managed authorization."));
  } catch (error) { if (localTarget === target) document.querySelector("#local-error").textContent = error.message; }
  finally { target.saving = false; if (localTarget === target) { const current = document.querySelector("#save-local"); if (current) current.disabled = false; } }
}
function disconnect(id) {
  pendingDisconnect = shownProviders().find((item) => item.id === id);
  if (!pendingDisconnect) return;
  modalStart();
  const root = document.querySelector("#modal"); root.hidden = false;
  root.innerHTML = `<div class="overlay" data-backdrop="1"><div class="dialog" role="dialog" aria-modal="true" aria-labelledby="disconnect-title"><h2 id="disconnect-title">${escapeHtml(tr(`断开 ${pendingDisconnect.name}？`, `Disconnect ${pendingDisconnect.name}?`))}</h2><p class="hint">${tr("这会删除本机服务保存的授权。其他使用同一共享凭据的配置也可能受影响；之后需要重新连接。", "This removes authorization saved by the local service. Other configurations using the same shared credential may also be affected. You will need to reconnect.")}</p><div class="row-actions"><button class="btn" type="button" id="cancel-disconnect">${tr("取消", "Cancel")}</button><button class="btn solid" type="button" id="confirm-disconnect">${tr("断开连接", "Disconnect")}</button></div></div></div>`;
  focusDialog();
}

document.querySelector("#refresh").addEventListener("click", () => {
  if (hostedPanel) void refreshRemote();
  else { status = loadState(); renderList(); }
});

document.querySelector("#reset").addEventListener("click", () => {
  if (apiMode !== "preview") return;
  status = seedStatus();
  save();
  renderList();
  toast(tr("已恢复示例数据", "Example data restored"));
});

document.querySelector("#rows").addEventListener("click", async (event) => {
  const target = event.target.closest("button");
  if (!target) return;
  if (target.dataset.login) openLogin(target.dataset.login, target.dataset.loginMethod || "browser");
  if (target.dataset.pull) {
    pullTarget = target.dataset.pull;
    void openPull(target.dataset.pull);
  }
  if (target.dataset.disconnect) disconnect(target.dataset.disconnect);
  if (target.dataset.connect) openConnection(target.dataset.connect, false);
  if (target.dataset.configure) openConnection(target.dataset.configure, true);
  if (target.dataset.usage) void refreshUsage(target.dataset.usage);
  if (target.dataset.local) void openLocal(target.dataset.local);
  if (target.dataset.copy) {
    const provider = shownProviders().find((item) => item.id === target.dataset.copy);
    await navigator.clipboard.writeText(provider.cli);
    toast(tr("已复制", "Copied"));
  }
});

document.querySelector("#modal").addEventListener("submit", submitAuthorization);
document.querySelector("#modal").addEventListener("submit", saveConnection);
document.querySelector("#modal").addEventListener("submit", saveLocal);
document.querySelector("#modal").addEventListener("change", syncRetention);

document.querySelector("#modal").addEventListener("click", async (event) => {
  if (event.target.dataset.local) { void openLocal(event.target.dataset.local); return; }
  if (event.target.id === "cancel-local" || (event.target.dataset.backdrop && localTarget)) { closeModal(); return; }
  if (event.target.id === "cancel-connection" || (event.target.dataset.backdrop && connectionTarget)) { closeModal(); return; }
  if (event.target.id === "toggle-models") {
    const inputs = [...document.querySelectorAll(".choice input")];
    const all = inputs.every((input) => input.checked);
    inputs.forEach((input) => { input.checked = !all; }); return;
  }
  if (event.target.id === "copy-authorization-url") {
    const url = safeAuthorizationUrl(activeLogin?.snapshot?.url);
    if (!url) return;
    try { await navigator.clipboard.writeText(url); toast(tr("授权链接已复制，可在常用浏览器中打开", "Authorization link copied. Open it in your preferred browser.")); }
    catch { toast(tr("无法写入剪贴板，可使用上方授权链接", "Could not copy. Use the authorization link above.")); }
    return;
  }
  if (event.target.id === "cancel-authorization") { await cancelAuthorization(); return; }
  if (event.target.id === "close-authorization") {
    cleanupLogin(true);
    closeModal();
    return;
  }
  const hours = event.target.dataset?.hours;
  if (hours) {
    const field = document.querySelector("#pull-expiry");
    if (field) field.value = localStamp(new Date(Date.now() + Number(hours) * 60 * 60 * 1000));
    const until = document.querySelector("#pull-until");
    if (until) until.checked = true;
    syncRetention();
    return;
  }
  if (event.target.id === "cancel-pull" || (event.target.dataset.backdrop && pullTarget && !pendingDisconnect)) {
    closeModal();
    return;
  }
  if (event.target.id === "confirm-pull" && pullTarget) {
    await confirmPull(pullTarget);
    return;
  }
  if (event.target.id === "cancel-disconnect" || (event.target.dataset.backdrop && pendingDisconnect)) {
    closeModal();
    return;
  }
  if (event.target.id === "confirm-disconnect" && pendingDisconnect) {
    const provider = pendingDisconnect;
    const button = event.target;
    button.disabled = true;
    if (apiMode === "live") {
      try {
        const response = await fetch("/oauth/api/logout", {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: provider.id }),
        });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || tr("断开连接失败", "Could not disconnect"));
        invalidateUsage(provider.id); usageOpen.delete(provider.id);
        await refreshRemote();
      } catch (error) {
        button.disabled = false;
        toast(error.message || tr("断开连接失败", "Could not disconnect"));
        return;
      }
    } else if (apiMode === "preview") {
      delete status[provider.id];
      save();
    } else {
      button.disabled = false;
      toast(tr("本机 OAuth 服务不可用，请刷新后重试", "The local OAuth service is unavailable. Refresh and try again."));
      return;
    }
    closeModal();
    renderList();
    toast(apiMode === "preview" ? tr(`${provider.name} 示例已移除`, `${provider.name} example removed`) : tr(`${provider.name} 已断开`, `${provider.name} disconnected`));
  }
});

document.addEventListener("dsh-oauth-providers", () => renderList());

function changeLocale(event) {
  const root = document.querySelector("#modal");
  const focused = document.activeElement?.id;
  const drafts = [...root.querySelectorAll("input, select")].map((input) => ({ id: input.id, value: input.value, checked: input.checked }));
  const choices = [...root.querySelectorAll(".choice input")].filter((input) => input.checked).map((input) => input.value);
  locale = event.target.value === "en" ? "en" : "zh";
  try { localStorage.setItem("dsh-oauth-locale", locale); } catch { /* UI preference is optional. */ }
  updateStaticText(); renderList();
  try { if (authPopup && !authPopup.closed) authPopup.postMessage({ type: "dsh-oauth-locale", locale }, location.protocol === "file:" ? "*" : location.origin); } catch { /* Provider-owned pages do not use panel locale. */ }
  if (activeLogin) { loginRenderKey = ""; renderAuthorization(); }
  else if (localTarget) renderLocal();
  else if (connectionTarget) renderConnection();
  else if (pullTarget) { const provider = shownProviders().find((item) => item.id === pullTarget); if (provider) renderPull(provider, pullModels, pullError); }
  else if (pendingDisconnect) disconnect(pendingDisconnect.id);
  for (const draft of drafts) {
    if (!draft.id) continue;
    const input = root.querySelector(`#${draft.id}`);
    if (input) { input.value = draft.value; if (typeof draft.checked === "boolean") input.checked = draft.checked; }
  }
  if (pullTarget) root.querySelectorAll(".choice input").forEach((input) => { input.checked = choices.includes(input.value); });
  syncRetention();
  if (focused) document.getElementById(focused)?.focus?.();
}
document.querySelector("#locale")?.addEventListener("change", changeLocale);
document.querySelector("#modal").addEventListener("change", (event) => { if (event.target.hasAttribute("data-modal-locale")) changeLocale(event); });
document.addEventListener("keydown", (event) => {
  const root = document.querySelector("#modal");
  if (root.hidden) return;
  if (event.key === "Escape") {
    event.preventDefault();
    if (activeLogin?.snapshot?.status === "pending") void cancelAuthorization();
    else { if (activeLogin) cleanupLogin(true); closeModal(); }
  }
  if (event.key === "Tab") {
    const nodes = [...root.querySelectorAll('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), summary, [tabindex="0"]')].filter((node) => node.getClientRects().length);
    const first = nodes[0], last = nodes[nodes.length - 1];
    if (!first) { event.preventDefault(); return; }
    if (event.shiftKey && (document.activeElement === first || !nodes.includes(document.activeElement))) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && (document.activeElement === last || !nodes.includes(document.activeElement))) { event.preventDefault(); first.focus(); }
  }
});
updateStaticText();
renderList();
void refreshRemote();
