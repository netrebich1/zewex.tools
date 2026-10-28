/**
 * Модуль «Новости» (Google Discover / Google News): настройки проекта, константы, типы воронки.
 * ТЗ: https://claude.ai/artifact/EE1mbM8S4gJtRcKetNfjud · заметки: docs/news/README.md
 */

export const BASE_PATH = "/discovery/news";
export const PROJECT_SLUG = "news";
/** Слоты проекта `news`: классификация пачками (CHAT) и эмбеддинги заголовков (EMBEDDING). */
export const SLOT_CLASSIFY = "text_main";
export const SLOT_EMBED = "embed";
/** Слот углов и ТЗ (CHAT): по кнопке «В работу» и «Сделать ТЗ». */
export const SLOT_BRIEF = "brief";
export const DEFAULT_EMBED_MODEL = "baai/bge-m3";
export const DEFAULT_CLASSIFY_MODEL = "deepseek/deepseek-v4-flash";
export const DEFAULT_BRIEF_MODEL = "google/gemini-2.5-flash";

export const PRIORITY_LABELS: Record<string, string> = { must: "Обязательно", should: "Стоит взять", maybe: "По желанию" };

/** Стиль редакции по умолчанию (beautydaily): подставляется в углы и ТЗ, правится в настройках проекта. */
export const DEFAULT_HOUSE_STYLE = `Мова — українська, жива й природна, без кальок з російської та англійської.
Тон — «подруга-експертка»: тепло, по-домашньому, з легкою іронією, але без пліток заради пліток і без зверхності. Звертаємося до читачки на «ви».
Ми невелике домашнє медіа про зірок, моду й красу для Google Discover: пишемо легко й коротко — момент, 3–5 фактів і одна наша думка (що повторити, що купити, чому про це говорять). Не довідник і не гайд під пошуковий запит.
Перший абзац — суть новини у 2 реченнях (хто, що, де, коли + деталь), далі 3–5 коротких блоків. Обсяг: фотоновина 250–400 слів, новина 300–450, розбір чи підбірка до 600.
Короткі абзаци по 2–4 речення, підзаголовки H2 — змістовні, без H3 і без списків «для кожного типу обличчя». Цифри, назви брендів, ціни — точно й лише з джерел.
Без: «шок», «сенсація», «ви не повірите», оцінок зовнішності й тіла, медичних обіцянок, непідтверджених чуток (лише з позначкою, що це чутки, і з посиланням на джерело).
Посилаємося на першоджерело (офіційний Instagram, пресреліз, інтерв'ю) і на 2–3 наші матеріали за темою.
Для іноземних новин — не перекладаємо статтю, а пояснюємо українській читачці, чому це цікаво саме їй, і додаємо український контекст (ціни в гривнях, де купити в Україні, схожі українські бренди чи зірки).`;

export const CATEGORIES = ["celebrity", "fashion", "beauty", "brands", "selfcare", "events", "relationships", "other"] as const;
export type Category = (typeof CATEGORIES)[number];
export const CATEGORY_LABELS: Record<string, string> = {
  celebrity: "Звёзды",
  fashion: "Мода",
  beauty: "Бьюти",
  brands: "Бренды и новинки",
  selfcare: "Уход за собой",
  events: "События",
  relationships: "Отношения",
  other: "Не наша тема",
};

export const SOURCE_KINDS = ["rss", "sitemap", "gnews_query", "gnews_topic", "trends"] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];
export const SOURCE_KIND_LABELS: Record<string, string> = {
  rss: "RSS / Atom",
  sitemap: "News-sitemap",
  gnews_query: "Запрос Google News",
  gnews_topic: "Раздел Google News",
  trends: "Google Trends",
};
export const TIERS = ["primary", "competitor", "world"] as const;
export const TIER_LABELS: Record<string, string> = { primary: "Первоисточник", competitor: "Украинские медиа", world: "Мировые медиа" };

