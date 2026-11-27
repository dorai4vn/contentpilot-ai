"use client";

import { useEffect, useSyncExternalStore } from "react";

type Theme = "light" | "dark" | "system";
const storageKey = "football-news-theme";

function savedTheme(): Theme {
  try {
    const value = localStorage.getItem(storageKey);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

function applyTheme(theme: Theme) {
  document.documentElement.classList.toggle("dark", theme === "dark" ||
    (theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches));
}

function subscribe(listener: () => void) {
  window.addEventListener("storage", listener);
  window.addEventListener("football-theme-change", listener);
  return () => {
    window.removeEventListener("storage", listener);
    window.removeEventListener("football-theme-change", listener);
  };
}

function initialTheme(): Theme { return "system"; }

export function ThemeControl() {
  const theme = useSyncExternalStore(subscribe, savedTheme, initialTheme);

  useEffect(() => {
    applyTheme(theme);
    const query = matchMedia("(prefers-color-scheme: dark)");
    const sync = () => applyTheme(theme);
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, [theme]);

  return (
    <select aria-label="Giao diện" value={theme} onChange={(event) => {
      const next = event.target.value as Theme;
      try { localStorage.setItem(storageKey, next); } catch { /* Browsing can disable storage. */ }
      window.dispatchEvent(new Event("football-theme-change"));
      applyTheme(next);
    }} className="theme-control" data-testid="theme-control">
      <option value="light">Sáng</option>
      <option value="dark">Tối</option>
      <option value="system">Hệ thống</option>
    </select>
  );
}
