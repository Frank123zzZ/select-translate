// 后台 service worker：负责调用 Claude API（API Key 只在这里使用，不暴露给网页）
const API_URL = "https://api.anthropic.com/v1/messages";

// 翻译方向：按原文是什么语言来定
const BASE_PROMPT =
  "你是专业翻译。用户会给你一个 JSON 数组，每项有 id 和 text，都是同一网页上的文字片段。\n" +
  "先判断每个 text 的语言，再按下面的规则决定译成什么：\n" +
  "1. 简体中文 → 译成英文。\n" +
  "2. 繁体中文 → 转成简体中文：不只是换字形，还要把台湾、香港的习惯用语换成大陆通行说法（例如「軟體」→「软件」、「資訊」→「信息」）。\n" +
  "3. 其他任何语言（英语、日语、韩语、法语等）→ 译成简体中文。\n" +
  "以文字的主体语言为准，夹杂的少量外文单词不影响判断。只靠字形难以区分简繁时，看有没有繁体专用字（如「這」「們」「國」「說」）。\n" +
  "专有名词、代码、网址、数字保持原样或采用通用译名。只输出译文，不要附加解释。每个 id 必须且只能返回一次。\n" +
  "近义词：如果某项带有 \"word\": true，说明用户只划了一个词（\"context\" 是这个词所在的句子，用来判断词义）。" +
  "这时 text 给出这个词在该语境下的译文，synonyms 给出 2 到 3 个英文近义词：" +
  "原词是英文，就给原词的英文近义词；原词是中文或其他语言，就给它英文译法的近义词。" +
  "近义词按常用程度排列，只写单词或短语本身，不要重复原词或译文里已有的英文词。" +
  "没有 \"word\": true 的项，synonyms 返回空数组。";

// 两种翻译模式：设置窗口里的滑块在这两者之间切换
const MODES = {
  sonnet: {
    model: "claude-sonnet-5-5",
    effort: "low", // 日常翻译：快、省
    style: "译文要自然、准确，保持原意和语气。\n"
  },
  opus: {
    model: "claude-opus-5-5",
    effort: "medium", // 文学翻译：多想一想措辞
    style:
      "译文要富有文学性：在忠实原意的前提下，讲究遣词造句、节奏和韵味，保留原文的修辞、意象与情感色彩，" +
      "读起来像出自目标语言优秀作家之手，而不是逐字直译。\n"
  }
};

const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    translations: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "integer" },
          text: { type: "string" },
          synonyms: { type: "array", items: { type: "string" } }
        },
        required: ["id", "text", "synonyms"],
        additionalProperties: false
      }
    }
  },
  required: ["translations"],
  additionalProperties: false
};

const SUMMARY_PROMPT =
  "你是阅读助手。用户会给你一段从网页上选中的长文。请总结这段内容：\n" +
  "先用一两句话概括主旨，再列出 3 到 6 个要点，每个要点单独一行，以「• 」开头。\n" +
  "总结用的语言：如果原文主体是简体中文，用英文写；其他情况（包括繁体中文）一律用简体中文写。\n" +
  "只输出总结本身，不要加标题或开场白。";

// 调用 Claude，返回第一段文字；format 为 JSON schema 时要求按格式输出
async function callClaude({ system, content, format, maxTokens = 16000 }) {
  const { apiKey, mode } = await chrome.storage.sync.get({ apiKey: "", mode: "sonnet" });
  if (!apiKey) {
    // 没有 Key 时由网页里的脚本改用 Chrome 内置翻译
    const err = new Error("还没有设置 API Key");
    err.code = "NO_KEY";
    throw err;
  }
  const cfg = MODES[mode] || MODES.sonnet;
  const output_config = { effort: cfg.effort };
  if (format) output_config.format = { type: "json_schema", schema: format };

  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2026-10-21",
      "anthropic-beta": "server-side-fallback-2026-07-01",
      "anthropic-dangerous-direct-browser-access": "true"
    },
    body: JSON.stringify({
      model: cfg.model,
      max_tokens: maxTokens,
      // 被安全分类器误拒时，服务端自动换模型重试
      fallbacks: "default",
      output_config,
      system: typeof system === "function" ? system(cfg) : system,
      messages: [{ role: "user", content }]
    })
  });

  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const err = await res.json();
      msg += `：${err?.error?.message || ""}`;
    } catch (_) {}
    if (res.status === 401) msg = "API Key 无效（401）";
    if (res.status === 429) msg = "请求太频繁（429），稍后再试";
    throw new Error(msg);
  }

  const data = await res.json();
  if (data.stop_reason === "refusal") throw new Error("模型拒绝了这段内容");
  if (data.stop_reason === "max_tokens") throw new Error("输出被截断（max_tokens）");

  const textBlock = (data.content || []).find((b) => b.type === "text");
  if (!textBlock) throw new Error("返回中没有文本");
  return textBlock.text;
}

async function translateBatch(items, languageHint) {
  const text = await callClaude({
    system: (cfg) => cfg.style + BASE_PROMPT,
    content: `源语言类别：${languageHint}\n\n${JSON.stringify(items)}`,
    format: OUTPUT_SCHEMA
  });
  return JSON.parse(text).translations || [];
}

async function summarize(text) {
  return (await callClaude({ system: SUMMARY_PROMPT, content: text, maxTokens: 4000 })).trim();
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const fail = (e) => sendResponse({ ok: false, code: e.code, error: String(e.message || e) });
  if (msg?.type === "translate") {
    translateBatch(msg.items, msg.languageHint)
      .then((translations) => sendResponse({ ok: true, translations }))
      .catch(fail);
    return true; // 异步响应
  }
  if (msg?.type === "summarize") {
    summarize(msg.text)
      .then((summary) => sendResponse({ ok: true, summary }))
      .catch(fail);
    return true;
  }
});

// 旧版本存过按网站开关的设置（blockedSites），现在只用 sites.js，安装或更新时清掉一次
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.remove("blockedSites");
});

// 关闭翻译时，在工具栏图标上显示 “OFF”
function updateBadge(on) {
  chrome.action.setBadgeText({ text: on ? "" : "OFF" });
  chrome.action.setBadgeBackgroundColor({ color: "#888" });
}
chrome.storage.sync.get({ enabled: true }, (v) => updateBadge(v.enabled));
chrome.storage.onChanged.addListener((c) => {
  if (c.enabled) updateBadge(c.enabled.newValue);
});
