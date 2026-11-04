import re, csv, sys
hard = r"\b(winter|spring|summer|fall|autumn|christmas|holiday|thanksgiving|friendsgiving|new years?|nye|valentines?|galentines|st patricks|easter|4th of july|halloween|mardi gras|super bowl|prom|graduation|homecoming|spring break|coachella|festival|kentucky derby|beach|vacation|cruise|snow|snowflake|ski|apres ski|cold weather|uggs|parka|peacoat|puffer|wool coat|teddy coat|sundress(es)?|linen|shorts|jorts|sandals|rainy day|picnic|garden party|frosted|icy nails|europe summer|mexico vacation|bid day|school dance|back to school|f1)\b"
soft = r"\b(sweater|turtleneck|cardigan|beanie|scarf|tights|coat|boots?|velvet|plaid|burgundy|oxblood|black cherry|mulled wine|plum|espresso|chocolate brown|jewel tone|emerald|knit|hoodie|sweatshirt|leather jacket|trench|pastel|lavender|lilac|mint green|coral|peach|neon|butter yellow|daisy|strawberry|espadrille|sunglasses|crocs|birkenstock|capri|bike shorts|tube top|tank top|crop top|halter|off the shoulder|strapless|backless|bucket hat|baseball cap|cherry|icy blue|pedicure|toe nails|wedding|bridesmaid|bridal|bachelorette|baby shower|rodeo|nashville|country concert|cozy|chunky knit|bubble braid|island twists)\b"
trend = r"\b(trends?|2027)\b"
rows=list(csv.reader(open('src.tsv',encoding='utf-8'),delimiter='\t'))
hdr,data=rows[0],rows[1:]
out=[];removed=[];softl=[];tr=[]
for r in data:
    k=r[2].lower()
    if r[2] in ('Beach Waves',): out.append(r+['']); continue
    if r[2] in ('Strawberry Blonde','Bubble Braid','Island Twists'): out.append(r+['']); continue
    if re.search(hard,k): removed.append(r[2]); continue
    tag=''
    if re.search(trend,k): tag='тренды (привязка к году)'; tr.append(r[2])
    elif re.search(soft,k): tag='мягкая сезонность'; softl.append(r[2])
    out.append(r+[tag])
with open('evergreen.tsv','w',encoding='utf-8',newline='') as f:
    w=csv.writer(f,delimiter='\t'); w.writerow(hdr+['Сезонность']); w.writerows(out)
print(len(data),'kept',len(out),'removed',len(removed),'soft',len(softl),'trend',len(tr))
print('REMOVED:', '; '.join(removed))
print('SOFT:', '; '.join(softl))
print('TREND:', '; '.join(tr))
