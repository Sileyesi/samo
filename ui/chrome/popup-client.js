// Chrome-side owner of the single popup surface (an opaque overlay BrowserView).
// One owner at a time; picks / hide notifications are routed to that owner.
import { safeCall } from "./util.js";

export class PopupClient {
  constructor(app) {
    this.app = app;
    this.samo = app.samo;
    this.cur = null;     // {kind, owner, onPick, onHide, shownAt}
    this.openSeq = 0;
    this.samo.on("popup:pick", (p) => {
      const c = this.cur;
      if (c?.onPick) c.onPick(p?.payload ?? p);
    });
    this.samo.on("popup:hidden", () => {
      // Ignore a stale notification racing a just-issued show.
      if (!this.cur || performance.now() - this.cur.shownAt < 80) return;
      this.dropped();
    });
  }

  get open() { return !!this.cur; }
  get owner() { return this.cur?.owner || null; }
  is(owner) { return this.cur?.owner === owner; }

  /** rect in chrome-view CSS px. */
  show(kind, rect, data, { owner = kind, focus = false, onPick, onHide } = {}) {
    const prev = this.cur;
    this.cur = { kind, owner, onPick, onHide, shownAt: performance.now() };
    if (prev && prev.owner !== owner) prev.onHide?.();
    const r = { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.w), h: Math.round(rect.h) };
    this.lastRect = r;
    this.app.compact?.hold("popup", true);
    // `_open` lets the popup document tell a fresh show (entrance animation) from an update.
    return safeCall(this.samo, "popup.show", { kind, rect: r, data: { ...data, _open: ++this.openSeq }, focus });
  }

  update(data) {
    if (!this.cur) return null;
    return safeCall(this.samo, "popup.update", { data });
  }

  hide(owner) {
    if (!this.cur || (owner && this.cur.owner !== owner)) return;
    safeCall(this.samo, "popup.hide");
    this.dropped();
  }

  dropped() {
    const c = this.cur;
    this.cur = null;
    this.app.compact?.hold("popup", false);
    c?.onHide?.();
  }
}
