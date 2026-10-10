/**
 * Контракт этапа статьи. Этап делает только недостающую работу (идемпотентен: при повторе проверяет,
 * что уже есть в базе), регулярно зовёт ctx.tick() — это продлевает lease и бросает StopRequested при «Стоп».
 * Этап НЕ меняет Article.status/stage сам — это делает раннер по результату.
 */
import type { Article, ArtSite, ArtStatus, SiteAccess } from "@prisma/client";
import type { ArticleCursor, ArticleFacts, ArticlePlan, ArticleRecipeSnapshot } from "@/lib/articles/types";
import type { AiCtx } from "@/lib/articles/ai";
import type { StageKey } from "@/lib/articles/stages";
import type { WpCreds } from "@/lib/pins/wp/client";

export type ArtStageCtx = {
  /** Свежая строка статьи на момент старта этапа */
  article: Article;
  site: ArtSite;
  /** Доступ WordPress сайта (без расшифровки пароля); creds() расшифрует при необходимости */
  access: SiteAccess | null;
  creds: () => WpCreds;
  recipe: ArticleRecipeSnapshot;
  cursor: ArticleCursor;
  facts: ArticleFacts;
  plan: ArticlePlan | null;
  ai: AiCtx;
  signal: AbortSignal;
  /** Продлить lease и записать прогресс в журнал этапа; бросает StopRequested при «Стоп». */
  tick: (label?: string) => Promise<void>;
  log: (msg: string, extra?: unknown) => void;
  /** Сохранить изменённый cursor/facts/plan (частично) — вызывать после значимых шагов внутри этапа. */
  save: (patch: { cursor?: ArticleCursor; facts?: ArticleFacts; plan?: ArticlePlan | null; note?: string | null }) => Promise<void>;
};

export type ArtStageResult = {
  /** Короткая сводка для журнала этапа */
  summary?: string;
  /** Подробности для карточки статьи (JSON) */
  details?: unknown;
  /**
   * Куда дальше. По умолчанию — следующий этап реестра. Можно вернуть явный этап (откат назад при доборе фото)
   * или состояние ожидания человека (PHOTO_REVIEW, WAITING_FOR_PHOTOS, REVIEW_PENDING …).
   */
  next?: StageKey | { wait: ArtStatus; note?: string };
  /** Фатальная причина: статья → FAILED с этим текстом */
  fatal?: string;
  /** Повторить этот же этап позже (мс): временная проблема (лимиты, сеть, занятые слоты) */
  retryInMs?: number;
};

export type ArtStageHandler = (ctx: ArtStageCtx) => Promise<ArtStageResult>;

export class StopRequested extends Error {
  constructor() {
    super("stop requested");
    this.name = "StopRequested";
  }
}

/**
 * Реестр обработчиков. Этапы без обработчика блокируют статью с понятным сообщением
 * (как у Пинов до реализации). Переносимые этапы регистрируются здесь по мере готовности.
 */
import { search } from "./search";
import { filter } from "./filter";
import { rank } from "./rank";
import { rate } from "./rate";
import { select } from "./select";
import { plan } from "./plan";
import { sectionPlan } from "./sectionPlan";
import { blueprint } from "./blueprint";
import { introOutro } from "./introOutro";
import { sections } from "./sections";
import { meta } from "./meta";
import { assemble } from "./assemble";
import { publish } from "./publish";

export const STAGES: Partial<Record<StageKey, ArtStageHandler>> = {
  search,
  filter,
  rank,
  rate,
  select,
  plan,
  section_plan: sectionPlan,
  blueprint,
  intro_outro: introOutro,
  sections,
  meta,
  assemble,
  publish,
};
