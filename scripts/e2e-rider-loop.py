#!/usr/bin/env python3
"""Full E2E rider loop test against the live backend."""
import json, urllib.request, urllib.error, sys

API = "https://mototrack-iq-backend-production.up.railway.app"
EMAIL = "everett.test.qa@gmail.com"
PASSWORD = "TestPass123!"

def call(method, path, token=None, body=None, raw_pdf=False):
    url = API + path
    headers = {"Content-Type": "application/json"}
    if token: headers["Authorization"] = "Bearer " + token
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req) as r:
            hdrs = dict(r.headers)
            if raw_pdf:
                return r.status, r.read(), hdrs
            return r.status, json.loads(r.read().decode()), hdrs
    except urllib.error.HTTPError as e:
        body = e.read()
        try: return e.code, json.loads(body.decode()), dict(e.headers)
        except: return e.code, {"raw": body.decode()[:200]}, dict(e.headers)

print("=== 1. LOGIN ===")
st, d, _ = call("POST", "/api/auth/login", body={"email": EMAIL, "password": PASSWORD})
if st != 200 or not d.get("token"):
    print("LOGIN FAILED:", st, d); sys.exit(1)
token = d["token"]
print(f"  ✅ logged in (token {len(token)} chars)")

print("=== 2. ENTITLEMENT (before) ===")
st, d, _ = call("GET", "/api/sessions/entitlement", token=token)
ent = d.get("entitlement", {})
before_credits = ent.get("reportCredits")
print(f"  plan={ent.get('plan')} credits={before_credits} canGenerate={ent.get('canGenerate')}")

print("=== 3. CREATE SESSION (upload + analyze) ===")
csv = open("/tmp/test-session.csv").read()
st, d, _ = call("POST", "/api/sessions", token=token, body={
    "name": "E2E Test Session", "track": "Calabogie", "bike": "SV650",
    "date": "2026-06-28", "csvContent": csv})
if st != 201:
    print("  ❌ CREATE FAILED:", st, d); sys.exit(1)
sid = d["session"]["id"]
a = d["analysis"]
summ = a.get("summary", {})
laps = a.get("laps", [])
print(f"  ✅ session {sid}")
print(f"  track={summ.get('trackName')} laps={len(laps)} topSpeed={summ.get('topSpeed')}")
lapstats = a.get("lapStats", {})
print(f"  bestLap={lapstats.get('bestLap') or summ.get('bestLap')}")

print("=== 4. PREVIEW ===")
st, d, _ = call("POST", f"/api/sessions/{sid}/report/preview", token=token)
print(f"  status={st} hasPreview={'preview' in d}")

print("=== 5. GENERATE PDF REPORT (credit-gated) ===")
st, pdf, hdrs = call("POST", f"/api/sessions/{sid}/report", token=token,
                     body={"riderName": "Test Rider", "bikeName": "SV650"}, raw_pdf=True)
if st != 200:
    try: print("  ❌ REPORT FAILED:", st, json.loads(pdf.decode())); 
    except: print("  ❌ REPORT FAILED:", st, pdf[:200])
    sys.exit(1)
is_pdf = pdf[:4] == b"%PDF"
print(f"  ✅ PDF generated: {len(pdf)} bytes, valid_pdf={is_pdf}")
print(f"  credits_remaining_hdr={hdrs.get('X-Report-Credits-Remaining')} reports_gen={hdrs.get('X-Reports-Generated')} ask_review={hdrs.get('X-Ask-Review')}")
open("/tmp/e2e-report.pdf", "wb").write(pdf)

print("=== 6. ENTITLEMENT (after) — credit should decrement ===")
st, d, _ = call("GET", "/api/sessions/entitlement", token=token)
after_credits = d.get("entitlement", {}).get("reportCredits")
print(f"  credits: {before_credits} → {after_credits}  (delta={after_credits - before_credits if isinstance(after_credits,int) and isinstance(before_credits,int) else '?'})")

print("=== 7. DAY PROGRESS (this date) ===")
st, d, _ = call("GET", "/api/sessions/progress?date=2026-06-28", token=token)
prog = d.get("progress")
print(f"  status={st} hasProgress={prog is not None} sessions={len(d.get('sessions',[]))}")

print("\n=== E2E SUMMARY ===")
print(f"  login ✅ | analyze ✅ ({len(laps)} laps) | PDF ✅ ({len(pdf)}b) | credit decrement {'✅' if (isinstance(after_credits,int) and isinstance(before_credits,int) and after_credits==before_credits-1) else '⚠️ '+str(before_credits)+'→'+str(after_credits)}")
