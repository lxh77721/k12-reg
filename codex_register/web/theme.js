(function () {
  const root = document.documentElement;
  const saved = localStorage.getItem("theme") || "dark";
  root.dataset.theme = saved;

  function label(theme) {
    return theme === "light" ? "夜间" : "白天";
  }

  function sync() {
    const theme = root.dataset.theme || "dark";
    document.querySelectorAll("[data-theme-toggle]").forEach((button) => {
      button.textContent = label(theme);
      button.setAttribute("aria-label", `切换到${label(theme)}模式`);
    });
  }

  window.toggleTheme = function () {
    const next = (root.dataset.theme || "dark") === "dark" ? "light" : "dark";
    root.dataset.theme = next;
    localStorage.setItem("theme", next);
    sync();
  };

  document.addEventListener("click", (event) => {
    const target = event.target.closest("[data-theme-toggle]");
    if (!target) return;
    window.toggleTheme();
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", sync);
  } else {
    sync();
  }
})();
