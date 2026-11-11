const keyEl = document.getElementById("key");
const enabledEl = document.getElementById("enabled");
const stateTextEl = document.getElementById("stateText");
const statusEl = document.getElementById("status");

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

// ---------- 当前网站开关 ----------
const siteEl = document.getElementById("site");
const siteNameEl = document.getElementById("siteName");
const siteOnEl = document.getElementById("siteOn");
let currentHost = "";

chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
  let url;
  try {
    url = new URL(tab?.url || "");
  } catch (_) {
    return;
  }
  if (!/^https?:$/.test(url.protocol)) return; // chrome:// 等页面不显示
  currentHost = normalizeHost(url.hostname);
  siteNameEl.textContent = currentHost;
  siteEl.title = currentHost;
  chrome.storage.sync.get({ blockedSites: DEFAULT_BLOCKED_SITES }, (v) => {
    siteOnEl.checked = !isSiteBlocked(currentHost, v.blockedSites);
    siteEl.classList.add("show");
  });
});

siteOnEl.addEventListener("change", () => {
  const on = siteOnEl.checked;
  chrome.storage.sync.get({ blockedSites: DEFAULT_BLOCKED_SITES }, (v) => {
    let list = v.blockedSites.slice();
    if (on) {
      // 开启：去掉所有能匹配到当前网站的条目
      list = list.filter((s) => !siteMatches(currentHost, s));
    } else if (!isSiteBlocked(currentHost, list)) {
      list.push(currentHost);
    }
    chrome.storage.sync.set({ blockedSites: list });
  });
});

document.getElementById("save").addEventListener("click", () => {
  chrome.storage.sync.set({ apiKey: keyEl.value.trim() }, () => {
    statusEl.textContent = "Key 已保存 ✓";
  });
});