export const RUN_SCOPES: { value: string; label: string }[] = [
  { value: "all", label: "Все источники" },
  { value: "sites", label: "Только сайты (RSS и sitemap)" },
  { value: "gnews", label: "Только Google News" },
  { value: "world", label: "Только мировые медиа" },
  { value: "trends", label: "Только Google Trends" },
];

export type NewsSettings = {
  /** Плановый прогон раз в N минут. */
  intervalMin: number;
  /** Материалы старше N часов не берутся. */
  maxAgeHours: number;
  /** Лента: топ-N кластеров за сутки. */
  topN: number;
  /** От этого балла — «Срочно» и алерт в Telegram. */
  urgentScore: number;
  /** Ниже этого балла кластер не показывается даже в топе. */
  minScore: number;
  /** Склейка в кластер: косинусная близость к центроиду; с совпадением главной сущности — пониженный порог. */
  clusterSim: number;
  clusterSimEntity: number;
  /** Кластер принимает материалы, пока моложе N часов. */
  clusterWindowHours: number;
  /** Фильтр по эмбеддингу: отсекать, если «не наше» ближе «нашего» больше чем на margin. Включается сам, когда хватает примеров. */
  embedFilter: boolean;
  embedMargin: number;
  /** Лимиты расхода. */
  classifyPerDay: number;
  monthlyBudgetUsd: number;
  /** Модели (OpenRouter): пусто — модель правила слота. */
  classifyModel: string;
  embedModel: string;
  /** Целевые категории (остальное в ленту не идёт). */
  targetCategories: string[];
  /** Стоп-слова: основы слов (без окончаний); материал с ними отсекается сразу. */
  stopWords: string[];
  /** Исключения стоп-слов: слова, которые начинаются со стоп-основы, но к ней не относятся (судячи, ракетка). */
  stopExceptions: string[];
  /** Стоп-рубрики источников: подстроки названий рубрик (без регистра). */
  stopRubrics: string[];
  /** Нишевые основы: без сущности материал проходит, только если есть одна из них (или источник профильный). */
  nicheWords: string[];
  /** Запросы Google News по нише (каждый прогон). */
  gnewsQueries: string[];
  /** Сущностей в одном запросе Google News через OR и сколько запросов-групп за прогон (первый ряд — всегда). */
  gnewsEntitiesPerQuery: number;
  gnewsGroupsPerRun: number;
  /** Вес сущности, с которого она «первого ряда» (опрашивается каждый прогон). */
  topEntityWeight: number;
  /** Гео и язык Google News / Trends. */
  hl: string;
  gl: string;
  ceid: string;
  /** Автопереход на прокси при ответах 403/429. */
  autoProxy: boolean;
  /** Алерт в Telegram о срочных кластерах. */
  telegramAlerts: boolean;
  /** Стиль редакции для углов и ТЗ. */
  houseStyle: string;
  /** Кто мы и наша аудитория — одной-двумя фразами (для «почему зайдёт у нас»). */
  siteAbout: string;
  /** Модель углов и ТЗ (слот brief); пусто — модель правила. */
  briefModel: string;
  /** Украинская суть и «почему зайдёт» в прогоне — для топа ленты, не больше N кластеров в сутки. */
  autoSummaryPerDay: number;
};

