#!/usr/bin/env python3
"""Test v1.0 scanner production pipeline with yingyu34"""
import base64, json, urllib.request, time, sqlite3

# Get fresh token
login_data = json.dumps({"email":"scanner-test@gaozhong.online","password":"test123456"}).encode()
req = urllib.request.Request('http://localhost:3001/auth/login',
    data=login_data, headers={"Content-Type":"application/json"})
resp = urllib.request.urlopen(req)
login_result = json.loads(resp.read())
TOKEN = login_result.get("token","")
print(f"Logged in as: {login_result.get('user',{}).get('email','?')}")

# Submit
with open('/app/data/papers/fbc20049/page_1.jpg', 'rb') as f:
    img_b64 = base64.b64encode(f.read()).decode()

req2 = urllib.request.Request('http://localhost:3001/paper/analyze',
    data=json.dumps({"subject":"英语","images":[f"data:image/jpeg;base64,{img_b64}"],"title":"v1.0-fix-layout-verify"}).encode(),
    headers={"Content-Type":"application/json","Authorization":f"Bearer {TOKEN}"})
resp2 = urllib.request.urlopen(req2)
result = json.loads(resp2.read())
task_id = result.get("taskId","")
print(f"Task: {task_id}\n")

# Poll
for i in range(40):
    time.sleep(15)
    req3 = urllib.request.Request(f'http://localhost:3001/paper/task/{task_id}',
        headers={"Authorization":f"Bearer {TOKEN}"})
    resp3 = urllib.request.urlopen(req3)
    task = json.loads(resp3.read())
    s, p = task.get("status",""), task.get("progress",{})
    msg = p.get("message","") if isinstance(p,dict) else str(p)
    print(f"  [{(i+1)*15}s] {s}: {msg}")
    
    if s in ("done","failed"):
        db = sqlite3.connect('/app/data/www/gaozhong.online/data/grading.db')
        errors = db.execute(f"SELECT topic, wrong_answer, correct_answer, error_type, grading_evidence FROM error_problems WHERE session_id='{task_id}' ORDER BY topic").fetchall()
        print(f"\n📋 错题 ({len(errors)}):")
        for e in errors:
            print(f"  {e[0]:<25} | {e[1] or '-':<6}→{e[2] or '-':<6} | {e[3]:<8} | {e[4][:50] if e[4] else '-'}")
        print(f"\nResult: {task.get('result',{})}")
        
        # Compare with truth
        truth = {24, 26, 32, 40, 41, 44}
        detected = set()
        for e in errors:
            try: detected.add(int(e[0].split('Q')[-1]))
            except: pass
        matches = truth & detected
        missed = truth - detected
        false_pos = detected - truth
        print(f"\n🎯 真相(Q24,26,32,40,41,44): 匹配{len(matches)}{matches}, 漏判{len(missed)}{missed}, 误判{len(false_pos)}{false_pos}")
        print(f"   精确率={len(matches)}/{len(detected)}={len(matches)/max(len(detected),1)*100:.0f}% 召回率={len(matches)}/{len(truth)}={len(matches)/len(truth)*100:.0f}%")
        break
