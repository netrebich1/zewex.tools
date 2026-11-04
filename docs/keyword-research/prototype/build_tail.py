

def pct(a, b):
    return f"{round(100 * a / b)}%" if b else ''


def verdict(v, s):
    if v is not None and v < 3000:
        return '❌ мало частоты'
    if not s or 'tmatch' not in s:
        return ''
    com = s['ad'] + s['prod']
    med = s['med'] if s['med'] is not None else 10 ** 9
    fol = s['fol'] if s['fol'] is not None else 10 ** 9
    weak_opt = s['org'] and s['tmatch'] / s['org'] <= 0.25
    if com >= 10:
        return '❌ реклама/товары'
    easy_signal = med <= 100 or (s['fresh3'] >= 3 and med <= 1000) or (weak_opt and fol <= 5000 and med <= 1000)
    if s['ad'] <= 2 and s['prod'] <= 2 and s['big'] <= 2 and easy_signal and (v is None or v <= 500000):
        return '✅ изи'
    if com <= 7 and (s['fresh'] >= 2 or med <= 500):
        return '🟡 средний'
    return '🔴 тяжёлый'


def flags(s, art):
    f = []
    if not s or 'tmatch' not in s:
        return ''
    n = s['n'] or 1
    if s['video'] / n >= 0.5:
        f.append('📹 видео-выдача')
    if s['big'] >= 3:
        f.append('🏢 крупные СМИ')
    if s['org'] and s['tmatch'] / s['org'] <= 0.25:
        f.append('🎯 слабая оптимизация топа')
    if s['fol'] is not None and s['fol'] <= 1000:
        f.append('👶 малые аккаунты в топе')
    if art[2] != '' and art[2] >= 24:
        f.append('🕰 старые статьи в топе')
    if s.get('resaved') is not None and s['org'] and s['resaved'] / s['org'] >= 0.4:
        f.append('🔁 в топе пересохранения пользователей')
    if s['ndom'] and s['udom'] <= 3 and s['ndom'] >= 5:
        f.append('🔒 топ держат 1-3 сайта')
    return ', '.join(f)


# ---------- variations (same intent, only neutral modifiers) ----------
ADJ = ['trendy', 'classy', 'simple', 'cute', 'easy', 'best', 'elegant', 'chic', 'pretty', 'modern', 'stylish',
       'beautiful', 'gorgeous', 'aesthetic', 'timeless', 'popular', 'unique', 'cool']
SUF = {'ideas': 'Ideas', 'idea': 'Ideas', 'inspo': 'Inspo', 'inspiration': 'Inspiration', 'looks': 'Looks',
       'designs': 'Designs', 'design': 'Designs', 'design ideas': 'Design Ideas', 'styles': 'Styles'}
SMALL = {'for', 'with', 'and', 'the', 'of', 'a', 'to', 'in', 'on', 'an', 'or', 'at'}


def tc(s):
    w = s.split()
    return ' '.join(x if (x.lower() in SMALL and i) else (x[:1].upper() + x[1:]) for i, x in enumerate(w))


def sing(word):
    if word.endswith('ies'):
        return word[:-3] + 'y'
    if word.endswith('s') and not word.endswith('ss'):
        return word[:-1]
    return word


def with_suffix(k, suf):
    m = re.match(r'(.+?)( (?:for|with|on|over|under) .+)$', k, re.I)
    head, tail = (m.group(1), m.group(2)) if m else (k, '')
    hw = head.split()
    if suf in ('Ideas', 'Inspo', 'Inspiration', 'Designs', 'Design Ideas', 'Looks', 'Styles'):
        if hw[-1].lower() in ('ideas', 'designs', 'inspo', 'looks', 'styles'):
            return None
        hw[-1] = sing(hw[-1])
    return ' '.join(hw) + ' ' + suf + tail


def variants(k, ta):
    lk = k.lower().strip()
    out = []

    def push(x):
        if x and tc(x).lower() != lk and tc(x) not in out:
            out.append(tc(x))

    starts_adj = lk.split()[0] in ADJ
    m = re.match(r'how to style (.+)$', lk) or re.match(r'what to wear with (.+)$', lk)
    if m:
        x = m.group(1)
        for t in (f'ways to style {x}', f'easy ways to style {x}', f'cute ways to style {x}', f'how to wear {x}',
                  f'what to wear with {x}' if lk.startswith('how') else f'how to style {x}'):
            push(t)
        return out[:5]
    if re.match(r'(how|what|why|which|best way|types of|colors that|can|does|is) ', lk):
        return []  # question/guide keywords: modifiers would shift intent
    # 1) confirmed by Pinterest autocomplete
    for s in ta:
        s = hum(s).lower()
        if not s.startswith(lk + ' '):
            continue
        extra = s[len(lk):].strip()
        if extra in ADJ and not starts_adj:
            push(f'{extra} {k}')
        elif extra in SUF:
            push(with_suffix(k, SUF[extra]))
    # 2) template fill
    if not starts_adj:
        for a in ('trendy', 'classy', 'simple', 'cute', 'easy', 'elegant', 'best', 'chic'):
            if len(out) >= 5:
                break
            push(f'{a} {k}')
    if len(out) < 5:
        push(with_suffix(k, 'Ideas'))
    if len(out) < 5:
        push(with_suffix(k, 'Inspo'))
    return out[:5]


