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

// 截图翻译的两种情况：
// 1) 有蓝色高亮：只翻译高亮的文字；2) 没有高亮、用户自己框选了一块：翻译框里的全部文字
const IMAGE_COMMON =
  "原样识别出来的文字写进 original，翻译写进 translation。\n" +
  DIRECTION_RULES +
  "看不清的字用 [?] 标出，不要编造。\n" +
  "数学公式（original 和 translation 都适用）：" + MATH_RULES;

const IMAGE_PROMPT_HIGHLIGHT =
  "你是专业翻译。这是一张网页（常常是 PDF 论文）的局部截图，其中带浅蓝色背景高亮的文字是用户选中、想要翻译的部分。\n" +
  "只识别并翻译高亮的文字；高亮以外的文字只用来理解上下文，不要识别也不要翻译。高亮跨多行时，按阅读顺序连起来。\n" +
  "如果图里其实没有被浅蓝色高亮的、看得清的文字（例如只是蓝色的边框、按钮、缩略图，或字太小看不清），" +
  "found 设为 false，original 和 translation 都留空；否则 found 设为 true。\n" +
  IMAGE_COMMON;

const IMAGE_PROMPT_REGION =
  "你是专业翻译。用户从网页（常常是 PDF 论文）上框选截了一块图。\n" +
  "识别并翻译图中的全部文字；被截断、只露出一半的行可以略去。found 设为 true。\n" +
  IMAGE_COMMON;

const IMAGE_SCHEMA = {
  type: "object",
  properties: {
    found: { type: "boolean" },
    original: { type: "string" },
    translation: { type: "string" }
  },
  required: ["found", "original", "translation"],
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

async function translateImage(base64, mediaType, highlight) {
  const text = await callClaude({
    system: (cfg) => cfg.style + (highlight ? IMAGE_PROMPT_HIGHLIGHT : IMAGE_PROMPT_REGION),
    content: [
      { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
      { type: "text", text: highlight ? "请识别并翻译截图里蓝色高亮的文字。" : "请识别并翻译这张截图里的文字。" }
    ],
    format: IMAGE_SCHEMA,
    maxTokens: 8000
  });
  return JSON.parse(text);
}

// ---------- 高亮截图翻译（快捷键，默认 Alt+T） ----------
// Chrome 自带的 PDF 阅读器不让插件读文字，也收不到鼠标和键盘事件。
// 做法：用户先在 PDF 里划选（文字变蓝）→ 按快捷键 → 后台截下当前页面（不显示给用户）
// → 找出蓝色高亮的区域 → 只把这一块交给 Claude 识别并翻译 → 结果显示在工具栏图标弹出的小窗里。
const MAX_EDGE = 1568; // 发给 Claude 的图片最长边，再大也不会更清楚，只会更贵

// 浅蓝色的选中高亮（PDF 阅读器和普通网页的选区颜色都在这个范围）；深蓝色的文字、链接不算
function isHighlight(r, g, b) {
  return b >= 200 && b - r >= 40 && b - g >= 8 && r >= 90 && r <= 215 && g >= 140;
}

// 在截图里找蓝色高亮：按 10×10 的小格统计，高亮像素占到一半左右的格子才算；
// 这样细细的蓝色边框（例如缩略图的选中框）不会被当成高亮。再取连在一起的最大一片。
async function findHighlight(bitmap) {
  const W = bitmap.width;
  const H = bitmap.height;
  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  const { data } = ctx.getImageData(0, 0, W, H);

  const CELL = 10;
  const cols = Math.ceil(W / CELL);
  const rows = Math.ceil(H / CELL);
  const marked = new Uint8Array(cols * rows);
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      let hit = 0;
      let total = 0;
      for (let y = cy * CELL; y < Math.min(H, cy * CELL + CELL); y += 2) {
        for (let x = cx * CELL; x < Math.min(W, cx * CELL + CELL); x += 2) {
          const i = (y * W + x) * 4;
          total++;
          if (isHighlight(data[i], data[i + 1], data[i + 2])) hit++;
        }
      }
      if (hit / total >= 0.45) marked[cy * cols + cx] = 1;
    }
  }

  // 相距两格以内的高亮格算作同一片（多行选区之间有行距的空白）
  const seen = new Uint8Array(cols * rows);
  let best = null;
  for (let start = 0; start < marked.length; start++) {
    if (!marked[start] || seen[start]) continue;
    const stack = [start];
    seen[start] = 1;
    const box = { minX: cols, minY: rows, maxX: -1, maxY: -1, count: 0 };
    while (stack.length) {
      const k = stack.pop();
      const x = k % cols;
      const y = (k - x) / cols;
      box.count++;
      box.minX = Math.min(box.minX, x);
      box.maxX = Math.max(box.maxX, x);
      box.minY = Math.min(box.minY, y);
      box.maxY = Math.max(box.maxY, y);
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
          const n = ny * cols + nx;
          if (marked[n] && !seen[n]) {
            seen[n] = 1;
            stack.push(n);
          }
        }
      }
    }
    // 真正的文字高亮至少有几个字宽、一行字高；细长的蓝线不算。
    // 高亮是实心的一块，缩略图的选中框是空心的框：框住的范围里蓝色格子太少就不算
    const w = box.maxX - box.minX + 1;
    const h = box.maxY - box.minY + 1;
    if (w < 3 || h < 2) continue;
    if (box.count / (w * h) < 0.4) continue;
    if (!best || box.count > best.count) best = box;
  }
  if (!best) return null;
  return {
    x: best.minX * CELL,
    y: best.minY * CELL,
    width: (best.maxX - best.minX + 1) * CELL,
    height: (best.maxY - best.minY + 1) * CELL
  };
}

