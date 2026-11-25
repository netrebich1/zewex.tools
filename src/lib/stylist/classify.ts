/**
 * «Стилист»: тип вещи, группа цвета и теги фасона по названию и разделу магазина. Без ИИ — словари (английский, украинский, русский).
 * Английское название читается с конца («shirt dress» — платье), славянское с начала («сукня-сорочка» — платье).
 */
import type { CategoryId } from "./consts";

const CYR = /[а-яіїєґё]/i;

/** Слово целиком: \b не работает с кириллицей, поэтому границы заданы явно. */
const word = (alts: string) => new RegExp(`(?<![a-zа-яіїєґё])(?:${alts})(?![a-zа-яіїєґё])`, "gi");
/** Начало слова (для славянских основ: «куртк» → куртка, куртки). */
const stem = (alts: string) => new RegExp(`(?<![a-zа-яіїєґё])(?:${alts})`, "gi");

const CATEGORY_RULES: Array<[CategoryId, RegExp]> = [
  ["swimwear", word("bikinis?|swimsuits?|swimwear|swim shorts?|swimming trunks")],
  ["swimwear", stem("купальник|бікіні|бикини|плавк")],
  ["lingerie", word("bras?|bralettes?|briefs|knickers|thongs?|boxers|pyjamas?|pajamas?|nightdress|nightgown|lingerie|underwear|tights|stockings|socks?|slippers|robe|bathrobe|dressing gown")],
  ["lingerie", stem("бюстгальтер|трус|піжам|пижам|колгот|шкарпет|носк|панчох|чулк|халат|білизн|бель[её]|капці|тапочк")],
  ["jewellery", word("earrings?|necklaces?|bracelets?|rings?|anklets?|brooch(?:es)?|chokers?|pendants?|jewell?ery|cufflinks|charms?")],
  ["jewellery", stem("сереж|серьг|кольє|колье|намист|ожерель|браслет|каблучк|кільц|кольц|брошк|брошь|підвіск|подвеск|чокер|біжутер|бижутер")],
  ["bags", word("bags?|handbags?|totes?|clutch(?:es)?|backpacks?|rucksacks?|shoppers?|pouch(?:es)?|purses?|wallets?|cardholders?|card holders?|crossbody|bumbags?|suitcases?|toiletry")],
  ["bags", stem("сумк|сумочк|рюкзак|клатч|гаманець|гаманц|кошел[её]к|шопер|шоппер|косметичк|валіз|чемодан")],
  ["shoes", word("shoes?|boots?|booties|trainers?|sneakers?|sandals?|heels|loafers?|ballerinas?|ballet flats?|flats|mules?|clogs?|pumps|slingbacks?|espadrilles?|moccasins?|slides?|flip[- ]flops?|wedges|brogues|derbys?|oxfords?|wellies")],
  ["shoes", stem("взутт|обув|черевик|ботин|чобот|чоб[оі]т|сапог|кросівк|кроссовк|кед|туфл|босоніж|босонож|сандал|лофер|балетк|мюл|сабо|шльопанц|шлепанц|шлёпанц|еспадриль|эспадриль|мокасин|сліпон|слипон|уггі|угги")],
  ["accessories", word("belts?|scarf|scarves|hats?|caps?|beanies?|berets?|gloves?|mittens?|sunglasses|glasses|ties?|bow ties?|umbrellas?|hair ?clips?|headbands?|scrunchies?|shawls?|foulards?|bandanas?|balaclavas?|keyrings?|key rings?|phone cases?|watch(?:es)?|perfumes?|eau de (?:parfum|toilette)|suspenders|braces|earmuffs|snoods?")],
  ["accessories", stem("ремінь|ремен|пояс(?![а-я]*\\s*(?:сукн|плать))|шарф|хустк|платок|шапк|кепк|бейсболк|берет|капелюх|шляп|панам|рукавичк|рукавиц|перчатк|окуляр|очки|краватк|галстук|парасол|зонт|заколк|обруч|ободок|резинк|годинник|часы|парфум|духи|туалетна вода|балаклав|брелок")],
  ["suits", word("suits?|co-?ords?|sets?|tracksuits?|tuxedos?|matching set")],
  ["suits", stem("костюм|комплект")],
  ["dresses", word("dress(?:es)?|gowns?|jumpsuits?|playsuits?|rompers?|dungarees|overalls|kaftans?|tunics?")],
  ["dresses", stem("сукн|сукен|плать|комбінезон|комбинезон|сарафан|туні|туник")],
  ["skirts", word("skirts?|skorts?|sarongs?|pareos?")],
  ["skirts", stem("спідниц|спідничк|юбк|юбочк|парео")],
  ["jeans", word("jeans|jeggings")],
  ["jeans", stem("джинс(?!ов[а-я]*\\s+(?:куртк|сорочк|рубашк|спідниц|юбк|сукн|плать|шорт|жилет|комбін|комбин))")],
  ["shorts", word("shorts|bermudas?|culottes")],
  ["shorts", stem("шорт|бермуд")],
  ["trousers", word("trousers|pants|leggings|joggers|chinos|cargos|sweatpants|slacks|palazzos?")],
  ["trousers", stem("штан|брюк|легінс|леггинс|лосин|джогер|джоггер|чінос|чинос|палаццо")],
  ["blazers", word("blazers?|waistcoats?|suit jackets?|gilets? blazer|tuxedo jacket")],
  ["blazers", stem("блейзер|жакет|піджак|пиджак|жилет(?![а-я]*\\s*(?:пухов|ст[ьеё]ган|утепл))")],
  ["coats", word("coats?|trench(?:es)?|trench coats?|raincoats?|overcoats?|capes?|ponchos?|macs?|duffle")],
  ["coats", stem("пальт|тренч|плащ|кейп|пончо|шуб|дублянк|дубленк|дублёнк")],
  ["jackets", word("jackets?|bombers?|puffers?|parkas?|anoraks?|windbreakers?|gilets?|bikers?|overshirts?|shackets?|quilted vest|puffer vest|fleece|down vest")],
  ["jackets", stem("куртк|курточк|бомбер|пуховик|парк[аиу]|анорак|вітрівк|ветровк|косух|безрукавк|пухов[а-я]* жилет")],
  ["sweatshirts", word("sweatshirts?|hoodies?|hoody|sweat")],
  ["sweatshirts", stem("худі|худи|світшот|свитшот|толстовк")],
  ["knitwear", word("jumpers?|sweaters?|cardigans?|pullovers?|knitwear|turtlenecks?|polo necks?|knit (?:top|vest|polo)|sweater vest|twinset")],
  ["knitwear", stem("светр|свитер|джемпер|кардиган|пуловер|гольф|водолазк|в'язан[а-я]* (?:топ|жилет)|трикотаж")],
  ["shirts", word("shirts?|blouses?|bodyshirt")],
  ["shirts", stem("сорочк|рубашк|блуз")],
  ["tshirts", word("t-?shirts?|tees?|polo shirts?|polos?|tank tops?|vest tops?|singlets?")],
  ["tshirts", stem("футболк|поло|майк|лонгслів|лонгслив")],
  ["tops", word("tops?|bodysuits?|bodies|bustiers?|corsets?|camisoles?|camis?|bandeaus?|crop top")],
  ["tops", stem("топ(?![а-я]*сайд)|боді|боди|бюстьє|бюстье|корсет")],
  // Итальянские названия (сайты Terranova, Calliope, Dan John): главное слово стоит первым.
  ["swimwear", stem("costum[ei] da bagno|bikini")],
  ["lingerie", stem("reggiseno|slip|pigiam|intimo|calzin|collant|boxer|vestaglia|pantofol")],
  ["jewellery", stem("orecchin|collan|braccial|anell[oi]")],
  ["bags", stem("bors[ae]|zain|pochette|portafogli|tracolla|marsupio")],
  ["shoes", stem("scarp|stival|sandal|mocassin|ballerin|decollet|ciabatt|anfib|polacchin")],
  ["accessories", stem("cintur|sciarp|cappell|berrett|guant|occhial|cravatt|ombrell|foulard|bandana|fascia per capelli")],
  ["suits", stem("completo|tailleur")],
  ["dresses", stem("abit[oi]|vestit|tuta|salopette")],
  ["skirts", stem("gonn")],
  ["shorts", stem("pantalone corto|pantaloncin|bermuda")],
  ["trousers", stem("pantalon")],
  ["blazers", stem("giacca sartorial|gilet(?! imbottit)")],
  ["coats", stem("cappott|impermeabil|mantell|pellicci|montgomery")],
  ["jackets", stem("giacc|giubbott|giubbin|piumin|chiodo|capospalla|gilet imbottit|smanicat")],
  ["sweatshirts", stem("felp")],
  ["knitwear", stem("maglion|maglia|dolcevita|lupetto|maglieria|coprispalle")],
  ["shirts", stem("camici|camicett|blus")],
  ["tshirts", stem("canott")],
];

