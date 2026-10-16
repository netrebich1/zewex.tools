/**
 * Анализ доменов Google TOP-10: какие домены относятся к бренду, какие у конкурентов зоны и приставки.
 * Приставки извлекаются из метки домена после вырезания бренда: по дефисам, а склеенные слова — по словарю.
 */
import type { MinedSuffix } from "./types";

const COMMON_PARTS = [
  "casino", "casinos", "casinoonline", "onlinecasino", "gokken", "gokkasten", "bet", "bets", "betting", "play", "player",
  "games", "game", "gaming", "slots", "slot", "app", "apps", "online", "live", "official", "review", "reviews", "bonus",
  "bonuses", "spin", "spins", "win", "club", "site", "net", "top", "best", "nederland", "netherlands", "netherland",
  "deutschland", "espana", "italia", "france", "polska", "365", "24", "777", "1", "2", "3", "x",
];

function splitGlued(rest: string): string[] {
  const parts: string[] = [];
  let buf = rest;
  let guard = 0;
  while (buf.length > 0 && guard++ < 12) {
    const match = COMMON_PARTS.filter((p) => buf.startsWith(p)).sort((a, b) => b.length - a.length)[0];
    if (match) {
      parts.push(match);
      buf = buf.slice(match.length);
      continue;
    }
    const tail = COMMON_PARTS.filter((p) => buf.endsWith(p)).sort((a, b) => b.length - a.length)[0];
    if (tail) {
      parts.push(tail);
      buf = buf.slice(0, -tail.length);
      continue;
    }
    break;
  }
  if (buf.length > 1 && buf.length <= 14) parts.push(buf);
  return parts;
}

const words = (b: string) => b.toLowerCase().replace(/[^a-z0-9\s-]/g, "").split(/[\s-]+/).filter(Boolean);

/** Формы бренда для поиска в метке: слитно, через дефис и само слово для однословных (от 3 символов). */
export function brandForms(brands: string[]): string[] {
  return Array.from(
    new Set(
      brands.flatMap((b) => {
        const w = words(b);
        if (w.length === 0) return [];
        return [w.join(""), w.join("-"), ...(w.length > 1 ? [] : w)];
      }),
    ),
  ).filter((v) => v.length >= 3);
}

/** Домен идёт в анализ, только если в его метке есть бренд (слитно или через дефис). trustpilot, x.com — отбрасываются. */
export function domainHasBrand(domain: string, brands: string[]): boolean {
  const parts = domain.toLowerCase().split(".").slice(0, -1);
  const label = parts.join("-").replace(/[^a-z0-9-]/g, "");
  if (!label) return false;
  const flat = label.replace(/-/g, "");
  return brandForms(brands).some((f) => label.includes(f) || flat.includes(f.replace(/-/g, "")));
}

/** Приставки конкурентов: count — в скольких доменах встретилась, до 3 примеров. Сортировка: count ↓, затем алфавит. */
export function mineSuffixes(domains: string[], brands: string[]): MinedSuffix[] {
  const forms = brands
    .flatMap((b) => {
      const w = words(b);
      if (w.length === 0) return [];
      return [w.join(""), w.join("-"), ...w];
    })
    .filter((v) => v.length >= 3)
    .sort((a, b) => b.length - a.length);

  const counts = new Map<string, MinedSuffix>();
  for (const domain of domains) {
    const label = domain.toLowerCase().split(".")[0] ?? "";
    if (!label) continue;
    let rest = label;
    for (const form of forms) rest = rest.split(form).join("-");
    const chunks = rest.split("-").map((c) => c.replace(/[^a-z0-9]/g, "")).filter(Boolean);
    const tokens = new Set<string>();
    for (const chunk of chunks) {
      if (COMMON_PARTS.includes(chunk) || chunk.length <= 12) tokens.add(chunk);
      for (const p of splitGlued(chunk)) tokens.add(p);
    }
    for (const token of tokens) {
      if (!token || token.length > 18) continue;
      const entry = counts.get(token) ?? { suffix: token, count: 0, examples: [] };
      entry.count += 1;
      if (entry.examples.length < 3 && !entry.examples.includes(domain)) entry.examples.push(domain);
      counts.set(token, entry);
    }
  }
  return Array.from(counts.values()).sort((a, b) => b.count - a.count || a.suffix.localeCompare(b.suffix));
}

/* ---------- Аналитика зон и приставок для интерфейса ---------- */

const norm = (v: string) => v.toLowerCase().replace(/[^a-z0-9]/g, "");

export function brandVariants(brand: string): string[] {
  const w = words(brand);
  if (w.length === 0) return [];
  return Array.from(new Set([w.join(""), w.join("-"), ...(w.length > 1 ? [] : w)])).filter((v) => v.length >= 3);
}

/** Домены выдачи, относящиеся к конкретному бренду. */
export function domainsOfBrand(domains: string[], brand: string): string[] {
  const key = norm(brand);
  if (!key) return [];
  return domains.filter((d) => norm(d).includes(key));
}

/** Зона домена: всё после первой точки (co.uk, com). */
export function tldOf(domain: string): string {
  const i = domain.indexOf(".");
  return i === -1 ? "—" : domain.slice(i + 1).toLowerCase();
}

/** Приставки домена: остаток метки после вырезания бренда, разбитый по дефисам. */
export function suffixesOf(domain: string, brands: string[]): string[] {
  const label = (domain.toLowerCase().split(".")[0] ?? "").replace(/[^a-z0-9-]/g, "");
  if (!label) return [];
  let rest = label;
  const forms = brands.flatMap(brandVariants).sort((a, b) => b.length - a.length);
  for (const form of forms) rest = rest.split(form).join("-");
  return Array.from(new Set(rest.split("-").map((c) => c.trim()).filter((c) => c.length >= 1)));
}

export type CountRow = { value: string; count: number };

export function countValues(items: string[][]): CountRow[] {
  const map = new Map<string, number>();
  for (const list of items) for (const v of list) map.set(v, (map.get(v) ?? 0) + 1);
  return Array.from(map.entries())
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}
