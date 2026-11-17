/**
 * Языки мешап-статей на других языках (docs/copy/LOCALES-PLAN.md). Пока константы; при переходе на таблицу
 * LocLanguage значения переедут туда. Пороги объёма — предложение 17.11.2026, владелец может поменять.
 */
export type LocaleLang = {
  code: string;
  /** Язык для промптов */
  language: string;
  /** Страна аудитории */
  country: string;
  /** База Semrush (v3) */
  semrushDb: string;
  /** location_code DataForSEO (запасной источник) */
  dfsLocation: number;
  /** Минимальный месячный объём ключа, чтобы ядро получило статьи */
  minVolume: number;
};

export const LOCALE_LANGS: Record<string, LocaleLang> = {
  cs: { code: "cs", language: "Czech", country: "Czech Republic", semrushDb: "cz", dfsLocation: 2203, minVolume: 300 },
  de: { code: "de", language: "German", country: "Germany", semrushDb: "de", dfsLocation: 2276, minVolume: 1000 },
  pl: { code: "pl", language: "Polish", country: "Poland", semrushDb: "pl", dfsLocation: 2616, minVolume: 500 },
  ro: { code: "ro", language: "Romanian", country: "Romania", semrushDb: "ro", dfsLocation: 2642, minVolume: 300 },
  es: { code: "es", language: "Spanish", country: "Spain", semrushDb: "es", dfsLocation: 2724, minVolume: 1000 },
};
