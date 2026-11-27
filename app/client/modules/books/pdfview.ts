// Imperative pdf.js page view (no React: hundreds of page boxes must not re-render on every scroll):
// continuous vertical scroll, one box per page sized from the PDF, and only the pages in or near the view are drawn
// (canvas, HiDPI) with a pdf.js TextLayer on top (selection, search highlights). Pages far from the view are released
// (canvas freed, text layer removed, page.cleanup()). Zoom: 'width' | 'page' | number (CSS px per PDF unit), Ctrl+wheel
// and two-finger pinch. Page jumps scroll inside the same document: nothing is reloaded.
//   const v = new PdfView(scrollEl, { lib, onPage(n), onScale(scale) }); await v.setDocument(doc); v.goto(12, hl); v.setZoom('page'); v.destroy();
import type { PDFDocumentProxy, PDFPageProxy, RenderTask, TextLayer, PageViewport } from 'pdfjs-dist';
import { computeTops, pageAt, scaleFor, clampScale, outputScale, findMatches, splitByRanges } from './readerlib.js';
import type { PdfjsLib } from './pdfdoc.ts';
import type { Zoom } from './types.ts';

/** Search highlight: folded words to mark on a PDF page; scroll = bring the first match into view once. */
export interface Highlight {
  terms: string[];
  pdfPage?: number;
  scroll?: boolean;
}
interface PageBox {
  n: number;
  w: number;
  h: number;
  div: HTMLDivElement;
  page: PDFPageProxy | null;
  canvas: HTMLCanvasElement | null;
  textDiv: HTMLDivElement | null;
  textLayer: TextLayer | null;
  textReady: boolean;
  renderedScale: number;
  task: RenderTask | null;
}
interface Anchor {
  n: number;
  frac: number;
  y: number;
}
interface PdfViewOptions {
  lib: PdfjsLib;
  onPage?: (n: number) => void;
  onScale?: (scale: number) => void;
}

const GAP = 12; // px around and between pages (matches .books-pages padding / gap)
const KEEP = 1.5; // screens above and below the view whose pages stay drawn
const MAX_LIVE = 10; // at most this many drawn pages

export class PdfView {
  el: HTMLElement;
  lib: PdfjsLib;
  onPage: (n: number) => void;
  onScale: (scale: number) => void;
  inner: HTMLDivElement;
  doc: PDFDocumentProxy | null;
  pages: PageBox[];
  tops: number[];
  heights: number[];
  zoom: Zoom;
  scale: number;
  current: number;
  pending: { n: number; hl: Highlight | null } | null;
  hl: (Highlight & { pdfPage: number }) | null;
  live: Set<number>;
  rendering: boolean;
  again: boolean;
  renderTimer: ReturnType<typeof setTimeout> | undefined;
  raf: number;
  programmaticTop: number | null;
  destroyed: boolean;
  pinch: { d0: number; s0: number; ratio: number; x: number; y: number } | null;
  ro: ResizeObserver | null;
  handleScroll: () => void;
  handleWheel: (e: WheelEvent) => void;
  handleTouchStart: (e: TouchEvent) => void;
  handleTouchMove: (e: TouchEvent) => void;
  handleTouchEnd: (e: TouchEvent) => void;