// 高亮区域四周多留一点，让 Claude 看得到上下文；太大就缩小
async function cropToBase64(bitmap, box) {
  const pad = 40;
  const sx = Math.max(0, box.x - pad);
  const sy = Math.max(0, box.y - pad);
  const ex = Math.min(bitmap.width, box.x + box.width + pad);
  const ey = Math.min(bitmap.height, box.y + box.height + pad);
  const sw = ex - sx;
  const sh = ey - sy;
  const shrink = Math.min(1, MAX_EDGE / Math.max(sw, sh));
  const canvas = new OffscreenCanvas(Math.round(sw * shrink), Math.round(sh * shrink));
  canvas.getContext("2d").drawImage(bitmap, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  const blob = await canvas.convertToBlob({ type: "image/png" });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

// 结果存在 session 存储里，工具栏弹窗打开后读取并跟着更新
async function setPdfResult(result) {
  await chrome.storage.session.set({ pdfResult: { ...result, at: Date.now() } });
}

// 打开工具栏弹窗显示结果；打不开时（例如窗口没有焦点）在图标上标个「译」，点图标也能看到
async function showResultPopup() {
  try {
    await chrome.action.openPopup();
  } catch (_) {
    chrome.action.setBadgeText({ text: "译" });
    chrome.action.setBadgeBackgroundColor({ color: "#d97757" });
  }
}

// 没有蓝色高亮：打开框选窗口，让用户自己框出要翻译的区域
async function openSnipWindow(tab, dataUrl) {
  await chrome.storage.session.set({ snip: { image: dataUrl } });
  const win = await chrome.windows.get(tab.windowId);
  const opts = { url: chrome.runtime.getURL("snip.html"), type: "popup", focused: true };
  if (win.state === "maximized" || win.state === "fullscreen") opts.state = "maximized";
  else Object.assign(opts, { left: win.left, top: win.top, width: win.width, height: win.height });
  await chrome.windows.create(opts);
}

async function translateHighlight(tab) {
  if (!tab) [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;

  let dataUrl;
  try {
    dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  } catch (_) {
    await setPdfResult({ status: "error", error: "这个页面不允许截图（例如 Chrome 的设置页、扩展商店页面）。" });
    await showResultPopup();
    return;
  }

  const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const box = await findHighlight(bitmap);
  if (!box) {
    await openSnipWindow(tab, dataUrl);
    return;
  }

  await setPdfResult({ status: "loading" });
  await showResultPopup();
  try {
    const data = await cropToBase64(bitmap, box);
    const r = await translateImage(data, "image/png", true);
    if (!r.found || !String(r.translation || "").trim()) {
      // Claude 看了说没有选中的文字：多半是把别的蓝色东西当成了高亮，改为让用户自己框选
      await chrome.storage.session.remove("pdfResult");
      await openSnipWindow(tab, dataUrl);
      return;
    }
    await setPdfResult({ status: "done", translation: r.translation, original: r.original });
  } catch (e) {
    const msg = e.code === "NO_KEY" ? "截图翻译需要先在插件设置里填写 Anthropic API Key。" : String(e.message || e);
    await setPdfResult({ status: "error", error: msg });
  }
}

// 按下快捷键后，图标上先显示「…」，让用户知道插件收到了；做完恢复原来的状态
async function restoreBadge() {
  // 已经换成了「译」（提示用户点图标看结果）就不动它
  if ((await chrome.action.getBadgeText({})) !== "…") return;
  const { enabled } = await chrome.storage.sync.get({ enabled: true });
  chrome.action.setBadgeText({ text: enabled ? "" : "OFF" });
  chrome.action.setBadgeBackgroundColor({ color: "#888" });
}

// 连按两次快捷键：不找高亮，直接截图并打开框选窗口
async function snipDirect(tab) {
  if (!tab) [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  let dataUrl;
  try {
    dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  } catch (_) {
    await setPdfResult({ status: "error", error: "这个页面不允许截图（例如 Chrome 的设置页、扩展商店页面）。" });
    await showResultPopup();
    return;
  }
  await openSnipWindow(tab, dataUrl);
}

async function runShortcut(tab, snipOnly) {
  try {
    if (snipOnly) await snipDirect(tab);
    else await translateHighlight(tab);
    await restoreBadge();
  } catch (e) {
    // 任何一步出错都显示出来，不再悄悄失败
    await restoreBadge();
    await setPdfResult({ status: "error", error: `截图翻译出错：${e?.message || e}` });
    await showResultPopup();
  }
}

// 按一次：翻译蓝色高亮；0.4 秒内再按一次：直接框选截图。
// 所以按一次之后要稍等一下，确认没有第二次再开始。
const DOUBLE_PRESS_MS = 400;
let pendingPress = null;

chrome.commands.onCommand.addListener((command, tab) => {
  if (command !== "snip-translate") return;
  chrome.action.setBadgeText({ text: "…" });
  chrome.action.setBadgeBackgroundColor({ color: "#d97757" });
  if (pendingPress) {
    clearTimeout(pendingPress);
    pendingPress = null;
    runShortcut(tab, true);
    return;
  }
  pendingPress = setTimeout(() => {
    pendingPress = null;
    runShortcut(tab, false);
  }, DOUBLE_PRESS_MS);
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
  if (msg?.type === "escape" && _sender.tab?.id != null) {
    // 某个小网页里按了 Esc（例如 Google Docs 把键盘输入交给内部的隐藏网页）：
    // 通知这个标签页里的所有网页，把翻译弹窗关掉
    chrome.tabs.sendMessage(_sender.tab.id, { type: "hidePopup" }).catch(() => {});
    return;
  }
  if (msg?.type === "translateImage") {
    // 框选窗口里用户自己框出的区域
    translateImage(msg.data, msg.mediaType, false)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch(fail);
    return true;
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
