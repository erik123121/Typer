'use strict';

const COMMANDS = {
  'start-typing': { cmd: 'start', source: 'hotkey' },
  'toggle-typing': { cmd: 'toggle' },
  'stop-typing': { cmd: 'stop' },
};

browser.commands.onCommand.addListener(async (name) => {
  const msg = COMMANDS[name];
  if (!msg) return;
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  try {
    await browser.tabs.sendMessage(tab.id, msg);
  } catch (e) {
    // No content script in this tab (about: pages, AMO, or opened before install).
  }
});
