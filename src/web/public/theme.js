// ── Theme Toggle (Dark / Light) ──────────────
(function() {
  function getPreferredTheme() {
    var saved = localStorage.getItem('pocket-cc-theme')
    if (saved) return saved
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
  }

  function setTheme(theme) {
    document.documentElement.dataset.theme = theme
    localStorage.setItem('pocket-cc-theme', theme)
    updateThemeToggle()
  }

  function toggleTheme() {
    var current = document.documentElement.dataset.theme || 'dark'
    setTheme(current === 'dark' ? 'light' : 'dark')
  }

  function updateThemeToggle() {
    var btn = document.getElementById('themeToggle')
    if (!btn) return
    var isDark = (document.documentElement.dataset.theme || 'dark') === 'dark'
    // Sun icon (go to light) / Moon icon (go to dark)
    btn.innerHTML = isDark
      ? '<svg class="ic" viewBox="0 0 24 24" style="font-size:14px"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>'
      : '<svg class="ic" viewBox="0 0 24 24" style="font-size:14px"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>'
  }

  // Listen for OS theme changes
  window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', function(e) {
    if (!localStorage.getItem('pocket-cc-theme')) {
      setTheme(e.matches ? 'light' : 'dark')
    }
  })

  // Initialize immediately
  setTheme(getPreferredTheme())

  // Expose globally
  window.toggleTheme = toggleTheme
  window.updateThemeToggle = updateThemeToggle
})()
