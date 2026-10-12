/*
 * Typer engine.
 *
 * Turns a piece of text plus settings into a timed "plan": a flat list of
 * editing actions (key, backspace, caret move, selection) with a wait before
 * each one. The plan is pure data, so the same engine runs in the content
 * script, the popup (for estimates) and the Node test suite.
 *
 * Action shapes:
 *   { type: 'key',    ch, wait, dwell }   insert ch (replacing any selection)
 *   { type: 'back',   wait, dwell }       backspace
 *   { type: 'move',   to, wait }          collapse caret to offset `to`
 *   { type: 'select', from, to, wait }    select [from, to)
 *   { type: 'phase',  phase, wait }       'typing' | 'reviewing' (UI only)
 *
 * Offsets are JS string indices into the text typed so far.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TyperEngine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DEFAULTS = Object.freeze({
    wpm: 55,                 // net speed, including pauses and corrections
    variance: 0.35,          // keystroke jitter (log-normal sigma)
    mistakeRate: 0.06,       // chance a word of 3+ letters gets a typo
    deferredShare: 0.4,      // share of typos left in for a later review pass
    reviewEveryMin: 1,       // paragraphs typed before going back to fix typos
    reviewEveryMax: 4,
    reviewFixRate: 0.7,      // chance a left-in typo is fixed in a review pass
    finalReview: true,       // one last pass over the whole text at the end
    finalReviewFixRate: 0.5,
    thinkingPauses: true,
    startDelay: 3,           // seconds before typing starts (popup only)
    keyEvents: true,         // dispatch keydown/keypress/keyup
    pauseOnUserInput: true,  // pause when you type or click in the field
  });

  // ---------------------------------------------------------------- random

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  class Rng {
    constructor(seed) {
      this.next = mulberry32(seed == null ? (Math.random() * 2 ** 32) >>> 0 : seed);
    }
    range(a, b) { return a + (b - a) * this.next(); }
    int(a, b) { return a + Math.floor(this.next() * (b - a + 1)); }
    chance(p) { return this.next() < p; }
    pick(arr) { return arr[Math.floor(this.next() * arr.length)]; }
    weighted(pairs) {
      let total = 0;
      for (const [, w] of pairs) total += w;
      let r = this.next() * total;
      for (const [v, w] of pairs) if ((r -= w) < 0) return v;
      return pairs[pairs.length - 1][0];
    }
    normal() {
      const u = 1 - this.next();
      const v = this.next();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    }
    // Log-normal multiplier with mean 1.
    jitter(sigma) { return Math.exp(sigma * this.normal() - (sigma * sigma) / 2); }
  }

  // -------------------------------------------------------------- keyboard

  // US QWERTY. `x` is the stagger offset of each row, in key widths.
  const ROWS = [
    { keys: '`1234567890-=', shifted: '~!@#$%^&*()_+', x: 0 },
    { keys: 'qwertyuiop[]\\', shifted: 'QWERTYUIOP{}|', x: 0.5 },
    { keys: "asdfghjkl;'", shifted: 'ASDFGHJKL:"', x: 0.75 },
    { keys: 'zxcvbnm,./', shifted: 'ZXCVBNM<>?', x: 1.25 },
  ];

  const FINGERS = {
    LP: '`1qaz', LR: '2wsx', LM: '3edc', LI: '45rtfgvb',
    RI: '67yuhjnm', RM: '8ik,', RR: '9ol.', RP: "0-=p[]\\;'/",
  };

  const CODE_NAMES = {
    '`': 'Backquote', '-': 'Minus', '=': 'Equal', '[': 'BracketLeft',
    ']': 'BracketRight', '\\': 'Backslash', ';': 'Semicolon', "'": 'Quote',
    ',': 'Comma', '.': 'Period', '/': 'Slash',
  };

  // Gecko legacy keyCodes for punctuation.
  const KEY_CODES = {
    '`': 192, '-': 173, '=': 61, '[': 219, ']': 221, '\\': 220,
    ';': 59, "'": 222, ',': 188, '.': 190, '/': 191,
  };

  const KEYS = {};
  ROWS.forEach((row, r) => {
    for (let c = 0; c < row.keys.length; c++) {
      const base = row.keys[c];
      const finger = Object.keys(FINGERS).find((f) => FINGERS[f].includes(base));
      const info = { base, row: r, x: c + row.x, finger };
      KEYS[base] = { ...info, shift: false };
      KEYS[row.shifted[c]] = { ...info, shift: true };
    }
  });

  const NEIGHBORS = {};
  for (const a of 'abcdefghijklmnopqrstuvwxyz') {
    NEIGHBORS[a] = [];
    for (const b of 'abcdefghijklmnopqrstuvwxyz') {
      if (a === b) continue;
      const dx = KEYS[a].x - KEYS[b].x;
      const dy = KEYS[a].row - KEYS[b].row;
      if (Math.hypot(dx, dy) <= 1.3) NEIGHBORS[a].push(b);
    }
  }

  // DOM KeyboardEvent fields for a character, as a US QWERTY keyboard sends them.
  function keyInfo(ch) {
    if (ch === '\n') return { key: 'Enter', code: 'Enter', keyCode: 13, shift: false };
    if (ch === '\t') return { key: 'Tab', code: 'Tab', keyCode: 9, shift: false };
    if (ch === ' ') return { key: ' ', code: 'Space', keyCode: 32, shift: false };
    const k = KEYS[ch];
    if (!k) return { key: ch, code: '', keyCode: 0, shift: false };
    let code;
    let keyCode;
    if (/[a-z]/.test(k.base)) {
      code = 'Key' + k.base.toUpperCase();
      keyCode = k.base.toUpperCase().charCodeAt(0);
    } else if (/[0-9]/.test(k.base)) {
      code = 'Digit' + k.base;
      keyCode = k.base.charCodeAt(0);
    } else {
      code = CODE_NAMES[k.base];
      keyCode = KEY_CODES[k.base];
    }
    return { key: ch, code, keyCode, shift: k.shift };
  }

  const BACKSPACE = { key: 'Backspace', code: 'Backspace', keyCode: 8, shift: false };

  const COMMON_BIGRAMS = new Set(
    ('th he in er an re on at en nd ti es or te of ed is it al ar st to nt ng ' +
      'se ha as ou io le ve co me de hi ri ro ic ne ea ra ce li ch ll be ma si om ur')
      .split(' ')
  );

  // Relative cost of typing `ch` right after `prev`.
  function keyCost(prev, ch) {
    if (ch === ' ') return 0.85;
    if (ch === '\n') return 1.3;
    const k = KEYS[ch];
    if (!k) return 1.8; // characters not on the keyboard (accents, emoji)
    let m = 1;
    if (k.shift) m *= 1.3;
    if (/[0-9]/.test(k.base)) m *= 1.35;
    else if (!/[a-z]/.test(k.base)) m *= 1.25;
    const pk = prev && KEYS[prev];
    if (pk) {
      if (pk.base === k.base) m *= 0.95;
      else if (pk.finger === k.finger) m *= 1.4;
      else if (pk.finger[0] === k.finger[0]) m *= 1.1;
      else m *= 0.85;
      if (COMMON_BIGRAMS.has((prev + ch).toLowerCase())) m *= 0.8;
    } else if (prev === ' ') {
      m *= 1.1;
    }
    return m;
  }

  // ---------------------------------------------------------------- buffer

  // Mirror of the text being edited. The planner uses it to know where
  // things are; the content script uses it to drive caret movement.
  class Buffer {
    constructor() {
      this.text = '';
      this.anchor = 0;
      this.focus = 0;
    }
    get selStart() { return Math.min(this.anchor, this.focus); }
    get selEnd() { return Math.max(this.anchor, this.focus); }
    get length() { return this.text.length; }

    apply(a) {
      const s = this.selStart;
      const e = this.selEnd;
      switch (a.type) {
        case 'key':
          this.text = this.text.slice(0, s) + a.ch + this.text.slice(e);
          this.anchor = this.focus = s + a.ch.length;
          break;
        case 'back':
          if (s !== e) {
            this.text = this.text.slice(0, s) + this.text.slice(e);
            this.anchor = this.focus = s;
          } else if (s > 0) {
            const lo = this.text.charCodeAt(s - 1);
            const n = lo >= 0xdc00 && lo <= 0xdfff && s >= 2 ? 2 : 1;
            this.text = this.text.slice(0, s - n) + this.text.slice(s);
            this.anchor = this.focus = s - n;
          }
          break;
        case 'move':
          this.anchor = this.focus = a.to;
          break;
        case 'select':
          this.anchor = a.from;
          this.focus = a.to;
          break;
      }
    }
  }

  // --------------------------------------------------------------- typos

  function sameCase(model, ch) {
    return model === model.toUpperCase() ? ch.toUpperCase() : ch;
  }

  function neighborOf(rng, ch) {
    const list = NEIGHBORS[ch.toLowerCase()];
    return list && list.length ? sameCase(ch, rng.pick(list)) : null;
  }

  // Returns a plausible misspelling of `w` (letters only, length >= 3).
  function mutate(rng, w) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const kind = rng.weighted([
        ['substitute', 38], ['transpose', 22], ['omit', 14],
        ['insert', 12], ['double', 8], ['caps', 6],
      ]);
      const i = rng.int(0, w.length - 1);
      let out = null;
      if (kind === 'substitute') {
        const n = neighborOf(rng, w[i]);
        if (n) out = w.slice(0, i) + n + w.slice(i + 1);
      } else if (kind === 'transpose') {
        const j = Math.min(i, w.length - 2);
        out = w.slice(0, j) + w[j + 1] + w[j] + w.slice(j + 2);
      } else if (kind === 'omit') {
        const j = Math.max(1, i);
        out = w.slice(0, j) + w.slice(j + 1);
      } else if (kind === 'insert') {
        const n = neighborOf(rng, w[i]);
        if (n) out = rng.chance(0.5) ? w.slice(0, i) + n + w.slice(i) : w.slice(0, i + 1) + n + w.slice(i + 1);
      } else if (kind === 'double') {
        out = w.slice(0, i + 1) + w[i] + w.slice(i + 1);
      } else if (kind === 'caps') {
        // Shift held a beat too long: "THe".
        if (/^[A-Z][a-z]/.test(w)) out = w[0] + w[1].toUpperCase() + w.slice(2);
      }
      if (out && out !== w) return out;
    }
    return w.slice(0, 1) + w[2] + w[1] + w.slice(3); // transpose 2nd/3rd as a fallback
  }

  function commonPrefix(a, b) {
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    return i;
  }

  function commonSuffix(a, b, prefix) {
    const max = Math.min(a.length, b.length) - prefix;
    let i = 0;
    while (i < max && a[a.length - 1 - i] === b[b.length - 1 - i]) i++;
    return i;
  }

  // --------------------------------------------------------------- planner

  const TOKEN_RE = /\n+|[^\S\n]+|[A-Za-z]+|[^A-Za-z\s]+/g;

  function normalize(text, opts) {
    let t = String(text).replace(/\r\n?/g, '\n');
    if (opts && opts.singleLine) t = t.replace(/\s*\n\s*/g, ' ');
    return t;
  }

  class Planner {
    constructor(settings, seed) {
      this.s = { ...DEFAULTS, ...settings };
      this.rng = new Rng(seed);
      this.buf = new Buffer();
      this.actions = [];
      this.mistakes = [];
      this.phase = 'typing';
      this.prev = '';          // last character typed while moving forward
      this.drift = 1;          // slow wander in speed
      this.wordFactor = 1;     // per-word burst speed
      this.typed = 0;          // forward characters typed so far
      this.stats = {
        immediate: 0, deferred: 0, fixedInReview: 0, fixedInFinal: 0, reviews: 0,
      };
    }

    // ---- low-level emitters

    emit(action, keyMs, pauseMs) {
      action.keyMs = keyMs || 0;
      action.pauseMs = pauseMs || 0;
      action.phase = this.phase;
      this.actions.push(action);
      this.buf.apply(action);
    }

    baseMs() { return 12000 / Math.max(5, this.s.wpm); }

    dwell() { return Math.round(this.rng.range(55, 125)); }

    key(ch, pauseMs) {
      const warm = 1 + 0.25 * Math.exp(-this.typed / 40);
      const ms = this.baseMs() * keyCost(this.prev, ch) * this.wordFactor * this.drift *
        warm * this.rng.jitter(this.s.variance);
      this.emit({ type: 'key', ch, dwell: this.dwell() }, ms, pauseMs);
      this.prev = ch;
    }

    back(pauseMs, first) {
      const ms = this.baseMs() * (first ? 1 : 0.7) * this.rng.jitter(0.25);
      this.emit({ type: 'back', dwell: this.dwell() }, ms, pauseMs);
      this.prev = '';
    }

    typeString(str, firstPause) {
      let pause = firstPause || 0;
      for (const ch of str) {
        this.key(ch, pause);
        pause = 0;
      }
    }

    setPhase(phase, pauseMs) {
      this.phase = phase;
      this.emit({ type: 'phase', phase }, 0, pauseMs || 0);
    }

    // ---- forward typing

    startWord(word, before) {
      this.drift = Math.min(1.2, Math.max(0.85, this.drift + this.rng.normal() * 0.03));
      this.wordFactor = this.rng.jitter(0.12) * (word.length >= 9 ? 1.08 : 1);

      // Pauses that follow the structure of the text.
      let pause = 0;
      const last = before.lastChar;
      if (before.newlines >= 2) pause += this.rng.range(700, 2600);
      else if (before.newlines === 1) pause += this.rng.range(300, 1200);
      else if (/[.!?]/.test(last)) pause += this.rng.range(200, 800);
      else if (/[,;:]/.test(last)) pause += this.rng.range(60, 280);
      if (this.s.thinkingPauses) {
        const p = /[.!?\n]/.test(last) || before.newlines ? 0.1 : 0.025;
        if (this.rng.chance(p)) pause += this.rng.range(600, 2600);
      }
      if (word.length >= 9) pause += this.rng.range(60, 260);
      return pause;
    }

    typeWord(w, pause) {
      const eligible = w.length >= 3 && this.s.mistakeRate > 0;
      if (!eligible || !this.rng.chance(this.s.mistakeRate)) {
        this.typeString(w, pause);
        this.typed += w.length;
        return;
      }
      const wrong = mutate(this.rng, w);
      if (this.rng.chance(this.s.deferredShare)) {
        // Leave it in; a review pass may come back for it.
        const start = this.buf.focus;
        this.typeString(wrong, pause);
        this.mistakes.push({ start, wrong, correct: w, fixed: false, chunk: this.stats.reviews });
        this.stats.deferred++;
      } else {
        this.typoNoticedNow(w, wrong, pause);
        this.stats.immediate++;
      }
      this.typed += w.length;
    }

    // Type the misspelling, notice it a few letters later, backspace, retype.
    typoNoticedNow(w, wrong, pause) {
      const p = commonPrefix(wrong, w);
      const lag = this.rng.weighted([[0, 45], [1, 30], [2, 15], [3, 10]]);
      const k = Math.min(wrong.length, p + 1 + lag);
      this.typeString(wrong.slice(0, k), pause);
      let del = k - p;
      if (p > 0 && this.rng.chance(0.12)) del++; // overshoot by one
      for (let i = 0; i < del; i++) this.back(i === 0 ? this.rng.range(180, 650) : 0, i === 0);
      this.prev = this.buf.text[this.buf.focus - 1] || '';
      this.typeString(w.slice(k - del), this.rng.range(40, 160));
    }

    // ---- review passes

    review(candidates, rate, isFinal) {
      const targets = candidates
        .filter((m) => !m.fixed && this.rng.chance(rate))
        .sort((a, b) => a.start - b.start);
      if (!targets.length) {
        // Sometimes you reread and find nothing worth changing.
        if (!isFinal && this.rng.chance(0.2)) this.emitPause(this.rng.range(1000, 3500));
        return;
      }
      this.stats.reviews++;
      const chars = isFinal ? this.buf.length : this.charsSinceReview;
      const readMs = Math.min(20000, Math.max(1500, (chars / 1250) * 60000 * this.rng.range(0.35, 0.8)));
      this.setPhase('reviewing', readMs);
      for (const m of targets) {
        this.fix(m);
        if (isFinal) this.stats.fixedInFinal++;
        else this.stats.fixedInReview++;
      }
      this.emit({ type: 'move', to: this.buf.length }, 0, this.rng.range(350, 1000));
      this.setPhase('typing', this.rng.range(200, 700));
      this.prev = this.buf.text[this.buf.length - 1] || '';
    }

    emitPause(ms) {
      this.emit({ type: 'phase', phase: this.phase }, 0, ms);
    }

    fix(m) {
      const { wrong, correct, start } = m;
      if (this.buf.text.slice(start, start + wrong.length) !== wrong) {
        throw new Error('Typer: mistake offsets out of sync');
      }
      const p = commonPrefix(wrong, correct);
      const s = commonSuffix(wrong, correct, p);
      const seek = this.rng.range(500, 1800); // find it, move the mouse, click
      const style = this.rng.weighted([['precise', 50], ['toError', 25], ['retype', 25]]);
      this.wordFactor = 1;

      if (style === 'retype') {
        // Double-click the word and type it again.
        this.emit({ type: 'select', from: start, to: start + wrong.length }, 0, seek);
        this.prev = '';
        this.typeString(correct, this.rng.range(150, 450));
      } else {
        const keep = style === 'precise' ? s : 0;
        const at = start + wrong.length - keep;
        this.emit({ type: 'move', to: at }, 0, seek);
        const del = wrong.length - keep - p;
        for (let i = 0; i < del; i++) this.back(i === 0 ? this.rng.range(150, 400) : 0, i === 0);
        this.prev = this.buf.text[this.buf.focus - 1] || '';
        this.typeString(correct.slice(p, correct.length - keep), del ? this.rng.range(30, 120) : this.rng.range(150, 400));
      }

      const delta = correct.length - wrong.length;
      m.fixed = true;
      for (const o of this.mistakes) if (o !== m && o.start > start) o.start += delta;
    }

    // ---- driver

    plan(text) {
      const tokens = text.match(TOKEN_RE) || [];
      let reviewTarget = this.nextReviewTarget();
      let paragraphs = 0;
      let paragraphHasText = false;
      let chunkStart = 0; // index into this.mistakes
      this.charsSinceReview = 0;
      const before = { lastChar: '', newlines: 0 };

      const endParagraph = (force) => {
        if (!paragraphHasText) return;
        paragraphHasText = false;
        paragraphs++;
        if (paragraphs >= reviewTarget || force) {
          this.review(this.mistakes.slice(chunkStart), this.s.reviewFixRate, false);
          chunkStart = this.mistakes.length;
          paragraphs = 0;
          this.charsSinceReview = 0;
          reviewTarget = this.nextReviewTarget();
        }
      };

      for (const tok of tokens) {
        if (tok[0] === '\n') {
          endParagraph(false);
          this.typeString(tok, this.rng.range(150, 600));
          this.typed += tok.length;
          before.newlines = tok.length;
          continue;
        }
        if (/^\s/.test(tok)) {
          this.typeString(tok);
          this.typed += tok.length;
          continue;
        }
        paragraphHasText = true;
        const pause = this.startWord(tok, before);
        if (/^[A-Za-z]+$/.test(tok)) this.typeWord(tok, pause);
        else {
          this.typeString(tok, pause);
          this.typed += tok.length;
        }
        this.charsSinceReview += tok.length + 1;
        before.lastChar = tok[tok.length - 1];
        before.newlines = 0;
      }
      endParagraph(true);
      if (this.s.finalReview) this.review(this.mistakes, this.s.finalReviewFixRate, true);
      return this.finish(text);
    }

    nextReviewTarget() {
      const lo = Math.max(1, Math.round(this.s.reviewEveryMin));
      const hi = Math.max(lo, Math.round(this.s.reviewEveryMax));
      return this.rng.int(lo, hi);
    }

    // Scale finger speed so the forward-typing part lands on the target WPM.
    finish(text) {
      let keyTotal = 0;
      let pauseTotal = 0;
      for (const a of this.actions) {
        if (a.phase !== 'typing') continue;
        keyTotal += a.keyMs;
        pauseTotal += a.pauseMs;
      }
      const targetMs = (text.length * 12000) / Math.max(5, this.s.wpm);
      let factor = keyTotal ? (targetMs - pauseTotal) / keyTotal : 1;
      factor = Math.min(3, Math.max(0.35, factor));

      let duration = 0;
      const actions = this.actions.map((a) => {
        let wait = a.keyMs * factor + a.pauseMs;
        if (a.type === 'key' || a.type === 'back') wait = Math.max(14, wait);
        wait = Math.round(wait);
        duration += wait;
        const out = { type: a.type, wait };
        if (a.type === 'key') { out.ch = a.ch; out.dwell = a.dwell; }
        if (a.type === 'back') out.dwell = a.dwell;
        if (a.type === 'move') out.to = a.to;
        if (a.type === 'select') { out.from = a.from; out.to = a.to; }
        if (a.type === 'phase') out.phase = a.phase;
        return out;
      });

      const left = this.mistakes.filter((m) => !m.fixed);
      return {
        actions,
        finalText: this.buf.text,
        duration,
        stats: {
          chars: text.length,
          typos: this.stats.immediate + this.stats.deferred,
          fixedImmediately: this.stats.immediate,
          leftForReview: this.stats.deferred,
          fixedInReview: this.stats.fixedInReview,
          fixedInFinal: this.stats.fixedInFinal,
          reviews: this.stats.reviews,
          leftIn: left.length,
          leftInWords: left.map((m) => ({ at: m.start, wrong: m.wrong, correct: m.correct })),
        },
      };
    }
  }

  function plan(text, settings, seed) {
    const t = normalize(text, settings);
    return new Planner(settings, seed).plan(t);
  }

  return { DEFAULTS, plan, normalize, keyInfo, BACKSPACE, Buffer, Rng, mutate, NEIGHBORS, keyCost };
});
