/**
 * План фото-пинов страницы: первые `perPage` фото публикуются как пины (engine PHOTO),
 * остальные остаются в резерве (pool) для Canvas. Доля пинов со ссылкой на статью = linkPercent.
 * Детерминировано по seed.
 */
import { mulberry32, shuffleWith } from "@/lib/pins/plan/seed";

export interface PhotoPlanInput {
  /** Фото статьи в порядке появления (дубли убираются). */
  images: string[];
  /** Сколько фото публиковать (mix.photos); 0 = ничего не публиковать, всё в резерв. */
  perPage: number;
  /** Доля публикуемых фото со ссылкой на статью, 0–100 (publishing.photoLinkPercent). */
  linkPercent: number;
  seed: number;
}

export interface PhotoPlanRow {
  url: string;
  /** true — пин; false — резерв для Canvas. */
  publish: boolean;
  /** Только для publish = true: ставить ли ссылку на статью. */
  withLink: boolean;
}

/** Раскладывает фото страницы на публикуемые (с долей ссылок) и резерв; порядок входа сохраняется. */
export function planPhotos(input: PhotoPlanInput): PhotoPlanRow[] {
  const images = [...new Set(input.images.map((u) => u.trim()).filter(Boolean))];
  if (!images.length) return [];
  const rng = mulberry32(input.seed);
  const perPage = Math.max(0, Math.floor(Number(input.perPage) || 0));
  const take = Math.min(perPage, images.length);
  const chosen = new Set(shuffleWith(images, rng).slice(0, take));

  const pct = Math.min(100, Math.max(0, Number(input.linkPercent) || 0));
  const linkCount = Math.round(take * (pct / 100));
  const flags = shuffleWith(Array.from({ length: take }, (_, i) => i < linkCount), rng);

  let fi = 0;
  return images.map((url) => {
    const publish = chosen.has(url);
    const withLink = publish ? flags[fi++] === true : false;
    return { url, publish, withLink };
  });
}
