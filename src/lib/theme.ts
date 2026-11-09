/** Темы интерфейса. Значение хранится в cookie, чтобы сервер сразу отдавал нужный data-theme без мигания. */
export const THEMES = ["dark", "light", "neutral"] as const;
export type Theme = (typeof THEMES)[number];
export const THEME_COOKIE = "zx_theme";
export const THEME_LABELS: Record<Theme, string> = { dark: "Тёмная", light: "Светлая", neutral: "Нейтральная" };

export function isTheme(v: unknown): v is Theme {
  return typeof v === "string" && (THEMES as readonly string[]).includes(v);
}

/** Без cookie: тёмная, если система тёмная, иначе светлая. Выполняется до первой отрисовки. */
export const THEME_BOOT_SCRIPT = `(function(){try{var d=document.documentElement;if(d.getAttribute("data-theme"))return;var m=document.cookie.match(/(?:^|; )${THEME_COOKIE}=(dark|light|neutral)/);d.setAttribute("data-theme",m?m[1]:(window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"));}catch(e){}})();`;
