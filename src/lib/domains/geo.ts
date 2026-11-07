/**
 * Встроенная база гео-приставок для доменов: по каждой стране все формы, которые встречаются в доменах.
 * Пользователь гео-приставки не вводит — набор страны в подборе берётся отсюда.
 *
 * Уровни по умолчанию:
 * 1 — код страны (nl; для gb — uk, gb) и главное местное название (nederland), у англоязычных стран — английское название;
 * 2 — английское название (netherlands; из нескольких слов — слитно, если не длиннее 12 букв: newzealand) и прочие местные названия;
 * 3 — трёхбуквенный код (nld), сокращения и варианты (holland, dutch).
 */
import { countryByCode, type Country } from "./countries";

/** ISO 3166-1 alpha-3 (сверено с таблицей ISO по числовому коду). */
const ALPHA3 = new Map("af:afg,al:alb,dz:dza,as:asm,ad:and,ao:ago,ai:aia,ag:atg,ar:arg,am:arm,aw:abw,au:aus,at:aut,az:aze,bs:bhs,bh:bhr,bd:bgd,bb:brb,by:blr,be:bel,bz:blz,bj:ben,bm:bmu,bt:btn,bo:bol,ba:bih,bw:bwa,br:bra,bn:brn,bg:bgr,bf:bfa,bi:bdi,kh:khm,cm:cmr,ca:can,cv:cpv,ky:cym,cf:caf,td:tcd,cl:chl,cn:chn,co:col,km:com,cg:cog,cd:cod,ck:cok,cr:cri,ci:civ,hr:hrv,cu:cub,cw:cuw,cy:cyp,cz:cze,dk:dnk,dj:dji,dm:dma,do:dom,ec:ecu,eg:egy,sv:slv,gq:gnq,er:eri,ee:est,sz:swz,et:eth,fk:flk,fo:fro,fj:fji,fi:fin,fr:fra,gf:guf,pf:pyf,ga:gab,gm:gmb,ge:geo,de:deu,gh:gha,gi:gib,gr:grc,gl:grl,gd:grd,gp:glp,gu:gum,gt:gtm,gg:ggy,gn:gin,gw:gnb,gy:guy,ht:hti,hn:hnd,hk:hkg,hu:hun,is:isl,in:ind,id:idn,ir:irn,iq:irq,ie:irl,im:imn,il:isr,it:ita,jm:jam,jp:jpn,je:jey,jo:jor,kz:kaz,ke:ken,ki:kir,kw:kwt,kg:kgz,la:lao,lv:lva,lb:lbn,ls:lso,lr:lbr,ly:lby,li:lie,lt:ltu,lu:lux,mo:mac,mg:mdg,mw:mwi,my:mys,mv:mdv,ml:mli,mt:mlt,mh:mhl,mq:mtq,mr:mrt,mu:mus,yt:myt,mx:mex,fm:fsm,md:mda,mc:mco,mn:mng,me:mne,ms:msr,ma:mar,mz:moz,mm:mmr,na:nam,nr:nru,np:npl,nl:nld,nc:ncl,nz:nzl,ni:nic,ne:ner,ng:nga,nu:niu,nf:nfk,mk:mkd,mp:mnp,no:nor,om:omn,pk:pak,pw:plw,ps:pse,pa:pan,pg:png,py:pry,pe:per,ph:phl,pn:pcn,pl:pol,pt:prt,pr:pri,qa:qat,re:reu,ro:rou,ru:rus,rw:rwa,bl:blm,sh:shn,kn:kna,lc:lca,mf:maf,pm:spm,vc:vct,ws:wsm,sm:smr,st:stp,sa:sau,sn:sen,rs:srb,sc:syc,sl:sle,sg:sgp,sx:sxm,sk:svk,si:svn,sb:slb,so:som,za:zaf,kr:kor,ss:ssd,es:esp,lk:lka,sd:sdn,sr:sur,se:swe,ch:che,sy:syr,tw:twn,tj:tjk,tz:tza,th:tha,tl:tls,tg:tgo,tk:tkl,to:ton,tt:tto,tn:tun,tr:tur,tm:tkm,tc:tca,tv:tuv,ug:uga,ua:ukr,ae:are,gb:gbr,us:usa,uy:ury,uz:uzb,vu:vut,va:vat,ve:ven,vn:vnm,vg:vgb,vi:vir,wf:wlf,ye:yem,zm:zmb,zw:zwe,bq:bes".split(",").map((p) => p.split(":") as [string, string]));

export function alpha3(code: string): string | null {
  return ALPHA3.get(code.trim().toLowerCase()) ?? null;
}

/** Коды, которые в доменах пишут иначе или в дополнение к ISO alpha-2. */
const CODE_ALIASES: Record<string, string[]> = { gb: ["uk", "gb"], us: ["us", "usa"], ae: ["ae", "uae"] };

