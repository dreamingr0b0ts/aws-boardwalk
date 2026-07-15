// Pre-paint theme election. Loaded as an external classic script (the CSP
// forbids inline scripts) before the app bundle, so a dark-preference visitor
// never sees a white flash. Stored choice wins; otherwise follow the OS.
(function () {
  try {
    var stored = localStorage.getItem('theme');
    var dark = stored ? stored === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
    if (dark) document.documentElement.classList.add('dark');
  } catch (e) {
    /* storage disabled — default to light */
  }
})();
