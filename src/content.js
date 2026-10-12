/* Typer content script: drives a plan from engine.js into the focused field. */
(function () {
  'use strict';
  if (window.__typerLoaded) return;
  window.__typerLoaded = true;

  const { plan: makePlan, keyInfo, BACKSPACE, Buffer, DEFAULTS } = window.TyperEngine;
  const isTop = window === window.top;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ------------------------------------------------------------- targets

  const SELECTABLE_INPUTS = new Set(['text', 'search', 'url', 'tel', 'password', '']);

  function deepActiveElement() {
    let el = document.activeElement;
    while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
    return el;
  }

  function findTarget() {
    if (!document.hasFocus()) return null;
    const el = deepActiveElement();
    if (!el) return null;
    if (el instanceof HTMLTextAreaElement && !el.readOnly && !el.disabled) return new TextControlTarget(el);
    if (el instanceof HTMLInputElement && !el.readOnly && !el.disabled) {
      const type = (el.getAttribute('type') || '').toLowerCase();
      if (SELECTABLE_INPUTS.has(type)) return new TextControlTarget(el);
      if (type === 'email' || type === 'number') return new TextControlTarget(el, { canNavigate: false });
      return null;
    }
    if (el.isContentEditable) return new EditableTarget(el);
    return null;
  }

  function fireKey(el, type, info, extra) {
    const init = {
      key: info.key, code: info.code, keyCode: info.keyCode, which: info.keyCode,
      shiftKey: !!(extra && extra.shift), bubbles: true, cancelable: true, composed: true,
      view: window,
    };
    if (type === 'keypress') {
      init.charCode = info.key.length === 1 ? info.key.charCodeAt(0) : info.keyCode;
      init.keyCode = info.key.length === 1 ? 0 : info.keyCode;
    }
    el.dispatchEvent(new KeyboardEvent(type, init));
  }

  const SHIFT = { key: 'Shift', code: 'ShiftLeft', keyCode: 16 };

  class BaseTarget {
    constructor(el, opts) {
      this.el = el;
      this.canNavigate = !opts || opts.canNavigate !== false;
      this.keyEvents = true;
      this.mirror = new Buffer();
    }

    // Key events around an edit, like a real keystroke. Keyup fires after the
    // dwell time, so fast typing overlaps keys the way people do.
    stroke(info, dwell, edit) {
      const el = this.eventTarget();
      if (this.keyEvents) {
        if (info.shift) fireKey(el, 'keydown', SHIFT, { shift: true });
        fireKey(el, 'keydown', info, { shift: info.shift });
        if (info.key.length === 1 || info.key === 'Enter') fireKey(el, 'keypress', info, { shift: info.shift });
      }
      edit();
      if (this.keyEvents) {
        setTimeout(() => {
          fireKey(el, 'keyup', info, { shift: info.shift });
          if (info.shift) fireKey(el, 'keyup', SHIFT, {});
        }, dwell || 80);
      }
    }

    eventTarget() { return this.el; }

    perform(a) {
      if (a.type === 'key') this.stroke(keyInfo(a.ch), a.dwell, () => this.insert(a.ch));
      else if (a.type === 'back') this.stroke(BACKSPACE, a.dwell, () => this.backspace());
      else if (a.type === 'move') this.moveTo(a.to);
      else if (a.type === 'select') this.selectRange(a.from, a.to);
      this.mirror.apply(a);
      this.afterAction();
    }

    afterAction() {}
  }

  // <textarea> and <input>: offsets map straight onto selectionStart/End.
  class TextControlTarget extends BaseTarget {
    constructor(el, opts) {
      super(el, opts);
      this.singleLine = el instanceof HTMLInputElement;
    }

    begin() {
      if (this.canNavigate) {
        const end = this.el.selectionEnd;
        this.el.setSelectionRange(end, end);
        this.base = end;
      }
    }

    hasFocus() { return deepActiveElement() === this.el; }

    restore() {
      this.el.focus();
      if (this.canNavigate) {
        const { anchor, focus } = this.mirror;
        const s = Math.min(anchor, focus);
        const e = Math.max(anchor, focus);
        this.el.setSelectionRange(this.base + s, this.base + e, 'forward');
      }
    }

    insert(ch) {
      if (document.execCommand('insertText', false, ch)) return;
      const s = this.el.selectionStart;
      const e = this.el.selectionEnd;
      this.el.setRangeText(ch, s, e, 'end');
      this.el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ch }));
    }

    backspace() {
      if (document.execCommand('delete', false)) return;
      let s = this.el.selectionStart;
      const e = this.el.selectionEnd;
      if (s === e) s = Math.max(0, s - 1);
      this.el.setRangeText('', s, e, 'end');
      this.el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
    }

    moveTo(to) {
      this.el.setSelectionRange(this.base + to, this.base + to);
    }

    selectRange(from, to) {
      this.el.setSelectionRange(this.base + from, this.base + to, 'forward');
    }
  }

  // contenteditable: caret is moved relative to where it is, by character,
  // which is what the arrow keys do and what rich editors cope with best.
  class EditableTarget extends BaseTarget {
    constructor(el) {
      super(el);
      let host = el;
      while (host.parentElement && host.parentElement.isContentEditable) host = host.parentElement;
      this.host = host;
      this.root = host.getRootNode();
    }

    selection() {
      return this.root.getSelection ? this.root.getSelection() : window.getSelection();
    }

    begin() {
      const sel = this.selection();
      if (sel.rangeCount && !sel.isCollapsed) sel.collapseToEnd();
      this.saveRange();
    }

    hasFocus() {
      const a = deepActiveElement();
      return !!a && (a === this.host || this.host.contains(a));
    }

    saveRange() {
      const sel = this.selection();
      this.saved = sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
    }

    afterAction() { this.saveRange(); }

    restore() {
      this.host.focus();
      if (this.saved) {
        const sel = this.selection();
        sel.removeAllRanges();
        sel.addRange(this.saved);
      }
    }

    insert(ch) {
      if (ch === '\n') {
        if (!document.execCommand('insertParagraph', false)) document.execCommand('insertLineBreak', false);
        return;
      }
      document.execCommand('insertText', false, ch);
    }

    backspace() { document.execCommand('delete', false); }

    steps(from, to) {
      const lo = Math.min(from, to);
      const hi = Math.max(from, to);
      return Array.from(this.mirror.text.slice(lo, hi)).length;
    }

    moveTo(to) {
      const sel = this.selection();
      if (!sel.isCollapsed) sel.collapseToEnd();
      const from = this.mirror.selEnd;
      const dir = to < from ? 'backward' : 'forward';
      for (let n = this.steps(from, to); n > 0; n--) sel.modify('move', dir, 'character');
    }

    selectRange(from, to) {
      this.moveTo(from);
      const sel = this.selection();
      for (let n = this.steps(from, to); n > 0; n--) sel.modify('extend', 'forward', 'character');
    }
  }

  // -------------------------------------------------------------- overlay

  class Overlay {
    constructor(onToggle, onStop) {
      this.host = document.createElement('div');
      this.host.style.cssText = 'all:initial;position:fixed;right:16px;bottom:16px;z-index:2147483647;';
      const root = this.host.attachShadow({ mode: 'closed' });
      root.innerHTML = `
        <style>
          .box { font: 12px/1.3 system-ui, sans-serif; color: #f4f4f5; background: #18181b;
                 border: 1px solid #3f3f46; border-radius: 10px; padding: 8px 10px; min-width: 210px;
                 box-shadow: 0 6px 24px rgba(0,0,0,.35); user-select: none; }
          .row { display: flex; align-items: center; gap: 8px; }
          .title { font-weight: 600; flex: 1; }
          .dot { width: 8px; height: 8px; border-radius: 50%; background: #22c55e; }
          .dot.reviewing { background: #f59e0b; } .dot.paused { background: #a1a1aa; }
          .dot.countdown { background: #60a5fa; } .dot.error { background: #ef4444; }
          button { font: inherit; color: inherit; background: #27272a; border: 1px solid #3f3f46;
                   border-radius: 6px; padding: 2px 8px; cursor: pointer; }
          button:hover { background: #3f3f46; }
          .bar { height: 3px; background: #3f3f46; border-radius: 2px; margin-top: 6px; overflow: hidden; }
          .fill { height: 100%; width: 0; background: #22c55e; transition: width .2s linear; }
          .meta { color: #a1a1aa; margin-top: 4px; }
        </style>
        <div class="box">
          <div class="row">
            <span class="dot"></span><span class="title">Typer</span>
            <button class="toggle" title="Pause / resume (Alt+Shift+P)">Pause</button>
            <button class="stop" title="Stop (Esc)">Stop</button>
          </div>
          <div class="bar"><div class="fill"></div></div>
          <div class="meta"></div>
        </div>`;
      this.dot = root.querySelector('.dot');
      this.title = root.querySelector('.title');
      this.fill = root.querySelector('.fill');
      this.meta = root.querySelector('.meta');
      this.toggleBtn = root.querySelector('.toggle');
      // Keep focus (and the caret) in the field when the overlay is clicked.
      root.addEventListener('mousedown', (e) => e.preventDefault());
      this.toggleBtn.addEventListener('click', onToggle);
      root.querySelector('.stop').addEventListener('click', onStop);
      document.documentElement.appendChild(this.host);
    }

    update({ state, label, progress, meta, controls }) {
      this.dot.className = 'dot ' + state;
      this.title.textContent = label;
      if (progress != null) this.fill.style.width = Math.round(progress * 100) + '%';
      this.meta.textContent = meta || '';
      this.toggleBtn.textContent = state === 'paused' ? 'Resume' : 'Pause';
      this.toggleBtn.style.display = controls === false ? 'none' : '';
    }

    remove() { this.host.remove(); }
  }

  function toast(text, state) {
    const o = new Overlay(() => {}, () => o.remove());
    o.update({ state: state || 'error', label: text, progress: 0, controls: false });
    setTimeout(() => o.remove(), 3500);
  }

  function fmtTime(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }

  // --------------------------------------------------------------- runner

  let current = null;

  class Runner {
    constructor(target, plan, settings) {
      this.target = target;
      this.plan = plan;
      this.settings = settings;
      this.state = 'typing';
      this.phase = 'typing';
      this.index = 0;
      this.remaining = plan.duration;
      this.resumeWaiters = [];
      this.pausedReason = '';
      this.overlay = new Overlay(() => this.toggle(), () => this.stop());
      this.onKey = this.onKey.bind(this);
      this.onMouse = this.onMouse.bind(this);
      window.addEventListener('keydown', this.onKey, true);
      window.addEventListener('mousedown', this.onMouse, true);
    }

    onKey(e) {
      if (!e.isTrusted || this.state === 'done') return;
      if (e.key === 'Escape') {
        e.preventDefault();
        this.stop();
        return;
      }
      if (e.altKey && e.shiftKey) return; // our own shortcuts
      if (this.settings.pauseOnUserInput && this.state !== 'paused') this.pause('you pressed a key');
    }

    onMouse(e) {
      if (!e.isTrusted || this.state === 'paused' || !this.settings.pauseOnUserInput) return;
      const path = e.composedPath();
      if (path.includes(this.overlay.host)) return;
      const field = this.target.host || this.target.el;
      if (path.includes(field)) this.pause('you clicked in the field');
    }

    pause(reason) {
      if (this.state === 'stopped' || this.state === 'done' || this.state === 'paused') return;
      this.state = 'paused';
      this.pausedReason = reason || '';
      this.render();
    }

    resume() {
      if (this.state !== 'paused') return;
      this.state = this.phase;
      this.target.restore();
      const w = this.resumeWaiters;
      this.resumeWaiters = [];
      w.forEach((fn) => fn());
      this.render();
    }

    toggle() {
      if (this.state === 'paused') this.resume();
      else this.pause('paused');
    }

    stop() {
      if (this.state === 'done' || this.state === 'stopped') return;
      this.state = 'stopped';
      this.resumeWaiters.forEach((fn) => fn());
      this.finish('Stopped');
    }

    async wait(ms) {
      let left = ms;
      while (left > 0) {
        if (this.state === 'stopped') return;
        if (this.state === 'paused') {
          await new Promise((r) => this.resumeWaiters.push(r));
          continue;
        }
        const step = Math.min(left, 100);
        const t0 = performance.now();
        await sleep(step);
        if (this.state !== 'paused') left -= Math.max(step, performance.now() - t0);
      }
      while (this.state === 'paused') await new Promise((r) => this.resumeWaiters.push(r));
    }

    render() {
      const { actions, stats } = this.plan;
      const progress = this.index / actions.length;
      let label;
      let meta;
      if (this.state === 'paused') {
        label = 'Paused';
        meta = this.pausedReason ? `${this.pausedReason}, press Resume` : '';
      } else if (this.phase === 'reviewing') {
        label = 'Rereading and fixing typos';
        meta = `${fmtTime(this.remaining)} left`;
      } else {
        label = `Typing · ${Math.round(progress * 100)}%`;
        meta = `${this.settings.wpm} wpm · ${fmtTime(this.remaining)} left · ${stats.typos} typos planned`;
      }
      this.overlay.update({ state: this.state === 'paused' ? 'paused' : this.phase, label, progress, meta });
    }

    async run() {
      const { actions } = this.plan;
      this.target.begin();
      this.render();
      let lastRender = 0;
      for (; this.index < actions.length; this.index++) {
        const a = actions[this.index];
        await this.wait(a.wait);
        if (this.state === 'stopped') return;
        if (!this.target.hasFocus()) {
          this.pause('the field lost focus');
          await this.wait(0);
          if (this.state === 'stopped') return;
        }
        this.remaining -= a.wait;
        if (a.type === 'phase') {
          this.phase = a.phase;
          if (this.state !== 'paused') this.state = a.phase;
          this.render();
          continue;
        }
        try {
          this.target.perform(a);
        } catch (err) {
          console.error('Typer:', err);
          this.state = 'stopped';
          this.finish('Stopped: ' + err.message, 'error');
          return;
        }
        if (performance.now() - lastRender > 250) {
          lastRender = performance.now();
          this.render();
        }
      }
      this.state = 'done';
      const s = this.plan.stats;
      this.finish('Done', 'typing', `${s.typos} typos · ${s.typos - s.leftIn} fixed · ${s.leftIn} left in`);
    }

    finish(label, state, meta) {
      window.removeEventListener('keydown', this.onKey, true);
      window.removeEventListener('mousedown', this.onMouse, true);
      this.overlay.update({ state: state || 'paused', label, progress: this.index / this.plan.actions.length, meta, controls: false });
      setTimeout(() => this.overlay.remove(), 4000);
      if (current === this) current = null;
    }

    status() {
      return {
        state: this.state,
        progress: this.index / this.plan.actions.length,
        remaining: this.remaining,
      };
    }
  }

  // -------------------------------------------------------------- startup

  async function loadSettings() {
    const { settings, text } = await browser.storage.local.get(['settings', 'text']);
    return { settings: { ...DEFAULTS, ...(settings || {}) }, text: text || '' };
  }

  async function countdown(seconds) {
    if (seconds <= 0) return;
    let cancelled = false;
    const o = isTop ? new Overlay(() => {}, () => { cancelled = true; }) : null;
    for (let s = seconds; s > 0 && !cancelled; s--) {
      if (o) o.update({ state: 'countdown', label: `Starting in ${s}…`, meta: 'Click into the field you want typed into', controls: false });
      await sleep(1000);
    }
    if (o) o.remove();
    if (cancelled) throw new Error('cancelled');
  }

  async function start(source) {
    if (current) return;
    const { settings, text } = await loadSettings();
    if (!text.trim()) {
      if (isTop) toast('Nothing to type. Paste text in the Typer popup first.');
      return;
    }
    try {
      await countdown(source === 'popup' ? Math.round(settings.startDelay) : 0);
    } catch (e) {
      return;
    }
    if (current) return;
    const target = findTarget();
    if (!target) {
      // Only the top frame complains, and only when focus isn't in a child frame.
      const active = document.activeElement;
      const inFrame = active && (active.tagName === 'IFRAME' || active.tagName === 'FRAME');
      if (isTop && !inFrame) toast('Click into a text field first.');
      return;
    }
    target.keyEvents = settings.keyEvents;
    const planSettings = { ...settings, singleLine: target.singleLine === true };
    if (!target.canNavigate) planSettings.deferredShare = 0;
    const plan = makePlan(text, planSettings);
    current = new Runner(target, plan, settings);
    current.run().catch((err) => console.error('Typer:', err));
  }

  browser.runtime.onMessage.addListener((msg) => {
    if (!msg || !msg.cmd) return undefined;
    switch (msg.cmd) {
      case 'start':
        start(msg.source);
        return undefined;
      case 'toggle':
        if (current) current.toggle();
        return undefined;
      case 'stop':
        if (current) current.stop();
        return undefined;
      case 'status':
        return current ? Promise.resolve(current.status()) : undefined;
      case 'ping':
        return isTop ? Promise.resolve({ ok: true }) : undefined;
    }
    return undefined;
  });
})();