/** «t-shirt» не должно читаться как «shirt», «polo shirt» — как рубашка, «shirt dress» — как рубашка. */
function categoryIn(text: string, headFirst = false): CategoryId | null {
  const t = text.toLowerCase().replace(/t-shirts?|tee shirts?/g, "tshirt").replace(/polo shirts?/g, "polo").replace(/sweat-?shirts?/g, "sweatshirt").replace(/over-?shirts?/g, "overshirt");
  const cyr = headFirst || CYR.test(t);
  // Хвост после «with / з / с» описывает детали, а не саму вещь.
  const head = t.split(cyr ? /\s(?:з|із|зі|с|со|на|для|в|у|con|in|a|di|effetto)\s/ : /\s(?:with|in|and|for|featuring)\s/)[0] || t;
  for (const src of [head, t]) {
    let best: { cat: CategoryId; at: number } | null = null;
    for (const [cat, re] of CATEGORY_RULES) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src))) {
        const at = m.index;
        if (!best || (cyr ? at < best.at : at > best.at)) best = { cat, at };
        if (m[0].length === 0) re.lastIndex++;
      }
    }
    if (best) return best.cat;
  }
  return null;
}

/** Тип вещи: сначала по названию, затем по подсказке магазина (раздел, семейство товара). */
export function classifyCategory(name: string, hint: string, headFirst = false): CategoryId {
  return categoryIn(name, headFirst) ?? categoryIn(hint.replace(/[-_/|]+/g, " "), headFirst) ?? "other";
}

