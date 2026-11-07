import csv, json, re, sys
sys.stdout.reconfigure(encoding='utf-8')


def lj(p):
    try:
        return json.loads(open(p, encoding='utf-8-sig').read())
    except Exception:
        return {}


artd = lj('artdates.json')
TODAY = __import__('datetime').date.today()


def months(d):
    y, m, dd = map(int, d.split('-'))
    return round(((TODAY - __import__('datetime').date(y, m, min(dd, 28))).days) / 30.44, 1)


def art_stats(s):
    ages = [months(artd[u]) for u, _, _ in s.get('top', []) if u and artd.get(u)]
    ages = [a for a in ages if a >= 0]
    if not ages:
        return ['', '', '', 0]
    return [min(ages), max(ages), round(sum(ages) / len(ages), 1), len(ages)]


vol = lj('vol.json')
serp = lj('serp.json')
for _k, _v in lj('serp_w.json').items():
    if _v.get('n') and ('views' in _v or 'views' not in serp.get(_k, {})):
        serp[_k] = _v
serp = {k: v for k, v in serp.items() if v.get('n')}
volci = {k.lower(): v for k, v in vol.items()}
serpci = {k.lower(): v for k, v in serp.items()}


def vnum(v):
    if not v:
        return None
    if v.get('none'):
        return 0
    if 'estimate' in v:
        return v['estimate']
    m = re.match(r'(\d+)k-(\d+)k', v.get('ui', '').replace(' ', ''))
    return (int(m.group(1)) + int(m.group(2))) * 500 if m else None


def hum(s):
    return re.sub(r'\s+', ' ', re.sub(r'[-_]+', ' ', s)).strip()


