# -*- coding: utf-8 -*-
"""
Frank 的標記工具（label.html）用自己的對話編號 s8_xxxxxxxxxxxx。要把他的人工標記對回我們的 lead，
拿 label.html 裡每段對話的訊息（台灣時間到分鐘＋文字）去我們的 messages 表比對。

  py scripts/adapters/frank_label_map.py <label.zip 或 label.html> <sqlite> <輸出 map.json>

輸出 {s8_id: {pseudonym, lead_id, conversation_id, matched, total}}；只印統計，不印對話。
"""
import sys, os, re, io, json, html, sqlite3, zipfile, collections, datetime as dt
sys.stdout.reconfigure(encoding="utf-8")

src, dbp, out = sys.argv[1], sys.argv[2], sys.argv[3]
if src.lower().endswith(".zip"):
    z = zipfile.ZipFile(src); page = z.read([n for n in z.namelist() if n.endswith(".html")][0]).decode("utf-8", "replace")
else:
    page = io.open(src, encoding="utf-8").read()

norm = lambda t: re.sub(r"\s+", " ", html.unescape(t)).strip()
convs = {}
for sec in re.finditer(r'<section class="conv" data-id="(s8_[0-9a-f]+)".*?</section>', page, re.S):
    cid = sec.group(1); msgs = []
    for m in re.finditer(r'<div class="m (customer|staff|bot)[^"]*" id="[^"]+">\s*<div class="meta"><b>M\d+</b> (\d{4}-\d{2}-\d{2} \d{2}:\d{2}) [^<]*(?:<span class="tag">[^<]*</span>)?</div>\s*<div class="body">(.*?)</div>', sec.group(0), re.S):
        role, at, body = m.group(1), m.group(2), norm(re.sub(r"<[^>]+>", " ", m.group(3)))
        if len(body) >= 4: msgs.append((role, at, body))
    convs[cid] = msgs
print("label.html 對話", len(convs), "訊息", sum(len(v) for v in convs.values()))

# 我們的 8 月訊息（Super 8 匯出時間是台灣時間 → 轉 UTC；分鐘為鍵，容忍 ±2 分）
con = sqlite3.connect(f"file:{dbp}?mode=ro", uri=True)
rows = con.execute("""SELECT m.conversation_id, m.created_at, m.text FROM messages m
  WHERE m.created_at >= '2026-07-20T00:00:00' AND m.created_at < '2026-09-10T00:00:00' AND m.msg_type IN ('text','menu')""").fetchall()
idx = collections.defaultdict(set)
for cv, at, text in rows:
    key = (at[:16], norm(text)[:80]); idx[key].add(cv)
print("我們的訊息", len(rows))

def utc_minute(tw, off):
    d = dt.datetime.strptime(tw, "%Y-%m-%d %H:%M") - dt.timedelta(hours=8) + dt.timedelta(minutes=off)
    return d.strftime("%Y-%m-%dT%H:%M")

result = {}; stats = collections.Counter()
for cid, msgs in convs.items():
    votes = collections.Counter(); hit = 0
    for role, at, body in msgs[:12]:
        found = set()
        for off in (0, -1, 1, -2, 2):
            found |= idx.get((utc_minute(at, off), body[:80]), set())
        if found: hit += 1
        w = 3 if role == "customer" else (1 if len(found) <= 3 else 0)   # 客戶訊息最有辨識度；群發（同時出現在很多段）不投票
        for cv in found: votes[cv] += w
    if not votes: stats["unmatched"] += 1; result[cid] = {"pseudonym": None, "matched": 0, "total": len(msgs[:12])}; continue
    cv, n = votes.most_common(1)[0]
    row = con.execute("SELECT cv.lead_id, c.pseudonym FROM conversations cv JOIN contacts c ON c.id = cv.contact_id WHERE cv.id = ?", (cv,)).fetchone()
    ambiguous = len([v for v in votes.values() if v == n]) > 1
    result[cid] = {"pseudonym": row[1] if row else None, "lead_id": row[0] if row else None, "conversation_id": cv, "matched": hit, "total": len(msgs[:12]), "ambiguous": ambiguous}
    stats["ambiguous" if ambiguous else "matched"] += 1
json.dump(result, open(out, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print("結果", dict(stats), "→", out)
for cid, r in result.items(): print(f"  {cid}  {r.get('pseudonym') or '—'}  {r['matched']}/{r['total']}{'  ⚠ 多個候選' if r.get('ambiguous') else ''}")
