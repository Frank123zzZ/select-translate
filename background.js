// 后台 service worker：负责调用 Claude API（API Key 只在这里使用，不暴露给网页）
const API_URL = "https://api.anthropic.com/v1/messages";

// 公式统一用 LaTeX 写，弹窗会把它渲染成正常的数学公式。翻译和总结共用这段规则
const MATH_RULES =
  "原文里的数学公式、符号、变量、单位，一律用 LaTeX 写在译文里：行内的用 $...$，单独成行的用 $$...$$。" +
  "从 PDF 等处复制出来的公式常常变形（上下标被拆开、∑ ∫ 等符号乱码、分式变成几段零散文字），" +
  "要根据上下文还原成正确的 LaTeX，例如「x 2 + y 2」写成 $x^2 + y^2$，「∑ 𝑖=1 𝑛 𝑥 𝑖」写成 $\\sum_{i=1}^{n} x_i$。" +
  "公式本身不翻译，变量名保持原样；只有公式旁边的文字需要翻译。" +
  "原文里表示金额等用途、不是公式的美元符号，写成 \\$。没有公式的内容照常输出纯文字，不要加 $。";

// 翻译方向：按原文是什么语言来定（划词翻译和截图翻译共用）
const DIRECTION_RULES =
  "先判断原文的语言，再按下面的规则决定译成什么：\n" +
  "1. 简体中文 → 译成英文。\n" +
  "2. 繁体中文 → 转成简体中文：不只是换字形，还要把台湾、香港的习惯用语换成大陆通行说法（例如「軟體」→「软件」、「資訊」→「信息」）。\n" +
  "3. 其他任何语言（英语、日语、韩语、法语等）→ 译成简体中文。\n" +
  "以文字的主体语言为准，夹杂的少量外文单词不影响判断。只靠字形难以区分简繁时，看有没有繁体专用字（如「這」「們」「國」「說」）。\n" +
  "专有名词、代码、网址、数字保持原样或采用通用译名。只输出译文，不要附加解释。\n";

const BASE_PROMPT =
  "你是专业翻译。用户会给你一个 JSON 数组，每项有 id 和 text，都是同一网页上的文字片段，每个 text 分别翻译。\n" +
  DIRECTION_RULES +
  "每个 id 必须且只能返回一次。\n" +
  "近义词：如果某项带有 \"word\": true，说明用户只划了一个词（\"context\" 是这个词所在的句子，用来判断词义）。" +
  "这时 text 给出这个词在该语境下的译文，synonyms 给出 2 到 3 个英文近义词：" +
  "原词是英文，就给原词的英文近义词；原词是中文或其他语言，就给它英文译法的近义词。" +
  "近义词按常用程度排列，只写单词或短语本身，不要重复原词或译文里已有的英文词。" +
  "没有 \"word\": true 的项，synonyms 返回空数组。\n" +
  "数学公式：" + MATH_RULES;

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
  "只输出总结本身，不要加标题或开场白。\n" +
  "数学公式：" + MATH_RULES;

// 截图翻译：先认出图里的文字，再按同样的规则翻译
const IMAGE_PROMPT =
  "你是专业翻译。用户从网页（常常是 PDF 论文）上截了一块图。\n" +
  "先把图中的文字原样识别出来写进 original，再翻译写进 translation。\n" +
  DIRECTION_RULES +
  "只处理图里实际出现的内容；被截断、只露出一半的行可以略去。看不清的字用 [?] 标出，不要编造。\n" +
  "数学公式（original 和 translation 都适用）：" + MATH_RULES;

const IMAGE_SCHEMA = {
  type: "object",
  properties: {
    original: { type: "string" },
    translation: { type: "string" }
  },
  required: ["original", "translation"],
  additionalProperties: false
};

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

async function translateImage(base64, mediaType) {
  const text = await callClaude({
    system: (cfg) => cfg.style + IMAGE_PROMPT,
    content: [
      { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
      { type: "text", text: "请识别并翻译这张截图里的文字。" }
    ],
    format: IMAGE_SCHEMA,
    maxTokens: 8000
  });
  return JSON.parse(text);
}

// ---------- 截图翻译（Alt+T，或设置窗口里的按钮） ----------
// Chrome 自带的 PDF 阅读器不让插件读文字，也收不到鼠标事件。
// 所以：截下当前标签页 → 在一个同样大小的窗口里显示截图 → 用户框选 → 把框选部分发给 Claude 识别并翻译。
async function startSnip(tab) {
  if (!tab) [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  try {
    const image = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
    await chrome.storage.session.set({ snip: { image } });
  } catch (e) {
    await chrome.storage.session.set({
      snip: { error: "这个页面不允许截图（例如 Chrome 的设置页、扩展商店页面）。" }
    });
  }
  const win = await chrome.windows.get(tab.windowId);
  const opts = { url: chrome.runtime.getURL("snip.html"), type: "popup", focused: true };
  if (win.state === "maximized" || win.state === "fullscreen") opts.state = "maximized";
  else Object.assign(opts, { left: win.left, top: win.top, width: win.width, height: win.height });
  await chrome.windows.create(opts);
}

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === "snip-translate") startSnip(tab);
});

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
  if (msg?.type === "translateImage") {
    translateImage(msg.data, msg.mediaType)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch(fail);
    return true;
  }
  if (msg?.type === "startSnip") {
    startSnip().catch(() => {});
  }
});

// 旧版本存过、现在已不用的设置，安装或更新时清掉一次：
// blockedSites（按网站开关，现在只用 sites.js）、showGpt（「显示用 ChatGPT 翻译」开关，已去掉）
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.remove(["blockedSites", "showGpt"]);
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