export const DEFAULT_STOP_WORDS = [
  // война и армия
  "війн", "войн", "обстріл", "обстрел", "ракет", "зсу", "всу", "фронт", "окупант", "оккупант", "мобіліз", "мобилиз", "тцк", "ппо", "дрон", "шахед", "вибух", "взрыв",
  "атак", "бойов", "боев", "загарбник", "полонен", "пленн", "генштаб", "сирен", "тривог", "бомб", "снаряд", "фронтов", "демобіліз", "демобилиз", "ветеран", "військов", "военн",
  // политика и власть
  "верховн", "міністр", "министр", "депутат", "вибори", "виборів", "виборч", "выборы", "выборов", "избират", "президент", "зеленськ", "зеленск", "путін", "путин", "трамп", "кремл", "уряд", "правительств",
  "санкці", "санкци", "переговор", "посол", "оон", "нато", "партія", "партия", "мерія", "мэрия", "губернатор", "євросоюз", "евросоюз", "лукашенк",
  // криминал и происшествия
  "суд", "поліці", "полици", "дтп", "загинул", "загибл", "погиб", "вбивств", "убийств", "затриман", "задержан", "арешт", "арест", "шахрай", "мошенн", "прокурор", "сбу",
  "пожеж", "пожары", "пожара", "аварі", "авари", "катастроф", "злочин", "преступ", "кримінал", "криминал",
  // экономика и быт
  "курс долар", "курс доллар", "нбу", "інфляці", "инфляци", "тариф", "пенсі", "пенси", "субсиді", "субсиди", "податк", "налог", "енергосистем", "енергетик", "энергосистем", "энергетик", "відключен", "отключен",
  "прогноз погоди", "прогноз погоды", "синоптик", "гороскоп", "астролог", "магнітн", "магнитн", "сад", "город", "врожа", "урожа", "рецепт",
  // спорт
  "футбол", "матч", "чемпіонат", "чемпионат", "збірн", "сборн", "олімпі", "олимпи", "бокс", "ломаченк", "усик",
];

export const DEFAULT_STOP_EXCEPTIONS = [
  "судячи", "судя", "ракетк", "радість", "радост", "радіо", "радио", "мерил", "мерседес", "мереж", "мерч", "мерехт", "ованес", "садовськ", "садовск", "садж", "городецьк",
  "енергійн", "энергичн", "світлан", "светлан", "світлин", "світлий", "светлый", "світло-", "погодил", "погодж", "свет-", "президентк", "загибел", "збірк", "сборк", "сборник", "светск", "світськ", "судин", "судн", "садиб", "городськ",
  "натовп", "натомість", "бомбезн", "бомбічн", "фронтмен", "фронтвумен", "судді", "суддів", "суддями", "суддівськ",
  // Фразы целиком: вырезаются из текста до поиска стоп-слов
  "зоряні війни", "звездные войны", "star wars", "битва екстрасенсів", "битва экстрасенсов",
];

export const DEFAULT_STOP_RUBRICS = [
  "політ", "полит", "війн", "войн", "war", "економ", "эконом", "фінанс", "финанс", "спорт", "авто", "світ", "мир", "world", "кримінал", "криминал", "crime", "надзвичайн",
  "происшеств", "суспільств", "обществ", "регіон", "регион", "київ", "киев", "україн", "украин", "енергетик", "энергетик", "погод", "гороскоп", "астролог", "сад", "кулінар",
  "кулинар", "рецепт", "технолог", "tech", "наука", "school", "школ", "здоров", "зброя", "оружие", "росі", "росси",
];

export const DEFAULT_NICHE_WORDS = [
  "мод", "стил", "образ", "сукн", "плать", "сукенк", "макіяж", "макияж", "зачіск", "прическ", "стрижк", "манікюр", "маникюр", "педикюр", "колекці", "коллекци", "бренд", "косметик",
  "парфум", "парфюм", "аромат", "показ", "подіум", "подиум", "дизайнер", "зірк", "звезд", "співачк", "певиц", "акторк", "актрис", "весілл", "свадьб", "вагітн", "беремен",
  "заручин", "помолвк", "розлуч", "развод", "блогерк", "блогер", "ведуч", "модел", "красн доріжк", "красной дорожк", "red carpet", "лук", "тренд", "колаборац", "коллаборац",
  "новинк", "запуск", "крем", "помад", "волосс", "волос", "фарбуван", "окрашиван", "схудл", "похудел", "фігур", "фигур", "краса", "красот", "б'юті", "бьюти", "beauty", "fashion",
  "дроп", "капсул", "кросівк", "кроссовк", "взутт", "обув", "сумк", "прикрас", "украшен", "ювелір", "ювелир", "премі", "преми", "церемон", "вечірк", "вечеринк", "фотосесі", "фотосесси",
  "кліп", "клип", "прем'єр", "премьер", "серіал", "сериал", "шоу", "холостяк", "тиждень моди", "неделя моды", "fashion week", "met gala", "оскар", "грэмми", "греммі", "канн",
  "чоловік", "муж", "дружин", "жена", "донь", "доч", "сину", "сына", "мама", "вагітність", "світськ", "светск",
  "актор", "артист", "співак", "певец", "шоумен", "режисер", "режиссер", "фільм", "фильм", "кіно", "кино", "голос країни", "танці з зірками", "маск сингер", "євробачен",
  "евровиден", "netflix", "геловін", "хелловин", "halloween", "костюм", "гардероб", "весільн", "кохан", "бойфренд", "пластик", "ботокс", "ін'єкц", "схудн", "дієт", "фітнес",
];

