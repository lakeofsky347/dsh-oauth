/**
 * Visual tokens taken from the open DeepSeek Harness page
 * (body[data-ds-dark-theme] in @deepseek-ai/dsh-client-ui-theme).
 *
 * Override before the panel paints:
 *
 *   DshOAuth.applyTheme({ accent: "#679efe", radius: "16px" })
 *
 * Or after load, the same call updates the live page and any auth popup
 * that reads DshOAuth.getTheme() from its opener.
 *
 * Login is separate from paint:
 *
 *   DshOAuth.setLoginOpener((provider) => window.open(realAuthUrl))
 *   DshOAuth.onAuthorize(async (provider) => exchangeCode(provider))
 *   DshOAuth.registerProvider({ id, name, cli, docs })
 */
(function () {
  const DARK = {
    bg: "#151517",
    layer1: "#232324",
    layer2: "#2c2c2e",
    layer3: "#353638",
    text: "#f9fafb",
    textSecondary: "#cfd3d6",
    textTertiary: "#adb2b8",
    caption: "#81858c",
    border: "#ffffff1f",
    borderSubtle: "#ffffff0f",
    hover: "#ffffff14",
    primaryFill: "#f9fafb",
    primaryText: "#0f1115",
    accent: "#5686fe",
    success: "#4ed17e",
    danger: "#f25a5a",
    font: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Helvetica Neue", Helvetica, Arial, sans-serif',
    mono: '"SF Mono", "JetBrains Mono", "Fira Code", Consolas, "Liberation Mono", Menlo, Courier, "PingFang SC", "Microsoft YaHei"',
    radius: "12px",
    radiusControl: "8px",
    shadow: "0 0 0 0.5px #ffffff29, 0 12px 32px #00000014",
  };

  const cssName = (key) => "--dsh-oauth-" + key.replace(/[A-Z]/g, (letter) => "-" + letter.toLowerCase());

  let current = { ...DARK };
  let loginOpener = null;
  const authorizeHooks = [];

  function applyTheme(partial) {
    current = { ...current, ...(partial || {}) };
    const root = document.documentElement;
    for (const [key, value] of Object.entries(current)) {
      if (value != null) root.style.setProperty(cssName(key), String(value));
    }
    document.dispatchEvent(new CustomEvent("dsh-oauth-theme", { detail: getTheme() }));
    return getTheme();
  }

  function getTheme() {
    return { ...current };
  }

  function registerProvider(provider) {
    if (!provider || typeof provider.id !== "string" || typeof provider.name !== "string") {
      throw new TypeError("DshOAuth.registerProvider requires { id, name }");
    }
    const next = {
      flow: "pkce",
      cli: `dsh oauth login ${provider.id}`,
      docs: "#",
      ...provider,
    };
    const index = PROVIDERS.findIndex((item) => item.id === next.id);
    if (index >= 0) PROVIDERS[index] = next;
    else PROVIDERS.push(next);
    if (!FLOW_LABEL[next.flow]) FLOW_LABEL[next.flow] = "浏览器登录";
    document.dispatchEvent(new CustomEvent("dsh-oauth-providers", { detail: next }));
    return next;
  }

  window.DshOAuth = {
    /** Token names accepted by applyTheme. Unknown keys still become CSS variables. */
    themeKeys: Object.keys(DARK),
    getTheme,
    applyTheme,
    /**
     * @param {(provider: {id: string, name: string}) => Window | null} opener
     * Return the auth window. The panel marks the row "登录中" and waits for
     * a postMessage `{ type: "dsh-oauth", provider, ok }`.
     */
    setLoginOpener(opener) {
      loginOpener = opener;
    },
    loginOpener() {
      return loginOpener;
    },
    /**
     * @param {(provider: {id: string, name: string}) => boolean | Promise<boolean>} hook
     * Return false to keep the provider disconnected after the auth page says ok.
     */
    onAuthorize(hook) {
      authorizeHooks.push(hook);
      return () => {
        const index = authorizeHooks.indexOf(hook);
        if (index >= 0) authorizeHooks.splice(index, 1);
      };
    },
    async runAuthorizeHooks(provider) {
      for (const hook of authorizeHooks) {
        if (await hook(provider) === false) return false;
      }
      return true;
    },
    registerProvider,
  };

  applyTheme();
})();
