// Adds a "Dev Companion" panel to DevTools showing the inspected tab's recordings.
const tabId = chrome.devtools.inspectedWindow.tabId;
chrome.devtools.panels.create(
  'Dev Companion',
  'icons/icon-32.png',
  `dashboard.html?tabId=${tabId}&embedded=1`,
);
