/**
 * render_ui `Html` (ADR 0013 addendum): Agent HTML/SVG in a sandboxed iframe (`allow-scripts`,
 * no `allow-same-origin`). The frame talks to the host only with postMessage, through the bridge below.
 */

/** No network, no external scripts or styles; inline only. Images from data: or https. */
export const HTML_CSP =
   "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: https:; font-src data:; connect-src 'none'";

/** The app's theme tokens the frame gets as CSS variables (packages/ui styles.css). */
export const THEME_VARS = [
   "background",
   "foreground",
   "card",
   "card-foreground",
   "popover",
   "popover-foreground",
   "primary",
   "primary-foreground",
   "secondary",
   "secondary-foreground",
   "muted",
   "muted-foreground",
   "accent",
   "accent-foreground",
   "destructive",
   "border",
   "input",
   "ring",
   "radius",
   "font-sans",
   "font-mono",
   "chat-font-size",
   "code-font-size",
   "chart-1",
   "chart-2",
   "chart-3",
   "chart-4",
   "chart-5",
] as const;

/** A `:root` block with the current values of the theme tokens. */
export function themeCss(read: (name: string) => string, scheme: string): string {
   const vars = THEME_VARS.map((n) => [n, read(`--${n}`).trim()] as const)
      .filter(([, v]) => v)
      .map(([n, v]) => `--${n}: ${v};`)
      .join(" ");
   return `:root { ${vars} color-scheme: ${scheme || "light"}; }`;
}

/** The theme of the app's <html> now (`.dark` class and inline preset tokens). */
export function currentTheme(): string {
   const root = document.documentElement;
   const style = getComputedStyle(root);
   return themeCss(
      (n) => style.getPropertyValue(n),
      root.classList.contains("dark") ? "dark" : "light",
   );
}

/**
 * Wraps `report` so each message goes out once, at most `max` in all: a frame can throw the same error on every
 * state change. The core dedupes too (replays, other windows); this keeps the calls few.
 */
export function onceEach(report: (message: string) => void, max = 5): (message: string) => void {
   const sent = new Set<string>();
   return (message) => {
      if (sent.has(message) || sent.size >= max) return;
      sent.add(message);
      report(message);
   };
}

/** Messages the frame sends to the host. */
export type FrameMessage =
   | { type: "state"; state: unknown }
   | { type: "actions"; actions: unknown }
   | { type: "patch"; ops: unknown }
   | { type: "send"; text: unknown }
   | { type: "height"; px: unknown }
   | { type: "snapshot"; id: unknown; xml: unknown; width: unknown; height: unknown }
   | { type: "error"; message: unknown };

/**
 * Runs in the frame before the Agent's HTML. `window.harness` gives scripts the Session State and
 * the actions; data-* attributes work without a script. Re-applied on each state message.
 */
