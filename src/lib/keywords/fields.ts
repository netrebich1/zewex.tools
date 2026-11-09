/**
 * Реестр метрик экрана «Ключи»: из него строятся колонки таблицы, выбор колонок, фильтры «от–до», сортировка, подсказки.
 * Каждое поле — колонка KwKeyword (денормализована при пересчёте, см. recompute.ts), поэтому фильтры и сортировка идут в базе.
 * Чистые данные — можно импортировать и в клиентские компоненты.
 */

export const GROUPS = [
  { key: "demand", label: "Спрос и оценка" },
  { key: "serp", label: "Состав выдачи" },
  { key: "fresh", label: "Свежесть и возраст пинов" },
  { key: "authors", label: "Авторы топа" },
  { key: "links", label: "Ссылки и блоги" },
  { key: "articles", label: "Статьи блогов" },
  { key: "design", label: "Оформление и заголовки" },
  { key: "changes", label: "Изменения и данные" },
] as const;
export type GroupKey = (typeof GROUPS)[number]["key"];

/**
 * kind: num — число (фильтр от–до), days — дата, фильтр по давности в днях; pct — проценты (0–100), months — месяцы.
 * count — какое количество показать рядом с процентом в ячейке (поле `counts` строки).
 */
export type Field = {
  key: string; label: string; short?: string; group: GroupKey;
  kind: "num" | "days"; col: string; unit?: "%" | "мес" | "дн" | "шт" | ""; count?: string;
  /** Наибольшее возможное значение (для количеств: 10 пинов топа и т. п.) — подсказка в фильтре и проверка ввода */
  max?: number;
  /** У процентной метрики — колонка с тем же в штуках (фильтр «в штуках») */
  countCol?: string;
  desc: string; default?: boolean;
};

