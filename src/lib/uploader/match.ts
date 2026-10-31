/**
 * Автосопоставление «сайт ↔ профиль Dolphin» (2026-10-24). Правило для сотрудников: профиль в Dolphin называется
 * доменом сайта («bellaromakitchen.com») — либо домен вписан в тег или заметку профиля. Портал ищет домен сайта
 * в имени, тегах и заметке профиля и предлагает пару; одна пара принимается кнопкой, все однозначные — одной кнопкой.
 *
 * Проверка при каждом визите остаётся: агент читает логин Pinterest в профиле и сверяет с запомненным
 * (`UplAccount.pinUsername`), так что ошибочно привязанный профиль не зальёт чужой файл молча.
 */

export type MatchSite = { id: string; name: string };
export type MatchProfile = { id: string; name: string; tags?: unknown };
export type MatchAccount = { pinSiteId: string; profileId: string | null };

/** Домен сайта из его названия в портале: «https://povixi.com/» → «povixi.com», «www.» убирается. */
export function siteDomain(name: string): string {
  return name.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/[/?#].*$/, "");
}

/** Текст профиля для поиска: имя, теги и заметка (агент присылает заметку тегом «note:…»). */
export function profileText(p: MatchProfile): string {
  const tags = Array.isArray(p.tags) ? p.tags.map((t) => (typeof t === "string" ? t : typeof t === "object" && t ? String((t as { name?: unknown }).name ?? "") : "")) : [];
  return [p.name, ...tags].join(" ").toLowerCase();
}

/**
 * Насколько профиль похож на сайт: 2 — полный домен («povixi.com»), 1 — имя без зоны отдельным словом
 * («povixi», не короче 5 букв), 0 — не похож.
 */
export function matchScore(site: MatchSite, p: MatchProfile): number {
  const domain = siteDomain(site.name);
  if (!domain) return 0;
  const text = profileText(p);
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (new RegExp(`(^|[^a-z0-9-])${esc(domain)}($|[^a-z0-9-])`).test(text)) return 2;
  const label = domain.split(".")[0];
  if (label.length >= 5 && new RegExp(`(^|[^a-z0-9])${esc(label)}($|[^a-z0-9])`).test(text)) return 1;
  return 0;
}

export type Suggestion = { pinSiteId: string; profileId: string; profileName: string; score: number; sure: boolean };

/**
 * Предложения для сайтов без профиля. `sure` — пара однозначная: у сайта ровно один лучший профиль, и этот профиль
 * лучше всего подходит только этому сайту (иначе выбирает человек). Уже занятые профили не предлагаются.
 */
export function suggestProfiles(sites: MatchSite[], profiles: MatchProfile[], accounts: MatchAccount[]): Map<string, Suggestion[]> {
  const taken = new Set(accounts.map((a) => a.profileId).filter((x): x is string => !!x));
  const mapped = new Set(accounts.filter((a) => a.profileId).map((a) => a.pinSiteId));
  const free = profiles.filter((p) => !taken.has(p.id));
  const out = new Map<string, Suggestion[]>();
  const bestForProfile = new Map<string, { score: number; sites: string[] }>();
  for (const s of sites) {
    if (mapped.has(s.id)) continue;
    const list = free.map((p) => ({ p, score: matchScore(s, p) })).filter((x) => x.score > 0).sort((a, b) => b.score - a.score || a.p.name.localeCompare(b.p.name));
    if (!list.length) continue;
    out.set(s.id, list.slice(0, 5).map(({ p, score }) => ({ pinSiteId: s.id, profileId: p.id, profileName: p.name, score, sure: false })));
    for (const { p, score } of list) {
      const b = bestForProfile.get(p.id);
      if (!b || score > b.score) bestForProfile.set(p.id, { score, sites: [s.id] });
      else if (score === b.score) b.sites.push(s.id);
    }
  }
  for (const [siteId, list] of out) {
    const top = list[0];
    const tie = list.length > 1 && list[1].score === top.score;
    const owner = bestForProfile.get(top.profileId);
    top.sure = !tie && !!owner && owner.sites.length === 1 && owner.sites[0] === siteId;
    out.set(siteId, list);
  }
  return out;
}