const COLOR_RULES: Array<[string, RegExp]> = [
  ["multi", stem("multi|print|floral|stripe|check|leopard|animal|zebra|snake|tie[- ]dye|різнокольор|разноцвет|мульти|принт|смуг|полоск|клітин|клетк|леопард")],
  ["metallic", stem("gold|silver|metallic|bronze|copper|золот|срібн|серебр|металік|металлик|бронз")],
  ["navy", stem("blu scuro|blu notte|navy|ink blue|midnight|dark blue|dark indigo|темно-син|тёмно-син|темно син")],
  ["burgundy", stem("bordeaux|vinaccia|burgundy|maroon|wine|bordeaux|marsala|aubergine|plum|oxblood|бордо|марсал|винн|баклажан|сливов")],
  ["khaki", stem("militare|khaki|olive|military|army|moss|хакі|хаки|оливк|мілітарі")],
  ["beige", stem("sabbia|cammello|beige|sand|camel|nude|taupe|stone|tan(?![a-z])|oatmeal|mink|straw|toffee|caramel|biscuit|greige|vanilla|бежев|пісочн|песочн|кемел|нюд|тауп|карамел")],
  ["white", stem("bianc|panna|latte|white|ecru|cream|ivory|off-white|oyster|bone|chalk|pearl(?! grey)|milk|біл|бел|молочн|екрю|экрю|кремов|айворі|айвори")],
  ["black", stem("nero|nera|black|чорн|черн|чёрн")],
  ["grey", stem("grigi|antracite|grey|gray|anthracite|charcoal|graphite|lead|сір|сер(?:ый|ая|ое|ые|о-)|антрацит|графіт|графит")],
  ["brown", stem("marron|cuoio|cioccolat|brown|chocolate|tobacco|coffee|mocha|cognac|chestnut|leather|earth|rust|brick|terracotta|коричн|шоколад|кавов|кофейн|терракот|цегл")],
  ["red", stem("ross[oa]|red(?![a-z])|scarlet|cherry|coral|tomato|червон|красн|вишн|корал|алый")],
  ["pink", stem("rosa|cipria|fucsia|pink|rose|fuchsia|blush|mauve|magenta|salmon|рожев|розов|фукс|пудр")],
  ["orange", stem("arancio|pesca|orange|apricot|peach|tangerine|помаранч|оранж|персик|абрикос")],
  ["yellow", stem("giall|senape|yellow|mustard|lemon|lime|жовт|желт|жёлт|гірчич|горчич|лимон")],
  ["green", stem("verde|salvia|green|mint|emerald|sage|bottle|pistachio|teal|turquoise|aqua|зелен|зелён|м'ят|мят|смарагд|изумруд|фісташ|фисташ|бірюз|бирюз")],
  ["purple", stem("viola|lilla|purple|violet|lilac|lavender|фіолет|фиолет|бузков|сирен|лаванд|лілов|лилов")],
  ["blue", stem("blu|azzurr|celeste|blue|indigo|cobalt|denim|azure|sky|bluish|синій|синя|синє|сині|синий|синяя|синее|синие|голуб|блакит|індиго|индиго|кобальт|денім|деним")],
];

