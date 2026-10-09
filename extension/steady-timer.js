// steady-timer.js — hand-tracker.js's steadyTimer worker (a worker's timers aren't slowed down
// while the page is hidden), as a file for the Chrome extension.
onmessage = (e) => setTimeout(() => postMessage(e.data.id), e.data.ms);
