"""Fetch publish dates for top-10 article links in serp.json; cache in artdates.json (url -> 'YYYY-MM-DD' | '')."""
import json, re, sys, urllib.request, ssl, datetime
from concurrent.futures import ThreadPoolExecutor

sys.stdout.reconfigure(encoding='utf-8')
serp = json.loads(open('serp.json', encoding='utf-8-sig').read())
try:
    cache = json.load(open('artdates.json', encoding='utf-8'))
except Exception:
    cache = {}

urls = []
for v in serp.values():
    for u, _, _ in v.get('top', []):
        if u and u.startswith('http') and u not in cache and u not in urls:
            urls.append(u)

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE
UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'
PATS = [
    r'property=["\']article:published_time["\'][^>]*content=["\']([^"\']+)',
    r'content=["\']([^"\']+)["\'][^>]*property=["\']article:published_time',
    r'"datePublished"\s*:\s*"([^"]+)"',
    r'itemprop=["\']datePublished["\'][^>]*content=["\']([^"\']+)',
    r'name=["\'](?:date|publish[-_]?date|pubdate)["\'][^>]*content=["\']([^"\']+)',
    r'<time[^>]*datetime=["\']([^"\']+)',
    r'"dateModified"\s*:\s*"([^"]+)"',
]


def norm(s):
    m = re.search(r'(20\d\d|19\d\d)-(\d\d)-(\d\d)', s)
    if m:
        return m.group(0)
    return ''


def get(u):
    try:
        req = urllib.request.Request(u, headers={'User-Agent': UA, 'Accept': 'text/html'})
        with urllib.request.urlopen(req, timeout=15, context=ctx) as r:
            final = r.geturl()
            html = r.read(600000).decode('utf-8', 'ignore')
        for p in PATS:
            m = re.search(p, html, re.I)
            if m and norm(m.group(1)):
                return u, norm(m.group(1))
        m = re.search(r'/(20[12]\d)/(\d\d)/(?:(\d\d)/)?', final)
        if m:
            return u, f'{m.group(1)}-{m.group(2)}-{m.group(3) or "15"}'
        return u, ''
    except Exception:
        return u, ''


with ThreadPoolExecutor(24) as ex:
    for i, (u, d) in enumerate(ex.map(get, urls)):
        cache[u] = d
        if i % 100 == 0:
            json.dump(cache, open('artdates.json', 'w', encoding='utf-8'))
json.dump(cache, open('artdates.json', 'w', encoding='utf-8'))
found = sum(1 for u in urls if cache.get(u))
print('fetched', len(urls), 'dated', found, 'cache', len(cache))