export const DEFAULT_GNEWS_QUERIES = [
  "нова колекція", "новинка косметики", "показ мод", "тиждень моди", "колаборація бренду", "новий аромат", "образ зірки", "червона доріжка", "манікюр тренд", "зачіска зірки",
];

export const DEFAULT_SETTINGS: NewsSettings = {
  intervalMin: 40,
  maxAgeHours: 72,
  topN: 40,
  urgentScore: 70,
  minScore: 20,
  clusterSim: 0.8,
  clusterSimEntity: 0.7,
  clusterWindowHours: 48,
  embedFilter: true,
  embedMargin: 0.06,
  classifyPerDay: 400,
  monthlyBudgetUsd: 50,
  classifyModel: DEFAULT_CLASSIFY_MODEL,
  embedModel: DEFAULT_EMBED_MODEL,
  targetCategories: ["celebrity", "fashion", "beauty", "brands", "selfcare", "events", "relationships"],
  stopWords: DEFAULT_STOP_WORDS,
  stopExceptions: DEFAULT_STOP_EXCEPTIONS,
  stopRubrics: DEFAULT_STOP_RUBRICS,
  nicheWords: DEFAULT_NICHE_WORDS,
  gnewsQueries: DEFAULT_GNEWS_QUERIES,
  gnewsEntitiesPerQuery: 6,
  gnewsGroupsPerRun: 6,
  topEntityWeight: 1.5,
  hl: "uk",
  gl: "UA",
  ceid: "UA:uk",
  autoProxy: true,
  telegramAlerts: true,
  houseStyle: DEFAULT_HOUSE_STYLE,
  siteAbout: "beautydaily.com.ua — українське жіноче медіа про зірок, моду й красу; аудиторія — жінки 22–45 років, які стежать за українськими зірками, трендами й новинками косметики.",
  briefModel: DEFAULT_BRIEF_MODEL,
  autoSummaryPerDay: 150,
};

const num = (v: unknown, d: number, min: number, max: number) => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d;
};
const strList = (v: unknown, d: string[]) => (Array.isArray(v) ? v.map((x) => String(x).trim().toLowerCase()).filter(Boolean) : d);
const str = (v: unknown, d: string) => (typeof v === "string" ? v.trim() : d);
const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);

