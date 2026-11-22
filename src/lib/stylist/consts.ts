/** «Стилист»: справочники без серверных зависимостей (их берут и страницы, и клиентские компоненты, и воркер). */

export const BASE_PATH = "/stylist";
/** Команда, на которую работает инструмент: образы принадлежат ей. */
export const TEAM_SLUG = "zewex";

export const GEOS = [
  { id: "MT", label: "Мальта" },
  { id: "UA", label: "Украина" },
] as const;
export const GEO_LABELS: Record<string, string> = Object.fromEntries(GEOS.map((g) => [g.id, g.label]));

export const SEGMENTS = [
  { id: "budget", label: "Бюджетный" },
  { id: "mid", label: "Средний" },
  { id: "premium", label: "Премиум" },
  { id: "luxury", label: "Люкс" },
] as const;
export const SEGMENT_LABELS: Record<string, string> = Object.fromEntries(SEGMENTS.map((s) => [s.id, s.label]));

export const GENDERS = [
  { id: "woman", label: "Женское" },
  { id: "man", label: "Мужское" },
  { id: "kids", label: "Детское" },
] as const;
export const GENDER_LABELS: Record<string, string> = { woman: "Женское", man: "Мужское", kids: "Детское", unisex: "Унисекс" };

export const CATEGORIES = [
  { id: "jackets", label: "Куртки" },
  { id: "coats", label: "Пальто и тренчи" },
  { id: "blazers", label: "Жакеты и жилеты" },
  { id: "knitwear", label: "Свитеры и кардиганы" },
  { id: "sweatshirts", label: "Худи и свитшоты" },
  { id: "shirts", label: "Рубашки и блузы" },
  { id: "tshirts", label: "Футболки и поло" },
  { id: "tops", label: "Топы и боди" },
  { id: "dresses", label: "Платья и комбинезоны" },
  { id: "skirts", label: "Юбки" },
  { id: "trousers", label: "Брюки" },
  { id: "jeans", label: "Джинсы" },
  { id: "shorts", label: "Шорты" },
  { id: "suits", label: "Костюмы и комплекты" },
  { id: "shoes", label: "Обувь" },
  { id: "bags", label: "Сумки" },
  { id: "accessories", label: "Аксессуары" },
  { id: "jewellery", label: "Украшения" },
  { id: "lingerie", label: "Бельё и домашнее" },
  { id: "swimwear", label: "Купальники" },
  { id: "other", label: "Другое" },
] as const;
export type CategoryId = (typeof CATEGORIES)[number]["id"];
export const CATEGORY_LABELS: Record<string, string> = Object.fromEntries(CATEGORIES.map((c) => [c.id, c.label]));

/** Группы цветов: по ним фильтр; точное название магазина хранится рядом. */
export const COLORS = [
  { id: "black", label: "Чёрный", hex: "#16161a" },
  { id: "white", label: "Белый и молочный", hex: "#f7f4ec" },
  { id: "grey", label: "Серый", hex: "#9a9da3" },
  { id: "beige", label: "Бежевый", hex: "#d8c4a3" },
  { id: "brown", label: "Коричневый", hex: "#7a5133" },
  { id: "red", label: "Красный", hex: "#cf2b2b" },
  { id: "burgundy", label: "Бордовый", hex: "#6d1f2c" },
  { id: "pink", label: "Розовый", hex: "#f2a7bd" },
  { id: "orange", label: "Оранжевый", hex: "#f08a24" },
  { id: "yellow", label: "Жёлтый", hex: "#f2cf3a" },
  { id: "green", label: "Зелёный", hex: "#3f8f52" },
  { id: "khaki", label: "Хаки и оливковый", hex: "#6f6f3f" },
  { id: "blue", label: "Синий и голубой", hex: "#3f73c9" },
  { id: "navy", label: "Тёмно-синий", hex: "#1c2a4d" },
  { id: "purple", label: "Фиолетовый", hex: "#7c4fb0" },
  { id: "metallic", label: "Золото и серебро", hex: "#c9b26b" },
  { id: "multi", label: "Разноцветный и принт", hex: "" },
] as const;
export const COLOR_LABELS: Record<string, string> = Object.fromEntries(COLORS.map((c) => [c.id, c.label]));
export const COLOR_HEX: Record<string, string> = Object.fromEntries(COLORS.map((c) => [c.id, c.hex]));

