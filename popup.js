const keyEl = document.getElementById("key");
const enabledEl = document.getElementById("enabled");
const stateTextEl = document.getElementById("stateText");
const statusEl = document.getElementById("status");

// 没填 Key 时提示正在用的是免费的 Chrome 内置翻译
const NO_KEY_HINT = "未填 Key：使用 Chrome 内置免费翻译";
function showKeyHint(key) {
  statusEl.textContent = key ? "" : NO_KEY_HINT;
  statusEl.style.color = key ? "" : "#999";
  // 「用 ChatGPT 翻译」开关只对填了 Key 的用户有意义；没填 Key 时两个按钮总是显示
  gptRowEl.classList.toggle("show", Boolean(key));
}

// ---------- 「用 ChatGPT 翻译」按钮开关 ----------
const gptRowEl = document.getElementById("gptRow");
const showGptEl = document.getElementById("showGpt");
chrome.storage.sync.get({ showGpt: true }, (v) => (showGptEl.checked = v.showGpt));
showGptEl.addEventListener("change", () => {
  chrome.storage.sync.set({ showGpt: showGptEl.checked });
});

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
      gptRowEl.classList.add("show");
    } else {
      showKeyHint("");
    }
  });
});