export const FIELDS: Field[] = [
  // Спрос и оценка
  { key: "volume", label: "Частотность", group: "demand", kind: "num", col: "volume", unit: "", desc: "Аудитория Ads Manager US в месяц. По умолчанию показываются ключи от 3000; поставьте «от» = 0, чтобы увидеть все.", default: true },
  { key: "score", label: "Оценка 0–100", short: "Оценка", group: "demand", kind: "num", col: "score", unit: "", desc: "Лёгкость выдачи × размер спроса (формула прототипа + вес позиции свежих пинов + устаревшие годы у блогов).", default: true },
  { key: "entryNew", label: "Вход нового блога", short: "Новый блог", group: "demand", kind: "num", col: "entryNew", unit: "", desc: "0–100: насколько выдача пускает молодой блог/аккаунт (свежие пины наверху, малые и личные аккаунты, мало сильных старых пинов).", default: true },
  { key: "entryOld", label: "Вход старого блога", short: "Старый блог", group: "demand", kind: "num", col: "entryOld", unit: "", desc: "0–100: шанс для старого блога, у которого новые статьи ранжируются слабо: топ держат старые пины и статьи, блоги с ссылками, мало свежей конкуренции.", default: true },
  // Состав выдачи
  { key: "pins", label: "Пинов на первом экране", short: "Пинов", group: "serp", kind: "num", col: "pins", unit: "шт", max: 20, desc: "Сколько пинов отдаёт первый экран поиска (до 20)." },
  { key: "com", label: "Реклама + товары", short: "Реклама+товары", group: "serp", kind: "num", col: "comPct", unit: "%", max: 100, countCol: "comN", count: "com", desc: "Коммерция на первом экране: рекламные и товарные пины. Много — информационную статью не пустят." },
  { key: "ad", label: "Реклама", group: "serp", kind: "num", col: "adPct", unit: "%", max: 100, countCol: "adN", count: "ad", desc: "Рекламные (promoted) пины первого экрана.", default: true },
  { key: "prod", label: "Товары", group: "serp", kind: "num", col: "prodPct", unit: "%", max: 100, countCol: "prodN", count: "prod", desc: "Товарные пины (карточки товаров, shopping).", default: true },
  { key: "info", label: "Инфо-пины со ссылкой", short: "Инфо", group: "serp", kind: "num", col: "infoPct", unit: "%", max: 100, countCol: "infoN", count: "info", desc: "Органические пины со ссылкой на статью." },
  { key: "nolink", label: "Пины без ссылки", short: "Без ссылки", group: "serp", kind: "num", col: "nolinkPct", unit: "%", max: 100, countCol: "nolinkN", count: "nolink", desc: "Органические пины без ссылки: за клик на сайт не конкурируют." },
  { key: "video", label: "Видео-пины", short: "Видео", group: "serp", kind: "num", col: "videoPct", unit: "%", max: 100, countCol: "videoN", count: "video", desc: "Видео среди пинов первого экрана. Много — выдача любит видео." },
  { key: "tmatch", label: "Ключ в заголовке", group: "serp", kind: "num", col: "tmatchPct", unit: "%", max: 100, countCol: "tmatchN", count: "tmatch", desc: "У скольких органических пинов все слова ключа в заголовке. Мало — топ плохо оптимизирован, можно обойти точным заголовком.", default: true },
  { key: "own", label: "От владельца сайта", short: "Владельцы", group: "serp", kind: "num", col: "ownPct", unit: "%", max: 100, countCol: "ownN", count: "own", desc: "Пины со ссылкой, которые сохранил сам владелец сайта." },
  { key: "resaved", label: "Пересохранения", group: "serp", kind: "num", col: "resavedPct", unit: "%", max: 100, countCol: "resavedN", count: "resaved", desc: "Пины со ссылкой, сохранённые чужими пользователями (не владельцем сайта)." },
  { key: "big", label: "Крупные СМИ и магазины", short: "СМИ", group: "serp", kind: "num", col: "bigCount", unit: "шт", max: 10, desc: "Ссылки топ-10 на крупные СМИ и магазины (Vogue, Allure, Amazon…)." },
  { key: "saves", label: "Сохранения (медиана)", short: "Сохранения", group: "serp", kind: "num", col: "medSaves", unit: "", desc: "Медиана сохранений пинов первого экрана. Большие — топ держат сильные пины.", default: true },
  { key: "savesTop3", label: "Сохранения мест 1–3", short: "Сохр. 1–3", group: "serp", kind: "num", col: "savesTop3", unit: "", desc: "Медиана сохранений трёх верхних пинов." },
  { key: "listn", label: "Число в заголовках", short: "Число в загол.", group: "serp", kind: "num", col: "listNum", unit: "", desc: "Медиана числа в заголовках пинов («35 ideas»): сколько пунктов ждут в подборке." },
  // Свежесть и возраст пинов
  { key: "fresh3", label: "Пины < 3 мес", group: "fresh", kind: "num", col: "fresh3Pct", unit: "%", max: 100, countCol: "fresh3N", count: "fresh3", desc: "Пины моложе 3 месяцев на первом экране.", default: true },
  { key: "fresh6", label: "Пины < 6 мес", group: "fresh", kind: "num", col: "freshPct", unit: "%", max: 100, countCol: "freshN", count: "fresh", desc: "Пины моложе полугода на первом экране." },
  { key: "freshTop", label: "Свежие вверху (вес места)", short: "Свежие вверху", group: "fresh", kind: "num", col: "freshTopPct", unit: "%", max: 100, desc: "Доля свежих (< 3 мес) пинов топ-10 с весом позиции: 1-е место весит больше 10-го.", default: true },
  { key: "freshTop3", label: "Свежих на местах 1–3", short: "Свежих 1–3", group: "fresh", kind: "num", col: "freshTop3", unit: "шт", max: 3, desc: "Сколько пинов моложе 3 месяцев на трёх верхних местах." },
  { key: "pinAgeMin", label: "Возраст самого свежего пина", short: "Свежий пин, мес", group: "fresh", kind: "num", col: "pinAgeMin", unit: "мес", desc: "Возраст самого молодого пина топ-10, месяцев." },
  { key: "pinAgeMed", label: "Возраст пинов топа (медиана)", short: "Возраст пинов", group: "fresh", kind: "num", col: "pinAgeMed", unit: "мес", desc: "Медиана возраста пинов топ-10, месяцев. Фильтр «от–до» — например, исключить ключи, где топ моложе 3 или старше 36 месяцев.", default: true },
  { key: "pinAgeMax", label: "Возраст самого старого пина", short: "Старый пин, мес", group: "fresh", kind: "num", col: "pinAgeMax", unit: "мес", desc: "Возраст самого старого пина топ-10, месяцев." },
  // Авторы
  { key: "biz", label: "Бизнес-аккаунты", short: "Бизнес", group: "authors", kind: "num", col: "bizPct", unit: "%", max: 100, countCol: "bizN", count: "biz", desc: "Бизнес-аккаунты среди авторов топ-10." },
  { key: "followers", label: "Подписчики авторов (медиана)", short: "Подписчики", group: "authors", kind: "num", col: "medFollowers", unit: "", desc: "Медиана подписчиков авторов пинов первого экрана. Малая — топ держат небольшие аккаунты." },
  { key: "bizViews", label: "Бизнес: просмотры/мес (среднее)", short: "Просм. бизнеса", group: "authors", kind: "num", col: "bizViewsAvg", unit: "", desc: "Средние месячные просмотры профилей бизнес-аккаунтов топа." },
  { key: "bizFollowers", label: "Бизнес: подписчики (среднее)", short: "Подп. бизнеса", group: "authors", kind: "num", col: "bizFollowersAvg", unit: "", desc: "Средние подписчики бизнес-аккаунтов топа." },
  { key: "dv", label: "С подтверждённым сайтом", short: "Подтв. сайт", group: "authors", kind: "num", col: "dvPct", unit: "%", max: 100, countCol: "dvN", count: "dv", desc: "Авторы топ-10 с подтверждённым (claimed) сайтом." },
  { key: "mer", label: "Проверенные магазины", short: "Магазины", group: "authors", kind: "num", col: "merPct", unit: "%", max: 100, countCol: "merN", count: "mer", desc: "Авторы топ-10 со статусом проверенного продавца." },
  // Ссылки и блоги
  { key: "links", label: "Ссылок в топ-10", short: "Ссылок", group: "links", kind: "num", col: "linksTop10", unit: "шт", max: 10, desc: "Пинов со ссылкой среди топ-10 органики." },
  { key: "blogs", label: "Блоги среди ссылок", short: "Блоги", group: "links", kind: "num", col: "blogPct", unit: "%", max: 100, countCol: "blogLinks", count: "blogs", desc: "Доля ссылок топ-10 на блоги. Соцсети, маркетплейсы и магазины (Instagram, Amazon…) не считаются конкурентами.", default: true },
  { key: "blogDomains", label: "Разных блогов", group: "links", kind: "num", col: "blogDomains", unit: "шт", max: 10, desc: "Сколько разных блогов в топ-10. 1–2 — топ держит один сайт." },
  { key: "blogTop5", label: "Блогов на местах 1–5", short: "Блогов 1–5", group: "links", kind: "num", col: "blogTop5", unit: "шт", max: 5, desc: "Сколько из пяти верхних пинов ведут на блоги." },
  { key: "linkTop5", label: "Со ссылкой на местах 1–5", short: "Ссылок 1–5", group: "links", kind: "num", col: "linkTop5", unit: "шт", max: 5, desc: "Сколько из пяти верхних пинов со ссылкой — реальные конкуренты за клик." },
  { key: "domains", label: "Разных доменов", group: "links", kind: "num", col: "domains", unit: "шт", max: 10, desc: "Разных доменов среди ссылок топ-10 (включая платформы)." },
  // Статьи блогов
  { key: "artCount", label: "Статей блогов с датой", short: "Статей с датой", group: "articles", kind: "num", col: "artCount", unit: "шт", max: 10, desc: "Статьи блогов топ-10, у которых нашлась дата публикации." },
  { key: "artAgeMin", label: "Самая свежая статья", short: "Свежая статья", group: "articles", kind: "num", col: "artAgeMin", unit: "мес", desc: "Возраст самой свежей статьи блога в топ-10, месяцев." },
  { key: "artAgeAvg", label: "Средний возраст статей", short: "Возраст статей", group: "articles", kind: "num", col: "artAgeAvg", unit: "мес", desc: "Средний возраст статей блогов топ-10, месяцев.", default: true },
  { key: "artAgeMax", label: "Самая старая статья", short: "Старая статья", group: "articles", kind: "num", col: "artAgeMax", unit: "мес", desc: "Возраст самой старой статьи блога в топ-10, месяцев." },
  { key: "oldYears", label: "Устаревший год в заголовке", short: "Устар. год", group: "articles", kind: "num", col: "oldYears", unit: "шт", max: 10, desc: "Статьи блогов топ-10 с прошлым годом в заголовке — статья «2027» будет свежее." },
  { key: "words", label: "Слов в статье (медиана)", short: "Слов", group: "articles", kind: "num", col: "artWords", unit: "", desc: "Медиана слов в статьях блогов топ-10." },
  { key: "images", label: "Фото в статье (медиана)", short: "Фото", group: "articles", kind: "num", col: "artImages", unit: "", desc: "Медиана фото в статьях блогов топ-10." },
  // Оформление и заголовки
  { key: "pinYear", label: "Пины с годом в заголовке", short: "Год у пинов", group: "design", kind: "num", col: "pinYearPct", unit: "%", max: 100, countCol: "tyN", count: "ty", desc: "Органические пины первого экрана с годом (любым) в заголовке." },
  { key: "designed", label: "Оформленные пины", short: "Оформлено", group: "design", kind: "num", col: "designedPct", unit: "%", max: 100, countCol: "designedN", desc: "Коллажи и фото с надписью среди пинов топ-10 (определяет модель со зрением)." },
  { key: "collage", label: "Коллажи", group: "design", kind: "num", col: "collagePct", unit: "%", max: 100, countCol: "collageN", desc: "Коллажи (несколько фото в одной картинке) среди пинов топ-10." },
  { key: "text", label: "Фото с надписью", short: "С надписью", group: "design", kind: "num", col: "textPct", unit: "%", max: 100, countCol: "textN", desc: "Фото с надписью поверх среди пинов топ-10." },
  { key: "photo", label: "Чистые фото", group: "design", kind: "num", col: "photoPct", unit: "%", max: 100, countCol: "photoN", desc: "Фото без надписей среди пинов топ-10." },
  // Изменения и данные
  { key: "scoreDelta", label: "Изменение оценки", short: "Δ оценки", group: "changes", kind: "num", col: "scoreDelta", unit: "", desc: "Насколько изменилась оценка с прошлого снимка выдачи (минус — стало тяжелее)." },
  { key: "comDelta", label: "Изменение рекламы + товаров", short: "Δ коммерции", group: "changes", kind: "num", col: "comDelta", unit: "", desc: "Изменение доли рекламы и товаров с прошлого снимка, п.п. Плюс — выдача стала коммерческой." },
  { key: "overlap", label: "Совпадение топа с прошлым снимком", short: "Топ как раньше", group: "changes", kind: "num", col: "topOverlapPrev", unit: "%", max: 100, desc: "Сколько пинов топ-10 остались с прошлого снимка. Мало — выдача сильно перемешалась." },
  { key: "snaps", label: "Снимков выдачи", short: "Снимков", group: "changes", kind: "num", col: "snapCount", unit: "", desc: "Сколько раз снималась выдача по ключу." },
  { key: "serpAge", label: "Давность снимка выдачи", short: "Снимок, дн", group: "changes", kind: "days", col: "serpAt", unit: "дн", desc: "Сколько дней назад снята выдача. Фильтр «от» — найти устаревшие снимки для пересъёма." },
  { key: "volAge", label: "Давность частотности", short: "Частотность, дн", group: "changes", kind: "days", col: "volAt", unit: "дн", desc: "Сколько дней назад снята частотность." },
];

