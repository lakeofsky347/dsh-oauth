/** Browser smoke with local mock endpoints only. No provider credentials or network are used. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
let playwright;
try { playwright = require("playwright"); }
catch {
  const bundled = join(homedir(), ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright");
  playwright = require(process.env.DSH_PLAYWRIGHT_MODULE || bundled);
}
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outIndex = process.argv.indexOf("--out-dir");
if (outIndex >= 0 && (!process.argv[outIndex + 1] || process.argv[outIndex + 1].startsWith("--"))) {
  throw new Error("--out-dir requires an output directory");
}
const artifactDirectory = outIndex >= 0 ? resolve(process.argv[outIndex + 1]) : join(root, "artifacts");
const artifact = join(artifactDirectory, "oauth-login-mock.png");
const xaiArtifact = join(artifactDirectory, "oauth-xai-browser-mock.png");
const reportArtifact = join(artifactDirectory, "browser-pkce.json");
const xaiBrowserUrl = "https://oauth.example.test/oauth2/authorize?state=mock";
const xaiDeviceUrl = "https://oauth.example.test/device/approve?user_code=XAI-DEMO-5678";
let mode = "manual";
let loggedIn = false;
let snapshot;
const requests = [];
const loginRequests = [];
const cancelRequests = [];
const xaiChecks = {};
const reset = () => {
  loggedIn = false;
  snapshot = {
    attemptId: "mock-attempt", status: "pending", pending: true,
    url: "https://oauth.example.test/authorize", code: "DEMO-1234",
    message: "在提供商页面完成授权后，请粘贴回调授权码。",
    prompt: { id: "manual-code", kind: "text", message: "粘贴授权码或回调 URL", placeholder: "code#state" },
  };
};
reset();
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    requests.push(url.pathname + url.search);
    const json = (body, status = 200) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/oauth/api/providers") {
      if (mode === "unavailable") return json({ error: "mock service unavailable" }, 503);
      if (mode === "xai") return json({ providers: [{ id: "xai", name: "xAI Grok", flow: "pkce", loggedIn, pullable: false, loginMethods: ["browser", "device"], defaultLoginMethod: "browser" }] });
      if (mode === "xai-legacy") return json({ providers: [{ id: "xai", name: "xAI Grok", flow: "device_code", loggedIn, pullable: false }] });
      return json({ providers: [{ id: "anthropic", name: "Claude Pro/Max", flow: "pkce", loggedIn, pullable: false, tokenPreview: loggedIn ? "mock…only" : "" }] });
    }
    if (url.pathname === "/oauth/api/login") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      loginRequests.push(body);
      if (mode === "xai") {
        assert.equal(body.provider, "xai");
        assert.ok(["browser", "device"].includes(body.method));
        snapshot = {
          attemptId: `mock-xai-${body.method}`, status: "pending", pending: true,
          url: body.method === "device" ? xaiDeviceUrl : xaiBrowserUrl,
          code: body.method === "device" ? "XAI-DEMO-5678" : "",
          message: body.method === "device" ? "在提供商审批页输入设备码。" : "请在浏览器中完成 xAI 授权。",
        };
      }
      return mode === "failure" ? json({ error: "mock provider offline" }, 400) : json(snapshot);
    }
    if (url.pathname === "/oauth/api/login/status") return json(snapshot);
    if (url.pathname === "/oauth/api/login/answer") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      assert.deepEqual(body, { provider: "anthropic", attemptId: "mock-attempt", promptId: "manual-code", value: "mock-callback-code" });
      loggedIn = true;
      snapshot = { attemptId: "mock-attempt", status: "authorized", pending: false };
      return json(snapshot);
    }
    if (url.pathname === "/oauth/api/login/cancel") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      cancelRequests.push(body);
      snapshot = { attemptId: snapshot.attemptId, status: "cancelled", pending: false };
      return json(snapshot);
    }
    const filename = url.pathname.replace(/^\/oauth\/?|^\//, "") || "index.html";
    if (!["index.html", "app.js", "auth.html", "styles.css", "providers.js", "theme.js"].includes(filename)) {
      res.writeHead(404); res.end(); return;
    }
    const type = { html: "text/html", js: "application/javascript", css: "text/css" }[filename.split(".").at(-1)];
    res.writeHead(200, { "content-type": `${type}; charset=utf-8` });
    res.end(await readFile(join(root, filename)));
  } catch (error) {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: error.message }));
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const browser = await playwright.chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 950 } });
const errors = [];
const blockedRequests = [];
context.on("page", (page) => page.on("pageerror", (error) => errors.push(error.message)));
await context.route("**/*", (route) => {
  const url = new URL(route.request().url());
  if (url.hostname === "oauth.example.test") return route.fulfill({ contentType: "text/html", body: "<h1>Mock provider only</h1>" });
  if (url.hostname === "127.0.0.1" || url.protocol === "file:") return route.continue();
  blockedRequests.push(route.request().url());
  return route.abort();
});
const origin = `http://127.0.0.1:${server.address().port}`;
await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin });
const completed = [];
try {
  let page = await context.newPage();
  await page.goto(`${origin}/oauth/`);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByLabel("粘贴授权码或回调 URL").fill("mock-callback-code");
  await page.getByText("DEMO-1234", { exact: true }).waitFor();
  await mkdir(dirname(artifact), { recursive: true });
  await page.screenshot({ path: artifact, fullPage: true });
  await page.getByRole("button", { name: "提交授权输入" }).click();
  await page.getByText("已连接 1/1 个提供商。凭据由本机服务保存。", { exact: true }).waitFor();
  await page.getByRole("button", { name: "断开连接" }).waitFor();
  completed.push("manual prompt, device code and credential-confirmed success");
  await page.close();

  const loginStartsBeforeReopen = requests.filter((path) => path === "/oauth/api/login").length;
  page = await context.newPage();
  await page.goto(`${origin}/oauth/`);
  await page.getByText("已连接 1/1 个提供商。凭据由本机服务保存。", { exact: true }).waitFor();
  await page.getByRole("button", { name: "断开连接" }).waitFor();
  assert.equal(await page.getByRole("button", { name: "登录", exact: true }).count(), 0);
  assert.equal(requests.filter((path) => path === "/oauth/api/login").length, loginStartsBeforeReopen);
  assert.equal(requests.includes("/oauth/api/logout"), false);
  completed.push("reopening the panel restores server-confirmed login without starting OAuth or logging out");
  await page.close();

  reset();
  page = await context.newPage();
  await page.goto(`${origin}/oauth/`);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByLabel("粘贴授权码或回调 URL").waitFor();
  await page.getByRole("button", { name: "取消登录", exact: true }).click();
  await page.getByText("本次登录已取消。", { exact: true }).waitFor();
  assert.equal(snapshot.status, "cancelled");
  completed.push("explicit cancel follows server outcome");
  await page.close();

  mode = "failure"; reset();
  page = await context.newPage();
  await page.goto(`${origin}/oauth/`);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByText("mock provider offline", { exact: true }).waitFor();
  assert.equal(loggedIn, false);
  assert.ok(!requests.some((url) => url.includes("preview=1")));
  completed.push("API failure never falls back to sample authorization");
  await page.close();

  mode = "unavailable";
  page = await context.newPage();
  await page.goto(`${origin}/oauth/`);
  await page.getByText(/本机 OAuth 服务不可用/).waitFor();
  assert.equal(await page.getByRole("button", { name: "登录", exact: true }).first().isDisabled(), true);
  completed.push("unavailable service disables real login");
  await page.close();

  mode = "manual";
  page = await context.newPage();
  await page.goto(pathToFileURL(join(root, "index.html")).href);
  await page.getByText(/静态示例 ·/).waitFor();
  const popupPromise = page.waitForEvent("popup");
  await page.getByRole("button", { name: "演示登录", exact: true }).first().click();
  const popup = await popupPromise;
  await popup.getByRole("button", { name: "演示授权", exact: true }).click();
  await page.getByText(/示例已连接，未登录真实账号/).waitFor();
  completed.push("file preview labels sample state and supports sample popup");
  await page.close();

  mode = "xai"; reset();
  page = await context.newPage();
  await page.addInitScript(() => {
    const open = window.open;
    window.__oauthOpenCalls = [];
    window.open = function (...args) {
      window.__oauthOpenCalls.push(args);
      return open.apply(this, args);
    };
  });
  await page.goto(`${origin}/oauth/`);
  await page.getByText("xAI Grok", { exact: true }).waitFor();
  await page.getByRole("button", { name: "设备码备用", exact: true }).waitFor();
  const browserPopupPromise = page.waitForEvent("popup");
  await page.getByRole("button", { name: "浏览器登录", exact: true }).click();
  const browserPopup = await browserPopupPromise;
  await browserPopup.waitForURL(xaiBrowserUrl);
  assert.deepEqual(loginRequests.at(-1), { provider: "xai", method: "browser" });
  const browserOpenCalls = await page.evaluate(() => window.__oauthOpenCalls);
  assert.equal(browserOpenCalls.length, 1);
  assert.equal(browserOpenCalls[0].length, 2, "xAI opens a normal tab without a popup feature string");
  assert.equal(browserOpenCalls[0][1], "_blank");
  assert.equal(new URL(browserOpenCalls[0][0]).pathname, "/oauth/auth.html");
  await page.getByText(/正在使用浏览器 PKCE 登录/).waitFor();
  assert.equal(await page.getByText(/在提供商页面输入设备码/).count(), 0);
  assert.equal(await page.locator("#authorization-answer").count(), 0);
  assert.equal(await page.getByRole("link", { name: "打开提供商授权页", exact: true }).getAttribute("href"), xaiBrowserUrl);
  xaiChecks.browser = { request: loginRequests.at(-1), url: browserPopup.url(), windowOpenArguments: browserOpenCalls[0], deviceCodeVisible: false, manualCodePromptVisible: false };
  completed.push("xAI defaults to browser PKCE, sends the browser method, opens a normal tab and displays no device code");

  await page.bringToFront();
  await page.getByRole("button", { name: "复制授权链接", exact: true }).click();
  await page.getByText("授权链接已复制，可在常用浏览器中打开", { exact: true }).waitFor();
  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  assert.equal(clipboard, xaiBrowserUrl);
  xaiChecks.clipboard = { readBack: clipboard, matchesAuthorizationUrl: true };
  await page.screenshot({ path: xaiArtifact, fullPage: true });
  completed.push("xAI authorization link is copied through the real Chromium clipboard and read back exactly");

  const browserClose = browserPopup.waitForEvent("close");
  await page.getByRole("button", { name: "取消登录", exact: true }).click();
  await page.getByText("本次登录已取消。", { exact: true }).waitFor();
  await browserClose;
  assert.deepEqual(cancelRequests.at(-1), { provider: "xai", attemptId: "mock-xai-browser" });
  assert.equal(snapshot.status, "cancelled");
  assert.equal(browserPopup.isClosed(), true);
  assert.equal(await page.getByRole("button", { name: "复制授权链接", exact: true }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "浏览器登录", exact: true }).isEnabled(), true);
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  assert.equal(await page.locator("#modal").isHidden(), true);
  xaiChecks.cancel = { request: cancelRequests.at(-1), status: snapshot.status, authorizationTabClosed: true, modalClosed: true, loginEnabled: true };
  completed.push("xAI cancel follows the server result, closes the authorization tab and clears the pending UI");

  const devicePopupPromise = page.waitForEvent("popup");
  await page.getByRole("button", { name: "设备码备用", exact: true }).click();
  const devicePopup = await devicePopupPromise;
  await devicePopup.waitForURL(xaiDeviceUrl);
  assert.deepEqual(loginRequests.at(-1), { provider: "xai", method: "device" });
  await page.getByText("XAI-DEMO-5678", { exact: true }).waitFor();
  await page.getByText(/在提供商页面输入设备码/).waitFor();
  await page.getByText(/正在使用设备码备用路线/).waitFor();
  assert.equal(await page.getByText(/正在使用浏览器 PKCE 登录/).count(), 0);
  assert.equal(await page.getByRole("link", { name: "打开提供商授权页", exact: true }).getAttribute("href"), xaiDeviceUrl);
  const deviceOpenCalls = await page.evaluate(() => window.__oauthOpenCalls);
  assert.equal(deviceOpenCalls.length, 2);
  assert.equal(deviceOpenCalls[1].length, 2);
  assert.equal(deviceOpenCalls[1][1], "_blank");
  xaiChecks.device = { request: loginRequests.at(-1), url: devicePopup.url(), deviceCode: "XAI-DEMO-5678", windowOpenArguments: deviceOpenCalls[1] };
  const deviceClose = devicePopup.waitForEvent("close");
  await page.getByRole("button", { name: "取消登录", exact: true }).click();
  await page.getByText("本次登录已取消。", { exact: true }).waitFor();
  await deviceClose;
  assert.deepEqual(cancelRequests.at(-1), { provider: "xai", attemptId: "mock-xai-device" });
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  assert.equal(await page.locator("#modal").isHidden(), true);
  completed.push("xAI explicit device fallback sends the device method, displays its approval URL and code, and can be cancelled");
  await page.close();

  mode = "xai-legacy"; reset();
  page = await context.newPage();
  await page.goto(`${origin}/oauth/`);
  await page.getByText("当前服务尚未加载浏览器登录，请重新启动 DSH 以启用新版路线。", { exact: true }).waitFor();
  const legacyBrowserButton = page.getByRole("button", { name: "浏览器登录", exact: true });
  assert.equal(await legacyBrowserButton.isDisabled(), true);
  assert.equal(await page.getByRole("button", { name: "设备码备用", exact: true }).isEnabled(), true);
  const loginStartsBeforeLegacy = loginRequests.length;
  const tabsBeforeLegacy = context.pages().length;
  // Native clicks on the disabled control do nothing. A synthetic click also exercises openLogin's capability guard.
  await legacyBrowserButton.evaluate((button) => button.click());
  await legacyBrowserButton.dispatchEvent("click");
  await page.getByText("请重新启动 DSH，以加载新版浏览器登录路线", { exact: true }).waitFor();
  assert.equal(loginRequests.length, loginStartsBeforeLegacy);
  assert.equal(context.pages().length, tabsBeforeLegacy);
  assert.equal(await page.locator("#modal").isHidden(), true);
  xaiChecks.legacy = { browserCapabilityDeclared: false, browserButtonDisabled: true, restartMessageVisible: true, deviceFallbackEnabled: true, loginRequestsStarted: 0, authorizationTabsOpened: 0 };
  completed.push("legacy xAI services without browser capability disable browser login, show the DSH restart hint and cannot start authorization");
  await page.close();
  assert.deepEqual(errors, []);
  assert.deepEqual(blockedRequests, []);
  const report = {
    completed, scenarioCount: completed.length, pageErrors: errors, blockedRequests,
    screenshot: artifact, xaiScreenshot: xaiArtifact, xaiChecks,
    evidence: "real Chromium with loopback/mock example endpoints only; no real OAuth, provider requests or credentials",
  };
  await writeFile(reportArtifact, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ ...report, report: reportArtifact }, null, 2));
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
