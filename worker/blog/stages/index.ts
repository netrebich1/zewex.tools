/**
 * Контракт этапа инфо-статьи (как у статей: worker/articles/stages/index.ts). Этап делает только недостающую работу
 * (идемпотентен), регулярно зовёт ctx.tick() — это продлевает lease и бросает StopRequested при «Стоп».
 * Этап НЕ меняет BlogPost.status/stage сам — это делает раннер по результату.
 */
import type { BlogPost, BlogSite, BlogStatus, SiteAccess } from "@prisma/client";
import type { BlogBrief, BlogCursor, BlogOutline, BlogRecipeSnapshot } from "@/lib/blog/types";
import type { AiCtx } from "@/lib/blog/ai";
import type { StageKey } from "@/lib/blog/stages";
import type { WpCreds } from "@/lib/pins/wp/client";
import type { RetryKind } from "@/lib/articles/errors";

export type StageCtx = {
  post: BlogPost;
  site: BlogSite;
  access: SiteAccess | null;
  creds: () => WpCreds;
  recipe: BlogRecipeSnapshot;
  cursor: BlogCursor;
  brief: BlogBrief | null;
  outline: BlogOutline | null;
  ai: AiCtx;
  signal: AbortSignal;
  tick: (label?: string) => Promise<void>;
  log: (msg: string, extra?: unknown) => void;
  /** Сохранить изменённые cursor/brief/outline (частично). */
  save: (patch: { cursor?: BlogCursor; brief?: BlogBrief | null; outline?: BlogOutline | null; note?: string | null }) => Promise<void>;
  retries: Record<RetryKind, number>;
};

export type StageResult = {
  summary?: string;
  details?: unknown;
  /** Куда дальше: явный этап, ожидание человека или по умолчанию следующий по реестру */
  next?: StageKey | { wait: BlogStatus; note?: string };
  fatal?: string;
  retryInMs?: number;
  retryKind?: RetryKind;
  giveUp?: string;
};

export type StageHandler = (ctx: StageCtx) => Promise<StageResult>;

export class StopRequested extends Error {
  constructor() {
    super("stop requested");
    this.name = "StopRequested";
  }
}

import { research } from "./research";
import { outline } from "./outline";
import { photoSearch } from "./photoSearch";
import { photoFilter } from "./photoFilter";
import { photoRate } from "./photoRate";
import { photoSelect } from "./photoSelect";
import { write } from "./write";
import { aiImagesStage } from "./aiImages";
import { wrap } from "./wrap";
import { meta } from "./meta";
import { pinImages } from "./pinImages";
import { assemble } from "./assemble";
import { publish } from "./publish";

export const STAGES: Partial<Record<StageKey, StageHandler>> = {
  research,
  outline,
  photo_search: photoSearch,
  photo_filter: photoFilter,
  photo_rate: photoRate,
  photo_select: photoSelect,
  write,
  ai_images: aiImagesStage,
  wrap,
  meta,
  pin_images: pinImages,
  assemble,
  publish,
};
