"""Build the volume queue: retry unreliable evergreen, then autocomplete suggestions, then short generated candidates."""
import json, re, csv, sys
sys.stdout.reconfigure(encoding='utf-8')
vol = json.loads(open('vol.json', encoding='utf-8-sig').read())
serp = json.loads(open('serp.json', encoding='utf-8-sig').read())
cand = json.load(open('cand.json', encoding='utf-8'))
ev = [r[2] for r in list(csv.reader(open('evergreen.tsv', encoding='utf-8'), delimiter='\t'))[1:]]
hard = re.compile(r"\b(winter|spring|summer|fall|autumn|christmas|holiday|thanksgiving|new years?|nye|valentines?|"
                  r"easter|halloween|prom|graduation|homecoming|beach|vacation|snow|ski|202[0-6]|men|mens|guys?|boys?)\b",
                  re.I)
done = {k.lower() for k, v in vol.items() if 'estimate' in v}


def hum(s):
    s = re.sub(r'[-_]+', ' ', s)
    s = re.sub(r'\s+', ' ', s).strip()
    return s[:1].upper() + s[1:]


q, seen = [], set()


def push(k):
    lk = k.lower()
    if lk in seen or lk in done or hard.search(k) or len(k) > 70:
        return
    seen.add(lk)
    q.append(k)


for k in ev:  # evergreen with missing/unreliable volume
    if k.lower() not in done:
        push(k)
n_ev = len(q)
for s in serp.values():  # real Pinterest autocomplete queries
    for t in s.get('ta', []):
        push(hum(t))
n_ta = len(q) - n_ev
for k in sorted(cand, key=lambda x: (len(x.split()), x)):
    push(k)
json.dump(q, open('volqueue.json', 'w', encoding='utf-8'))
print('queue', len(q), 'evergreen retry', n_ev, 'autocomplete', n_ta, 'generated', len(q) - n_ev - n_ta)
