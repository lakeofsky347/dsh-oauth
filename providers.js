/** Catalog for the first panel. Status is filled in by the page. */
const PROVIDERS = [
  {
    id: "openai-codex",
    name: "ChatGPT / Codex",
    flow: "pkce",
    cli: "dsh oauth login openai-codex",
    docs: "https://github.com/openai/codex",
  },
  {
    id: "anthropic",
    name: "Claude Pro/Max",
    flow: "pkce",
    cli: "dsh oauth login anthropic",
    docs: "https://platform.claude.com",
  },
  {
    id: "xai",
    name: "xAI Grok",
    flow: "device_code",
    cli: "dsh oauth login xai",
    docs: "https://docs.x.ai",
  },
  {
    id: "github-copilot",
    name: "GitHub Copilot",
    flow: "device_code",
    cli: "dsh oauth login github-copilot",
    docs: "https://docs.github.com/copilot",
  },
  {
    id: "kimi-coding",
    name: "Kimi Code",
    flow: "device_code",
    cli: "dsh oauth login kimi-coding",
    docs: "https://www.kimi.com/code",
  },
  {
    id: "google-antigravity",
    name: "Google Antigravity",
    flow: "pkce",
    cli: "dsh oauth login google-antigravity",
    docs: "https://antigravity.google",
  },
];

const FLOW_LABEL = {
  pkce: "浏览器登录",
  device_code: "浏览器登录",
  external: "外部 CLI",
};