export const FIELD = new Map(FIELDS.map((f) => [f.key, f]));
/** Колонки по умолчанию (ключ и вердикт показываются всегда). */
export const DEFAULT_COLUMNS = FIELDS.filter((f) => f.default).map((f) => f.key);

/** Поля, которые ячейка таблицы показывает «количество · процент» (count — ключ в `counts`). */
export const COUNT_KEYS = ["com", "ad", "prod", "info", "nolink", "video", "tmatch", "own", "resaved", "fresh3", "fresh", "biz", "dv", "mer", "blogs", "ty"] as const;

/** Режим значений фильтров: проценты (по умолчанию) или штуки. Параметр адреса `fu=cnt` — штуки. */
export type FilterUnit = "pct" | "cnt";
/**
 * Как поле фильтруется в выбранном режиме: колонка, единица и множитель перевода введённого числа в значение колонки.
 *  • процентная метрика в штуках — своя колонка-количество (countCol), если она есть;
 *  • количество из фиксированной базы (ссылок из 10 мест топа, блогов на местах 1–5…) в процентах — % от базы (max).
 */
export function filterSpec(f: Field, mode: FilterUnit): { col: string; unit: Field["unit"]; factor: number; max?: number } {
  if (f.unit === "%" && mode === "cnt" && f.countCol) return { col: f.countCol, unit: "шт", factor: 1 };
  if (f.unit === "шт" && mode === "pct" && f.max) return { col: f.col, unit: "%", factor: f.max / 100, max: 100 };
  return { col: f.col, unit: f.unit, factor: 1, max: f.max };
}
/** Можно ли у поля переключать проценты и штуки. */
export const toggles = (f: Field) => (f.unit === "%" && !!f.countCol) || (f.unit === "шт" && !!f.max);
