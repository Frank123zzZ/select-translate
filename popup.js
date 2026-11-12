const keyEl = document.getElementById("key");
const enabledEl = document.getElementById("enabled");
const stateTextEl = document.getElementById("stateText");
const statusEl = document.getElementById("status");

// 没填 Key 时提示正在用的是免费的 Chrome 内置翻译
const NO_KEY_HINT = "未填 Key：使用 Chrome 内置免费翻译";
function showKeyHint(key) {
  statusEl.textContent = key ? "" : NO_KEY_HINT;
  statusEl.style.color = key ? "" : "#999";
}

// ---------- 截图翻译结果（Alt+T 后由后台写入，弹窗打开时显示） ----------
// 两分钟内的结果才显示；否则就是普通的设置窗口
const RESULT_FRESH_MS = 2 * 60 * 1000;
const resultTextEl = document.getElementById("resultText");
const origWrapEl = document.getElementById("origWrap");
const origTextEl = document.getElementById("origText");
let mathLib = null;

async function renderResult(r) {
  if (!r || Date.now() - r.at > RESULT_FRESH_MS) return;
  document.body.classList.add("result-mode");
  if (!mathLib) {
    mathLib = await import("./lib/mathtext.mjs");
    document.getElementById("mathCss").textContent = mathLib.MATH_CSS;
  }
  resultTextEl.textContent = "";
  origTextEl.textContent = "";
  origWrapEl.style.display = "none";
  if (r.status === "loading") {
    resultTextEl.className = "loading";
    resultTextEl.textContent = "识别并翻译中…";
  } else if (r.status === "error") {
    resultTextEl.className = "error";
    resultTextEl.textContent = r.error || "翻译失败";
  } else {
    resultTextEl.className = "";
    mathLib.fillWithMath(resultTextEl, r.translation || "（没有识别到文字）");
    if (r.original) {
      mathLib.fillWithMath(origTextEl, r.original);
      origWrapEl.style.display = "block";
    }
  }
  // 公式的字形会比文字行略高几个像素；只有译文真的很长时才显示滚动条
  resultTextEl.style.overflowY = resultTextEl.scrollHeight - resultTextEl.clientHeight > 4 ? "auto" : "hidden";
}

chrome.storage.session.get("pdfResult", (v) => renderResult(v.pdfResult));
chrome.storage.onChanged.addListener((c, area) => {
  if (area === "session" && c.pdfResult) renderResult(c.pdfResult.newValue);
});
document.getElementById("toSettings").addEventListener("click", () => {
  document.body.classList.remove("result-mode");
  chrome.storage.session.remove("pdfResult"); // 看过了，下次点图标直接进设置
});

// 打开弹窗后去掉图标上的「译」提示，恢复开关状态的显示
chrome.storage.sync.get({ enabled: true }, (v) => chrome.action.setBadgeText({ text: v.enabled ? "" : "OFF" }));

function showState(on) {
  enabledEl.checked = on;
  stateTextEl.textContent = on ? "已开启" : "已关闭";
  stateTextEl.style.color = on ? "#d97757" : "#999";
}

const segEl = document.getElementById("seg");

function showMode(mode) {
  segEl.dataset.mode = mode;
  for (const b of segEl.querySelectorAll("button")) {
    const on = b.dataset.mode === mode;
    b.classList.toggle("active", on);
    b.setAttribute("aria-checked", String(on));
  }
}

chrome.storage.sync.get({ apiKey: "", enabled: true, mode: "sonnet" }, (v) => {
  keyEl.value = v.apiKey;
  showKeyHint(v.apiKey);
  showState(v.enabled);
  showMode(v.mode);
});

// 模型滑块：点哪边就切到哪边，立即生效
segEl.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-mode]");
  if (!btn) return;
  const mode = btn.dataset.mode;
  chrome.storage.sync.set({ mode }, () => showMode(mode));
});

// 开关：一拨就生效，不需要点保存
enabledEl.addEventListener("change", () => {
  const on = enabledEl.checked;
  chrome.storage.sync.set({ enabled: on }, () => showState(on));
});

document.getElementById("save").addEventListener("click", () => {
  const key = keyEl.value.trim();
  chrome.storage.sync.set({ apiKey: key }, () => {
    if (key) {
      statusEl.textContent = "Key 已保存 ✓";
      statusEl.style.color = "";
    } else {
      showKeyHint("");
    }
  });
});