function colorByHex(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return "";
  const n = parseInt(m[1], 16);
  const r = (n >> 16) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  let h = 0;
  if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h = (h * 60 + 360) % 360;
  if (l < 0.13) return "black";
  if (s < 0.12) return l > 0.88 ? "white" : "grey";
  if (l > 0.9 && s < 0.6) return "white";
  if (h < 15 || h >= 345) return l < 0.3 ? "burgundy" : l > 0.75 ? "pink" : "red";
  if (h < 45) return l < 0.45 ? "brown" : s < 0.45 || l > 0.7 ? "beige" : "orange";
  if (h < 70) return s < 0.4 ? (l > 0.55 ? "beige" : "khaki") : l < 0.35 ? "khaki" : "yellow";
  if (h < 170) return s < 0.3 || (h < 100 && l < 0.4) ? "khaki" : "green";
  if (h < 200) return "green";
  if (h < 255) return l < 0.25 ? "navy" : "blue";
  if (h < 300) return "purple";
  return l < 0.3 ? "burgundy" : "pink";
}

/** Группа цвета: по названию магазина, иначе по hex. Два разных цвета через «/» — «разноцветный». */
export function classifyColor(name: string, hex = ""): string {
  const parts = name.toLowerCase().split(/\s*[\/+&]\s*|\s+and\s+/).filter(Boolean);
  const found = new Set<string>();
  for (const p of parts) {
    for (const [id, re] of COLOR_RULES) {
      re.lastIndex = 0;
      if (re.test(p)) { found.add(id); break; }
    }
  }
  if (found.size > 1) return "multi";
  if (found.size === 1) return [...found][0];
  return colorByHex(hex);
}

