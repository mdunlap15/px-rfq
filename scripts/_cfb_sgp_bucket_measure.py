# CFB spread+total SGP correlation by spread bucket (2026-09-25).
# Inputs (download into cwd first):
#   cfb_line_odds.csv.gz  <- raw.githubusercontent.com/sportsdataverse/cfbfastR-data/main/betting/csv/cfb_line_odds.csv.gz
#   cfbsched/<YYYY>.csv   <- .../main/schedules/csv/cfb_schedules_<YYYY>.csv, 2006-2025
# M = P(fav covers AND over) / (P(cover) * P(over)); pushes excluded; 4,000-resample bootstrap CIs.
# Feeds services/football-sgp-correlation.js DEFAULTS.ncaaf.spreadBuckets.
import csv, gzip, glob, random, statistics as st
from collections import defaultdict, Counter
random.seed(7)
# ---- lines
g = defaultdict(lambda: {'sp': defaultdict(list), 'tot': [], 'meta': None})
co = defaultdict(Counter)
with gzip.open('cfb_line_odds.csv.gz','rt',encoding='utf-8') as f:
    for r in csv.DictReader(f):
        mt = r['market_type']
        if mt not in ('spread','total'): continue
        try: season=int(float(r['season'])); h=int(float(r['home_team_id'])); a=int(float(r['away_team_id']))
        except: continue
        key=(r['game_id'])
        G=g[key]; G['meta']=(season,h,a,r['date_time'][:10],r['season_type'])
        try: ln=float(r['lines'])
        except: continue
        if mt=='spread':
            G['sp'][r['abbr']].append(ln); co[h][r['abbr']]+=1; co[a][r['abbr']]+=1
        elif r['abbr']=='over': G['tot'].append(ln)
abbr_of={t:c.most_common(1)[0][0] for t,c in co.items() if c}
# ---- scores
sc={}
for fn in glob.glob('cfbsched/*.csv'):
    with open(fn,encoding='utf-8') as f:
        for r in csv.DictReader(f):
            try: s=int(r['season']); h=int(r['home_id']); a=int(r['away_id']); hp=float(r['home_points']); ap=float(r['away_points'])
            except: continue
            sc[(s,h,a)]=(hp,ap)
rows=[]
for key,G in g.items():
    if not G['meta'] or not G['tot']: continue
    season,h,a,_,_=G['meta']
    if (season,h,a) not in sc: continue
    ha=abbr_of.get(h)
    if ha not in G['sp'] or not G['sp'][ha]: continue
    hs=st.median(G['sp'][ha]); T=st.median(G['tot'])
    if hs==0: continue
    hp,ap=sc[(season,h,a)]
    S=abs(hs)
    fav_margin = (hp-ap) if hs<0 else (ap-hp)
    tot=hp+ap
    if fav_margin==S or tot==T: continue   # pushes
    rows.append((S, fav_margin>S, tot>T))
print('games joined:',len(rows))
def M(rs):
    n=len(rs); c=sum(1 for _,x,_ in rs if x)/n; o=sum(1 for _,_,y in rs if y)/n; j=sum(1 for _,x,y in rs if x and y)/n
    return j/(c*o) if c and o else float('nan'), c, o
def boot(rs,B=4000):
    v=[]
    for _ in range(B):
        s=[random.choice(rs) for _ in rs]; m=M(s)[0]
        if m==m: v.append(m)
    v.sort(); return v[int(.025*len(v))], v[int(.975*len(v))]
buckets=[(0,3.5),(3.5,7.5),(7.5,14.5),(14.5,21),(21,28),(28,35),(35,99),(40,99),(14.5,99)]
print('bucket         n     M      95%CI            P(cover) P(over)')
for lo,hi in buckets:
    rs=[r for r in rows if lo<=r[0]<hi]
    if len(rs)<50: print(f'{lo:>5}-{hi:<5} n={len(rs)} (too few)'); continue
    m,c,o=M(rs); lo_ci,hi_ci=boot(rs)
    print(f'{lo:>5}-{hi:<5} {len(rs):5d}  {m:.3f}  [{lo_ci:.3f}, {hi_ci:.3f}]   {c:.3f}   {o:.3f}')
