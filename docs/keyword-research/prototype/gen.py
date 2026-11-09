import json, re, csv
C = set()


def add(*xs):
    for x in xs:
        x = re.sub(r'\s+', ' ', x).strip()
        if x:
            C.add(x[0].upper() + x[1:])


# ---------- HAIR ----------
hair_heads = ['hairstyles', 'haircuts', 'hair color ideas', 'short haircuts', 'bob haircuts', 'pixie haircuts',
              'layered haircuts', 'updos', 'braids', 'bangs', 'highlights', 'balayage', 'easy hairstyles',
              'hairstyle ideas', 'haircut ideas']
hair_aud = ['for women over 40', 'for women over 50', 'for women over 60', 'for women over 70', 'for older women',
            'for fine hair', 'for thin hair', 'for thick hair', 'for curly hair', 'for wavy hair', 'for straight hair',
            'for frizzy hair', 'for thinning hair', 'for round face', 'for oval face', 'for square face',
            'for heart shaped face', 'for long face', 'for double chin', 'for big forehead', 'for glasses',
            'for short hair', 'for medium length hair', 'for long hair', 'for black women', 'for teens', 'for moms',
            'for little girls', 'for work', 'for school', 'for gray hair', 'for coarse hair', 'for natural hair',
            'for petite women', 'for plus size women', 'for chubby face']
for h in hair_heads:
    for a in hair_aud:
        add(f'{h} {a}')
add(*['how to style curtain bangs', 'how to cut curtain bangs', 'how to do a messy bun', 'how to do a french braid',
      'how to dutch braid your own hair', 'how to do a fishtail braid', 'how to braid your own hair',
      'how to curl hair with a flat iron', 'how to curl hair without heat', 'heatless curls overnight',
      'how to get beach waves', 'how to do a sleek ponytail', 'how to make hair look thicker', 'how to style short hair',
      'how to style a bob', 'how to style a pixie cut', 'how to style layered hair', 'how to style wavy hair',
      'how to style curly hair', 'how to style thin hair', 'how to grow out bangs', 'how to grow out a pixie cut',
      'how to grow hair faster', 'how to get volume at the roots', 'how to style hair with a claw clip',
      'how to do a half up half down', 'how to do a low bun', 'how to do space buns', 'how to do a crown braid',
      'how to do a milkmaid braid', 'how to do a bubble braid', 'how to do box braids', 'how to do knotless braids',
      'how to take care of braids', 'how to blend gray hair', 'how to transition to gray hair',
      'how to go gray gracefully', 'how to choose hair color for skin tone', 'hair color for cool skin tone',
      'hair color for warm skin tone', 'hair color for neutral skin tone', 'best hair color for brown eyes',
      'best hair color to hide gray', 'best hair color for older women', 'best haircut for thin hair',
      'best haircut for fine hair', 'best haircut for round face', 'best haircut for long face',
      'best bangs for round face', 'best layers for thin hair', 'what haircut should i get',
      'what hair color should i get', 'face shape hairstyles', 'hairstyles that make you look younger',
      'haircuts that make you look younger', 'haircuts that make you look thinner',
      'low maintenance haircuts for busy moms', 'wash and go haircuts', 'haircuts for women with cowlicks',
      'hairstyles for wet hair', 'hairstyles for dirty hair', 'hairstyles for sleeping', 'lazy day hairstyles',
      '5 minute hairstyles', 'hairstyles for working out', 'hairstyles for hats', 'hairstyles to hide thinning hair',
      'hairstyles to hide grey roots', 'hairstyles for hair loss', 'hair growth tips', 'hair care routine',
      'hair care tips', 'hair mask diy', 'hair oil for hair growth', 'how to stop frizzy hair',
      'how to fix damaged hair', 'how to fix split ends', 'hair types chart', 'curl pattern chart', 'hair color chart',
      'hair color names', 'blonde shades chart', 'brown hair color chart', 'red hair color chart',
      'toner for brassy hair', 'purple shampoo before and after'])

# ---------- NAILS ----------
nail_heads = ['nail designs', 'nail ideas', 'nail art', 'nail colors', 'short nail designs', 'simple nail designs',
              'french tip nails', 'gel nail designs', 'acrylic nail designs', 'almond nail designs',
              'square nail designs', 'coffin nail designs', 'oval nail designs', 'dip nail designs', 'manicure ideas',
              'pedicure ideas']
