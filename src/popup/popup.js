'use strict';

const { DEFAULTS, plan } = window.TyperEngine;
const $ = (id) => document.getElementById(id);

const SLIDERS = {
  wpm: (v) => `${v} wpm`,
  mistakeRate: (v) => `${Math.round(v * 1000) / 10}% of words`,
  deferredShare: (v) => `${Math.round(v * 100)}%`,
  reviewFixRate: (v) => `${Math.round(v * 100)}%`,
  finalReviewFixRate: (v) => `${Math.round(v * 100)}%`,
  variance: (v) => (v < 0.2 ? 'steady' : v < 0.45 ? 'natural' : 'erratic'),
};
const NUMBERS = ['reviewEveryMin', 'reviewEveryMax', 'startDelay'];
const CHECKS = ['finalReview', 'thinkingPauses', 'keyEvents', 'pauseOnUserInput'];

let settings = { ...DEFAULTS };

function fmtTime(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

function render() {
  for (const [id, fmt] of Object.entries(SLIDERS)) {
    $(id).value = settings[id];
    $(id + 'Out').textContent = fmt(settings[id]);
  }
  for (const id of NUMBERS) $(id).value = settings[id];
  for (const id of CHECKS) $(id).checked = !!settings[id];
  $('finalReviewFixRate').disabled = !settings.finalReview;
}

let estimateTimer;
function estimate() {
  clearTimeout(estimateTimer);
  estimateTimer = setTimeout(() => {
    const text = $('text').value;
    if (!text.trim()) {
      $('estimate').textContent = '';
      return;
    }
    // Average a few runs; each real run is randomised.
    let duration = 0;
    let typos = 0;
    let left = 0;
    const runs = text.length > 20000 ? 1 : 3;
    for (let i = 0; i < runs; i++) {
      const p = plan(text, settings);
      duration += p.duration;
      typos += p.stats.typos;
      left += p.stats.leftIn;
    }
    $('estimate').textContent =
      `≈ ${fmtTime(duration / runs)} · ~${Math.round(typos / runs)} typos, ~${Math.round(left / runs)} left in`;
  }, 250);
}

async function save() {
  await browser.storage.local.set({ settings, text: $('text').value });
}

async function activeTab() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function send(msg) {
  const tab = await activeTab();
  if (!tab) return undefined;
  return browser.tabs.sendMessage(tab.id, msg);
}

async function refreshStatus() {
  let s;
  try {
    await send({ cmd: 'ping' });
    s = await send({ cmd: 'status' });
  } catch (e) {
    $('status').textContent = 'Typer can’t run on this page. Reload it, or try a normal web page.';
    $('start').disabled = true;
    return;
  }
  $('start').disabled = false;
  const running = s && (s.state === 'typing' || s.state === 'reviewing' || s.state === 'paused');
  $('toggle').disabled = !running;
  $('stop').disabled = !running;
  $('toggle').textContent = s && s.state === 'paused' ? 'Resume' : 'Pause';
  $('status').textContent = running
    ? `${s.state === 'reviewing' ? 'Fixing typos' : s.state === 'paused' ? 'Paused' : 'Typing'} · ${Math.round(s.progress * 100)}% · ${fmtTime(s.remaining)} left`
    : '';
}

async function checkPermission() {
  const ok = await browser.permissions.contains({ origins: ['<all_urls>'] });
  $('perm').hidden = ok;
}

async function init() {
  const stored = await browser.storage.local.get(['settings', 'text']);
  settings = { ...DEFAULTS, ...(stored.settings || {}) };
  $('text').value = stored.text || '';
  render();
  estimate();
  checkPermission();
  refreshStatus();
  setInterval(refreshStatus, 1000);

  $('text').addEventListener('input', () => { save(); estimate(); });

  for (const id of Object.keys(SLIDERS)) {
    $(id).addEventListener('input', () => {
      settings[id] = Number($(id).value);
      render();
      save();
      estimate();
    });
  }
  for (const id of NUMBERS) {
    $(id).addEventListener('change', () => {
      const n = Math.max(Number($(id).min), Math.min(Number($(id).max), Math.round(Number($(id).value) || 0)));
      settings[id] = n;
      if (id === 'reviewEveryMin' && settings.reviewEveryMax < n) settings.reviewEveryMax = n;
      if (id === 'reviewEveryMax' && settings.reviewEveryMin > n) settings.reviewEveryMin = n;
      render();
      save();
      estimate();
    });
  }
  for (const id of CHECKS) {
    $(id).addEventListener('change', () => {
      settings[id] = $(id).checked;
      render();
      save();
      estimate();
    });
  }

  $('grant').addEventListener('click', async () => {
    await browser.permissions.request({ origins: ['<all_urls>'] });
    checkPermission();
  });

  $('start').addEventListener('click', async () => {
    if (!$('text').value.trim()) {
      $('status').textContent = 'Paste some text first.';
      return;
    }
    await save();
    await send({ cmd: 'start', source: 'popup' });
    window.close(); // hand focus back to the page for the countdown
  });
  $('toggle').addEventListener('click', () => send({ cmd: 'toggle' }).then(refreshStatus));
  $('stop').addEventListener('click', () => send({ cmd: 'stop' }).then(refreshStatus));
}

init();