  constructor(el: HTMLElement, { lib, onPage, onScale }: PdfViewOptions) {
    this.el = el;
    this.lib = lib;
    this.onPage = onPage || (() => {});
    this.onScale = onScale || (() => {});
    this.inner = document.createElement('div');
    this.inner.className = 'books-pages';
    el.appendChild(this.inner);
    this.doc = null;
    this.pages = []; // { n, w, h, div, page, canvas, textDiv, textLayer, textReady, renderedScale, task }
    this.tops = [];
    this.heights = [];
    this.zoom = 'width';
    this.scale = 1;
    this.current = 1;
    this.pending = null; // { n, hl } goto before the document is ready
    this.hl = null; // { terms, pdfPage, scroll }
    this.live = new Set();
    this.rendering = false;
    this.again = false;
    this.renderTimer = undefined;
    this.raf = 0;
    this.programmaticTop = null;
    this.destroyed = false;

    this.handleScroll = () => {
      if (this.programmaticTop !== null && Math.abs(this.el.scrollTop - this.programmaticTop) <= 2) {
        this.programmaticTop = null;
        this.scheduleRender(30);
        return;
      }
      this.programmaticTop = null;
      if (!this.raf)
        this.raf = requestAnimationFrame(() => {
          this.raf = 0;
          this.updateCurrent();
        });
      this.scheduleRender(60);
    };
    this.handleWheel = (e) => {
      if (!e.ctrlKey || !this.doc) return; // Ctrl+wheel / trackpad pinch = zoom (else the browser zooms the whole page)
      e.preventDefault();
      const r = this.el.getBoundingClientRect();
      const factor = Math.exp(-e.deltaY * (e.deltaMode ? 0.05 : 0.0025));
      this.zoomAt(this.scale * factor, e.clientX - r.left, e.clientY - r.top);
    };
    this.pinch = null;
    this.handleTouchStart = (e) => {
      if (e.touches.length !== 2 || !this.doc) return;
      const [a, b] = e.touches;
      const r = this.el.getBoundingClientRect();
      this.pinch = { d0: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1, s0: this.scale, ratio: 1,
        x: (a.clientX + b.clientX) / 2 - r.left, y: (a.clientY + b.clientY) / 2 - r.top };
      this.inner.style.transformOrigin = `${this.el.scrollLeft + this.pinch.x}px ${this.el.scrollTop + this.pinch.y}px`;
    };
    this.handleTouchMove = (e) => {
      if (!this.pinch || e.touches.length !== 2) return;
      e.preventDefault();
      const [a, b] = e.touches;
      const ratio = clampScale(this.pinch.s0 * (Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) / this.pinch.d0)) / this.pinch.s0;
      this.pinch.ratio = ratio;
      this.inner.style.transform = `scale(${ratio})`; // preview; the real zoom is applied when the fingers lift
    };
    this.handleTouchEnd = (e) => {
      if (!this.pinch || e.touches.length >= 2) return;
      const p = this.pinch;
      this.pinch = null;
      this.inner.style.transform = '';
      if (Math.abs(p.ratio - 1) > 0.02) this.zoomAt(p.s0 * p.ratio, p.x, p.y);
    };
    el.addEventListener('scroll', this.handleScroll, { passive: true });
    el.addEventListener('wheel', this.handleWheel, { passive: false });
    el.addEventListener('touchstart', this.handleTouchStart, { passive: true });
    el.addEventListener('touchmove', this.handleTouchMove, { passive: false });
    el.addEventListener('touchend', this.handleTouchEnd);
    el.addEventListener('touchcancel', this.handleTouchEnd);
    let lastW = el.clientWidth;
    let lastH = el.clientHeight;
    this.ro = typeof ResizeObserver === 'function'
      ? new ResizeObserver(() => {
          if (el.clientWidth === lastW && el.clientHeight === lastH) return;
          lastW = el.clientWidth;
          lastH = el.clientHeight;
          if (this.doc && typeof this.zoom !== 'number') this.applyScale(this.computeScale());
          else this.scheduleRender(100);
        })
      : null;
    this.ro?.observe(el);
  }

  // ----- document & layout -----
  async setDocument(doc: PDFDocumentProxy, startPage = 1) {
    this.doc = doc;
    const first = await doc.getPage(1);
    if (this.destroyed) return;
    const vp = first.getViewport({ scale: 1 });
    const frag = document.createDocumentFragment();
    this.pages = Array.from({ length: doc.numPages }, (_, i): PageBox => {
      const div = document.createElement('div');
      div.className = 'books-page';
      div.dataset.n = String(i + 1);
      frag.appendChild(div);
      return { n: i + 1, w: vp.width, h: vp.height, div, page: i === 0 ? first : null, canvas: null, textDiv: null, textLayer: null, textReady: false, renderedScale: 0, task: null };
    });
    this.inner.replaceChildren(frag);
    this.scale = this.computeScale();
    this.layout();
    this.onScale(this.scale);
    const pend = this.pending;
    this.pending = null;
    this.goto(pend?.n || startPage, pend?.hl || null);
  }

  /** Scale for the current zoom setting (fit modes use the current page's size). */
  computeScale(): number {
    const p = this.pages[this.current - 1] || this.pages[0];
    if (!p) return 1;
    return scaleFor(this.zoom, { width: p.w, height: p.h }, { width: this.el.clientWidth - 2 * GAP, height: this.el.clientHeight - 2 * GAP });
  }

  layout() {
    const s = this.scale;
    this.inner.style.setProperty('--scale-factor', String(s));
    this.heights = this.pages.map((p) => {
      const w = Math.round(p.w * s);
      const h = Math.round(p.h * s);
      p.div.style.width = `${w}px`;
      p.div.style.height = `${h}px`;
      return h;
    });
    this.tops = computeTops(this.heights, GAP).tops;
  }

  /** Where the view is: { n, frac } of the page at viewport y (px from the top of the scroll box). */
  anchorAt(y = 0): Anchor {
    const top = this.el.scrollTop + y;
    const n = pageAt(this.tops, top);
    return { n, frac: (top - this.tops[n - 1]) / Math.max(1, this.heights[n - 1]), y };
  }
  restoreAnchor(a: Anchor | null) {
    if (!a || !this.tops.length) return;
    this.setScrollTop(this.tops[a.n - 1] + a.frac * this.heights[a.n - 1] - a.y);
  }
  setScrollTop(top: number) {
    const max = Math.max(0, this.el.scrollHeight - this.el.clientHeight);
    const target = Math.round(Math.max(0, Math.min(max, top)));
    if (Math.abs(this.el.scrollTop - target) < 1) {
      this.programmaticTop = null;
      return;
    }
    this.programmaticTop = target;
    this.el.scrollTop = target;
  }

  // ----- navigation -----
  /** Scroll to PDF page n (1-based); hl = { terms, scroll } highlights those words on that page. */
  goto(n: number, hl: Highlight | null = null) {
    if (!this.pages.length) {
      this.pending = { n, hl };
      return;
    }
    const p = Math.max(1, Math.min(this.pages.length, Math.round(Number(n) || 1)));
    this.current = p;
    this.setScrollTop(this.tops[p - 1] - GAP / 2);
    this.setHighlight(hl ? { ...hl, pdfPage: p } : null); // after the jump: it may scroll down to the first match
    this.scheduleRender(0);
  }

  updateCurrent() {
    if (!this.tops.length) return;
    const top = this.el.scrollTop;
    const bottom = top + this.el.clientHeight;
    const a = pageAt(this.tops, top);
    const b = pageAt(this.tops, bottom);
    let best = a;
    let bestVis = -1;
    for (let n = a; n <= b; n++) {
      const vis = Math.min(bottom, this.tops[n - 1] + this.heights[n - 1]) - Math.max(top, this.tops[n - 1]);
      if (vis > bestVis + 1) {
        best = n;
        bestVis = vis;
      }
    }
    if (best !== this.current) {
      this.current = best;
      this.onPage(best);
    }
  }

  // ----- zoom -----
  setZoom(zoom: Zoom) {
    this.zoom = typeof zoom === 'number' ? clampScale(zoom) : zoom === 'page' ? 'page' : 'width';
    if (this.doc && this.pages.length) this.applyScale(this.computeScale());
  }
  /** Zoom to a numeric scale keeping the point (x, y) of the view still (wheel / pinch). */
  zoomAt(scale: number, x: number, y: number) {
    const s = clampScale(scale);
    if (Math.abs(s - this.scale) < 0.001) return;
    const ratio = s / this.scale;
    const left = this.el.scrollLeft;
    this.zoom = s;
    this.applyScale(s, this.anchorAt(y));
    this.el.scrollLeft = Math.max(0, (left + x) * ratio - x);
  }
  applyScale(s: number, anchor: Anchor = this.anchorAt(0)) {
    if (!this.pages.length || Math.abs(s - this.scale) < 0.0005) return;
    for (const p of this.pages) if (p.task) p.task.cancel();
    this.scale = s;
    this.layout(); // drawn canvases stretch (CSS 100 %) until they are redrawn at the new scale
    this.restoreAnchor(anchor);
    this.onScale(s);
    this.scheduleRender(160);
  }

  // ----- drawing -----
  scheduleRender(delay = 0) {
    clearTimeout(this.renderTimer);
    this.renderTimer = setTimeout(() => this.renderPass(), delay);
  }

  async renderPass() {
    if (this.destroyed || !this.pages.length) return;
    if (this.rendering) {
      this.again = true;
      return;
    }
    this.rendering = true;
    try {
      do {
        this.again = false;
        const h = this.el.clientHeight;
        const top = this.el.scrollTop;
        const first = pageAt(this.tops, top);
        const last = pageAt(this.tops, top + h);
        const keepA = pageAt(this.tops, top - KEEP * h);
        const keepB = pageAt(this.tops, top + h + KEEP * h);
        for (const n of [...this.live]) if (n < keepA || n > keepB) this.release(this.pages[n - 1]);
        // visible pages first (nearest to the current page first), then one page of look-ahead on each side
        const order = [];
        for (let n = first; n <= last; n++) order.push(n);
        order.sort((x, y) => Math.abs(x - this.current) - Math.abs(y - this.current));
        if (last < this.pages.length) order.push(last + 1);
        if (first > 1) order.push(first - 1);
        for (const n of order) {
          if (this.again || this.destroyed) break;
          await this.renderPage(this.pages[n - 1]);
        }
        // too many drawn pages (very small zoom): release the farthest ones
        if (this.live.size > MAX_LIVE) {
          const far = [...this.live].sort((x, y) => Math.abs(y - this.current) - Math.abs(x - this.current));
          for (const n of far.slice(0, this.live.size - MAX_LIVE)) if (n < first || n > last) this.release(this.pages[n - 1]);
        }
      } while (this.again && !this.destroyed);
    } finally {
      this.rendering = false;
    }
  }

  async renderPage(p: PageBox | undefined) {
    if (!p || this.destroyed || (p.renderedScale === this.scale && p.canvas)) return;
    if (!p.page) {
      p.page = await this.doc!.getPage(p.n);
      if (this.destroyed) return;
      const vp1 = p.page.getViewport({ scale: 1 });
      if (Math.abs(vp1.width - p.w) > 0.5 || Math.abs(vp1.height - p.h) > 0.5) {
        // Not the size of page 1 (fold-out, cover): resize its box without moving what the reader looks at.
        const anchor = this.anchorAt(0);
        p.w = vp1.width;
        p.h = vp1.height;
        this.layout();
        this.restoreAnchor(anchor);
      }
    }
    const scale = this.scale;
    const vp = p.page.getViewport({ scale });
    const out = outputScale(vp.width, vp.height, globalThis.devicePixelRatio);
    const canvas = document.createElement('canvas');
    canvas.className = 'books-canvas';
    canvas.width = Math.max(1, Math.floor(vp.width * out));
    canvas.height = Math.max(1, Math.floor(vp.height * out));
    const task = p.page.render({ canvasContext: canvas.getContext('2d', { alpha: false })!, viewport: vp, transform: out !== 1 ? [out, 0, 0, out, 0, 0] : undefined });
    p.task = task;
    try {
      await task.promise;
    } catch (err) {
      canvas.width = canvas.height = 0;
      if ((err as Error)?.name !== 'RenderingCancelledException') console.warn('[books] page', p.n, err);
      return;
    } finally {
      if (p.task === task) p.task = null;
    }
    if (this.destroyed) {
      canvas.width = canvas.height = 0;
      return;
    }
    if (p.canvas) {
      p.canvas.replaceWith(canvas);
      p.canvas.width = p.canvas.height = 0; // free the old bitmap now
    } else p.div.prepend(canvas);
    p.canvas = canvas;
    p.renderedScale = scale;
    this.live.add(p.n);
    await this.renderText(p, vp);
  }

  async renderText(p: PageBox, vp: PageViewport) {
    if (p.textLayer) {
      if (p.textReady) p.textLayer.update({ viewport: vp });
      return;
    }
    const div = document.createElement('div');
    div.className = 'textLayer';
    p.div.appendChild(div);
    const tl = new this.lib.TextLayer({ textContentSource: p.page!.streamTextContent({ includeMarkedContent: true, disableNormalization: true }), container: div, viewport: vp });
    p.textDiv = div;
    p.textLayer = tl;
    try {
      await tl.render();
    } catch {
      return;
    }
    if (p.textLayer !== tl) return;
    p.textReady = true;
    this.applyHighlight(p);
  }

  release(p: PageBox | undefined) {
    if (!p) return;
    p.task?.cancel();
    p.task = null;
    if (p.canvas) {
      p.canvas.width = p.canvas.height = 0;
      p.canvas.remove();
      p.canvas = null;
    }
    if (p.textLayer) p.textLayer.cancel();
    p.textDiv?.remove();
    p.textDiv = null;
    p.textLayer = null;
    p.textReady = false;
    p.renderedScale = 0;
    try {
      p.page?.cleanup();
    } catch {}
    this.live.delete(p.n);
  }

  // ----- search highlight -----
  /** hl = { terms: [folded words], pdfPage, scroll? } or null (clears). */
  setHighlight(hl: (Highlight & { pdfPage: number }) | null) {
    const old = this.hl;
    this.hl = hl && hl.terms?.length ? { ...hl } : null;
    if (old) this.clearHighlight(this.pages[old.pdfPage - 1]);
    if (this.hl) this.applyHighlight(this.pages[this.hl.pdfPage - 1]);
  }
  clearHighlight(p: PageBox | undefined) {
    if (!p?.textLayer || !p.textReady) return;
    const { textDivs, textContentItemsStr } = p.textLayer;
    textDivs.forEach((div, i) => {
      if (div.firstElementChild) div.textContent = textContentItemsStr[i];
    });
  }
  applyHighlight(p: PageBox | undefined) {
    const hl = this.hl;
    if (!p || !hl || hl.pdfPage !== p.n || !p.textLayer || !p.textReady) return;
    const { textDivs, textContentItemsStr } = p.textLayer;
    let first: HTMLElement | null = null;
    textDivs.forEach((div, i) => {
      const s = textContentItemsStr[i] || '';
      const ranges = findMatches(s, hl.terms);
      if (!ranges.length) return;
      div.replaceChildren(
        ...splitByRanges(s, ranges).map((part) => {
          if (!part.hit) return document.createTextNode(part.text);
          const m = document.createElement('span');
          m.className = 'books-hl';
          m.textContent = part.text;
          return m;
        })
      );
      first = first || div;
    });
    if (first && hl.scroll) {
      hl.scroll = false;
      const r = (first as HTMLElement).getBoundingClientRect();
      const box = this.el.getBoundingClientRect();
      if (r.top < box.top + 40 || r.bottom > box.bottom - 40) this.setScrollTop(this.el.scrollTop + r.top - box.top - this.el.clientHeight / 3);
    }
  }

  destroy() {
    this.destroyed = true;
    clearTimeout(this.renderTimer);
    cancelAnimationFrame(this.raf);
    for (const p of this.pages) this.release(p);
    this.ro?.disconnect();
    const el = this.el;
    el.removeEventListener('scroll', this.handleScroll);
    el.removeEventListener('wheel', this.handleWheel);
    el.removeEventListener('touchstart', this.handleTouchStart);
    el.removeEventListener('touchmove', this.handleTouchMove);
    el.removeEventListener('touchend', this.handleTouchEnd);
    el.removeEventListener('touchcancel', this.handleTouchEnd);
    this.inner.remove();
    this.pages = [];
    this.doc = null;
  }
}
