(function () {
  // Gurukul Olympics 2026 brand theme: warm ivory + white surfaces.
  var theme = 'light';
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem('mosaic-theme', theme);
  } catch (error) {
    // Storage may be unavailable; the brand theme still applies.
  }
  var meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', '#FAF9F5');
})();