EXTRA = ['Частотность (аудитория US/мес)', 'Диапазон', 'Оценка возможности (0-100)', 'Вердикт', 'Флаги', 'Ищут с годом (2025-2027)', 'Выдача снята с аккаунта',
         'Вариация 1', 'Вариация 2', 'Вариация 3', 'Вариация 4', 'Вариация 5',
         'Пинов на 1 экране', 'Пинов на 1 экране %', 'Реклама', 'Реклама %', 'Товары', 'Товары %', 'Инфо-пины со ссылкой', 'Инфо-пины %',
         'Пины без ссылки', 'Без ссылки %', 'Видео-пины', 'Видео %', 'Пинов < 3 мес', 'Пинов < 3 мес %',
         'Пинов < 6 мес', 'Пинов < 6 мес %', 'От владельца сайта', 'От владельца %', 'Пересохранения пользователей', 'Пересохранения %', 'Ключ в заголовке (органика)', 'Ключ в заголовке %',
         'Медиана сохранений топа', 'Медиана подписчиков авторов', 'Бизнес-аккаунты в топ-10', 'Бизнес-аккаунты %', 'Личные аккаунты в топ-10', 'Личные аккаунты %', 'Бизнес: просмотры/мес мин', 'Бизнес: просмотры/мес среднее', 'Бизнес: просмотры/мес макс', 'Бизнес: охват/мес мин', 'Бизнес: охват/мес среднее', 'Бизнес: охват/мес макс', 'Бизнес: подписчики мин', 'Бизнес: подписчики среднее', 'Бизнес: подписчики макс', 'Бизнес: пинов среднее', 'Бизнес: досок среднее', 'С подтверждённым сайтом', 'С подтверждённым сайтом %', 'Проверенные магазины', 'Проверенные магазины %', 'Ссылок в топ-10', 'Ссылок в топ-10 %', 'Разных доменов в топ-10', 'Разных доменов %',
         'Крупные СМИ/магазины в топ-10', 'Крупные СМИ %', 'Число в заголовках топа (медиана)',
         'Самая свежая статья топ-10 (мес)', 'Самая старая статья топ-10 (мес)', 'Средний возраст статей (мес)',
         'Статей с датой', 'Статей с датой %', 'Подсказки поиска', 'Уточнения (чипсы)', 'Топ-10: ссылка | дата пина | сохранения']


def prof(s):
    ul = s.get('ul')
    if ul is None:
        return [''] * 19
    n = len(ul)
    biz = [u for u in ul if u[5]]

    def trio(idx):
        a = [u[idx] for u in biz if u[idx] is not None and u[idx] >= 0]
        return [min(a), round(sum(a) / len(a)), max(a)] if a else ['', '', '']

    def avg(idx):
        a = [u[idx] for u in biz if u[idx] is not None and u[idx] >= 0]
        return round(sum(a) / len(a)) if a else ''
    dv = sum(u[6] for u in ul)
    mer = sum(u[7] for u in ul)
    return ([len(biz), pct(len(biz), n), n - len(biz), pct(n - len(biz), n)] + trio(0) + trio(1) + trio(2) +
            [avg(3), avg(4), dv, pct(dv, n), mer, pct(mer, n)])


def score(v, s):
    """0-100: ease of the SERP x size of demand."""
    import math
    if not v or not s or 'tmatch' not in s or v < 3000:
        return ''
    n = s['n'] or 1
    org = s['org'] or 1
    ease = 100.0
    ease -= 100 * s['ad'] / n * 1.0
    ease -= 100 * s['prod'] / n * 1.0
    ease -= 100 * s['big'] / max(s['ndom'], 1) * 0.3
    ease -= 100 * s['tmatch'] / org * 0.25
    ease += 100 * s['fresh3'] / n * 0.25
    if s.get('ul') is not None and s['ul']:
        ease -= 100 * sum(u[5] for u in s['ul']) / len(s['ul']) * 0.25
    if s['med']:
        ease -= max(0, math.log10(s['med']) - 1) * 15
    ease = max(0, min(100, ease))
    # sweet spot = mid volume; head terms are hard, tiny ones bring little
    demand = 0.6 if v < 10000 else 0.85 if v < 50000 else 1.0 if v < 300000 else 0.8 if v < 1000000 else 0.6
    return round(ease * demand)