nail_mod = ['for beginners', 'for short nails', 'for long nails', 'for work', 'for women over 40', 'for women over 50',
            'for women over 60', 'for older women', 'for pale skin', 'for dark skin', 'for tan skin', 'for olive skin',
            'for kids', 'for teens', 'at home', 'easy', 'simple', 'classy', 'elegant', 'minimalist', 'natural',
            'neutral', 'nude', 'black', 'white', 'pink', 'red', 'blue', 'green', 'purple', 'brown', 'gray', 'silver',
            'gold', 'with glitter', 'with gems', 'with rhinestones', 'with flowers', 'with hearts', 'with stars',
            'with lines', 'with dots', 'ombre', 'chrome', 'matte', 'abstract', 'cute', 'aesthetic', 'unique', 'trendy',
            '2 color', 'one color', 'for wide nail beds', 'for small nails', 'for chubby fingers', 'for bitten nails']
for h in nail_heads:
    for m in nail_mod:
        add(f'{h} {m}' if m.startswith(('for', 'with', 'at')) else f'{m} {h}')
add(*['how to do french tip nails at home', 'how to do gel nails at home', 'how to do nail art at home',
      'how to do ombre nails', 'how to do chrome nails', 'how to do dip powder nails at home',
      'how to apply press on nails', 'how to make press on nails last', 'how to remove gel nails at home',
      'how to remove acrylic nails at home', 'how to remove dip powder nails', 'how to grow nails fast',
      'how to grow nails longer', 'how to strengthen weak nails', 'how to fix a broken nail', 'how to stop biting nails',
      'how to shape nails', 'how to file nails', 'how to push back cuticles', 'cuticle care', 'nail care routine',
      'nail care tips', 'healthy nails tips', 'nail shapes chart', 'nail shapes for short fingers',
      'nail shapes for chubby fingers', 'best nail shape for short fingers', 'best nail color for pale skin',
      'best nail color for dark skin', 'best nail color for tan skin', 'nail colors for older hands',
      'nail colors that make hands look younger', 'nail polish colors that go with everything',
      'neutral nail colors for work', 'nail art for beginners', 'easy nail art designs', 'nail art tools for beginners',
      'dotting tool nail art', 'nail stamping designs', 'nail stickers designs', 'gel vs acrylic nails',
      'builder gel vs gel x', 'biab nails', 'biab nail designs', 'russian manicure', 'japanese manicure',
      'korean nail art', 'structured gel manicure', 'nail polish hacks', 'diy nail art with tape', 'toe nail designs',
      'toenail colors', 'pedicure colors for pale skin', 'pedicure colors for dark skin', 'short gel nails ideas',
      'short acrylic nails ideas', 'natural nail designs', 'minimalist nail art', 'negative space nails',
      'vertical french tip nails', 'micro french tip', 'double french tip', 'skittle nails', 'tuxedo nails',
      'quiet luxury nails', 'old money nails ideas', 'clean girl nails ideas', 'soap nails', 'glass nails',
      'jelly nails ideas', 'aura nails ideas', 'velvet nails ideas', 'cat eye nails ideas', 'marble nails ideas',
      'tortoise shell nails ideas'])

# ---------- OUTFITS ----------
out_heads = ['outfits', 'outfit ideas', 'casual outfits', 'work outfits', 'business casual outfits', 'date night outfits',
             'going out outfits', 'church outfits', 'travel outfits', 'airport outfits', 'everyday outfits',
             'weekend outfits', 'classy outfits', 'comfy outfits', 'capsule wardrobe']
out_aud = ['for women over 40', 'for women over 50', 'for women over 60', 'for women over 70', 'for older women',
           'for plus size women', 'for petite women', 'for tall women', 'for curvy women', 'for apple shape',
           'for pear shape', 'for hourglass shape', 'for inverted triangle body shape', 'for rectangle body shape',
           'for short legs', 'for big busts', 'for big tummy', 'for moms', 'for teens', 'for college students',
           'for teachers', 'for nurses', 'for office', 'for interview', 'for black women', 'for short women',
           'for midsize women', 'on a budget', 'with jeans', 'with leggings', 'with sneakers', 'with black pants',
           'with flats', 'with loafers']
for h in out_heads:
    for a in out_aud:
        add(f'{h} {a}')
