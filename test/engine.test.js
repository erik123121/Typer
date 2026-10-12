'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { plan, Buffer, mutate, Rng, NEIGHBORS, keyInfo, DEFAULTS } = require('../src/engine.js');

const ESSAY = [
  'The quick brown fox jumps over the lazy dog. Typing realistically means making mistakes, noticing some of them right away and catching others later.',
  'Second paragraph here, with a few longer words like extraordinary, characteristic and responsibility to give the typo model something to chew on.',
  'Third paragraph. Short sentences. Then a longer one that keeps going for a while so the timing model has room to drift around a little bit.',
  'Fourth paragraph mentions numbers like 1984 and 3.14, plus symbols (parentheses) and "quotes" for good measure.',
  'Fifth and final paragraph wraps things up and says goodbye.',
].join('\n\n');

function replay(actions) {
  const buf = new Buffer();
  for (const a of actions) buf.apply(a);
  return buf.text;
}

test('replaying the plan produces the planned final text', () => {
  for (let seed = 1; seed <= 50; seed++) {
    const p = plan(ESSAY, { mistakeRate: 0.2 }, seed);
    assert.equal(replay(p.actions), p.finalText);
  }
});

test('with no typos the output is exact', () => {
  const p = plan(ESSAY, { mistakeRate: 0 }, 7);
  assert.equal(p.finalText, ESSAY);
  assert.ok(p.actions.every((a) => a.type === 'key' || a.type === 'phase'));
});

test('immediately corrected typos never survive', () => {
  for (let seed = 1; seed <= 30; seed++) {
    const p = plan(ESSAY, { mistakeRate: 0.3, deferredShare: 0 }, seed);
    assert.equal(p.finalText, ESSAY);
    assert.ok(p.stats.fixedImmediately > 0);
  }
});

test('review passes fix every left-in typo when the fix rate is 1', () => {
  for (let seed = 1; seed <= 30; seed++) {
    const p = plan(ESSAY, { mistakeRate: 0.3, deferredShare: 1, reviewFixRate: 1 }, seed);
    assert.equal(p.finalText, ESSAY, `seed ${seed}`);
    assert.equal(p.stats.leftIn, 0);
    assert.ok(p.actions.some((a) => a.type === 'move'));
  }
});

test('the final review catches what the chunk reviews skipped', () => {
  const p = plan(ESSAY, {
    mistakeRate: 0.3, deferredShare: 1, reviewFixRate: 0, finalReview: true, finalReviewFixRate: 1,
  }, 3);
  assert.equal(p.finalText, ESSAY);
  assert.equal(p.stats.fixedInReview, 0);
  assert.ok(p.stats.fixedInFinal > 0);
});

test('typos that are never reviewed stay in the text', () => {
  const p = plan(ESSAY, { mistakeRate: 0.3, deferredShare: 1, reviewFixRate: 0, finalReview: false }, 4);
  assert.notEqual(p.finalText, ESSAY);
  assert.equal(p.stats.leftIn, p.stats.leftForReview);
  let text = p.finalText;
  const left = [...p.stats.leftInWords].sort((a, b) => b.at - a.at);
  for (const { at, wrong, correct } of left) {
    assert.equal(text.slice(at, at + wrong.length), wrong);
    text = text.slice(0, at) + correct + text.slice(at + wrong.length);
  }
  assert.equal(text, ESSAY);
});

test('defaults leave a few typos but fix most of them', () => {
  let deferred = 0;
  let left = 0;
  for (let seed = 1; seed <= 200; seed++) {
    const p = plan(ESSAY, {}, seed);
    deferred += p.stats.leftForReview;
    left += p.stats.leftIn;
  }
  const leftShare = left / deferred;
  assert.ok(leftShare > 0.05 && leftShare < 0.3, `left in ${leftShare}`);
});

test('reviews happen after 1-4 paragraphs and the caret returns to the end', () => {
  const text = Array.from({ length: 12 }, (_, i) => `Paragraph number ${i} with several ordinary words inside it.`).join('\n\n');
  const p = plan(text, { mistakeRate: 0.4, deferredShare: 1, reviewFixRate: 1 }, 11);
  const buf = new Buffer();
  let reviews = 0;
  let paragraphsTyped = 0;
  let sinceReview = 0;
  for (let i = 0; i < p.actions.length; i++) {
    const a = p.actions[i];
    if (a.type === 'phase' && a.phase === 'reviewing') {
      reviews++;
      assert.ok(sinceReview >= 1 && sinceReview <= 4, `reviewed after ${sinceReview} paragraphs`);
      sinceReview = 0;
    }
    if (a.type === 'phase' && a.phase === 'typing' && reviews) {
      assert.equal(buf.focus, buf.length, 'caret back at the end before typing resumes');
    }
    buf.apply(a);
    if (a.type === 'key' && a.ch === '\n' && buf.text.endsWith('\n\n')) {
      paragraphsTyped++;
      sinceReview++;
    }
  }
  assert.ok(reviews >= 3);
  assert.equal(buf.text, text);
});

test('net speed lands near the target WPM', () => {
  for (const wpm of [35, 60, 90]) {
    const p = plan(ESSAY, { wpm, mistakeRate: 0 }, 5);
    const minutes = p.duration / 60000;
    const actual = ESSAY.length / 5 / minutes;
    assert.ok(Math.abs(actual - wpm) / wpm < 0.12, `target ${wpm}, got ${actual.toFixed(1)}`);
  }
});

test('keystroke intervals vary and are never instant', () => {
  const p = plan(ESSAY, { mistakeRate: 0 }, 9);
  const waits = p.actions.filter((a) => a.type === 'key').map((a) => a.wait);
  assert.ok(Math.min(...waits) >= 14);
  const mean = waits.reduce((a, b) => a + b, 0) / waits.length;
  const sd = Math.sqrt(waits.reduce((a, b) => a + (b - mean) ** 2, 0) / waits.length);
  assert.ok(sd / mean > 0.3, 'intervals should not look metronomic');
});

test('single-line mode removes newlines', () => {
  const p = plan('one\ntwo\n\nthree', { singleLine: true, mistakeRate: 0 }, 1);
  assert.equal(p.finalText, 'one two three');
});

test('handles emoji and accents without corrupting offsets', () => {
  const text = 'Café déjà vu 🎉 is wonderful.\n\nAnother paragraph 👍 follows here.';
  for (let seed = 1; seed <= 20; seed++) {
    const p = plan(text, { mistakeRate: 0.5, deferredShare: 1, reviewFixRate: 1 }, seed);
    assert.equal(p.finalText, text);
  }
});

test('typos use QWERTY neighbours', () => {
  assert.deepEqual([...NEIGHBORS.g].sort(), ['b', 'f', 'h', 't', 'v', 'y']);
  const rng = new Rng(1);
  for (let i = 0; i < 500; i++) {
    const w = 'Something';
    const m = mutate(rng, w);
    assert.notEqual(m, w);
    assert.ok(Math.abs(m.length - w.length) <= 1);
  }
});

test('keyInfo matches a US QWERTY keyboard', () => {
  assert.deepEqual(keyInfo('A'), { key: 'A', code: 'KeyA', keyCode: 65, shift: true });
  assert.deepEqual(keyInfo('!'), { key: '!', code: 'Digit1', keyCode: 49, shift: true });
  assert.deepEqual(keyInfo('\n').key, 'Enter');
  assert.equal(keyInfo('?').code, 'Slash');
});

test('defaults are sane', () => {
  assert.ok(DEFAULTS.reviewEveryMin === 1 && DEFAULTS.reviewEveryMax === 4);
});