const TAG_RULES: Array<[string, RegExp]> = [
  ["oversize", stem("oversize|oversized|relaxed fit|loose[- ]fit|boxy|baggy|оверсайз|вільн[а-я]* кро|свободн[а-я]* кро|мішкуват|багі")],
  ["cropped", stem("crop|short jacket|укорочен|короткий|коротка|кроп")],
  ["fitted", stem("fitted|slim|tailored fit|bodycon|притален|слім|слим|облягаюч|облегающ")],
  ["straight", stem("straight|прям")],
  ["wide", stem("wide[- ]leg|wide leg|palazzo|широк|палаццо")],
  ["flare", stem("flare|bootcut|boot-cut|кльош|клеш|клёш|буткат")],
  ["skinny", stem("skinny|скіні|скинни")],
  ["highwaist", stem("high[- ]waist|high[- ]rise|висок[а-я]* (?:посадк|тал)|высок[а-я]* (?:посадк|тал)")],
  ["lowwaist", stem("low[- ]waist|low[- ]rise|низьк[а-я]* (?:посадк|тал)|низк[а-я]* (?:посадк|тал)")],
  ["mini", stem("mini(?![a-z]*mal)|міні|мини(?!мал)")],
  ["midi", stem("midi|міді|миди")],
  ["maxi", stem("maxi|long (?:dress|skirt|coat)|максі|макси|довг[а-я]* (?:сукн|спідниц|пальт)|длинн[а-я]* (?:плать|юбк|пальт)")],
  ["leather", stem("leather|faux leather|шкір|кож(?:а|и|ан)|екошкір|экокож")],
  ["suede", stem("suede|замш")],
  ["denim", stem("denim|jeans|джинс|денім|деним")],
  ["knit", stem("knit|crochet|cable|в'язан|вязан|трикотаж")],
  ["wool", stem("wool|cashmere|merino|alpaca|mohair|вовн|шерст|кашемір|кашемир|меринос|альпак|мохер")],
  ["linen", stem("linen|льон|льня|лён|лен(?:а|у)?(?![а-я])")],
  ["satin", stem("satin|silk|атлас|сатин|шовк|шёлк|шелк")],
  ["fur", stem("fur|shearling|teddy|sherpa|хутр|мех(?![а-я]*ан)|шерп|тедді|тедди")],
  ["velvet", stem("velvet|corduroy|velour|оксамит|бархат|вельвет|велюр")],
  ["lace", stem("lace|мережив|кружев")],
  ["sequin", stem("sequin|glitter|rhinestone|metallic thread|sparkl|паєтк|пайетк|блискіт|блест|страз")],
  ["puffer", stem("puffer|quilted|padded|down (?:jacket|coat|vest)|пухов|стьобан|стеган|стёган|дут(?:а|ий|ая|ый)")],
  ["bomber", stem("bomber|бомбер")],
  ["biker", stem("biker|косух|байкер")],
  ["trench", stem("trench|тренч")],
  ["parka", stem("parka|парк[аиу](?![а-я])")],
  ["vest", stem("gilet|waistcoat|vest(?! top)|жилет|безрукавк")],
  ["hooded", stem("hood|капюш")],
  ["belted", stem("belted|with belt|з поясом|с поясом|на поясі")],
  ["print", stem("print|принт")],
  ["striped", stem("stripe|смуг|полоск")],
  ["checked", stem("check|plaid|tartan|houndstooth|gingham|клітин|клетк|гусяч|гусин")],
  ["floral", stem("floral|flower|квітк|квіт|цветоч|цветы")],
  ["animal", stem("leopard|animal|zebra|snake|croc|леопард|зебр|змії|змеин|тварин|животн")],
  ["heels", stem("heel|stiletto|pumps|kitten|каблук|підбор|шпильк")],
  ["flat", stem("flat|плоск")],
  ["boots", stem("boot|ботильйон|ботильон|черевик|ботин|чобот|чобіт|сапог")],
  ["sneakers", stem("sneaker|trainer|кросівк|кроссовк|кеди|кеды")],
  ["sandals", stem("sandal|босоніж|босонож|сандал|шльопанц|шлепанц")],
  ["loafers", stem("loafer|ballerina|ballet flat|moccasin|лофер|балетк|мокасин")],
];

/** Теги фасона, материала и деталей по названию и подсказке магазина. */
export function classifyTags(name: string, hint = ""): string[] {
  const t = `${name} ${hint}`.toLowerCase();
  const out: string[] = [];
  for (const [id, re] of TAG_RULES) {
    re.lastIndex = 0;
    if (re.test(t)) out.push(id);
  }
  return out;
}