items = ['black jeans', 'wide leg jeans', 'straight leg jeans', 'mom jeans', 'baggy jeans', 'flare jeans', 'white jeans',
         'cargo pants', 'wide leg pants', 'black pants', 'leggings', 'flare leggings', 'maxi skirt', 'midi skirt',
         'mini skirt', 'denim skirt', 'pleated skirt', 'satin skirt', 'slip skirt', 'leather skirt', 'blazer',
         'oversized blazer', 'cardigan', 'white shirt', 'button down shirt', 'denim jacket', 'leather jacket',
         'trench coat', 'vest', 'sweater vest', 'turtleneck', 'loafers', 'ballet flats', 'mary janes', 'white sneakers',
         'ankle boots', 'chelsea boots', 'knee high boots', 'combat boots', 'cowboy boots', 'kitten heels',
         'slingbacks', 'clogs', 'birkenstocks', 'converse', 'new balance', 'adidas samba', 'claw clip', 'silk scarf',
         'headband', 'baseball cap', 'beret', 'tote bag', 'crossbody bag', 'pearl necklace', 'gold jewelry',
         'silver jewelry', 'jumpsuit', 'slip dress', 'black dress', 'wrap dress', 'shirt dress', 'sweater dress',
         'denim dress', 'tank top', 'graphic tee', 'bodysuit', 'corset top', 'crop top']
for i in items:
    add(f'how to style {i}', f'what to wear with {i}', f'{i} outfit ideas', f'how to style {i} for work')
colors = ['brown', 'navy', 'olive green', 'sage green', 'burgundy', 'beige', 'camel', 'gray', 'black', 'white', 'cream',
          'pink', 'red', 'blue', 'green', 'purple', 'yellow', 'orange', 'emerald green', 'light blue', 'mustard']
for c in colors:
    add(f'colors that go with {c}', f'what colors go with {c}', f'{c} color combinations outfit',
        f'how to style {c} outfit')
add(*['how to dress for your body type', 'how to dress for apple shape', 'how to dress for pear shape',
      'how to dress for hourglass figure', 'how to dress for rectangle body shape', 'how to dress for inverted triangle',
      'how to look taller', 'how to look thinner in clothes', 'how to dress older women', 'how to dress in your 40s',
      'how to dress in your 50s', 'how to dress in your 60s', 'how to look expensive on a budget',
      'how to look put together', 'how to dress classy', 'how to dress like old money',
      'how to dress like a french woman', 'how to dress minimalist', 'how to build a capsule wardrobe',
      'capsule wardrobe checklist', 'capsule wardrobe for moms', 'capsule wardrobe for work',
      'capsule wardrobe for travel', 'capsule wardrobe over 50', 'wardrobe essentials list', 'closet essentials women',
      'basic wardrobe pieces', 'how to layer clothes', 'how to tuck a shirt', 'french tuck', 'how to cuff jeans',
      'how to roll sleeves', 'how to tie a silk scarf', 'how to wear a scarf', 'color analysis',
      'seasonal color analysis', 'soft autumn color palette', 'deep winter color palette', 'true summer color palette',
      'light spring color palette', 'kibbe body types', 'kibbe soft natural', 'kibbe soft classic',
      'kibbe flamboyant natural', 'kibbe romantic', 'body shape calculator', 'how to find your style',
      'personal style aesthetics list', 'fashion aesthetics list', 'outfit formulas', 'outfit formulas for women',
      'what to wear to a wedding as a guest', 'what to wear to a funeral', 'what to wear to an interview',
      'what to wear to a concert', 'what to wear on a first date', 'what to wear to church', 'what to wear on a plane',
      'what to wear to dinner', 'what to wear to brunch', 'what to wear to a baby shower', 'dress code guide',
      'cocktail attire for women', 'business casual for women', 'smart casual for women',
      'black tie optional for women', 'semi formal attire for women', 'what shoes to wear with wide leg jeans',
      'what shoes to wear with flare jeans', 'what shoes to wear with a maxi dress',
      'what shoes to wear with a midi skirt', 'what top to wear with wide leg pants', 'what to wear with a black skirt',
      'jeans for body type', 'jeans size chart women', 'types of jeans', 'types of skirts', 'types of dresses',
      'types of necklines', 'types of sleeves', 'types of shoes for women', 'types of boots', 'types of bags',
      'types of coats', 'fashion vocabulary', 'fabric types'])

ex = set()
for f in ('evergreen.tsv', 'src.tsv'):
    for r in csv.reader(open(f, encoding='utf-8'), delimiter='\t'):
        ex.add(r[2].lower())
hard = re.compile(r"\b(winter|spring|summer|fall|autumn|christmas|holiday|thanksgiving|new years?|valentines?|easter|"
                  r"halloween|prom|graduation|beach|vacation|snow|ski)\b", re.I)
L = sorted(x for x in C if x.lower() not in ex and not hard.search(x))
json.dump(L, open('cand.json', 'w', encoding='utf-8'))
print(len(L))
