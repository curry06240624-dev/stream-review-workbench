# -*- coding: utf-8 -*-
"""
用 SUPER8 匯出（每則訊息都寫了誰發的）修正我們資料庫裡靠「出現次數」猜的 staff／bot 標記與發送者。

  py scripts/adapters/super8_sender_patch.py <sqlite檔> <輸出.json> <zip1> [zip2 …] [--map oa.map.json …]

做法：SUPER8 每則非客戶訊息做索引 key＝(客戶顯示名, 文字前60字, 台灣時間到分鐘)，另有不看客戶名的備用 key。
      我們資料庫裡官方帳號這邊的文字訊息（staff／bot）逐則查：找到就用 SUPER8 的答案；
      要改的（角色不同、或原本是「Super 8 客服（未署名）」現在知道是誰）寫進 patch：[{id, role, seat}]。
      patch 裡只有訊息 id、角色、座位名，沒有客戶內容，可以放心傳給正式站的 /api/admin/sender-patch。
只讀資料庫，不寫。
"""
import sys, os, re, json, sqlite3, collections, datetime as dt, argparse
sys.stdout.reconfigure(encoding="utf-8")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from super8_dump import iter_conversations

ap = argparse.ArgumentParser()
ap.add_argument("db"); ap.add_argument("out"); ap.add_argument("zips", nargs="+")
ap.add_argument("--map", action="append", default=[], help="oa.map.json：化名 → 顯示名，用來把客戶名也放進比對鍵")
ap.add_argument("--since", default="", help="只處理這個 UTC ISO 之後的訊息（預設全部）")
A = ap.parse_args()
norm = lambda t: re.sub(r"\s+", " ", t or "").strip()[:60]

pseudo2name = {}
for mp in A.map:
    if os.path.exists(mp):
        for p, v in json.load(open(mp, encoding="utf-8")).items(): pseudo2name[p] = v["name"]

# 1. SUPER8 索引
idx = {}; idx_loose = {}; n_s8 = collections.Counter()
def add(d, key, val):
    c = d.setdefault(key, collections.Counter()); c[val] += 1
for zp in A.zips:
    print("讀", zp)
    for conv in iter_conversations(zp):
        cust = conv.get("customer", "")
        for m in conv["messages"]:
            if m["who"] == "customer" or not m["text"]: continue
            n_s8[m["who"]] += 1
            val = (m["who"], m["name"]); minute = m["at_tw"][:16]; t = norm(m["text"])
            add(idx, (cust, t, minute), val); add(idx_loose, (t, minute), val)
print("SUPER8 非客戶訊息：", dict(n_s8), "| 索引鍵", len(idx))

def lookup(cust, text, at_utc):
    t = norm(text)
    if not t: return None
    base = dt.datetime.strptime(at_utc[:19], "%Y-%m-%dT%H:%M:%S") + dt.timedelta(hours=8)
    for off in (0, -1, 1, -2, 2):
        mn = (base + dt.timedelta(minutes=off)).strftime("%Y-%m-%d %H:%M")
        d = idx.get((cust, t, mn)) if cust else None
        if not d: d = idx_loose.get((t, mn))
        if d: return d.most_common(1)[0][0]
    return None

# 2. 我們的訊息
con = sqlite3.connect(f"file:{A.db}?mode=ro", uri=True)
sql = """SELECT m.id, m.sender_role, COALESCE(u.name,'') AS uname, m.text, m.created_at, c.pseudonym
         FROM messages m JOIN conversations cv ON cv.id = m.conversation_id JOIN contacts c ON c.id = cv.contact_id LEFT JOIN users u ON u.id = m.sender_user_id
         WHERE m.sender_role IN ('staff','bot') AND m.msg_type = 'text'""" + (" AND m.created_at >= ?" if A.since else "")
rows = con.execute(sql, (A.since,) if A.since else ()).fetchall()
print("我們的 staff／bot 文字訊息：", len(rows))
patch = []; stats = collections.Counter()
for mid, role, uname, text, at, pseudo in rows:
    hit = lookup(pseudo2name.get(pseudo, ""), text, at)
    if hit is None: stats["unmatched"] += 1; continue
    who, seat = hit
    # id 只在產生 patch 的那個資料庫有效；正式站用 (化名, 時間, 文字前60字) 對——所以兩種都帶
    item = {"id": mid, "pseudonym": pseudo, "at": at, "text": norm(text)}
    if who == "staff":
        if role != "staff": stats["bot→staff"] += 1; patch.append({**item, "role": "staff", "seat": seat})
        elif uname.startswith("Super 8"): stats["staff:name_added"] += 1; patch.append({**item, "role": "staff", "seat": seat})
        else: stats["staff_ok"] += 1
    else:
        if role != "bot": stats["staff→bot"] += 1; patch.append({**item, "role": "bot", "seat": ""})
        else: stats["bot_ok"] += 1
seats = collections.Counter(p["seat"] for p in patch if p["seat"])
json.dump({"generated_at": dt.datetime.now(dt.timezone.utc).isoformat(), "stats": dict(stats), "seats": dict(seats), "items": patch}, open(A.out, "w", encoding="utf-8"), ensure_ascii=False)
print("統計：", dict(stats)); print("座位：", seats.most_common(15)); print("寫出", A.out, len(patch), "筆")
