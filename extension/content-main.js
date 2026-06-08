// Main-world helper — runs in the page's JS context so it can read framework
// internals (React fibers, Angular debug API, etc.) that are invisible from
// the extension's isolated content script.
//
// Protocol:
//   isolated → main:  postMessage({type: "__WA_REACT_EXTRACT", requestId, marker})
//                     `marker` is the value of a data-wa-marker attribute set
//                     on the target element.
//   main → isolated:  postMessage({type: "__WA_REACT_RESULT", requestId, result})
//                     result: { componentName?, sourceFile?, sourceLine? }
//
// Sections in this file:
//   1. PATH HEURISTICS    — classify file paths (vendor / chunk / user source)
//   2. STACK PARSING      — parse Error.stack strings into frame objects
//   3. SOURCE-MAP DECODER — VLQ + indexed source map support
//   4. NEXT.JS RESOLVER   — POST /__nextjs_original-stack-frames + fallback to map decoder
//   5. REACT HANDLER      — walk React 19 fiber tree, prefer user source
//   6. (FUTURE)           — Angular / Vue / Svelte handlers
//   7. DISPATCH           — pick the right framework handler and respond

(function () {
  if (window.__waReactExtractInstalled) return;
  window.__waReactExtractInstalled = true;

  // ════════════════════════════════════════════════════════════════════════
  // 1. PATH HEURISTICS
  // ════════════════════════════════════════════════════════════════════════

  function isVendorPath(file) {
    if (!file) return true;
    if (/\/node_modules\//.test(file)) return true;
    if (/chunks\/node_modules/.test(file)) return true;
    if (/chunks\/_next/.test(file)) return true;
    if (/\/react-dom|\/react\/|\/scheduler\//.test(file)) return true;
    // Turbopack-specific vendor chunks
    if (/chunks\/turbopack-/.test(file)) return true;
    if (/chunks\/[^/]*next_dist/.test(file)) return true;
    if (/chunks\/[^/]*react-server-dom/.test(file)) return true;
    if (/chunks\/[^/]*_pnpm_/.test(file)) return true;
    // Filename-based detection (no path prefix)
    const filename = file.split("/").pop() || file;
    if (/^(react|react-dom|react-dom-client|scheduler|use-sync-external-store)(\.|\.[^.]+\.)?(production|development)?\.[mc]?js$/i.test(filename)) return true;
    if (/^react-jsx(-dev)?-runtime(\.[^.]+)*\.[mc]?js$/i.test(filename)) return true;
    if (/^(next|next-error|next-flight|next-app)([-./]|$)/i.test(filename)) return true;
    if (file === "<anonymous>") return true;
    return false;
  }

  function isBundledChunk(file) {
    if (!file) return false;
    return /\/_next\/static\/chunks\//.test(file)
      || /(^|\/)chunks\/[^/]+\.js/.test(file)
      || /^webpack-internal:/.test(file)
      || /^webpack:\/\//.test(file);
  }

  function looksLikeUserSource(file) {
    if (!file) return false;
    if (/(?:^|\/)(src|app|pages|components|hooks|features|views|screens|routes)\//i.test(file)) return true;
    // .tsx/.jsx are almost always user code (libraries ship as .js/.mjs)
    if (/\.(?:tsx|jsx)$/.test(file)) return true;
    return false;
  }

  function isLibraryDist(file) {
    if (!file) return false;
    return /(?:^|\/)dist\//.test(file)
      || /(?:^|\/)esm\//.test(file)
      || /(?:^|\/)cjs\//.test(file)
      || /\.mjs$/.test(file);
  }

  // ════════════════════════════════════════════════════════════════════════
  // 2. STACK PARSING
  // ════════════════════════════════════════════════════════════════════════

  function allStackFrames(stack) {
    if (!stack) return [];
    const text = typeof stack === "string" ? stack : (stack.stack || String(stack));
    const out = [];
    for (const line of text.split("\n")) {
      const m = line.match(/(?:\(|@|\s)((?:[a-z]+:\/\/[^\s()]+?|[^\s()]+?\.[tj]sx?)):(\d+):(\d+)/);
      if (m) out.push({ file: m[1], line: parseInt(m[2], 10), column: parseInt(m[3], 10), isVendor: isVendorPath(m[1]) });
    }
    return out;
  }

  function firstUserFrame(stack) {
    const frames = allStackFrames(stack);
    const userSource = frames.find((f) => !f.isVendor && !isBundledChunk(f.file) && looksLikeUserSource(f.file));
    if (userSource) return userSource;
    const userPlain = frames.find((f) => !f.isVendor && !isBundledChunk(f.file) && !isLibraryDist(f.file));
    if (userPlain) return userPlain;
    const original = frames.find((f) => !f.isVendor && !isBundledChunk(f.file));
    if (original) return original;
    return frames.find((f) => !f.isVendor) || null;
  }

  function firstAnyFrame(stack) {
    return allStackFrames(stack)[0] || null;
  }

  // ════════════════════════════════════════════════════════════════════════
  // 3. SOURCE-MAP DECODER (VLQ + indexed maps)
  // ════════════════════════════════════════════════════════════════════════

  const decodedMapCache = new Map(); // chunkUrl → { type, lineMap | sections, sources, sourceRoot }

  const VLQ_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const VLQ_TABLE = (() => {
    const t = new Int8Array(128).fill(-1);
    for (let i = 0; i < VLQ_CHARS.length; i++) t[VLQ_CHARS.charCodeAt(i)] = i;
    return t;
  })();

  function decodeVlqSegment(str, out) {
    out.length = 0;
    let value = 0, shift = 0;
    for (let i = 0; i < str.length; i++) {
      const n = VLQ_TABLE[str.charCodeAt(i)];
      if (n < 0) continue;
      const cont = n & 32;
      value += (n & 31) << shift;
      if (cont) {
        shift += 5;
      } else {
        out.push(value & 1 ? -(value >>> 1) : value >>> 1);
        value = 0; shift = 0;
      }
    }
  }

  function buildLineMap(mappings) {
    const lines = mappings.split(";");
    const lineMap = new Array(lines.length);
    let srcIdx = 0, srcLine = 0, srcCol = 0;
    const tmp = [];
    for (let lineNo = 0; lineNo < lines.length; lineNo++) {
      const line = lines[lineNo];
      const segs = [];
      if (line) {
        let genCol = 0;
        for (const s of line.split(",")) {
          if (!s) continue;
          decodeVlqSegment(s, tmp);
          genCol += tmp[0];
          if (tmp.length >= 4) {
            srcIdx += tmp[1];
            srcLine += tmp[2];
            srcCol += tmp[3];
            segs.push([genCol, srcIdx, srcLine, srcCol]);
          }
        }
      }
      lineMap[lineNo] = segs;
    }
    return lineMap;
  }

  function lookupPosition(lineMap, sources, sourceRoot, genLine, genCol) {
    const segs = lineMap[genLine - 1];
    if (!segs || segs.length === 0) return null;
    // Binary search for the largest segment whose genCol <= input
    let lo = 0, hi = segs.length - 1, best = segs[0];
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if (segs[mid][0] <= genCol) { best = segs[mid]; lo = mid + 1; }
      else hi = mid - 1;
    }
    let file = sources[best[1]] || null;
    if (file && sourceRoot && !/^[a-z]+:\/\//.test(file)) file = sourceRoot + file;
    if (file) file = file
      .replace(/^webpack:\/\/_N_E\//, "")
      .replace(/^webpack:\/\/\//, "")
      .replace(/^\[project\]\//, "")
      .replace(/^\[turbopack\]\//, "")
      .replace(/^file:\/\//, "");
    if (file) {
      try { file = decodeURIComponent(file); } catch { /* leave as-is on invalid encoding */ }
    }
    return { file, line: best[2] + 1, column: best[3] };
  }

  function lookupIndexed(sections, genLine, genCol) {
    // Section offsets are 0-based; genLine is 1-based per stack-trace convention.
    let target = null;
    for (const sec of sections) {
      if (sec.offsetLine > genLine - 1) break;
      if (sec.offsetLine === genLine - 1 && sec.offsetCol > genCol) break;
      target = sec;
    }
    if (!target) return null;
    const adjLine = genLine - target.offsetLine;
    const adjCol = (genLine - 1 === target.offsetLine) ? genCol - target.offsetCol : genCol;
    return lookupPosition(target.lineMap, target.sources, target.sourceRoot, adjLine, adjCol);
  }

  async function getDecodedMap(chunkUrl) {
    if (decodedMapCache.has(chunkUrl)) return decodedMapCache.get(chunkUrl);
    let result = null;
    try {
      let mapJson = null;

      // 1. Try sibling .map file
      try {
        const res = await fetch(chunkUrl + ".map");
        if (res.ok) mapJson = await res.json();
      } catch { /* */ }

      // 2. Fallback: fetch chunk and read sourceMappingURL
      if (!mapJson) {
        const chunkRes = await fetch(chunkUrl);
        if (chunkRes.ok) {
          const text = await chunkRes.text();
          const m = text.match(/\/\/# sourceMappingURL=([^\s]+)/);
          if (m) {
            const mapUrl = m[1].trim();
            if (mapUrl.startsWith("data:")) {
              const b64 = (mapUrl.split(",")[1] || "").trim();
              // Skip un-evaluated template literals (Turbopack runtime: "${btoa(...)}")
              if (!b64.startsWith("$")) {
                try { mapJson = JSON.parse(atob(b64)); } catch { /* */ }
              }
            } else {
              const abs = new URL(mapUrl, chunkUrl).toString();
              const mapRes = await fetch(abs);
              if (mapRes.ok) mapJson = await mapRes.json();
            }
          }
        }
      }

      if (mapJson) {
        if (Array.isArray(mapJson.sections)) {
          // Indexed source map (used by Turbopack to concatenate sub-maps)
          const sections = [];
          for (const sec of mapJson.sections) {
            const sub = sec.map;
            if (sub && sub.mappings && Array.isArray(sub.sources)) {
              sections.push({
                offsetLine: sec.offset?.line ?? 0,
                offsetCol: sec.offset?.column ?? 0,
                sources: sub.sources,
                sourceRoot: sub.sourceRoot || "",
                lineMap: buildLineMap(sub.mappings),
              });
            }
          }
          result = { type: "indexed", sections };
        } else if (mapJson.mappings && Array.isArray(mapJson.sources)) {
          result = {
            type: "flat",
            sources: mapJson.sources,
            sourceRoot: mapJson.sourceRoot || "",
            lineMap: buildLineMap(mapJson.mappings),
          };
        }
      }
    } catch { /* */ }
    decodedMapCache.set(chunkUrl, result);
    return result;
  }

  async function resolveViaSourceMap(file, lineNumber, column) {
    const absUrl = file.startsWith("/") ? new URL(file, window.location.origin).toString() : file;
    const decoded = await getDecodedMap(absUrl);
    if (!decoded) return null;
    const pos = decoded.type === "indexed"
      ? lookupIndexed(decoded.sections, lineNumber, column || 0)
      : lookupPosition(decoded.lineMap, decoded.sources, decoded.sourceRoot, lineNumber, column || 0);
    if (!pos || !pos.file) return null;
    return { sourceFile: pos.file, sourceLine: pos.line };
  }

  // ════════════════════════════════════════════════════════════════════════
  // 4. NEXT.JS RESOLVER (with fallback to our own source-map decoder)
  // ════════════════════════════════════════════════════════════════════════

  const resolvedFrameCache = new Map(); // file:line:col → result

  async function resolveNextJsFrame(file, lineNumber, column) {
    const cacheKey = `${file}:${lineNumber}:${column}`;
    if (resolvedFrameCache.has(cacheKey)) return resolvedFrameCache.get(cacheKey);
    const result = await tryResolveNextJsFrame(file, lineNumber, column);
    resolvedFrameCache.set(cacheKey, result);
    return result;
  }

  async function tryResolveNextJsFrame(file, lineNumber, column) {
    // Turbopack only accepts paths, not full URLs. Strip the origin if present.
    let filePath = file;
    try {
      const parsed = new URL(file, window.location.origin);
      if (parsed.origin === window.location.origin) filePath = parsed.pathname + parsed.search;
    } catch { /* not a URL, keep as is */ }

    const body = {
      frames: [{ file: filePath, methodName: "", lineNumber: lineNumber || 0, column: column || 0, arguments: [] }],
      isServer: false,
      isEdgeServer: false,
      isAppDirectory: true,
    };
    try {
      const res = await fetch("/__nextjs_original-stack-frames", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        const data = await res.json();
        // Shape: PromiseSettledResult<OriginalStackFrameResponse>[]
        const r = Array.isArray(data) ? data[0] : data;
        if (r?.status !== "rejected") {
          const resp = r?.value || r;
          const f = resp?.originalStackFrame;
          // Turbopack returns the same chunk with null line/column when its lookup fails
          const line = f?.lineNumber ?? f?.line ?? f?.line1;
          const isSameFileNoPos = f && f.file === filePath && line == null;
          if (f?.file && !isSameFileNoPos && line != null) {
            return { sourceFile: f.file, sourceLine: line };
          }
        }
      }
    } catch { /* */ }

    // Fall back to our own source-map decoder
    return await resolveViaSourceMap(filePath, lineNumber, column);
  }

  // ════════════════════════════════════════════════════════════════════════
  // 5. REACT HANDLER
  // ════════════════════════════════════════════════════════════════════════

  function reactComponentName(type) {
    if (!type) return null;
    if (typeof type === "string") return null;
    if (typeof type === "function") return type.displayName || type.name || null;
    if (typeof type === "object") {
      if (type.displayName) return type.displayName;
      if (type.type) return reactComponentName(type.type);
      if (type.render) return reactComponentName(type.render);
    }
    return null;
  }

  function hasReactFiber(el) {
    return Object.keys(el).some((k) => k.startsWith("__reactFiber") || k.startsWith("__reactInternalInstance"));
  }

  async function extractReactInfo(el) {
    const key = Object.keys(el).find((k) => k.startsWith("__reactFiber") || k.startsWith("__reactInternalInstance"));
    if (!key) return {};

    let fiber = el[key];
    let depth = 0;
    // Track candidates by priority so we can prefer real user source over library bundles
    let bestUserSource = null;   // frame matching src/, app/, .tsx, etc.
    let bestUser = null;         // first non-vendor non-chunk frame (may be library)
    let firstNamed = null;       // first fiber with a component name
    let firstSourced = null;     // first fiber with any source at all
    const chunkCandidates = [];  // { name, frame } pairs whose source is a chunk

    while (fiber && depth < 30) {
      depth++;
      const name = reactComponentName(fiber.type) || reactComponentName(fiber.elementType);

      let userFrame = null, anyFrame = null;
      if (fiber._debugSource && fiber._debugSource.fileName) {
        const f = {
          file: fiber._debugSource.fileName,
          line: fiber._debugSource.lineNumber,
          column: null,
          isVendor: isVendorPath(fiber._debugSource.fileName),
        };
        anyFrame = f;
        if (!f.isVendor) userFrame = f;
      } else if (fiber._debugStack) {
        anyFrame = firstAnyFrame(fiber._debugStack);
        userFrame = firstUserFrame(fiber._debugStack);
      }

      if (!bestUserSource && userFrame && looksLikeUserSource(userFrame.file)) {
        bestUserSource = { name, frame: userFrame };
      }
      if (!bestUser && userFrame) bestUser = { name, frame: userFrame };
      if (!firstNamed && name) firstNamed = { name, frame: userFrame || anyFrame };
      if (!firstSourced && anyFrame) firstSourced = { name, frame: anyFrame };
      if (userFrame && isBundledChunk(userFrame.file)) {
        chunkCandidates.push({ name, frame: userFrame });
      }

      if (bestUserSource && firstNamed) break;
      fiber = fiber.return;
    }

    // Prefer a non-chunk user-source frame directly (no network round-trip)
    if (bestUserSource) {
      return {
        componentName: bestUserSource.name || firstNamed?.name || null,
        sourceFile: bestUserSource.frame.file,
        sourceLine: bestUserSource.frame.line,
      };
    }

    // Try resolving chunk candidates in fiber order; prefer ones that map to user source
    let resolvedUser = null;
    let resolvedAny = null;
    for (const cand of chunkCandidates) {
      const r = await resolveNextJsFrame(cand.frame.file, cand.frame.line, cand.frame.column);
      if (!r) continue;
      if (!resolvedAny) resolvedAny = { name: cand.name, ...r };
      if (looksLikeUserSource(r.sourceFile)) {
        resolvedUser = { name: cand.name, ...r };
        break;
      }
    }
    const picked = resolvedUser || resolvedAny;
    if (picked) {
      return {
        componentName: firstNamed?.name || picked.name || null,
        sourceFile: picked.sourceFile,
        sourceLine: picked.sourceLine,
      };
    }

    // Last resort: closest non-vendor frame or any source
    const fallback = bestUser?.frame || firstSourced?.frame || null;
    return {
      componentName: firstNamed?.name || bestUser?.name || null,
      sourceFile: fallback?.file ?? null,
      sourceLine: fallback?.line ?? null,
    };
  }

  // ════════════════════════════════════════════════════════════════════════
  // 6. ANGULAR HANDLER
  // ════════════════════════════════════════════════════════════════════════
  //
  // Angular (Ivy, v9+) exposes a debug API at `window.ng` in dev mode:
  //   - ng.getComponent(el)     → component instance if el is the host element
  //   - ng.getDirectives(el)    → array of directive instances on the element
  //   - ng.getOwningComponent(el) → the parent component that rendered el
  //
  // We walk up the DOM to find the nearest component host, then read:
  //   - constructor.name        → component class name
  //   - constructor.ɵcmp.selectors → the CSS selector (e.g. "app-login-form")
  //
  // Source file resolution: Angular doesn't expose _debugSource/_debugStack.
  // The agent can grep for `selector: '...'` or `class ComponentName` to find
  // the file. We still try to extract a sourceURL comment from the compiled
  // factory if one is present.

  function hasAngularDebugApi() {
    return typeof window.ng?.getComponent === "function";
  }

  // Detect Angular even if window.ng is unavailable (tree-shaken in some builds).
  function hasAngularIvy() {
    return !!document.querySelector("[ng-version]")
      || typeof window.getAllAngularRootElements === "function";
  }

  // Fallback: walk up DOM looking for an element with __ngContext__ at all.
  function findClosestLContext(el) {
    let node = el;
    while (node && node.nodeType === 1) {
      const ctx = node.__ngContext__;
      if (ctx !== undefined && ctx !== null) return { host: node, ctx };
      node = node.parentElement;
    }
    return null;
  }

  // Heuristic: identify whether a value looks like an Angular component instance.
  function isLikelyComponentInstance(val) {
    if (!val || typeof val !== "object") return false;
    const ctor = val.constructor;
    if (!ctor || ctor === Object || ctor === Array) return false;
    // Ivy component definition presence is the strongest signal
    if (ctor.ɵcmp || ctor.ngComponentDef) return true;
    return false;
  }

  // Walk down all Angular root LViews to find the LView whose HOST element
  // matches the target. Necessary because non-root hosts often store
  // __ngContext__ as a numeric LView ID (lazy resolution), and the actual
  // LView lookup table is internal to @angular/core.
  function findLViewByHostElement(targetEl) {
    if (typeof window.getAllAngularRootElements !== "function") return null;
    let roots;
    try { roots = window.getAllAngularRootElements(); }
    catch { return null; }
    const seen = new WeakSet();
    for (const root of roots) {
      const ctx = root.__ngContext__;
      if (Array.isArray(ctx)) {
        const found = walkLViewForHost(ctx, targetEl, seen);
        if (found) return found;
      }
    }
    return null;
  }

  function walkLViewForHost(lView, targetEl, seen) {
    if (!Array.isArray(lView) || seen.has(lView)) return null;
    seen.add(lView);
    // HOST is typically at index 0; some versions also expose at T_HOST=5
    if (lView[0] === targetEl) return lView;
    // Recurse into any nested LView/LContainer arrays
    for (let i = 0; i < lView.length; i++) {
      const v = lView[i];
      if (Array.isArray(v)) {
        const found = walkLViewForHost(v, targetEl, seen);
        if (found) return found;
      }
    }
    return null;
  }

  // Read the component instance from an LView.
  // Angular's LView stores its component at the CONTEXT slot — index varies
  // by version: Angular 18 uses 8; older versions used 1 or 9. We try those
  // first (most reliable) before falling back to a scan.
  function findComponentInLView(lView) {
    if (!Array.isArray(lView)) return null;
    for (const idx of [8, 9, 7, 1, 10]) {
      const val = lView[idx];
      if (isLikelyComponentInstance(val)) return val;
    }
    // Last-resort scan if known indices missed
    for (let i = 0; i < lView.length; i++) {
      const v = lView[i];
      if (isLikelyComponentInstance(v)) return v;
    }
    return null;
  }

  // Get the component instance hosted by a specific element.
  //
  // When window.ng.getComponent is available, trust it strictly — its `null`
  // means the element is NOT a component host (just a plain tag inside
  // someone else's template), and we should skip it rather than guess.
  //
  // The LView/__ngContext__ fallback (used only when ng API is unavailable)
  // is intentionally strict: it must find an LView whose HOST is exactly
  // this element, not just any LView that references it.
  function getComponentForHost(el) {
    if (!el) return null;
    if (typeof window.ng?.getComponent === "function") {
      try { return window.ng.getComponent(el) || null; } catch { return null; }
    }
    const ctx = el.__ngContext__;
    if (Array.isArray(ctx) && ctx[0] === el) {
      return findComponentInLView(ctx);
    }
    const lView = findLViewByHostElement(el);
    if (lView && lView[0] === el) return findComponentInLView(lView);
    return null;
  }

  // Walk up DOM from `start` (exclusive or inclusive) and return the first
  // element that's a component host (custom element or has _nghost-* marker).
  function walkUpForHost(start, includeStart) {
    let node = includeStart ? start : start?.parentElement;
    while (node && node.nodeType === 1) {
      if (node.tagName && node.tagName.includes("-")) return node;
      for (const attr of node.attributes || []) {
        if (attr.name.startsWith("_nghost-")) return node;
      }
      node = node.parentElement;
    }
    return null;
  }

  // Extract the component from an LView/LContext. Angular's LView layout
  // changed over time — CONTEXT lived at index 1 in older versions, then 8,
  // then 9. We scan multiple indices and walk PARENT LViews if the current
  // CONTEXT is a template context (embedded view) rather than a component.
  function ngComponentFromCtx(ctx, depth = 0) {
    if (!ctx || depth > 10) return null;
    if (!Array.isArray(ctx)) {
      if (ctx.component) return ctx.component;
      if (ctx.lView) return ngComponentFromCtx(ctx.lView, depth + 1);
      return null;
    }
    // Try common CONTEXT slot indices across Angular versions
    for (const idx of [8, 9, 7, 1, 10]) {
      const val = ctx[idx];
      if (isLikelyComponentInstance(val)) return val;
    }
    // Not a component view (might be embedded) — walk to PARENT LView
    // PARENT is typically at index 3
    const parent = ctx[3];
    if (Array.isArray(parent) && parent !== ctx) return ngComponentFromCtx(parent, depth + 1);
    return null;
  }

  function ngComponentName(component) {
    const raw = component?.constructor?.name;
    if (!raw) return null;
    // Bundlers (webpack/esbuild) sometimes wrap exported classes in an IIFE that
    // prefixes the class name with an underscore. Strip a single leading "_"
    // so we get the source-level class name (e.g. _LoginComponent → LoginComponent).
    return raw.startsWith("_") ? raw.slice(1) : raw;
  }

  function ngSelector(component) {
    const cmp = component?.constructor?.ɵcmp || component?.constructor?.ngComponentDef;
    if (!cmp?.selectors?.[0]) return null;
    const sel = cmp.selectors[0];
    if (!Array.isArray(sel)) return null;
    // Selector array format: [tagName] or ["", attrName, ""] etc.
    // The first string is the element tag selector (most common case).
    const parts = sel.filter((s) => typeof s === "string" && s);
    return parts.length ? parts[0] : null;
  }

  function ngSourceUrlFromFn(fn) {
    if (typeof fn !== "function") return null;
    try {
      const src = Function.prototype.toString.call(fn);
      const m = src.match(/\/[/*][@#]\s*sourceURL=([^\s*]+)/);
      if (m) return m[1];
    } catch { /* */ }
    return null;
  }

  // ── Scan loaded JS chunks for a class definition and source-map it ────────
  //
  // Angular CLI (and most bundlers) don't add per-class sourceURL comments, so
  // we can't read the .ts location off the class directly. But the chunks have
  // source maps. Strategy: search each loaded chunk's text for `class _Foo`,
  // find the line of the match, then ask the source map for the original .ts
  // file + line.

  const chunkTextCache = new Map();   // url → text (or null on fail)
  const classLocationCache = new Map(); // className → { sourceFile, sourceLine } | null

  async function fetchChunkText(url) {
    if (chunkTextCache.has(url)) return chunkTextCache.get(url);
    let text = null;
    try {
      const res = await fetch(url);
      if (res.ok) text = await res.text();
    } catch { /* */ }
    chunkTextCache.set(url, text);
    return text;
  }

  function getLoadedChunkUrls() {
    const urls = new Set();
    // <script src> tags (classic webpack/esbuild bundles)
    for (const s of document.querySelectorAll("script[src]")) {
      if (s.src) urls.add(s.src);
    }
    // Performance API: catches dynamic imports, ESM modules (used by Vite),
    // and lazy-loaded chunks — none of these appear as <script> tags.
    try {
      for (const e of performance.getEntriesByType("resource")) {
        const name = e.name;
        if (!name) continue;
        if (e.initiatorType === "script" || /\.[mc]?[jt]sx?(\?|$)/.test(name)) {
          urls.add(name);
        }
      }
    } catch { /* performance API unavailable */ }
    return Array.from(urls).filter((src) => {
      if (!src) return false;
      if (!src.startsWith(window.location.origin)) return false;
      if (/\/polyfills/.test(src)) return false;
      if (/\/runtime/.test(src)) return false;
      if (/\/vendor/.test(src)) return false;
      if (/\/@vite\//.test(src)) return false;
      if (/\/@id\//.test(src)) return false;
      if (/\/@fs\//.test(src)) return false;
      if (/\/node_modules\//.test(src)) return false;
      return true;
    });
  }

  async function findClassDefinitionLocation(className) {
    if (!className) return null;
    if (classLocationCache.has(className)) return classLocationCache.get(className);

    const chunkUrls = getLoadedChunkUrls();
    // Strip leading "_" — source code has the unprefixed name; the underscore
    // is added by the bundler's IIFE wrapper at runtime.
    const baseName = className.replace(/^_/, "");
    const safeName = baseName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Match all common bundler output forms:
    //   class Foo {                       — classic
    //   class _Foo {                      — IIFE-wrapped
    //   var _Foo = class { ... }          — ESBuild (Angular CLI)
    //   let _Foo = class { ... }
    //   const _Foo = class { ... }
    const re = new RegExp(
      `(?:class\\s+_?${safeName}\\b|(?:var|let|const)\\s+_?${safeName}\\s*=\\s*class\\b)`
    );

    let result = null;
    for (const url of chunkUrls) {
      const text = await fetchChunkText(url);
      if (!text) continue;
      const m = re.exec(text);
      if (!m) continue;
      const lineInChunk = text.slice(0, m.index).split("\n").length;
      const colInChunk = m.index - text.lastIndexOf("\n", m.index - 1) - 1;
      const decoded = await getDecodedMap(url);
      if (decoded) {
        const pos = decoded.type === "indexed"
          ? lookupIndexed(decoded.sections, lineInChunk, colInChunk)
          : lookupPosition(decoded.lineMap, decoded.sources, decoded.sourceRoot, lineInChunk, colInChunk);
        if (pos?.file) {
          result = { sourceFile: pos.file, sourceLine: pos.line };
          break;
        }
      }
      result = { sourceFile: url, sourceLine: lineInChunk };
      break;
    }

    classLocationCache.set(className, result);
    return result;
  }

  function findAngularHost(el) {
    let node = el;
    while (node && node.nodeType === 1) {
      try {
        const c = window.ng.getComponent(node);
        if (c) return { host: node, component: c };
      } catch { /* */ }
      node = node.parentElement;
    }
    return null;
  }

  async function extractAngularInfo(el) {
    if (!hasAngularDebugApi() && !hasAngularIvy()) return null;

    // Build the chain of authoring components (innermost first).
    const chain = buildAuthoringChain(el);
    if (chain.length === 0) return {};

    // Render each entry as a single tag: prefer the component's own selector,
    // fall back to the host element's tag name.
    const tags = chain.map((e) => {
      if (e.component) {
        const sel = ngSelector(e.component);
        if (sel) return sel;
      }
      return e.host.tagName.toLowerCase();
    });

    // Drop consecutive duplicates (happens when one component class is bound
    // to multiple host selectors, or when emulated encapsulation produces
    // overlapping content scopes).
    const innerToOuter = tags.filter((tag, i) => tag !== tags[i - 1]);
    // Outer → inner (visually reads as a path from app root down to clicked).
    const componentChain = [...innerToOuter].reverse();

    return {
      componentName: innerToOuter[0],
      componentChain,
    };
  }

  // Walk up via _ngcontent hashes, collecting each authoring component
  // (the component whose template owns each element along the way).
  function buildAuthoringChain(el) {
    const chain = [];
    const seen = new Set();
    let node = el;
    let safety = 0;
    while (node && node.nodeType === 1 && safety++ < 50) {
      let authorHost = null;
      for (const attr of node.attributes || []) {
        if (attr.name.startsWith("_ngcontent-")) {
          const hash = attr.name.substring("_ngcontent-".length);
          try {
            authorHost = document.querySelector(`[_nghost-${CSS.escape(hash)}]`);
          } catch { /* */ }
          break;
        }
      }
      if (authorHost && !seen.has(authorHost)) {
        seen.add(authorHost);
        chain.push({ host: authorHost, component: getComponentForHost(authorHost) });
        node = authorHost.parentElement;
        continue;
      }
      node = node.parentElement;
    }
    return chain;
  }

  // ════════════════════════════════════════════════════════════════════════
  // 7. DISPATCH
  // ════════════════════════════════════════════════════════════════════════

  async function extractFrameworkInfo(el) {
    if (hasReactFiber(el)) return await extractReactInfo(el);
    if (hasAngularDebugApi() || hasAngularIvy()) {
      const r = await extractAngularInfo(el);
      if (r && (r.componentName || r.componentChain || r.sourceFile)) return r;
    }
    return {};
  }

  window.addEventListener("message", async (e) => {
    if (e.source !== window) return;
    const data = e.data;
    if (!data || data.type !== "__WA_REACT_EXTRACT") return;
    const { requestId, marker } = data;
    const el = document.querySelector(`[data-wa-marker="${marker}"]`);
    const result = el ? await extractFrameworkInfo(el) : {};
    window.postMessage({ type: "__WA_REACT_RESULT", requestId, result }, "*");
  });
})();
