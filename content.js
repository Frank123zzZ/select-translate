// 内容脚本：监听划词 → 把选中的文字发去翻译 → 在选区旁边弹出翻译结果（不改动网页原文）
(() => {
  // 选中的内容里至少要有文字（纯数字、符号不翻译）。
  // 翻译方向交给模型判断：简体中文 → 英文，繁体中文 → 简体中文，其他语言 → 简体中文
  const LETTER = /\p{L}/u;

  // 当前网站（在嵌入的小网页里，以浏览器地址栏上的网站为准）
  function topHost() {
    try {
      return window.top.location.hostname;
    } catch (_) {
      const a = location.ancestorOrigins;
      if (a && a.length) {
        try {
          return new URL(a[a.length - 1]).hostname;
        } catch (_) {}
      }
      return location.hostname;
    }
  }
  const HOST = topHost();

  // 总开关打开、并且当前网站没有被停用，才翻译
  let switchOn = true;
  let siteBlocked = isSiteBlocked(HOST, DEFAULT_BLOCKED_SITES);
  let enabled = switchOn && !siteBlocked;
  function refreshEnabled() {
    enabled = switchOn && !siteBlocked;
    if (!enabled) hidePopup(); // 关掉时顺手收起已经弹出的翻译
  }

  chrome.storage.sync.get({ enabled: true, blockedSites: DEFAULT_BLOCKED_SITES }, (v) => {
    switchOn = v.enabled;
    siteBlocked = isSiteBlocked(HOST, v.blockedSites);
    refreshEnabled();
  });
  chrome.storage.onChanged.addListener((c) => {
    if (c.enabled) switchOn = c.enabled.newValue;
    if (c.blockedSites) siteBlocked = isSiteBlocked(HOST, c.blockedSites.newValue);
    if (c.enabled || c.blockedSites) refreshEnabled();
  });

  // ---------- 弹窗（放在 Shadow DOM 里，不受网页样式影响） ----------
  let host = null;
  let box = null;
  let bodyEl = null;
  let requestSeq = 0;

  function ensurePopup() {
    if (host) return;
    host = document.createElement("div");
    host.className = "cst-host";
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        .box {
          position: absolute;
          box-sizing: border-box;
          width: max-content;
          max-height: 320px;
          overflow: auto;
          padding: 10px 30px 10px 12px;
          border-radius: 10px;
          background: #fff;
          color: #1f1f1f;
          border: 1px solid rgba(0, 0, 0, 0.1);
          box-shadow: 0 6px 24px rgba(0, 0, 0, 0.18);
          font: 14px/1.6 -apple-system, "Microsoft YaHei", "PingFang SC", sans-serif;
          text-align: left;
        }
        .body { white-space: pre-wrap; word-break: break-word; }
        .close {
          position: absolute; top: 4px; right: 6px;
          border: 0; background: none; cursor: pointer;
          font-size: 16px; line-height: 1; color: #999; padding: 4px;
        }
        .close:hover { color: #333; }
        .loading { color: #888; }
        .error { color: #c0392b; }
        .syn { margin-top: 4px; padding-top: 4px; border-top: 1px solid rgba(0, 0, 0, 0.08); font-size: 13px; color: #555; }
        .syn-label { margin-right: 6px; font-size: 12px; color: #d97757; }
        @media (prefers-color-scheme: dark) {
          .box { background: #2b2b2b; color: #eee; border-color: rgba(255,255,255,0.12); }
          .close:hover { color: #fff; }
          .error { color: #ff8a80; }
          .syn { color: #bbb; border-top-color: rgba(255, 255, 255, 0.12); }
        }
      </style>
      <div class="box" role="dialog" aria-label="翻译">
        <button class="close" title="关闭" aria-label="关闭">×</button>
        <div class="body"></div>
      </div>`;
    box = shadow.querySelector(".box");
    bodyEl = shadow.querySelector(".body");
    shadow.querySelector(".close").addEventListener("click", hidePopup);
    document.documentElement.appendChild(host);
  }

  function hidePopup() {
    requestSeq++; // 让还没返回的请求结果作废
    if (host) host.style.display = "none";
  }

  const MAX_W = 420; // 弹窗最大宽度
  const GAP = 8; // 弹窗和选中文字的间距
  const MARGIN = 8; // 弹窗离屏幕边缘的最小距离

  // 宽度：一行放得下就按一行的宽度；两行放得下就让两行差不多一样长；更长才用最大宽度
  function sizePopup() {
    const vw = document.documentElement.clientWidth;
    const maxW = Math.min(MAX_W, vw - MARGIN * 2);
    box.style.maxWidth = "none";
    bodyEl.style.whiteSpace = "pre"; // 先不换行，量出一行的自然宽度
    box.style.width = "max-content";
    const natural = Math.ceil(box.getBoundingClientRect().width) + 1;
    const cs = getComputedStyle(box);
    const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) + 2; // +边框
    bodyEl.style.whiteSpace = "";

    let width;
    if (natural <= maxW) {
      width = natural;
    } else if (natural - padX <= (maxW - padX) * 2) {
      width = Math.ceil((natural - padX) / 2 + padX + 20); // 两行均分，留一点余量
    } else {
      width = maxW;
    }
    box.style.width = `${Math.min(width, maxW)}px`;
  }

  // 收集选区附近已经被占用的区域：文字行、图片、视频、表单控件等
  function collectObstacles(region, sel) {
    const rects = [];
    const hits = (r) =>
      r.width > 0 && r.height > 0 &&
      r.right > region.left && r.left < region.right &&
      r.bottom > region.top && r.top < region.bottom;

    const MEDIA = new Set([
      "IMG", "VIDEO", "CANVAS", "SVG", "IFRAME", "EMBED", "OBJECT",
      "INPUT", "TEXTAREA", "SELECT", "BUTTON", "HR"
    ]);
    const range = document.createRange();

    // 遍历整个页面，包括网页组件内部（Shadow DOM）里的内容
    forEachDeep(document.body, (node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        if (!node.nodeValue.trim()) return;
        const p = node.parentElement;
        if (!p || !hits(p.getBoundingClientRect())) return;
        range.selectNodeContents(node);
        for (const r of range.getClientRects()) if (hits(r)) rects.push(r);
      } else if (MEDIA.has(node.tagName.toUpperCase())) {
        const r = node.getBoundingClientRect();
        if (!hits(r)) return;
        // 网页里的 PDF 阅读器：整页画在一张 canvas/图片上，上面盖一层透明文字。
        // 选中的文字压在这张图上，说明它只是页面背景，空白要按文字层来判断
        if (sel && r.left <= sel.left && r.right >= sel.right && r.top <= sel.top && r.bottom >= sel.bottom) return;
        rects.push(r);
      }
    });
    return rects;
  }

  // 深度遍历：普通节点 + 打开的 Shadow DOM；跳过插件自己的弹窗
  function forEachDeep(root, fn) {
    if (!root) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) {
      if (n === host) continue;
      fn(n);
      if (n.nodeType === Node.ELEMENT_NODE && n.shadowRoot) forEachDeep(n.shadowRoot, fn);
    }
  }

  // 找位置：优先选区附近的空白处（离选区越近越好）；附近没有空白就放到选区上方
  function placePopup(range) {
    sizePopup();
    const sel = range.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const vh = window.innerHeight;
    const w = box.offsetWidth;
    const h = box.offsetHeight;

    const fits = (c) =>
      c.left >= MARGIN && c.top >= MARGIN && c.left + w <= vw - MARGIN && c.top + h <= vh - MARGIN;

    const region = {
      left: sel.left - w - GAP * 2,
      right: sel.right + w + GAP * 2,
      top: sel.top - h - GAP * 2,
      bottom: sel.bottom + h + GAP * 2
    };
    const obstacles = collectObstacles(region, sel);
    const PAD = 4; // 和周围文字至少隔开一点
    const isBlank = (c) =>
      !obstacles.some(
        (r) =>
          r.right > c.left - PAD && r.left < c.left + w + PAD &&
          r.bottom > c.top - PAD && r.top < c.top + h + PAD
      );

    // 选区跨多行时，以第一行和最后一行为准：最后一行后面、第一行前面常常有空白
    const lines = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
    const first = lines[0] || sel;
    const last = lines[lines.length - 1] || sel;

    // 候选位置：右边、左边、下方、上方，每个方向再错开几档
    const candidates = [];
    for (const dy of [0, -(h - last.height) / 2, -(h - last.height)]) {
      candidates.push({ left: last.right + GAP, top: last.top + dy });
    }
    for (const dy of [0, -(h - first.height) / 2, -(h - first.height)]) {
      candidates.push({ left: first.left - w - GAP, top: first.top + dy });
    }
    for (const dx of [0, -(w - last.width) / 2, -(w - last.width), -w / 2]) {
      candidates.push({ left: last.left + dx, top: sel.bottom + GAP });
    }
    for (const dx of [0, -(w - first.width) / 2, -(w - first.width), -w / 2]) {
      candidates.push({ left: first.left + dx, top: sel.top - h - GAP });
    }

    const cx = (sel.left + sel.right) / 2;
    const cy = (sel.top + sel.bottom) / 2;
    const dist = (c) => Math.hypot(c.left + w / 2 - cx, c.top + h / 2 - cy);

    let best = candidates
      .filter((c) => fits(c) && isBlank(c))
      .sort((a, b) => dist(a) - dist(b))[0];

    if (!best) {
      // 附近全是文字：放在选区上方，不挡住下文；上方放不下才放下方
      const left = Math.max(MARGIN, Math.min(sel.left, vw - w - MARGIN));
      const above = sel.top - h - GAP;
      best = above >= MARGIN ? { left, top: above } : { left, top: sel.bottom + GAP };
    }

    // 用页面坐标定位，这样页面滚动时弹窗跟着选中的文字走
    box.style.left = `${best.left + window.scrollX}px`;
    box.style.top = `${best.top + window.scrollY}px`;
  }

  function showPopup(range, content, cls, synonyms = []) {
    ensurePopup();
    host.style.display = "block";
    bodyEl.className = `body ${cls || ""}`;
    bodyEl.textContent = content;
    if (synonyms.length) {
      // 单词的英文近义词，显示在译文下面一行
      const syn = document.createElement("div");
      syn.className = "syn";
      const label = document.createElement("span");
      label.className = "syn-label";
      label.textContent = "近义词";
      syn.append(label, synonyms.join(" · "));
      bodyEl.append(syn);
    }
    box.scrollTop = 0;
    placePopup(range);
  }

  function inPopup(e) {
    return host && e.composedPath().includes(host);
  }

  // ---------- 调用后台翻译 ----------
  // 插件被重新加载/更新后，已经打开的网页里还留着旧脚本，它和插件的连接已经断了
  const STALE_MSG = "插件刚刚更新过，请刷新这个网页（F5）后再划词。";
  function extensionAlive() {
    try {
      return Boolean(chrome.runtime?.id);
    } catch (_) {
      return false;
    }
  }

  // 只划了一个词：英文等用空格分词的语言是一个不带空格的单词；中文、日文是不超过 4 个字的词
  function isSingleWord(text) {
    // 划词时常会顺带选上前后的标点，例如 "validate,"
    const t = text.replace(/^[\p{P}\s]+|[\p{P}\s]+$/gu, "");
    if (!t || /\s/.test(t)) return false;
    if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(t)) {
      return /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー]{1,4}$/u.test(t);
    }
    return /^[\p{L}\p{M}]+(?:['’-][\p{L}\p{M}]+)*$/u.test(t) && t.length <= 40;
  }

  // 单词所在的那句话，帮模型判断多义词在这里是什么意思
  function contextOf(range) {
    let el = range.startContainer;
    if (el.nodeType !== Node.ELEMENT_NODE) el = el.parentElement;
    let text = "";
    for (let i = 0; el && i < 4; i++, el = el.parentElement) {
      text = (el.textContent || "").replace(/\s+/g, " ").trim();
      if (text.length >= 40) break;
    }
    return text.slice(0, 400);
  }

  function requestTranslation(text, extra) {
    return new Promise((resolve) => {
      if (!extensionAlive()) return resolve({ ok: false, stale: true, error: STALE_MSG });
      try {
        chrome.runtime.sendMessage(
          { type: "translate", items: [{ id: 0, text, ...extra }], languageHint: "自动识别" },
          (res) => {
            const err = chrome.runtime.lastError;
            if (err) resolve({ ok: false, error: err.message });
            else resolve(res);
          }
        );
      } catch (e) {
        const stale = /context invalidated/i.test(String(e?.message));
        resolve({ ok: false, stale, error: stale ? STALE_MSG : String(e?.message || e) });
      }
    });
  }

  async function translateSelection(text, range) {
    const seq = ++requestSeq;
    showPopup(range, "翻译中…", "loading");
    const word = isSingleWord(text);
    const res = await requestTranslation(text, word ? { word: true, context: contextOf(range) } : {});
    if (seq !== requestSeq) return; // 期间用户又选了别的或关掉了弹窗
    if (res?.ok && res.translations?.length) {
      const t = res.translations[0];
      const synonyms = word && Array.isArray(t.synonyms) ? t.synonyms.filter(Boolean).slice(0, 3) : [];
      showPopup(range, t.text, "", synonyms);
    } else {
      const msg = res?.stale ? res.error : `翻译失败：${res?.error || "没有返回结果"}`;
      showPopup(range, msg, "error");
    }
  }

  // ---------- 事件 ----------
  document.addEventListener(
    "mousedown",
    (e) => {
      if (!inPopup(e)) hidePopup();
    },
    true
  );

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hidePopup();
  });

  // 取得当前选中的文字和位置。
  // 很多网站（例如 Brightspace）把内容放在网页组件内部（Shadow DOM），
  // 这时普通的 window.getSelection() 读不到选中的文字，要到组件内部去取。
  function getSelected(path) {
    const shadowRoots = path.filter((n) => n instanceof ShadowRoot);

    // 1) Chrome：组件内部自己的选区（从最里层往外找）
    for (const root of shadowRoots) {
      try {
        const s = root.getSelection?.();
        if (s && s.rangeCount && !s.isCollapsed && s.toString().trim()) {
          return { text: s.toString(), range: s.getRangeAt(0).cloneRange() };
        }
      } catch (_) {}
    }

    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;

    // 2) 新标准：getComposedRanges 能穿透 Shadow DOM
    if (shadowRoots.length && typeof sel.getComposedRanges === "function") {
      let sr = null;
      try {
        sr = sel.getComposedRanges({ shadowRoots })[0];
      } catch (_) {
        try {
          sr = sel.getComposedRanges(...shadowRoots)[0];
        } catch (_) {}
      }
      if (sr && !sr.collapsed) {
        try {
          const r = document.createRange();
          r.setStart(sr.startContainer, sr.startOffset);
          r.setEnd(sr.endContainer, sr.endOffset);
          const t = r.toString();
          if (!r.collapsed && t.trim()) return { text: t, range: r };
        } catch (_) {}
      }
    }

    // 3) 普通网页
    const text = sel.toString();
    if (!text.trim()) return null;
    return { text, range: sel.getRangeAt(0).cloneRange() };
  }

  // 用捕获阶段监听：有些网页组件会拦下鼠标事件，不让它冒泡到 document
  document.addEventListener(
    "mouseup",
    (e) => {
      if (e.button !== 0 || !enabled || inPopup(e)) return;
      const path = e.composedPath();
      if (path.some((n) => n.matches?.("input, textarea, [contenteditable=''], [contenteditable='true']"))) return;
      setTimeout(() => {
        const got = getSelected(path);
        if (!got) return;
        const text = got.text.trim();
        if (!text || text.length > 5000 || !LETTER.test(text)) return;
        const rect = got.range.getBoundingClientRect();
        if (!rect.width && !rect.height) return;
        translateSelection(text, got.range);
      }, 10);
    },
    true
  );
})();
