// content.js — the Chrome extension's pointer over this page: web-pc.js's page pointer (the
// website's hand mouse), worked by the control page through background.js.
(() => {
  // Put in twice (by Chrome, then again by background.js for a tab that was open before), it
  // runs once; an earlier copy whose extension was updated or reloaded is replaced.
  const alive = () => {
    try {
      return !!chrome.runtime.id;
    } catch {
      return false;
    }
  };
  if (window.__handTrackerAlive && window.__handTrackerAlive()) return;
  window.__handTrackerAlive = alive;
  for (const old of document.querySelectorAll("#handPointer")) old.remove();

  const pointer = WebPc._pagePointer();
  chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    const run = {
      pointer: () => pointer.pointer(msg.nx, msg.ny),
      button: () => pointer.button(msg.which, msg.action),
      wheel: () => pointer.wheel(msg.notches),
      key: () => pointer.key(msg.combo, msg.action),
      text: () => pointer.text(msg.text),
      stop: () => pointer.stop(),
    }[msg && msg.cmd];
    if (!run) return false;
    Promise.resolve()
      .then(run)
      .then(
        (result) => reply({ ok: true, result: result === undefined ? null : result }),
        (err) => reply({ error: String((err && err.message) || err) })
      );
    return true;
  });
})();
