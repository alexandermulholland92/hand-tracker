// background.js — the Chrome extension's go-between. The control page (control.html: the
// camera, the hand tracking and the hand mouse) sends each move, click, scroll and key here,
// and this passes it to the tab in front, whose content script (content.js: web-pc.js's page
// pointer) moves a pointer over that page and works it.

const CONTROL = chrome.runtime.getURL("control.html");
let lastTab = null; // the tab the pointer was last in (its pointer is taken away when another one is in front)

// The toolbar button: the control page, opened (pinned, out of the way) or brought to the front.
chrome.action.onClicked.addListener(async () => {
  const [open] = await chrome.tabs.query({ url: CONTROL });
  if (open) {
    await chrome.tabs.update(open.id, { active: true });
    await chrome.windows.update(open.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: CONTROL, pinned: true });
  }
});

// Alt+Shift+M (chrome://extensions/shortcuts): the hand mouse on or off.
chrome.commands.onCommand.addListener((command) => {
  if (command === "toggle-hand-mouse") chrome.runtime.sendMessage({ to: "control", cmd: "toggle" }).catch(() => {});
});

// Pages no extension may work: Chrome's own (new tabs, settings), other extensions', the Web Store.
const restricted = (url) =>
  !/^(https?|file):/i.test(url || "") || /^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)/i.test(url);

async function toTab(msg) {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) return { error: "No tab is in front." };
  if ((tab.url || "").startsWith(CONTROL)) return { self: true }; // the control page: its own pointer
  if (lastTab !== null && lastTab !== tab.id) chrome.tabs.sendMessage(lastTab, { cmd: "stop" }, { frameId: 0 }).catch(() => {});
  lastTab = tab.id;
  try {
    return await chrome.tabs.sendMessage(tab.id, msg, { frameId: 0 });
  } catch {
    if (msg.cmd === "stop") return { ok: true };
    if (restricted(tab.url)) return { error: "Chrome doesn't let extensions work this page (its own pages, like a new tab or settings, and the Web Store).", restricted: true };
    // A tab opened before the extension was (or reloaded since): its pointer put in now.
    try {
      await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ["content.css"] });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["web-pc.js", "content.js"] });
      return await chrome.tabs.sendMessage(tab.id, msg, { frameId: 0 });
    } catch (err) {
      return { error: `This page can't be worked (${(err && err.message) || err}).` };
    }
  }
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!msg || msg.to !== "tab") return false;
  toTab(msg).then(reply, (err) => reply({ error: String((err && err.message) || err) }));
  return true; // (answered later)
});
