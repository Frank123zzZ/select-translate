// 截图翻译页：显示刚截下的网页截图，用户框选一块，发给 Claude 识别并翻译
import katex from "./lib/katex.mjs";

const shot = document.getElementById("shot");
const dim = document.getElementById("dim");
const box = document.getElementById("box");
const hint = document.getElementById("hint");
const panel = document.getElementById("panel");
const resultEl = document.getElementById("result");
const origWrap = document.getElementById("origWrap");
const origEl = document.getElementById("orig");

const MAX_EDGE = 1568; // 发给 Claude 的图片最长边，再大也不会更清楚，只会更贵
let start = null;
let requestSeq = 0;

// ---------- 读取截图 ----------
const { snip } = await chrome.storage.session.get("snip");
await chrome.storage.session.remove("snip");
if (!snip?.image) {
  showPanelAt(window.innerWidth / 2 - 210, window.innerHeight / 2 - 40);
  setResult(snip?.error || "没有拿到截图，请回到网页再按一次快捷键。", "error");
  hint.style.display = "none";
} else {
  shot.src = snip.image;
  await shot.decode().catch(() => {});
  fitImage();
}
window.addEventListener("resize", fitImage);

// 截图按窗口大小等比缩放显示
function fitImage() {
  if (!shot.naturalWidth) return;
  const scale = Math.min(window.innerWidth / shot.naturalWidth, window.innerHeight / shot.naturalHeight);
  shot.style.width = `${shot.naturalWidth * scale}px`;
  shot.style.height = `${shot.naturalHeight * scale}px`;
}

// ---------- 框选 ----------
document.addEventListener("mousedown", (e) => {
  if (e.button !== 0 || panel.contains(e.target) || !shot.naturalWidth) return;
  start = { x: e.clientX, y: e.clientY };
  panel.style.display = "none";
  hint.style.display = "none";
  dim.style.display = "none";
  drawBox(start, start);
});

document.addEventListener("mousemove", (e) => {
  if (start) drawBox(start, { x: e.clientX, y: e.clientY });
});

document.addEventListener("mouseup", (e) => {
  if (!start) return;
  const end = { x: e.clientX, y: e.clientY };
  const rect = rectOf(start, end);
  start = null;
  if (rect.width < 8 || rect.height < 8) {
    resetSelection();
    return;
  }
  translateRegion(rect);
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") window.close();
});
document.getElementById("close").addEventListener("click", () => window.close());
document.getElementById("again").addEventListener("click", resetSelection);

function rectOf(a, b) {
  const left = Math.min(a.x, b.x);
  const top = Math.min(a.y, b.y);
  return { left, top, width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) };
}

function drawBox(a, b) {
  const r = rectOf(a, b);
  Object.assign(box.style, {
    display: "block",
    left: `${r.left}px`,
    top: `${r.top}px`,
    width: `${r.width}px`,
    height: `${r.height}px`
  });
}

function resetSelection() {
  requestSeq++;
  box.style.display = "none";
  panel.style.display = "none";
  dim.style.display = "block";
  hint.style.display = "block";
}

