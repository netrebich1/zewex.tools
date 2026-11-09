"""Competitors tab: which sites hold the top-10 across all analyzed keywords."""
import csv, json, re, sys, datetime
from collections import defaultdict
from urllib.parse import urlparse

sys.stdout.reconfigure(encoding='utf-8')


def lj(p):
    try:
        return json.loads(open(p, encoding='utf-8-sig').read())
    except Exception:
        return {}


serp = {k: v for k, v in lj('serp.json').items() if v.get('n')}
vol = {k.lower(): v for k, v in lj('vol.json').items()}
artd = lj('artdates.json')
today = datetime.date.today()
PLATFORM = re.compile(r'(instagram|tiktok|youtube|youtu\.be|facebook|pinterest|twitter|x\.com|reddit|etsy|amazon|'
                      r'shein|walmart|target|temu|aliexpress|ebay|nordstrom|zara|hm\.com|ulta|sephora)', re.I)


def months(d):
    y, m, dd = map(int, d.split('-'))
    return (today - datetime.date(y, m, min(dd, 28))).days / 30.44


def niche(k):
    k = k.lower()
    if re.search(r'nail|manicure|pedicure|cuticle|french tip|biab', k):
        return 'Ногти'
    if re.search(r'hair|braid|bob|bang|pixie|updo|balayage|highlight|blonde|brunette|loc|twist|bun|ponytail|shag|'
                 r'haircut|cornrow|layers|curls|wig|silk press|lob|wolf cut|cut$', k):
        return 'Волосы'
    return 'Одежда'


def vnum(v):
    if not v:
        return 0
    return v.get('estimate', 0) if not v.get('none') else 0


D = defaultdict(lambda: {'kws': set(), 'pins': 0, 'pos': [], 'ages': [], 'saves': [], 'niches': defaultdict(int),
                         'vol': 0})
total = len(serp)
for k, s in serp.items():
    seen = set()
    for pos, (u, d, sv) in enumerate(s.get('top', []), 1):
        if not u:
            continue
        host = urlparse(u).netloc.lower().replace('www.', '')
        if not host:
            continue
        e = D[host]
        e['pins'] += 1
        e['pos'].append(pos)
        if sv != '' and sv is not None:
            e['saves'].append(sv)
        if artd.get(u):
            a = months(artd[u])
            if a >= 0:
                e['ages'].append(a)
        if host not in seen:
            seen.add(host)
            e['kws'].add(k)
            e['niches'][niche(k)] += 1
            e['vol'] += vnum(vol.get(k.lower()))


def med(a):
    a = sorted(a)
    return a[len(a) // 2] if a else ''


rows = [['Домен', 'Тип', 'В топ-10 ключей', 'В топ-10 ключей %', 'Пинов в топ-10 всего', 'Средняя позиция в топ-10',
         'Суммарная частотность их ключей', 'Ногти (ключей)', 'Ногти %', 'Волосы (ключей)', 'Волосы %',
         'Одежда (ключей)', 'Одежда %', 'Медиана сохранений их пинов', 'Самая свежая статья (мес)',
         'Самая старая статья (мес)', 'Средний возраст статей (мес)', 'Статей с датой', 'Статей с датой %',
         'Примеры ключей']]
for host, e in sorted(D.items(), key=lambda kv: (-len(kv[1]['kws']), -kv[1]['pins'])):
    n = len(e['kws'])
    if n < 2:
        continue
    ages = e['ages']
    pct = lambda a, b: f'{round(100 * a / b)}%' if b else ''
    rows.append([host, 'платформа/магазин' if PLATFORM.search(host) else 'сайт/блог', n, pct(n, total), e['pins'],
                 round(sum(e['pos']) / len(e['pos']), 1), e['vol'],
                 e['niches']['Ногти'], pct(e['niches']['Ногти'], n), e['niches']['Волосы'], pct(e['niches']['Волосы'], n),
                 e['niches']['Одежда'], pct(e['niches']['Одежда'], n), med(e['saves']),
                 round(min(ages), 1) if ages else '', round(max(ages), 1) if ages else '',
                 round(sum(ages) / len(ages), 1) if ages else '', len(ages), pct(len(ages), e['pins']),
                 '; '.join(sorted(e['kws'], key=lambda k: -vnum(vol.get(k.lower())))[:8])])
with open('paste_comp.tsv', 'w', encoding='utf-8', newline='') as f:
    csv.writer(f, delimiter='\t', lineterminator='\n').writerows(rows)
print('keywords analyzed', total, 'domains total', len(D), 'in 2+ keywords', len(rows) - 1)
for r in rows[1:16]:
    print(r[0], '|', r[1], '|', r[2], r[3], '| age', r[16], '| saves', r[13])
