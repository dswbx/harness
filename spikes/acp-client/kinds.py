import json,sys,collections
c=collections.Counter()
for l in open(sys.argv[1]):
    try: d=json.loads(l)
    except: continue
    c[d['data']['kind'] if d['ev']=='session/update' else d['ev']]+=1
print(dict(c))