/**
 * Местные названия и варианты: «код: местные | варианты». Местные — как страну называют на её языке (латиницей, без диакритики),
 * первое — главное. Варианты — сокращения, прилагательные и язык (dutch, deutsch, espanol), прозвища (naija, kiwi).
 * Английское название и коды сюда не пишутся — они берутся из справочника стран.
 */
const GEO_TABLE = `
af: afghanestan | afghan
al: shqiperia, shqiperi | albanian, shqip
dz: aljazair, algerie | algerian, dzair
as: | amsamoa
ad: | andorran
ao: | angolan
ai: |
ag: antigua | antiguabarbuda
ar: | argentino, argentinian
am: hayastan | armenian
aw: |
au: | aussie, oz
at: osterreich, oesterreich | austrian
az: azerbaycan | azeri, azerbaijani
bs: | bahamian
bh: albahrain | bahraini
bd: | bangla, bangladeshi
bb: | bajan
by: bielarus | belarusian
be: belgie, belgique, belgien | belgian, belge, belgisch
bz: | belizean
bj: | beninois
bm: | bermudian
bt: druk | bhutanese
bo: | boliviano, bolivian
ba: bosna, bosnaihercegovina | bosnian
bw: | motswana
br: brasil | brasileiro, brazilian
bn: | bruneian
bg: balgariya, bulgariya | bulgarian
bf: burkina |
bi: | burundian
kh: kampuchea | khmer, cambodian
cm: cameroun | cameroonian
ca: | canadian, canadien
cv: caboverde |
ky: | cayman, caymans
cf: centrafrique |
td: tchad | chadian
cl: | chileno, chilean
cn: zhongguo | chinese, prc
co: | colombiano, colombian
km: comores, komori |
cg: | congolais
cd: rdc, rdcongo | drc
ck: |
cr: | tico, costarricense
ci: cotedivoire | ivoirien, ivorian, rci
hr: hrvatska | croatian, hrvatski
cu: | cubano, cuban
cw: korsou |
cy: kypros, kibris | cypriot
cz: cesko, ceskarepublika | czech, cesky, czechrepublic
dk: danmark | danish, dansk
dj: | djiboutian
dm: |
do: republicadominicana | dominicana, dominicano
ec: | ecuatoriano, ecuadorian
eg: misr, masr | egyptian
sv: | salvador, salvadoreno
gq: guineaecuatorial |
er: ertra | eritrean
ee: eesti | estonian
sz: swaziland | swazi
et: ityopiya | ethiopian
fk: falklands | malvinas
fo: foroyar | faroese, faroe
fj: | fijian
fi: suomi | finnish, suomen
fr: | francais, french
gf: guyane | guyanefrancaise
pf: polynesie | tahiti, polynesiefrancaise
ga: | gabonais
gm: | gambian
ge: sakartvelo | georgian
de: deutschland | deutsch, german, ger
gh: | ghanaian
gi: | gib
gr: hellas, ellada, ellas | greek, hellenic
gl: kalaallitnunaat |
gd: |
gp: | gwada
gu: guahan |
gt: | guate, guatemalteco, chapin
gg: |
gn: guinee |
gw: guinebissau |
gy: | guyanese
ht: ayiti | haitian
hn: | hondureno, catracho
hk: xianggang, heunggong |
hu: magyarorszag, magyar | hungarian
is: island | icelandic
in: bharat, hindustan | indian
id: | indo, indonesian
ir: | persian, persia
iq: aliraq | iraqi
ie: eire | irish
im: | manx, iom
il: yisrael | israeli
it: italia | italiano, italian
jm: | jamaican
jp: nihon, nippon | japanese
je: |
jo: alurdun | jordanian
kz: qazaqstan | kazakh
ke: | kenyan
ki: |
kw: | kuwaiti
kg: kyrgyz | kirgizia
la: | lao, laotian
lv: latvija | latvian
lb: lubnan | lebanese
ls: | basotho
lr: | liberian
ly: libiya | libyan
li: |
lt: lietuva | lithuanian
lu: letzebuerg, luxemburg | luxembourgeois
mo: aomen | macau
mg: madagasikara | malagasy
mw: | malawian
my: | malaysian, msia
mv: | maldivian
ml: | malien
mt: | maltese
mh: | marshall
mq: madinina |
mr: muritaniya | mauritanian
mu: maurice | mauritian
yt: |
mx: | mexicano, mexican
fm: |
md: | moldovan
mc: | monegasque
mn: mongol | mongolian
me: crnagora | montenegrin
ms: |
ma: maroc, almaghrib | moroccan, marocain
mz: mocambique | mozambican
mm: | burma, burmese
na: | namibian
nr: |
np: | nepali, nepalese
nl: nederland | netherland, holland, dutch, nederlands
nc: nouvellecaledonie | caledonie
nz: aotearoa | kiwi, kiwis
ni: | nica, nicaraguense
ne: | nigerien
ng: | naija, nigerian, 9ja
nu: |
nf: | norfolk
mk: makedonija, severnamakedonija | macedonia, macedonian
mp: | marianas, saipan
no: norge, noreg | norsk, norwegian
om: uman | omani
pk: | pakistani
pw: belau |
ps: filastin | palestinian
pa: | panameno
pg: | papua, png
py: | paraguayo
pe: | peruano, peruvian
ph: pilipinas | pinoy, pinas, filipino
pn: |
pl: polska | polski, polish
pt: | portugues, portuguese, tuga
pr: | boricua
qa: | qatari
re: | reunion
ro: | romana, romanian
ru: rossiya, rossia | russian, russkiy
rw: | rwandan
bl: stbarth | stbarts
sh: | sthelena
kn: | stkitts, saintkitts, nevis
lc: | stlucia
mf: | stmartin
pm: | stpierre
vc: | stvincent, svg
ws: | samoan
sm: |
st: saotome |
sa: | ksa, saudi
sn: | senegalais
rs: srbija | serbian, srpski
sc: | seychellois
sl: | salone
sg: singapura |
sx: |
sk: slovensko | slovak, slovensky
si: slovenija | slovenian, slovenski
sb: | solomons
so: soomaaliya | somali
za: | mzansi, rsa
kr: hanguk, daehanminguk | korea, korean, skorea
ss: |
es: espana | espanol, spanish
lk: | lanka, srilankan
sd: | sudanese
sr: | surinaams
se: sverige | svensk, svenska, swedish
ch: schweiz, suisse, svizzera, svizra | swiss, helvetia
sy: suriya | syrian
tw: | taiwanese
tj: tojikiston | tajik
tz: | tanzanian
th: prathetthai | thai, siam
tl: timor |
tg: | togolais
tk: |
to: | tongan
tt: trinidad | trini, tnt
tn: tunisie, tounes | tunisian
tr: turkiye | turk, turkish, turkce
tm: | turkmen
tc: | tci
tv: |
ug: | ugandan
ua: ukraina | ukrainian
ae: | emirates, emirati, dubai
gb: britain, england | british, greatbritain
us: | america, american
uy: | uruguayo
uz: ozbekiston | uzbek
vu: |
va: vaticano | vatican
ve: | venezolano, vzla
vn: | vietnamese, viet
vg: | bvi
vi: | usvi
wf: | wallis
ye: alyaman | yemeni
zm: | zambian
zw: | zimbabwean, zim
bq: bonaire |
`;

