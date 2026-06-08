// Content script — crosshair element selection + a prompt composer. Standalone:
// it never talks to a server. You click elements, write an instruction, and Copy.
// The copy carries two clipboard formats:
//   - text/plain : a readable markdown prompt (paste into Cursor, Claude, an issue…)
//   - text/html  : the same text + a hidden base64 payload, so a system that knows
//                  to look (e.g. Whipped) can recover the structured visualComment.

(function () {
  if (window.__whippedAnnotate) {
    // Already injected on this page — just re-activate.
    window.__whippedActivate?.();
    return;
  }
  window.__whippedAnnotate = true;

  let active = false;
  let hl = null;
  let form = null;
  let indicator = null;
  let barMove = null;
  // Elements collected for the prompt currently being written. Each entry:
  // { el, selector, elementText, ri, badgeEl }.
  let selections = [];
  let onViewportChange = null;
  let dragging = false;
  // Pass-through modes that let clicks reach the page instead of selecting it,
  // so you can open dropdowns/menus and then annotate what they reveal:
  // `altDown` = Alt held (transient), `interactMode` = Interact toggle (sustained).
  let interactMode = false;
  let altDown = false;

  // Distinct colors so each referenced element — its page outline, its badge,
  // and the `#N` mention in the textarea — share one identity.
  const PALETTE = ["#f87171", "#fbbf24", "#34d399", "#60a5fa", "#c084fc", "#f472b6", "#22d3ee", "#a3e635"];
  const colorFor = (i) => PALETTE[i % PALETTE.length];

  // ── Styles ────────────────────────────────────────────────────────────────

  const style = document.createElement("style");
  style.textContent = `
    .__wa-hl {
      outline: 2px solid #7c6aff !important;
      outline-offset: 2px !important;
      cursor: crosshair !important;
    }

    .__wa-badge {
      position: fixed; z-index: 2147483646; pointer-events: none;
      min-width: 18px; height: 18px; padding: 0 5px; box-sizing: border-box;
      display: flex; align-items: center; justify-content: center;
      color: #0c0c0f; border-radius: 9px; font-weight: 700;
      font: 700 11px/1 -apple-system, BlinkMacSystemFont, sans-serif;
      box-shadow: 0 2px 6px rgba(0,0,0,.5);
    }

    #__wa-bar {
      position: fixed; top: 16px; left: 50%; transform: translateX(-50%);
      z-index: 2147483647; display: flex; align-items: center; gap: 8px;
      padding: 6px 6px 6px 12px; border-radius: 999px;
      background: rgba(20, 20, 28, 0.92); backdrop-filter: blur(12px);
      border: 1px solid rgba(124, 106, 255, 0.35);
      box-shadow: 0 8px 30px rgba(0,0,0,.45), 0 0 0 1px rgba(0,0,0,.2);
      font-family: -apple-system, BlinkMacSystemFont, sans-serif; color: #f0f0f5;
      font-size: 12px; user-select: none; -webkit-user-select: none;
      animation: __wa-pop .18s ease-out;
      pointer-events: none; transition: opacity .15s ease;
    }
    #__wa-bar.faded { opacity: .12; }
    @keyframes __wa-pop { from { opacity: 0; transform: translate(-50%, -8px); } to { opacity: 1; transform: translate(-50%, 0); } }
    #__wa-bar .pulse { width: 8px; height: 8px; border-radius: 50%; background: #7c6aff; box-shadow: 0 0 0 0 rgba(124,106,255,.6); animation: __wa-pulse 1.6s infinite; flex-shrink: 0; }
    @keyframes __wa-pulse { 0% { box-shadow: 0 0 0 0 rgba(124,106,255,.5); } 70% { box-shadow: 0 0 0 7px rgba(124,106,255,0); } 100% { box-shadow: 0 0 0 0 rgba(124,106,255,0); } }
    #__wa-bar .label { font-weight: 600; }
    #__wa-bar .hint { color: #60607a; }
    #__wa-bar .exit {
      background: rgba(255,255,255,.06); border: none; color: #9a9ab0;
      font-family: inherit; font-size: 11px; font-weight: 600;
      padding: 5px 10px; border-radius: 999px;
    }
    #__wa-bar .toggle {
      pointer-events: auto; cursor: pointer;
      background: rgba(124,106,255,.18); border: 1px solid rgba(124,106,255,.4);
      color: #c4baff; font-family: inherit; font-size: 11px; font-weight: 600;
      padding: 5px 10px; border-radius: 999px;
    }
    #__wa-bar .toggle:hover { background: rgba(124,106,255,.3); }
    #__wa-bar .toggle.on { background: #34d399; border-color: #34d399; color: #07120d; }
    #__wa-bar.pass { border-color: rgba(52,211,153,.5); background: rgba(10,26,20,.92); }
    #__wa-bar.pass .pulse { background: #34d399; box-shadow: none; animation: none; }
    #__wa-bar.pass .hint { color: #6ee7b7; }
    #__wa-bar.alt .toggle { pointer-events: none; opacity: .5; }

    #__wa-form {
      position: fixed; z-index: 2147483646; right: 16px; bottom: 16px;
      max-height: 75vh; overflow: hidden; display: flex; flex-direction: column;
      background: #16161c; border: 1px solid #34344a; border-radius: 12px;
      padding: 14px; width: 380px; box-shadow: 0 16px 48px rgba(0,0,0,.6);
      font-family: -apple-system, sans-serif; color: #f0f0f5;
    }
    #__wa-form .header {
      display: flex; align-items: center; gap: 6px; margin-bottom: 10px;
      cursor: move; user-select: none; -webkit-user-select: none;
    }
    #__wa-form .header .grip { color: #4a4a5a; font-size: 13px; letter-spacing: -2px; }
    #__wa-form .header .htitle { font-size: 12px; color: #c4baff; font-weight: 600; flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    #__wa-form .els { display: flex; flex-direction: column; gap: 6px; margin-bottom: 8px; flex: 1 1 auto; min-height: 0; overflow-y: auto; }
    #__wa-form .el {
      display: flex; align-items: flex-start; gap: 8px;
      background: #ffffff08; border: 1px solid #ffffff14; border-left-width: 3px; border-radius: 8px; padding: 7px 8px;
    }
    #__wa-form .el .num {
      flex-shrink: 0; min-width: 18px; height: 18px; padding: 0 5px; box-sizing: border-box;
      display: flex; align-items: center; justify-content: center;
      color: #0c0c0f; border-radius: 9px; font-size: 11px; font-weight: 700;
    }
    #__wa-form .el-meta { flex: 1; min-width: 0; font-size: 11px; color: #8888a0; line-height: 1.5; }
    #__wa-form .el-meta code { font-family: monospace; color: #c4baff; word-break: break-all; }
    #__wa-form .el-meta .chain { color: #6a6a80; }
    #__wa-form .el-meta .src { color: #4a4a5a; font-family: monospace; }
    #__wa-form .el .rm {
      flex-shrink: 0; background: transparent; border: none; color: #6a6a80;
      font-size: 16px; line-height: 1; cursor: pointer; padding: 0 2px;
    }
    #__wa-form .el .rm:hover { color: #f0f0f5; }
    #__wa-form .add-hint { font-size: 11px; color: #60607a; margin-bottom: 8px; }
    #__wa-form .ta-wrap { position: relative; }
    #__wa-form .ta-backdrop, #__wa-form textarea {
      width: 100%; box-sizing: border-box; margin: 0;
      border: 1px solid #34344a; border-radius: 8px; padding: 9px;
      font: 13px/1.5 -apple-system, BlinkMacSystemFont, sans-serif;
      white-space: pre-wrap; overflow-wrap: break-word; word-break: normal;
    }
    #__wa-form .ta-backdrop {
      position: absolute; inset: 0; overflow: hidden; pointer-events: none;
      border-color: transparent; background: #0c0c0f; color: #f0f0f5; z-index: 0;
    }
    #__wa-form .ta-backdrop mark { padding: 0; border-radius: 3px; color: #0c0c0f; }
    #__wa-form textarea {
      position: relative; z-index: 1; display: block; resize: vertical; outline: none;
      min-height: 84px; background: transparent; color: transparent;
      -webkit-text-fill-color: transparent; caret-color: #f0f0f5;
      /* Hide the scrollbar so the textarea width never changes — otherwise the
         backdrop's #N highlights drift out of alignment when it appears. */
      scrollbar-width: none;
    }
    #__wa-form textarea::-webkit-scrollbar { width: 0; height: 0; display: none; }
    #__wa-form textarea:focus { border-color: #7c6aff; }
    #__wa-form textarea::selection { background: #7c6aff55; -webkit-text-fill-color: #f0f0f5; }
    #__wa-form .actions { display: flex; gap: 8px; margin-top: 10px; justify-content: flex-end; }
    #__wa-form button { border: none; border-radius: 8px; padding: 7px 16px; font-size: 12px; cursor: pointer; font-family: inherit; font-weight: 600; }
    #__wa-form .cancel { background: #26263a; color: #9a9ab0; }
    #__wa-form .cancel:hover { background: #34344a; }
    #__wa-form .send { background: #7c6aff; color: #fff; }
    #__wa-form .send:hover { background: #6a57f0; }
    #__wa-form .send:disabled { opacity: .5; cursor: not-allowed; }
    #__wa-form .err { font-size: 11px; color: #ffb4b4; background: rgba(239,68,68,.1); border: 1px solid rgba(239,68,68,.25); border-radius: 8px; padding: 8px; margin-top: 8px; }
    #__wa-toast {
      position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;
      background: #16161c; border: 1px solid #34344a; border-radius: 10px;
      padding: 10px 14px; color: #34d399; font: 600 13px -apple-system, BlinkMacSystemFont, sans-serif;
      box-shadow: 0 8px 30px rgba(0,0,0,.45);
    }
  `;
  document.head.appendChild(style);

  // ── Indicator bar ───────────────────────────────────────────────────────────

  function showIndicator() {
    if (indicator) indicator.remove();
    indicator = document.createElement("div");
    indicator.id = "__wa-bar";
    indicator.innerHTML = `
      <span class="pulse"></span>
      <span class="label">Selecting</span>
      <span class="hint"></span>
      <button class="toggle" type="button"></button>
      <span class="exit">Esc to exit</span>
    `;
    document.body.appendChild(indicator);

    indicator.querySelector(".toggle").addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      interactMode = !interactMode;
      onPassthroughChange();
    });

    barMove = (e) => {
      if (!indicator) return;
      const r = indicator.getBoundingClientRect();
      const over = picking() && e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      indicator.classList.toggle("faded", over);
    };
    document.addEventListener("mousemove", barMove, true);
    updateIndicator();
  }

  function updateIndicator() {
    if (!indicator) return;
    indicator.classList.toggle("pass", passthrough());
    indicator.classList.toggle("alt", altDown);
    const hint = indicator.querySelector(".hint");
    const toggle = indicator.querySelector(".toggle");
    if (hint) {
      hint.textContent = altDown
        ? "· pass-through — release Alt to select"
        : interactMode
          ? "· interact mode — page clicks work"
          : "· click elements (optional) · hold Alt to interact";
    }
    if (toggle) {
      toggle.textContent = interactMode ? "Select" : "Interact";
      toggle.classList.toggle("on", interactMode);
    }
  }

  function updateCursor() {
    document.body.style.cursor = active && !passthrough() ? "crosshair" : "";
  }

  function onPassthroughChange() {
    if (passthrough() && hl) { hl.classList.remove("__wa-hl"); hl = null; }
    updateCursor();
    updateIndicator();
  }

  function setAltDown(v) {
    if (!active || altDown === v) return;
    altDown = v;
    onPassthroughChange();
  }

  function hideIndicator() {
    if (barMove) { document.removeEventListener("mousemove", barMove, true); barMove = null; }
    if (indicator) { indicator.remove(); indicator = null; }
  }

  // ── Activation ──────────────────────────────────────────────────────────────

  function setToolbarActive(on) {
    try { chrome.runtime.sendMessage({ type: "WHIPPED_SET_ACTIVE", active: on }); } catch {}
  }

  function activate() {
    if (active) { renderForm(); return; }
    active = true;
    setToolbarActive(true);
    interactMode = false;
    altDown = false;
    updateCursor();
    showIndicator();
    if (!onViewportChange) {
      onViewportChange = () => positionBadges();
      window.addEventListener("scroll", onViewportChange, true);
      window.addEventListener("resize", onViewportChange, true);
    }
    // Open the composer immediately — elements are optional, the instruction isn't.
    renderForm();
  }
  window.__whippedActivate = activate;

  function deactivate() {
    active = false;
    setToolbarActive(false);
    interactMode = false;
    altDown = false;
    document.body.style.cursor = "";
    if (hl) { hl.classList.remove("__wa-hl"); hl = null; }
    closeForm();
    hideIndicator();
    if (onViewportChange) {
      window.removeEventListener("scroll", onViewportChange, true);
      window.removeEventListener("resize", onViewportChange, true);
      onViewportChange = null;
    }
  }

  function inOwnUi(target) {
    return (indicator && indicator.contains(target)) || (form && form.contains(target));
  }

  // ── Selection bookkeeping ───────────────────────────────────────────────────

  function clearSelections() {
    for (const s of selections) {
      s.el.style.removeProperty("outline");
      s.el.style.removeProperty("outline-offset");
      s.badgeEl.remove();
    }
    selections = [];
  }

  function recolorSelections() {
    selections.forEach((s, i) => {
      const c = colorFor(i);
      s.el.style.setProperty("outline", `2px solid ${c}`, "important");
      s.el.style.setProperty("outline-offset", "2px", "important");
      s.badgeEl.style.background = c;
    });
  }

  function closeForm() {
    if (form) { form.remove(); form = null; }
    clearSelections();
  }

  function showToast(text) {
    const t = document.createElement("div");
    t.id = "__wa-toast";
    t.textContent = text;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 2000);
  }

  function showFormError(text) {
    if (!form) return;
    let box = form.querySelector(".err");
    if (!box) {
      box = document.createElement("div");
      box.className = "err";
      const foot = form.querySelector(".actions");
      foot ? form.insertBefore(box, foot) : form.appendChild(box);
    }
    box.textContent = text;
  }

  function positionBadges() {
    selections.forEach((s, i) => {
      const r = s.el.getBoundingClientRect();
      s.badgeEl.textContent = String(i + 1);
      s.badgeEl.style.left = `${Math.max(2, r.left)}px`;
      s.badgeEl.style.top = `${Math.max(2, r.top)}px`;
    });
  }

  function removeSelection(idx) {
    const removedNum = idx + 1;
    const [s] = selections.splice(idx, 1);
    if (s) {
      s.el.style.removeProperty("outline");
      s.el.style.removeProperty("outline-offset");
      s.badgeEl.remove();
    }
    const ta = form?.querySelector("textarea");
    if (ta) ta.value = renumberMentions(ta.value, removedNum);
    recolorSelections();
    positionBadges();
    renderForm();
  }

  function cssSelector(el) {
    const parts = [];
    let node = el;
    while (node && node !== document.body) {
      let sel = node.tagName.toLowerCase();
      if (node.id) { sel += "#" + node.id; parts.unshift(sel); break; }
      const cls = typeof node.className === "string"
        ? node.className.trim().split(/\s+/).filter(Boolean).slice(0, 2).join(".")
        : null;
      if (cls) sel += "." + cls;
      parts.unshift(sel);
      node = node.parentElement;
      if (parts.length >= 4) break;
    }
    return parts.join(" > ");
  }

  // React fiber lives in the page's main world (isolated content scripts can't
  // see __reactFiber$xxx properties). content-main.js runs in MAIN world and
  // bridges back via window.postMessage.
  function reactInfoAsync(el) {
    return new Promise((resolve) => {
      const requestId = "r" + Math.random().toString(36).slice(2);
      const marker = requestId;
      el.setAttribute("data-wa-marker", marker);

      function cleanup() {
        window.removeEventListener("message", listener);
        el.removeAttribute("data-wa-marker");
      }

      const timer = setTimeout(() => {
        cleanup();
        resolve({});
      }, 5000);

      function listener(e) {
        if (e.source !== window) return;
        if (e.data?.type !== "__WA_REACT_RESULT") return;
        if (e.data.requestId !== requestId) return;
        clearTimeout(timer);
        cleanup();
        const result = e.data.result || {};
        resolve({
          componentName: result.componentName || null,
          componentChain: result.componentChain || null,
          sourceFile: result.sourceFile || null,
          sourceLine: result.sourceLine || null,
        });
      }

      window.addEventListener("message", listener);
      window.postMessage({ type: "__WA_REACT_EXTRACT", requestId, marker }, "*");
    });
  }

  function escHtml(s) {
    return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  async function addSelection(el) {
    if (selections.some((s) => s.el === el)) return;
    const selector = cssSelector(el);
    const rawText = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
    const elementText = rawText.slice(0, 300);
    const ri = await reactInfoAsync(el);

    el.classList.remove("__wa-hl");
    const badgeEl = document.createElement("div");
    badgeEl.className = "__wa-badge";
    document.body.appendChild(badgeEl);

    // Capture the URL now — selections can span pages (pass-through lets you
    // navigate/open menus between picks), so each element remembers its own page.
    selections.push({ el, selector, elementText, ri, badgeEl, pageUrl: location.href });
    recolorSelections();
    positionBadges();
    renderForm();
  }

  function selectionMetaHtml(s, i) {
    const chain = Array.isArray(s.ri.componentChain) && s.ri.componentChain.length
      ? s.ri.componentChain.join(" → ")
      : s.ri.componentName;
    const shortFile = s.ri.sourceFile ? s.ri.sourceFile.split("/").slice(-2).join("/") : null;
    const c = colorFor(i);
    return `
      <div class="el" style="border-left-color:${c}">
        <span class="num" style="background:${c}">${i + 1}</span>
        <div class="el-meta">
          <div><code>${escHtml(s.selector)}</code></div>
          ${chain ? `<div class="chain">🧩 ${escHtml(chain)}</div>` : ""}
          ${shortFile ? `<div class="src">📄 ${escHtml(shortFile)}${s.ri.sourceLine ? ":" + s.ri.sourceLine : ""}</div>` : ""}
        </div>
        <button class="rm" data-idx="${i}" title="Remove">×</button>
      </div>
    `;
  }

  function renumberMentions(text, removedNum) {
    return text.replace(/#(\d+)( ?)/g, (m, n, sp) => {
      const num = Number(n);
      if (num === removedNum) return "";
      if (num > removedNum) return `#${num - 1}${sp}`;
      return m;
    });
  }

  function renderBackdrop(backdrop, text) {
    const html = escHtml(text).replace(/#(\d+)/g, (m, n) => {
      const idx = Number(n) - 1;
      if (idx < 0 || idx >= selections.length) return m;
      return `<mark style="background:${colorFor(idx)}">#${n}</mark>`;
    });
    backdrop.innerHTML = text.endsWith("\n") ? `${html}\n` : html;
  }

  function makeDraggable(handle) {
    handle.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const rect = form.getBoundingClientRect();
      const offX = e.clientX - rect.left;
      const offY = e.clientY - rect.top;
      form.style.right = "auto";
      form.style.bottom = "auto";
      dragging = true;
      const onMove = (ev) => {
        const maxL = window.innerWidth - form.offsetWidth - 4;
        const maxT = window.innerHeight - form.offsetHeight - 4;
        form.style.left = `${Math.max(4, Math.min(ev.clientX - offX, maxL))}px`;
        form.style.top = `${Math.max(4, Math.min(ev.clientY - offY, maxT))}px`;
      };
      const onUp = () => {
        dragging = false;
        document.removeEventListener("mousemove", onMove, true);
        document.removeEventListener("mouseup", onUp, true);
      };
      document.addEventListener("mousemove", onMove, true);
      document.addEventListener("mouseup", onUp, true);
    });
  }

  // ── Composer form ────────────────────────────────────────────────────────────

  function renderForm() {
    if (!form) {
      form = document.createElement("div");
      form.id = "__wa-form";
      document.body.appendChild(form);
    }
    const prevText = form.querySelector("textarea")?.value ?? "";
    form.innerHTML = `
      <div class="header">
        <span class="grip">⠿</span>
        <span class="htitle">New prompt</span>
      </div>
      <div class="els">${selections.map((s, i) => selectionMetaHtml(s, i)).join("")}</div>
      <div class="add-hint">Click elements to reference them by number (optional), then describe what you want.</div>
      <div class="ta-wrap">
        <div class="ta-backdrop"></div>
        <textarea rows="5" placeholder="Describe the change… (reference elements by number, e.g. #1, #2)"></textarea>
      </div>
      <div class="actions">
        <button class="cancel">Cancel</button>
        <button class="send">Copy</button>
      </div>
    `;

    const ta = form.querySelector("textarea");
    const backdrop = form.querySelector(".ta-backdrop");
    ta.value = prevText;
    renderBackdrop(backdrop, prevText);
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);

    makeDraggable(form.querySelector(".header"));
    for (const btn of form.querySelectorAll(".rm")) {
      btn.addEventListener("click", () => removeSelection(Number(btn.dataset.idx)));
    }
    form.querySelector(".cancel").addEventListener("click", deactivate);
    form.querySelector(".send").addEventListener("click", () => void copyPrompt(ta));

    ta.addEventListener("input", () => renderBackdrop(backdrop, ta.value));
    ta.addEventListener("scroll", () => { backdrop.scrollTop = ta.scrollTop; });
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void copyPrompt(ta); }
      if (e.key === "Escape") { e.stopPropagation(); deactivate(); }
    });
  }

  // ── Building + copying the prompt ─────────────────────────────────────────────

  function buildElements() {
    return selections.map((s) => ({
      elementSelector: s.selector,
      elementText: s.elementText || undefined,
      componentName: s.ri.componentName || undefined,
      componentChain: s.ri.componentChain || undefined,
      sourceFile: s.ri.sourceFile || undefined,
      sourceLine: s.ri.sourceLine || undefined,
      pageUrl: s.pageUrl || undefined,
    }));
  }

  function yamlQuote(s) {
    return `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }

  // Bare scalar when it's safe; quote when it could confuse a YAML parser.
  function yamlScalar(v) {
    const s = String(v);
    const risky = s === "" || /^\s|\s$/.test(s) || /: /.test(s) || / #/.test(s) || /^[-?:,[\]{}#&*!|>'"%@`]/.test(s);
    return risky ? yamlQuote(s) : s;
  }

  // Human instruction on top, then a fenced YAML block describing each selected
  // element (ref number, component, captured text, source, page, selector).
  function buildPromptText(desc) {
    if (!selections.length) return desc.trim();
    const uniqueUrls = [...new Set(selections.map((s) => s.pageUrl).filter(Boolean))];
    const singlePage = uniqueUrls.length === 1;
    const yaml = [];
    if (singlePage) yaml.push(`page: ${yamlScalar(uniqueUrls[0])}`);
    yaml.push("elements:");
    selections.forEach((s, i) => {
      const chain = (Array.isArray(s.ri.componentChain) && s.ri.componentChain.length)
        ? s.ri.componentChain.join(" → ")
        : s.ri.componentName;
      const src = s.ri.sourceFile ? `${s.ri.sourceFile}${s.ri.sourceLine ? ":" + s.ri.sourceLine : ""}` : null;
      yaml.push(`  - ref: ${i + 1}`);
      if (chain) yaml.push(`    component: ${yamlScalar(chain)}`);
      if (s.elementText) yaml.push(`    text: ${yamlQuote(s.elementText)}`);
      if (src) yaml.push(`    source: ${yamlScalar(src)}`);
      if (!singlePage && s.pageUrl) yaml.push(`    url: ${yamlScalar(s.pageUrl)}`);
      yaml.push(`    selector: ${yamlQuote(s.selector)}`);
    });
    const block = "```yaml\n" + yaml.join("\n") + "\n```";
    return desc.trim() ? `${desc.trim()}\n\n${block}` : block;
  }

  function b64encodeUtf8(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }

  // Unsanitized web custom clipboard format — survives Chrome's text/html
  // sanitizer (which strips our hidden payload span). The consumer reads this.
  const WHIPPED_FORMAT = "web application/whipped+json";

  function buildPayloadObject(desc) {
    return {
      v: 1,
      description: desc,
      visualComment: selections.length ? { pageUrl: location.href, elements: buildElements() } : undefined,
    };
  }

  // text/html mirrors the readable prompt and also hides a base64 payload (a
  // fallback for when the custom format isn't available).
  function buildPromptHtml(text, payloadJson) {
    const b64 = b64encodeUtf8(payloadJson);
    const readable = `<pre style="white-space:pre-wrap;font-family:inherit;margin:0">${escHtml(text)}</pre>`;
    return `${readable}<span data-whipped-payload="${b64}"></span>`;
  }

  async function writeClipboard(text, html, payloadJson) {
    const base = {
      "text/plain": new Blob([text], { type: "text/plain" }),
      "text/html": new Blob([html], { type: "text/html" }),
    };
    // Prefer including the unsanitized custom format; some browsers reject custom
    // types in ClipboardItem, so fall back to plain+html, then plain text only.
    try {
      await navigator.clipboard.write([
        new ClipboardItem({ ...base, [WHIPPED_FORMAT]: new Blob([payloadJson], { type: WHIPPED_FORMAT }) }),
      ]);
      return true;
    } catch {
      // Browser rejected the custom format — retry with plain + html.
    }
    try {
      await navigator.clipboard.write([new ClipboardItem(base)]);
      return true;
    } catch {
      // Multi-format write blocked — fall back to plain text.
    }
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  }

  async function copyPrompt(ta) {
    const desc = ta.value.trim();
    if (!desc && !selections.length) return;
    const text = buildPromptText(desc);
    const payloadJson = JSON.stringify(buildPayloadObject(desc));
    const html = buildPromptHtml(text, payloadJson);
    const ok = await writeClipboard(text, html, payloadJson);
    if (ok) {
      // Copy is the end of the flow — show a confirmation and dismiss the tool.
      // The toast lives outside the form, so it survives deactivate().
      showToast("✓ Copied to clipboard");
      deactivate();
    } else {
      showFormError("Couldn't access the clipboard.");
    }
  }

  // ── Element selection (gated on `active`) ──────────────────────────────────

  const passthrough = () => altDown || interactMode;
  const picking = () => active && !dragging && !passthrough();

  document.addEventListener("mouseover", (e) => {
    if (!picking() || inOwnUi(e.target)) return;
    if (hl) hl.classList.remove("__wa-hl");
    hl = selections.some((s) => s.el === e.target) ? null : e.target;
    if (hl) hl.classList.add("__wa-hl");
  }, true);

  document.addEventListener("click", (e) => {
    if (!picking() || inOwnUi(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    if (hl) hl.classList.remove("__wa-hl");
    void addSelection(e.target);
  }, true);

  document.addEventListener("keydown", (e) => {
    if (!active) return;
    if (e.key === "Alt") { setAltDown(true); return; }
    if (e.key === "Escape" && !form) deactivate();
  });
  document.addEventListener("keyup", (e) => {
    if (e.key === "Alt") setAltDown(false);
  });
  // Alt-tabbing away fires no keyup, which would leave pass-through stuck on.
  window.addEventListener("blur", () => setAltDown(false));

  // ── Messages from the popup ────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "START_ANNOTATING") activate();
    if (msg.type === "STOP_ANNOTATING") deactivate();
  });
})();