/** Теги фасона, материала и деталей. group — заголовок в фильтре. */
export const TAGS = [
  { id: "oversize", label: "Оверсайз", group: "Фасон" },
  { id: "cropped", label: "Укороченное", group: "Фасон" },
  { id: "fitted", label: "Приталенное / slim", group: "Фасон" },
  { id: "straight", label: "Прямой крой", group: "Фасон" },
  { id: "wide", label: "Широкое / wide leg", group: "Фасон" },
  { id: "flare", label: "Клёш", group: "Фасон" },
  { id: "skinny", label: "Скинни", group: "Фасон" },
  { id: "highwaist", label: "Высокая посадка", group: "Фасон" },
  { id: "lowwaist", label: "Низкая посадка", group: "Фасон" },
  { id: "mini", label: "Мини", group: "Длина" },
  { id: "midi", label: "Миди", group: "Длина" },
  { id: "maxi", label: "Макси / длинное", group: "Длина" },
  { id: "leather", label: "Кожа и экокожа", group: "Материал" },
  { id: "suede", label: "Замша", group: "Материал" },
  { id: "denim", label: "Деним", group: "Материал" },
  { id: "knit", label: "Вязаное", group: "Материал" },
  { id: "wool", label: "Шерсть и кашемир", group: "Материал" },
  { id: "linen", label: "Лён", group: "Материал" },
  { id: "satin", label: "Атлас и шёлк", group: "Материал" },
  { id: "fur", label: "Мех", group: "Материал" },
  { id: "velvet", label: "Бархат и вельвет", group: "Материал" },
  { id: "lace", label: "Кружево", group: "Материал" },
  { id: "sequin", label: "Пайетки и блеск", group: "Материал" },
  { id: "puffer", label: "Пуховик / стёганое", group: "Вид" },
  { id: "bomber", label: "Бомбер", group: "Вид" },
  { id: "biker", label: "Косуха", group: "Вид" },
  { id: "trench", label: "Тренч", group: "Вид" },
  { id: "parka", label: "Парка", group: "Вид" },
  { id: "vest", label: "Жилет", group: "Вид" },
  { id: "hooded", label: "С капюшоном", group: "Детали" },
  { id: "belted", label: "С поясом", group: "Детали" },
  { id: "print", label: "Принт", group: "Детали" },
  { id: "striped", label: "Полоска", group: "Детали" },
  { id: "checked", label: "Клетка", group: "Детали" },
  { id: "floral", label: "Цветы", group: "Детали" },
  { id: "animal", label: "Животный принт", group: "Детали" },
  { id: "heels", label: "На каблуке", group: "Обувь" },
  { id: "flat", label: "Плоская подошва", group: "Обувь" },
  { id: "boots", label: "Ботинки и сапоги", group: "Обувь" },
  { id: "sneakers", label: "Кроссовки и кеды", group: "Обувь" },
  { id: "sandals", label: "Босоножки и сандалии", group: "Обувь" },
  { id: "loafers", label: "Лоферы и балетки", group: "Обувь" },
] as const;
export const TAG_LABELS: Record<string, string> = Object.fromEntries(TAGS.map((t) => [t.id, t.label]));

/** Частые размеры для фильтра (в базе размеры хранятся как у магазина). */
export const SIZE_OPTIONS = ["XXS", "XS", "S", "M", "L", "XL", "XXL", "32", "34", "36", "38", "40", "42", "44", "46", "35", "37", "39", "41", "43", "45"];

export const CURRENCY_SIGN: Record<string, string> = { EUR: "€", UAH: "₴", USD: "$", GBP: "£", PLN: "zł" };

export function money(v: number, currency: string): string {
  const s = v.toLocaleString("ru-RU", { minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2 });
  const sign = CURRENCY_SIGN[currency];
  return sign ? (currency === "UAH" || currency === "PLN" ? `${s} ${sign}` : `${sign}${s}`) : `${s} ${currency}`;
}

/** «|a|b|» ⇄ список. */
export const pack = (list: string[]) => (list.length ? `|${[...new Set(list)].join("|")}|` : "");
export const unpack = (s: string | null | undefined) => (s ? s.split("|").filter(Boolean) : []);

/** Вещь в общем виде, как её отдаёт адаптер магазина. */
export type RawItem = {
  extId: string;
  name: string;
  url: string;
  imageUrl: string;
  images?: string[];
  price: number;
  oldPrice?: number | null;
  gender: string;
  /** Название раздела магазина и любые подсказки о типе вещи (по ним определяется тип). */
  rawCategory: string;
  colorName?: string;
  colorHex?: string;
  /** Размеры в наличии, если магазин отдаёт их в списке. */
  sizes?: string[] | null;
  inStock?: boolean;
  /** Вся размерная сетка и размеры, которых осталось мало (если магазин отдаёт остатки). */
  sizesAll?: string[];
  sizesLow?: string[];
  /** Артикул, как он написан на бирке и на сайте магазина. */
  sku?: string;
  /** Сезон коллекции («I2026»), состав, описание, страна производства, дата появления на сайте — если магазин отдаёт. */
  season?: string;
  composition?: string;
  description?: string;
  madeIn?: string;
  storeDate?: Date | null;
};

/** «I2026» → «осень–зима 2026», «V2026» → «весна–лето 2026». */
export function seasonLabel(code: string): string {
  const m = /^([IV])(20\d\d)$/.exec(code);
  return m ? `${m[1] === "I" ? "осень–зима" : "весна–лето"} ${m[2]}` : code;
}

export type StoreBranch = { name?: string; address?: string; phone?: string; email?: string; hours?: string; note?: string; source?: string };
export type StoreContacts = { customerService?: { phone?: string; email?: string; note?: string }; branches?: StoreBranch[] };
