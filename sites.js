// 在这些网站上默认不翻译（主要是 AI 聊天网站）。
// 子域名也算在内，例如 "openai.com" 也包括 "chat.openai.com"。
// 设置窗口里可以对当前网站单独开启/关闭，改动会存进 blockedSites。
const DEFAULT_BLOCKED_SITES = [
  "chatgpt.com",
  "chat.openai.com",
  "claude.ai",
  "claude.com",
  "gemini.google.com",
  "aistudio.google.com",
  "notebooklm.google.com",
  "copilot.microsoft.com",
  "perplexity.ai",
  "poe.com",
  "grok.com",
  "chat.mistral.ai",
  "chat.deepseek.com",
  "kimi.com",
  "kimi.moonshot.cn",
  "doubao.com",
  "tongyi.aliyun.com",
  "qianwen.aliyun.com",
  "yiyan.baidu.com",
  "chatglm.cn",
  "yuanbao.tencent.com"
];

function normalizeHost(host) {
  return String(host || "").trim().toLowerCase().replace(/^www\./, "");
}

// host 是否在列表里（含子域名）
function siteMatches(host, site) {
  host = normalizeHost(host);
  site = normalizeHost(site);
  return Boolean(site) && (host === site || host.endsWith("." + site));
}

function isSiteBlocked(host, list) {
  return (list || []).some((s) => siteMatches(host, s));
}