def year_flag(s):
    ta = ' '.join(s.get('ta', [])).lower()
    return 'да' if re.search(r'202[5-9]', ta) else ''


def extra(k):
    v = volci.get(k.lower())
    s = serpci.get(k.lower(), {})
    n = vnum(v)
    rng = f"{v['lower_bound']}-{v['upper_bound']}" if v and 'lower_bound' in v else (
        'нет данных (≈0)' if v and v.get('none') else '')
    ta = []
    for x in s.get('ta', []):
        h = hum(x)
        if h.lower() != k.lower() and h not in ta:
            ta.append(h)
    has = 'own' in s
    art = art_stats(s) if has else ['', '', '', '']
    art = art + [pct(art[3], s.get('ndom', 0)) if has and art[3] != '' else '']
    var = variants(k, s.get('ta', []))
    var += [''] * (5 - len(var))
    top = ' || '.join(f'{u or "без ссылки"} | {d} | {sv}' for u, d, sv in s.get('top', []))
    if has:
        tot = s['n'] or 1
        cells = [s['n'], pct(s['n'], 20)]
        for key in ('ad', 'prod', 'info', 'nolink', 'video', 'fresh3', 'fresh'):
            cells += [s[key], pct(s[key], tot)]
        cells += [s.get('own', ''), pct(s.get('own', 0), s['org']), s.get('resaved', ''), pct(s.get('resaved', 0), s['org'])]
        cells += [s['tmatch'], pct(s['tmatch'], s['org']), s['med'] if s['med'] is not None else '',
                  s['fol'] if s['fol'] is not None else ''] + prof(s) + [s['ndom'], pct(s['ndom'], 10), s['udom'], pct(s['udom'], s['ndom']), s['big'], pct(s['big'], s['ndom']),
                  s['listn'] if s['listn'] is not None else '']
    else:
        cells = [''] * 50
    return ([n if n is not None else '', rng, score(n, s), verdict(n, s), flags(s, art), year_flag(s), s.get('acc', 'SEO Netrebich') if s.get('n') else ''] + var + cells + art +
            ['; '.join(ta), ', '.join(s.get('guides', [])), top])


rows = list(csv.reader(open('evergreen.tsv', encoding='utf-8'), delimiter='\t'))
out = [rows[0][:6] + EXTRA] + [r[:6] + extra(r[2]) for r in rows[1:]]
with open('paste.tsv', 'w', encoding='utf-8', newline='') as f:
    csv.writer(f, delimiter='\t', lineterminator='\n').writerows(out)

known = {r[2].lower() for r in rows[1:]}
new = [k for k in vol if k.lower() not in known]
new.sort(key=lambda k: -(vnum(vol[k]) or 0))
nout = [['Ключ', 'Ниша'] + EXTRA]
for k in new:
    lk = k.lower()
    niche = 'Ногти' if re.search(r'nail|manicure|pedicure|cuticle|biab|french tip', lk) else (
        'Одежда' if re.search(r'outfit|wear|dress|style |styl|wardrobe|jeans|skirt|pants|color|colour|kibbe|fashion|'
                              r'shoes|boots|types of|tuck|cuff|scarf|attire|look |blazer|sneakers|loafers|flats|'
                              r'jacket|coat|bag|jewelry|necklace|tee|top|shirt', lk) else 'Волосы')
    nout.append([k, niche] + extra(k))
with open('paste_new.tsv', 'w', encoding='utf-8', newline='') as f:
    csv.writer(f, delimiter='\t', lineterminator='\n').writerows(nout)

from collections import Counter
H = out[0]
iv, isn, ivd = H.index('Частотность (аудитория US/мес)'), H.index('Пинов на 1 экране'), H.index('Вердикт')
print('evergreen vol', sum(1 for r in out[1:] if r[iv] != ''), 'serp', sum(1 for r in out[1:] if r[isn] != ''),
      dict(Counter(r[ivd] for r in out[1:] if r[ivd])))
print('new rows', len(nout) - 1, 'new with serp', sum(1 for r in nout[1:] if r[2 + EXTRA.index('Пинов на 1 экране')] != ''))
