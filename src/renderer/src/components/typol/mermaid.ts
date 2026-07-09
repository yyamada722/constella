/**
 * Lazy-loaded Mermaid diagram renderer.
 *
 * Each `<div class="mermaid-block" data-source="<encoded>"></div>` placeholder
 * is replaced with rendered SVG. Re-renders are cheap thanks to a per-source
 * SVG cache, which is invalidated when the theme changes.
 */
type MermaidApi = typeof import("mermaid").default;

let mermaidPromise: Promise<MermaidApi> | null = null;
let currentTheme: "default" | "dark" = "default";
const cache = new Map<string, string>();

async function getMermaid(): Promise<MermaidApi> {
  if (!mermaidPromise) {
    mermaidPromise = import("mermaid").then((m) => {
      m.default.initialize({
        startOnLoad: false,
        theme: currentTheme,
        securityLevel: "strict",
        fontFamily: "inherit",
      });
      return m.default;
    });
  }
  return mermaidPromise;
}

export function setMermaidTheme(theme: "light" | "dark") {
  const t = theme === "dark" ? "dark" : "default";
  if (t === currentTheme) return;
  currentTheme = t;
  cache.clear();
  if (mermaidPromise) {
    mermaidPromise.then((m) =>
      m.initialize({
        startOnLoad: false,
        theme: t,
        securityLevel: "strict",
        fontFamily: "inherit",
      })
    );
  }
}

export async function renderMermaidIn(root: HTMLElement) {
  const blocks = root.querySelectorAll<HTMLElement>(".mermaid-block:not([data-rendered])");
  if (blocks.length === 0) return;

  // Fast-path from cache.
  const remaining: HTMLElement[] = [];
  for (const block of blocks) {
    const source = decodeSource(block);
    const cached = cache.get(source);
    if (cached) {
      block.innerHTML = cached;
      block.dataset.rendered = "1";
    } else {
      remaining.push(block);
    }
  }
  if (remaining.length === 0) return;

  let mermaid: MermaidApi;
  try {
    mermaid = await getMermaid();
  } catch (e) {
    for (const block of remaining) errorOut(block, e);
    return;
  }

  for (const block of remaining) {
    const source = decodeSource(block);
    const id = "mmd-" + Math.random().toString(36).slice(2, 10);
    try {
      const { svg } = await mermaid.render(id, source);
      block.innerHTML = svg;
      block.dataset.rendered = "1";
      cache.set(source, svg);
    } catch (e) {
      errorOut(block, e);
    }
  }
}

function decodeSource(el: HTMLElement): string {
  const raw = el.dataset.source ?? "";
  try { return decodeURIComponent(raw); } catch { return raw; }
}

function errorOut(block: HTMLElement, e: unknown) {
  const msg = (e as Error)?.message ?? String(e);
  block.innerHTML =
    `<pre class="mermaid-error">⚠ Mermaid: ${escapeHtml(msg)}</pre>`;
  block.dataset.rendered = "1";
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!)
  );
}