const asLabel = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
const words = (s: string | undefined) => (s ?? "").split(",").map(asLabel).filter(Boolean);

const TABLE = new Map<string, { local: string[]; variants: string[] }>();
for (const line of GEO_TABLE.split("\n")) {
  const m = line.match(/^([a-z]{2}):([^|]*)\|?(.*)$/);
  if (m) TABLE.set(m[1]!, { local: words(m[2]), variants: words(m[3]) });
}

/** Длиннее этого английское название из нескольких слов слитно не пишут (unitedkingdom, centralafricanrepublic). */
const JOINED_MAX = 12;

export type GeoTiers = [string[], string[], string[]];

function buildTiers(c: Country): GeoTiers {
  const row = TABLE.get(c.code) ?? { local: [], variants: [] };
  const multi = /[\s-]/.test(c.en.trim());
  const enLabel = asLabel(c.en);
  const en = multi ? "" : enLabel;
  const joined = multi && enLabel.length <= JOINED_MAX ? enLabel : "";
  const local = row.local.filter((w) => w !== enLabel);
  const codes = CODE_ALIASES[c.code] ?? [c.code];
  const english = c.lang.startsWith("en");
  const head = english ? en || local[0] : local[0] || en;
  const t1 = [...codes, head];
  const t2 = [en, ...local, joined];
  const t3 = [alpha3(c.code) ?? "", c.code, ...row.variants];
  const seen = new Set<string>();
  const uniq = (l: Array<string | undefined>) => l.filter((v): v is string => !!v && !seen.has(v) && (seen.add(v), true));
  return [uniq(t1), uniq(t2), uniq(t3)];
}

const CACHE = new Map<string, GeoTiers>();

/** Гео-приставки страны по уровням из встроенной базы. Неизвестный код — пустые уровни. */
export function geoTiers(code: string): GeoTiers {
  const key = code.trim().toLowerCase();
  const hit = CACHE.get(key);
  if (hit) return hit;
  const c = countryByCode(key);
  const tiers: GeoTiers = c ? buildTiers(c) : [[], [], []];
  CACHE.set(key, tiers);
  return tiers;
}

/** Все гео-формы страны одним множеством (для распознавания гео-приставок в выдаче). */
export function geoWordsOf(code: string): Set<string> {
  return new Set(geoTiers(code).flat());
}

/** Коды без своей рабочей доменной зоны (зона не делегирована или закрыта для регистрации). */
const NO_CCTLD = new Set(["bq", "bl", "mf"]);

/** Доменная зона страны: fr → fr, gb → uk. */
export function countryTld(code: string): string | null {
  const c = code.trim().toLowerCase();
  if (!countryByCode(c) || NO_CCTLD.has(c)) return null;
  return c === "gb" ? "uk" : c;
}