export const BRIDGE = `(function () {
  var post = function (m) { parent.postMessage(m, "*"); };
  var subs = [];
  var get = function (o, p) {
    if (typeof p !== "string" || p === "") return o;
    var t = p.split("/").slice(1);
    for (var i = 0; i < t.length; i++) {
      if (o == null || typeof o !== "object") return undefined;
      o = o[t[i].replace(/~1/g, "/").replace(/~0/g, "~")];
    }
    return o;
  };
  var same = function (a, b) { return JSON.stringify(a) === JSON.stringify(b); };
  var visible = function (v) {
    if (v === undefined || v === true) return true;
    if (!v || typeof v !== "object") return false;
    if (v.$and) return v.$and.every(visible);
    if (v.$or) return v.$or.some(visible);
    var x = get(h.state, v.$state);
    var ok = "eq" in v ? same(x, v.eq) : "neq" in v ? !same(x, v.neq) : Array.isArray(x) ? x.length > 0 : !!x;
    return v.not ? !ok : ok;
  };
  var json = function (el, name) {
    try { return JSON.parse(el.getAttribute(name)); }
    catch (e) { post({ type: "error", message: name + ": " + e.message }); }
  };
  var all = function (sel, fn) { Array.prototype.forEach.call(document.querySelectorAll(sel), fn); };
  var apply = function () {
    all("[data-state]", function (el) {
      var x = get(h.state, el.getAttribute("data-state"));
      el.textContent = x == null ? "" : typeof x === "object" ? JSON.stringify(x) : String(x);
    });
    all("[data-visible]", function (el) {
      el.style.display = visible(json(el, "data-visible")) ? "" : "none";
    });
    all("[data-bind]", function (el) {
      var x = get(h.state, el.getAttribute("data-bind"));
      if (el.type === "checkbox") el.checked = !!x;
      else if (el.type === "radio") el.checked = el.value === String(x);
      else if (el !== document.activeElement) el.value = x == null ? "" : String(x);
    });
  };
  var h = {
    state: JSON.parse(document.getElementById("harness-state").textContent),
    get: function (path) { return get(h.state, path); },
    subscribe: function (fn) {
      subs.push(fn);
      fn(h.state);
      return function () { subs = subs.filter(function (f) { return f !== fn; }); };
    },
    patch: function (ops) { post({ type: "patch", ops: ops }); },
    send: function (text) { post({ type: "send", text: String(text) }); },
    run: function (actions) { post({ type: "actions", actions: actions }); },
  };
  window.harness = h;
  // The document as XML, for the host to draw as an image (capture.ts): what the scripts made of it so far.
  var snapshot = function (id) {
    if (snapshotting) return;
    snapshotting = true;
    var send = function () {
      snapshotting = false;
      var root = document.documentElement;
      var clone = root.cloneNode(true);
      var from = root.querySelectorAll("canvas, input, textarea");
      var to = clone.querySelectorAll("canvas, input, textarea");
      Array.prototype.forEach.call(from, function (el, i) {
        if (el.tagName === "CANVAS") {
          var img = document.createElement("img");
          try { img.src = el.toDataURL(); } catch (err) {}
          img.setAttribute("style", el.getAttribute("style") || "");
          img.width = el.offsetWidth;
          img.height = el.offsetHeight;
          to[i].replaceWith(img);
        } else if (el.tagName === "TEXTAREA") to[i].textContent = el.value;
        else {
          to[i].setAttribute("value", el.value);
          if (el.checked) to[i].setAttribute("checked", "");
        }
      });
      Array.prototype.forEach.call(clone.querySelectorAll("script, meta"), function (el) { el.remove(); });
      post({
        type: "snapshot",
        id: id,
        xml: new XMLSerializer().serializeToString(clone),
        width: Math.max(root.scrollWidth, document.body.scrollWidth, 1),
        height: Math.max(root.scrollHeight, document.body.scrollHeight, 1),
      });
    };
    // Scripts that draw on load get a moment.
    if (document.readyState === "complete") setTimeout(send, 150);
    else window.addEventListener("load", function () { setTimeout(send, 150); });
  };
  var snapshotting = false;
  window.addEventListener("message", function (e) {
    if (e.source !== parent || !e.data) return;
    if (e.data.type === "state") {
      h.state = e.data.state;
      subs.forEach(function (fn) { try { fn(h.state); } catch (err) { post({ type: "error", message: String(err) }); } });
      apply();
    } else if (e.data.type === "theme") document.getElementById("harness-theme").textContent = e.data.css;
    else if (e.data.type === "snapshot") snapshot(e.data.id);
  });
  document.addEventListener("click", function (e) {
    var el = e.target && e.target.closest && e.target.closest("[data-on-click]");
    if (el) h.run(json(el, "data-on-click"));
  });
  document.addEventListener("change", function (e) {
    var el = e.target;
    if (!el || !el.getAttribute) return;
    var path = el.getAttribute("data-bind");
    if (path) {
      var v = el.type === "checkbox" ? el.checked
        : (el.type === "number" || el.type === "range") && el.value !== "" ? Number(el.value)
        : el.value;
      h.patch([{ op: "replace", path: path, value: v }]);
    }
    if (el.hasAttribute("data-on-change")) h.run(json(el, "data-on-change"));
  });
  window.addEventListener("error", function (e) { post({ type: "error", message: e.message }); });
  window.addEventListener("unhandledrejection", function (e) { post({ type: "error", message: String(e.reason) }); });
  var last = 0;
  var size = function () {
    var px = Math.ceil(document.documentElement.getBoundingClientRect().height);
    if (px !== last) { last = px; post({ type: "height", px: px }); }
  };
  document.addEventListener("DOMContentLoaded", function () {
    apply();
    size();
    new ResizeObserver(size).observe(document.documentElement);
  });
})();`;

/** Tags of a full document; the Agent's HTML goes into our body either way. */
const docTags = /<!doctype[^>]*>|<\/?(html|head|body)(\s[^>]*)?>/gi;

/** The frame's document: CSP, theme, initial state and the bridge, then the Agent's HTML in the body. */
export function buildSrcdoc(html: string, theme: string, state: unknown): string {
   const data = JSON.stringify(state ?? null).replace(/</g, "\\u003c");
   return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${HTML_CSP}">
<style id="harness-theme">${theme}</style>
<style>html { height: auto; } body { margin: 0; display: flow-root; background: transparent; color: var(--foreground); font-family: var(--font-sans); font-size: var(--chat-font-size, 14px); line-height: 1.5; } [data-on-click] { cursor: pointer; }</style>
<script type="application/json" id="harness-state">${data}</script>
<script>${BRIDGE}</script>
</head><body>${html.replace(docTags, "")}</body></html>`;
}
