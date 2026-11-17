/** Сезонность ключа — перенос docs/keyword-research/prototype/classify.py (жёсткая отсекается, мягкая и «тренд» помечаются). */

const HARD = /\b(winter|spring|summer|fall|autumn|christmas|holiday|thanksgiving|friendsgiving|new years?|nye|valentines?|galentines|st patricks|easter|4th of july|halloween|mardi gras|super bowl|prom|graduation|homecoming|spring break|coachella|festival|kentucky derby|beach|vacation|cruise|snow|snowflake|ski|apres ski|cold weather|uggs|parka|peacoat|puffer|wool coat|teddy coat|sundress(es)?|linen|shorts|jorts|sandals|rainy day|picnic|garden party|frosted|icy nails|europe summer|mexico vacation|bid day|school dance|back to school|f1)\b/;
const SOFT = /\b(sweater|turtleneck|cardigan|beanie|scarf|tights|coat|boots?|velvet|plaid|burgundy|oxblood|black cherry|mulled wine|plum|espresso|chocolate brown|jewel tone|emerald|knit|hoodie|sweatshirt|leather jacket|trench|pastel|lavender|lilac|mint green|coral|peach|neon|butter yellow|daisy|strawberry|espadrille|sunglasses|crocs|birkenstock|capri|bike shorts|tube top|tank top|crop top|halter|off the shoulder|strapless|backless|bucket hat|baseball cap|cherry|icy blue|pedicure|toe nails|wedding|bridesmaid|bridal|bachelorette|baby shower|rodeo|nashville|country concert|cozy|chunky knit|bubble braid|island twists)\b/;
const TREND = /\b(trends?|2027)\b/;
/** Исключения прототипа: в названии «сезонное» слово, но ключ вечнозелёный. */
const KEEP = new Set(["beach waves", "strawberry blonde", "bubble braid", "island twists"]);

export function classifySeason(k: string): "none" | "soft" | "trend" | "hard" {
  const s = k.toLowerCase();
  if (KEEP.has(s)) return "none";
  if (HARD.test(s)) return "hard";
  if (TREND.test(s)) return "trend";
  if (SOFT.test(s)) return "soft";
  return "none";
}

/** Значение колонки «Сезонность» листа Evergreen → код. */
export function seasonFromSheet(v: string): "none" | "soft" | "trend" {
  if (/тренд/i.test(v)) return "trend";
  if (/мягк/i.test(v)) return "soft";
  return "none";
}
