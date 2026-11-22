# Собирает prisma/seed-data/stylist-stores.json из компактных списков ниже (ресерч 22.11.2026).
# Запуск: python scripts/stylist/build-stores.py
# Строка: название | сегмент | сайт. Магазины с автоматическим сбором заданы отдельно в AUTO.
import io, json, os, re

AUTO = [
    {"slug": "zara-mt", "name": "Zara Мальта", "brand": "Zara", "segment": "mid", "geo": "MT", "adapter": "zara", "baseUrl": "https://www.zara.com/mt/en/", "currency": "EUR", "config": {"path": "mt/en"}},
    {"slug": "parfois-mt", "name": "Parfois Мальта", "brand": "Parfois", "segment": "mid", "geo": "MT", "adapter": "parfois", "baseUrl": "https://www.parfois.com/en/mt/", "currency": "EUR", "config": {"path": "en/mt", "locale": "en_MT", "country": "MT"}},
    {"slug": "massimo-dutti-mt", "name": "Massimo Dutti", "brand": "Massimo Dutti", "segment": "premium", "geo": "MT", "adapter": "itx", "baseUrl": "https://www.massimodutti.com/mt/", "currency": "EUR", "config": {"host": "massimodutti.com", "storeId": "35009489", "path": "mt"}},
    {"slug": "bershka-mt", "name": "Bershka", "brand": "Bershka", "segment": "mid", "geo": "MT", "adapter": "itx", "baseUrl": "https://www.bershka.com/mt/", "currency": "EUR", "config": {"host": "bershka.com", "storeId": "45109539", "path": "mt"}},
    {"slug": "pullandbear-mt", "name": "Pull&Bear", "brand": "Pull&Bear", "segment": "mid", "geo": "MT", "adapter": "itx", "baseUrl": "https://www.pullandbear.com/mt/", "currency": "EUR", "config": {"host": "pullandbear.com", "storeId": "25009539", "path": "mt"}},
    {"slug": "stradivarius-mt", "name": "Stradivarius", "brand": "Stradivarius", "segment": "mid", "geo": "MT", "adapter": "itx", "baseUrl": "https://www.stradivarius.com/mt/", "currency": "EUR", "config": {"host": "stradivarius.com", "storeId": "55009589", "path": "mt", "gender": "woman"}},
    {"slug": "oysho-mt", "name": "Oysho", "brand": "Oysho", "segment": "mid", "geo": "MT", "adapter": "itx", "baseUrl": "https://www.oysho.com/mt/", "currency": "EUR", "config": {"host": "oysho.com", "storeId": "65009639", "path": "mt", "gender": "woman"}},
    {"slug": "zara-ua", "name": "Zara Украина", "brand": "Zara", "segment": "mid", "geo": "UA", "adapter": "zara", "baseUrl": "https://www.zara.com/ua/uk/", "currency": "UAH", "config": {"path": "ua/uk"}},
]

UA = """
Sinsay | budget | https://www.sinsay.com/ua/uk/
LC Waikiki | budget | https://www.lcwaikiki.ua/
House | budget | https://www.housebrand.com/ua/uk/
Cropp | budget | https://www.cropp.com/ua/uk/
Colin's | budget | https://www.colins.ua/
CCC | budget | https://ccc.eu/ua
Decathlon | budget | https://www.decathlon.ua/
Goldi | budget | https://goldi.ua/
Staff | budget | https://www.staff-clothes.com/
Garne | budget | https://garne.com.ua/
Kasta | budget | https://kasta.ua/
Rozetka | budget | https://rozetka.com.ua/
H&M | mid | https://www2.hm.com/uk_ua/
Reserved | mid | https://www.reserved.com/ua/uk/
Mohito | mid | https://www.mohito.com/ua/uk/
Mango | mid | https://shop.mango.com/ua
Bershka | mid | https://www.bershka.com/ua/
Pull&Bear | mid | https://www.pullandbear.com/ua/
Stradivarius | mid | https://www.stradivarius.com/ua/
Oysho | mid | https://www.oysho.com/ua/
Tezenis | mid | https://www.tezenis.com/ua/
Calzedonia | mid | https://www.calzedonia.com/ua/
Intimissimi | mid | https://www.intimissimi.com/ua/
adidas | mid | https://www.adidas.ua/
Puma | mid | https://ua.puma.com/
New Balance | mid | https://newbalance.ua/
Columbia | mid | https://columbia.ua/
Intertop | mid | https://intertop.ua/
Answear | mid | https://answear.ua/
Argo | mid | https://argo.ua/
Intersport | mid | https://intersport.ua/
Megasport | mid | https://megasport.ua/
Vovk | mid | https://vovk.com/ua/
Gepur | mid | https://gepur.com/
Must Have | mid | https://musthave.ua/
Arber | mid | https://arber.ua/
Andre Tan | mid | https://andretan.ua/
One by One | mid | https://onebyone.ua/
Solmar | mid | https://solmar.com.ua/ua/
Stimma | mid | https://stimma.com.ua/
Cher'17 | mid | https://cher17.com/
Papaya | mid | https://papaya.ua/
Rikky Hype | mid | https://rikkyhype.com/ua/
Etnodim | mid | https://etnodim.com/
Dolcedonna | mid | https://dolcedonna.com.ua/
Massimo Dutti | premium | https://www.massimodutti.com/ua/
Lacoste | premium | https://lacoste.ua/
MD Fashion | premium | https://md-fashion.ua/
Modivo | premium | https://modivo.ua/
Kachorovska | premium | https://kachorovska.com/
The Coat by Katya Silchenko | premium | https://thecoat.com.ua/
Gunia Project | premium | https://guniaproject.com.ua/
Sleeper | premium | https://the-sleeper.com/
TSUM Kyiv | luxury | https://tsum.ua/
Helen Marlen | luxury | https://helen-marlen.com/
Symbol | luxury | https://symbol.ua/
Sanahunt | luxury | https://sanahunt.com/
Kameron | luxury | https://kameron.ua/
Ostriv | luxury | https://ostriv.ua/
Bevza | luxury | https://bevza.com/
Ruslan Baginskiy | luxury | https://ruslanbaginskiy.com/
"""

