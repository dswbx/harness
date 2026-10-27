import json,sys
for l in open(sys.argv[1]):
    try: d=json.loads(l)
    except: continue
    e=d['ev']; x=d['data']
    if e=='session/update':
        u=x['update']; print(e, x['kind'], json.dumps({k:v for k,v in u.items() if k!='sessionUpdate'})[:int(sys.argv[2]) if len(sys.argv)>2 else 230])
    elif e in('initialize','session/new.response'): print(e,'...')
    else: print(e, json.dumps(x)[:300])