// ---------- 裁剪并翻译 ----------
function cropToBase64(rect) {
  const img = shot.getBoundingClientRect();
  const scale = shot.naturalWidth / img.width;
  // 框选区域换算到截图原始像素，并限制在图片范围内
  const sx = Math.max(0, (rect.left - img.left) * scale);
  const sy = Math.max(0, (rect.top - img.top) * scale);
  const ex = Math.min(shot.naturalWidth, (rect.left + rect.width - img.left) * scale);
  const ey = Math.min(shot.naturalHeight, (rect.top + rect.height - img.top) * scale);
  const sw = ex - sx;
  const sh = ey - sy;
  if (sw < 4 || sh < 4) return null;
  const shrink = Math.min(1, MAX_EDGE / Math.max(sw, sh));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(sw * shrink);
  canvas.height = Math.round(sh * shrink);
  canvas.getContext("2d").drawImage(shot, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/png").split(",")[1];
}

async function translateRegion(rect) {
  const seq = ++requestSeq;
  placePanel(rect);
  setResult("识别并翻译中…", "loading");
  const data = cropToBase64(rect);
  if (!data) {
    setResult("框选的区域在截图外面，请重新框选。", "error");
    return;
  }
  let res;
  try {
    res = await chrome.runtime.sendMessage({ type: "translateImage", data, mediaType: "image/png" });
  } catch (e) {
    res = { ok: false, error: String(e?.message || e) };
  }
  if (seq !== requestSeq) return; // 期间重新框选了
  if (res?.ok) {
    setResult(res.translation || "（没有识别到文字）", "", res.original);
  } else if (res?.code === "NO_KEY") {
    setResult("截图翻译需要先在插件设置里填写 Anthropic API Key。", "error");
  } else {
    setResult(`翻译失败：${res?.error || "没有返回结果"}`, "error");
  }
  placePanel(rect); // 内容变了，重新摆放
}

// 结果面板放在选框旁边：优先右边，其次左边、下方、上方；都放不下就放在屏幕内
function placePanel(rect) {
  panel.style.display = "block";
  const gap = 10;
  const m = 8;
  const w = panel.offsetWidth;
  const h = panel.offsetHeight;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const clampY = (y) => Math.max(m, Math.min(y, vh - h - m));
  const clampX = (x) => Math.max(m, Math.min(x, vw - w - m));
  const options = [
    { left: rect.left + rect.width + gap, top: clampY(rect.top), ok: rect.left + rect.width + gap + w <= vw - m },
    { left: rect.left - gap - w, top: clampY(rect.top), ok: rect.left - gap - w >= m },
    { left: clampX(rect.left), top: rect.top + rect.height + gap, ok: rect.top + rect.height + gap + h <= vh - m },
    { left: clampX(rect.left), top: rect.top - gap - h, ok: rect.top - gap - h >= m }
  ];
  const best = options.find((o) => o.ok) || { left: clampX(rect.left), top: clampY(rect.top) };
  showPanelAt(best.left, best.top);
}

function showPanelAt(left, top) {
  panel.style.display = "block";
  panel.style.left = `${left}px`;
  panel.style.top = `${top}px`;
}

function setResult(text, cls, original = "") {
  resultEl.className = `text ${cls}`;
  resultEl.textContent = "";
  fillWithMath(resultEl, text);
  origEl.textContent = "";
  if (original) fillWithMath(origEl, original);
  origWrap.style.display = original ? "block" : "none";
  origWrap.open = false;
}

// ---------- LaTeX 公式（和划词弹窗的规则一样） ----------
const ESCAPED_DOLLAR = "";
const MATH_RE = /\$\$([\s\S]+?)\$\$|\$(?!\s)([^$\n]+?)(?<!\s)\$/g;

function fillWithMath(el, text) {
  const t = String(text).replace(/\\\$/g, ESCAPED_DOLLAR);
  const plain = (s) => s.split(ESCAPED_DOLLAR).join("$");
  MATH_RE.lastIndex = 0;
  let last = 0;
  let m;
  while ((m = MATH_RE.exec(t))) {
    const display = m[1] != null;
    let before = t.slice(last, m.index);
    if (display) before = before.replace(/[ \t]*\n[ \t]*$/, "");
    if (last > 1 && t[last - 1] === "$" && t[last - 2] === "$") before = before.replace(/^[ \t]*\n/, "");
    el.append(plain(before));
    const tex = (display ? m[1] : m[2]).split(ESCAPED_DOLLAR).join("\\$");
    const span = document.createElement("span");
    span.className = display ? "math display" : "math";
    try {
      span.innerHTML = katex.renderToString(tex, { output: "mathml", throwOnError: false, displayMode: display });
    } catch (_) {
      span.textContent = m[0];
    }
    el.append(span);
    last = MATH_RE.lastIndex;
  }
  let tail = t.slice(last);
  if (last > 1 && t[last - 1] === "$" && t[last - 2] === "$") tail = tail.replace(/^[ \t]*\n/, "");
  el.append(plain(tail));
}