# Сайт пуст — у бренда на Мальте только обычные магазины (или интернет-магазин не подтверждён).
MT = """
Kiabi | budget | https://www.kiabi.com.mt/
Terranova | budget |
LC Waikiki | budget | https://retail.com.mt/
New Yorker | budget |
Calliope | budget |
Piazza Italia | budget |
Matalan | budget |
Sports Direct | budget | https://www.sportsdirect.mt/
Mango | mid | https://shop.mango.com/mt/en
H&M | mid | https://www2.hm.com/en_mt/
Next | mid | https://www.next.com.mt/en
Marks & Spencer | mid | https://retail.com.mt/
ASOS | mid | https://www.asos.com/
Hudson Store | mid | https://hudsonstore.com/
Nike | mid | https://hudsonstore.com/
adidas | mid |
Urban Jungle | mid | https://urbanjunglestore.com/
Skechers | mid |
Springfield | mid | https://myspringfield.com.mt/
Women'secret | mid | https://womensecret.com.mt/
Cortefiel | mid |
Lindex | mid |
United Colors of Benetton | mid |
Celio | mid |
Dan John | mid |
Punt Roma | mid | https://retail.com.mt/
Aldo | mid | https://retail.com.mt/
Accessorize | mid |
Bata | mid |
Darmanin Footwear | mid |
Tezenis | mid | https://tezenismalta.com/
Intimissimi | mid | https://www.intimissimi.com/mt/
Calzedonia | mid |
Desigual | mid | https://www.desigual.com/en_MT/
Levi's | mid |
Victoria's Secret | mid |
MVintage | mid |
Tommy Hilfiger | premium | https://hudsonstore.com/
Calvin Klein | premium | https://hudsonstore.com/
Guess | premium | https://www.guess.com/en-mt/
Armani Exchange | premium | https://hudsonstore.com/
Lacoste | premium |
Polo Ralph Lauren | premium |
BOSS | premium | https://www.hugoboss.com/mt/en/home
Gant | premium |
Liu Jo | premium |
Harmont & Blaine | premium |
Bortex | premium |
Charles & Ron | premium |
Dune London | premium |
Sarto | luxury |
Mytheresa | luxury | https://www.mytheresa.com/
Farfetch | luxury | https://www.farfetch.com/mt/
YOOX | luxury | https://www.yoox.com/mt
"""

TR = {"&": "and", "'": ""}


def slug(name, geo):
    s = name.lower()
    for a, b in TR.items():
        s = s.replace(a, b)
    return (re.sub(r"[^a-z0-9]+", "-", s).strip("-") + "-" + geo.lower())[:60]


def rows(text, geo):
    out = []
    for line in text.strip().splitlines():
        if not line.strip() or line.startswith("#"):
            continue
        name, segment, url = [p.strip() for p in line.split("|")]
        assert segment in ("budget", "mid", "premium", "luxury"), line
        out.append({"slug": slug(name, geo), "name": name, "brand": name, "segment": segment, "geo": geo, "adapter": "manual", "baseUrl": url, "currency": "UAH" if geo == "UA" else "EUR"})
    return out


stores = AUTO + rows(MT, "MT") + rows(UA, "UA")
slugs = [s["slug"] for s in stores]
assert len(slugs) == len(set(slugs)), [s for s in slugs if slugs.count(s) > 1]
path = os.path.join(os.path.dirname(__file__), "..", "..", "prisma", "seed-data", "stylist-stores.json")
with io.open(path, "w", encoding="utf-8", newline="\n") as f:
    f.write("[\n" + ",\n".join("  " + json.dumps(s, ensure_ascii=False) for s in stores) + "\n]\n")
print(len(stores), "stores")
