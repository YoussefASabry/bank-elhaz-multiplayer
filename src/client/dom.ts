/**
 * Typed DOM access.
 *
 * The extracted script did `document.getElementById('x').innerHTML = …` in some
 * places and `document.getElementById('x')?.…` in others, so half the call sites
 * threw on a missing node and half silently no-opped. Under `strict` the
 * compiler forces that decision to be explicit, so the difference is encoded
 * here once:
 *
 *   byId    — may be absent; caller handles it (the legacy `?.` behaviour)
 *   need    — genuinely required by index.html; absence is a bug, so it throws
 *             with the id instead of "cannot read properties of null"
 *
 * No lookup is cached. Several containers are replaced wholesale by innerHTML
 * during a render, so a cached reference would point at a detached node — that
 * is the "stale DOM after reconnect" class of bug.
 */

export function byId<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

export function need<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id) as T | null;
  if (!el) throw new Error(`[dom] required element #${id} is missing from index.html`);
  return el;
}

export function qs<T extends Element = Element>(selector: string, root: ParentNode = document): T | null {
  return root.querySelector<T>(selector);
}

export function qsa<T extends Element = Element>(selector: string, root: ParentNode = document): T[] {
  return Array.from(root.querySelectorAll<T>(selector));
}

// ── Value accessors ──

/** Trimmed value of an <input>, or '' when the field is absent. */
export function inputValue(id: string): string {
  const el = byId<HTMLInputElement>(id);
  return el ? el.value.trim() : '';
}

export function setInputValue(id: string, value: string): void {
  const el = byId<HTMLInputElement>(id);
  if (el) el.value = value;
}

export function checkboxValue(id: string, fallback: boolean): boolean {
  const el = byId<HTMLInputElement>(id);
  return el ? el.checked : fallback;
}

/** Parses a numeric field, falling back when empty or not a number. */
export function numberValue(id: string, fallback: number): number {
  const raw = inputValue(id);
  if (raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

// ── Mutators (all null-tolerant, matching the legacy `?.` call sites) ──

export function setText(id: string, text: string): void {
  const el = byId(id);
  if (el) el.textContent = text;
}

export function setHtml(id: string, html: string): void {
  const el = byId(id);
  if (el) el.innerHTML = html;
}

export function setDisplay(id: string, display: string): void {
  const el = byId(id);
  if (el) el.style.display = display;
}

export function show(id: string, display = 'block'): void {
  setDisplay(id, display);
}

export function hide(id: string): void {
  setDisplay(id, 'none');
}

export function addClass(id: string, cls: string): void {
  byId(id)?.classList.add(cls);
}

export function removeClass(id: string, cls: string): void {
  byId(id)?.classList.remove(cls);
}

export function toggleClass(id: string, cls: string, on: boolean): void {
  byId(id)?.classList.toggle(cls, on);
}

/** Escapes text that is about to be interpolated into an innerHTML template. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
