/**
 * Оценки входа 0–100: «новый блог» и «старый блог» (у которого новые пины ранжируются слабо) + красные флаги.
 * Формулы — из исследования docs/keyword-research/01-pinterest-algorithm.md, раздел 3 (пороги — стартовые эвристики,
 * калибруются по реальным позициям наших пинов). Чего нет в выдаче (здоровье домена, тематическое соответствие блога),
 * берётся нейтральным: Health = 1, topicFit = 0.5. Чистая функция — без базы.
 */
export type EntryInput = {
  /** доли первого экрана 0–1 */
  ad: number; prod: number; vid: number;
  /** доля органики со ссылкой на статью, 0–1 */
  link: number;
  /** доля пинов топ-10 моложе 30 дней / старше 2 лет, 0–1 */
  f30: number | null; old2y: number | null;
  /** доля органики моложе 90 дней, 0–1 */
  f90: number;
  /** медиана сохранений топ-10; свежих (≤ 90 дн) пинов топ-10 с сохранениями < 50 */
  savesMed: number | null; freshLowSave: number;
  /** доля «малых» авторов топ-10 (подписчиков < 5 тыс или просмотров < 100 тыс), 0–1 */
  small: number | null;
  /** наибольшая доля одного домена среди ссылок топ-10, 0–1 */
  topDom: number | null;
  /** доля пинов со ссылкой от владельца сайта, 0–1 */
  own: number | null;
  /** доля крупных СМИ/брендов среди ссылок топ-10, 0–1 */
  media: number | null;
  /** доля органики с ключом в заголовке, 0–1 */
  kwTitle: number | null;
  /** наш сайт (из раздела «Сайты» портала) есть в топе */
  ourSite: boolean;
  /** статьи блогов топа устарели (средний возраст, устаревшие годы) — отставание закрывается обновлением, 0–1 */
  artGap: number | null;
};

export type EntryResult = { entryNew: number | null; entryOld: number | null; redFlags: string[] };

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

export function entryScores(x: EntryInput): EntryResult {
  const gate = Math.sqrt(clamp01(1 - x.ad - x.prod)) * Math.min(x.link / 0.5, 1);
  const small = x.small ?? 0.5;
  const topDomN = x.topDom == null ? 0.5 : clamp01((x.topDom - 0.1) / 0.3);
  const own = x.own ?? 0;
  const media = x.media ?? 0;
  let lowSave = x.savesMed == null ? 0.5 : clamp01(1 - Math.log10(x.savesMed + 1) / Math.log10(2000));
  if (x.freshLowSave >= 2) lowSave = Math.min(1, lowSave + 0.1);
  const kwGap = x.link >= 0.5 && x.kwTitle != null ? 1 - x.kwTitle : 0;
  const f30 = x.f30 ?? 0;

  // (a) новый блог: выдача ротируется — свежие пины, мелкие авторы, разные домены, мало сохранений.
  const nw = 0.22 * Math.min(f30 / 0.3, 1) + 0.13 * x.f90 + 0.18 * small + 0.12 * (1 - topDomN) + 0.1 * own
    + 0.1 * lowSave + 0.08 * (1 - media) + 0.07 * kwGap;
  // (b) старый блог: evergreen-выдача, где держатся старые пины и уже есть наш домен; обновить статью и поставить новые картинки.
  const ownPresence = x.ourSite ? 1 : 0;
  const old2y = x.old2y ?? 0;
  const od = 0.25 * ownPresence + 0.15 * Math.min(old2y / 0.5, 1) + 0.15 * own + 0.12 * (1 - media)
    + 0.1 * 0.5 + 0.08 * (x.artGap ?? 0.5) + 0.08 * (1 - x.vid) + 0.07 * small;

  // (c) красные флаги: не выиграет ни новый, ни старый блог.
  const redFlags: string[] = [];
  if (x.link < 0.3) redFlags.push("no_links");
  if (x.topDom != null && x.topDom >= 0.4 && f30 === 0) redFlags.push("captured");
  if (old2y >= 0.7 && (x.savesMed ?? 0) >= 1000 && x.f90 < 0.1) redFlags.push("frozen");
  if (x.ourSite) redFlags.push("our_site");
  return { entryNew: Math.round(100 * nw * gate), entryOld: Math.round(100 * od * gate), redFlags };
}