/** Настройки из JSON (с подстановкой значений по умолчанию и границами). */
export function parseSettings(raw: unknown): NewsSettings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_SETTINGS;
  return {
    intervalMin: num(r.intervalMin, d.intervalMin, 10, 24 * 60),
    maxAgeHours: num(r.maxAgeHours, d.maxAgeHours, 6, 24 * 7),
    topN: num(r.topN, d.topN, 5, 200),
    urgentScore: num(r.urgentScore, d.urgentScore, 30, 100),
    minScore: num(r.minScore, d.minScore, 0, 90),
    clusterSim: num(r.clusterSim, d.clusterSim, 0.5, 0.99),
    clusterSimEntity: num(r.clusterSimEntity, d.clusterSimEntity, 0.4, 0.99),
    clusterWindowHours: num(r.clusterWindowHours, d.clusterWindowHours, 6, 168),
    embedFilter: bool(r.embedFilter, d.embedFilter),
    embedMargin: num(r.embedMargin, d.embedMargin, 0, 0.5),
    classifyPerDay: num(r.classifyPerDay, d.classifyPerDay, 0, 10000),
    monthlyBudgetUsd: num(r.monthlyBudgetUsd, d.monthlyBudgetUsd, 0, 100000),
    classifyModel: str(r.classifyModel, d.classifyModel),
    embedModel: str(r.embedModel, d.embedModel),
    targetCategories: strList(r.targetCategories, d.targetCategories).filter((c) => (CATEGORIES as readonly string[]).includes(c)),
    stopWords: strList(r.stopWords, d.stopWords),
    stopExceptions: strList(r.stopExceptions, d.stopExceptions),
    stopRubrics: strList(r.stopRubrics, d.stopRubrics),
    nicheWords: strList(r.nicheWords, d.nicheWords),
    gnewsQueries: Array.isArray(r.gnewsQueries) ? r.gnewsQueries.map((x) => String(x).trim()).filter(Boolean) : d.gnewsQueries,
    gnewsEntitiesPerQuery: num(r.gnewsEntitiesPerQuery, d.gnewsEntitiesPerQuery, 1, 10),
    gnewsGroupsPerRun: num(r.gnewsGroupsPerRun, d.gnewsGroupsPerRun, 0, 50),
    topEntityWeight: num(r.topEntityWeight, d.topEntityWeight, 0.5, 2),
    hl: str(r.hl, d.hl) || d.hl,
    gl: str(r.gl, d.gl) || d.gl,
    ceid: str(r.ceid, d.ceid) || d.ceid,
    autoProxy: bool(r.autoProxy, d.autoProxy),
    telegramAlerts: bool(r.telegramAlerts, d.telegramAlerts),
    houseStyle: typeof r.houseStyle === "string" && r.houseStyle.trim() ? r.houseStyle.trim() : d.houseStyle,
    siteAbout: typeof r.siteAbout === "string" && r.siteAbout.trim() ? r.siteAbout.trim() : d.siteAbout,
    briefModel: str(r.briefModel, d.briefModel),
    autoSummaryPerDay: num(r.autoSummaryPerDay, d.autoSummaryPerDay, 0, 2000),
  };
}

/** Состояние проекта между прогонами (курсор ротации Google News, отметки алертов). */
export type ProjectState = { gnewsCursor?: number; budgetAlertDay?: string };
export function parseState(raw: unknown): ProjectState {
  return (raw && typeof raw === "object" ? raw : {}) as ProjectState;
}

/** Воронка прогона: сколько собрано и где отсеялось. */
export type RunStats = {
  sources: number;
  sourceErrors: number;
  fetched: number;
  fresh: number;
  dup: number;
  old: number;
  cutWords: number;
  cutRubric: number;
  cutWhitelist: number;
  cutEmbed: number;
  embedded: number;
  classified: number;
  cutLlm: number;
  waiting: number;
  clustersNew: number;
  clustersUpdated: number;
  alerts: number;
  trends: number;
  proxied: number;
  budgetStop?: string;
  summarized?: number;
  embedFilterOn?: boolean;
  log?: string[];
};
export const emptyStats = (): RunStats => ({
  sources: 0, sourceErrors: 0, fetched: 0, fresh: 0, dup: 0, old: 0, cutWords: 0, cutRubric: 0, cutWhitelist: 0, cutEmbed: 0, embedded: 0, classified: 0, cutLlm: 0,
  waiting: 0, clustersNew: 0, clustersUpdated: 0, alerts: 0, trends: 0, proxied: 0, log: [],
});

export type ScorePart = { key: string; label: string; points: number; max: number; why: string };

export const CLUSTER_STATUS_LABELS: Record<string, string> = { new: "Новая", in_work: "В работе", published: "Опубликована", rejected: "Отклонена" };
export const RUN_STATUS_LABELS: Record<string, string> = { queued: "В очереди", running: "Идёт", done: "Готов", failed: "Ошибка" };
