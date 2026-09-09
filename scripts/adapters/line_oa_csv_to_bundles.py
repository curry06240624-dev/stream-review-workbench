# -*- coding: utf-8 -*-
"""
LINE 官方帳號後台匯出（一段對話一個 CSV，zip 解開）→ NormalizedBundle 分批檔（去識別化）。

  py scripts/adapters/line_oa_csv_to_bundles.py <匯出資料夾> <輸出資料夾> [--since 2026-03-10] [--chunk 500]
      [--super8 data/real/2026-09-06/bundle.json] [--map data/real/2026-09-06/bundle.map.json] [--today 2026-09-06]

匯出格式（2026-09-06 實檔，54,497 個檔、547 萬則）：
  前三行  Account name / Time zone,'+09:00' / Downloaded on
  表頭    Sender type,Sender name,Date,Time,Message   （時間是 +09:00 日本時區，不是台灣）
  Sender type = User（客戶）| Account（官方帳號這邊）
  Account 的 Sender name：
    Auto-response  → 加好友自動回覆、關鍵字回覆        → bot
    Unknown        → 透過 Messaging API 送的：Super 8 的機器人車卡、群發、還有 Super 8 客服打的字（API 不帶人名）
    人名（陳昱孝、Ash、阿軒…）→ 直接在 LINE 官方後台打字的人（2026 年幾乎沒人這樣用）
  Unknown 怎麼分：同一分鐘同一段文字出現在 ≥50 段對話＝群發（bot）；同一段文字（前 80 字）在 ≥30 段對話出現過＝模板／機器人（bot）；
  其餘＝Super 8 客服打的（staff）。人名對不出來，先歸「Super 8 客服（未署名）」；跟 Super 8 匯出重疊的對話用同文字同時間對回真名。
  媒體：「您收到一則影片訊息」「You sent a photo.」→ 只留類型。客戶按選單的（線上車庫／🚘國產…）標 type=menu。
去識別化：顯示名稱換成 客戶#NNNNN（跟 Super 8 那 40 段對得上的沿用原編號）；對照表 oa.map.json 只留本機、不上傳。
電話與身分證由匯入器再抹一次。
"""
import sys, os, re, csv, json, glob, argparse, datetime as dt, collections, time

sys.stdout.reconfigure(encoding="utf-8")
csv.field_size_limit(10**9)

ap = argparse.ArgumentParser()
ap.add_argument("src"); ap.add_argument("out")
ap.add_argument("--since", default="2026-03-10")
ap.add_argument("--until", default="", help="只轉最後一則客戶訊息在這天之前的（跟 --since 互補，用來補舊資料）")
ap.add_argument("--start-no", type=int, default=41, help="新客戶編號從幾號起（補舊資料時要接在已匯入的後面，避免撞號）")
ap.add_argument("--chunk", type=int, default=500)
ap.add_argument("--super8", default="data/real/2026-09-06/bundle.json")
ap.add_argument("--map", default="data/real/2026-09-06/bundle.map.json")
ap.add_argument("--today", default="2026-09-06")
ap.add_argument("--limit", type=int, default=0, help="只轉前 N 段（測試用）")
A = ap.parse_args()

TZ = dt.timezone(dt.timedelta(hours=9))
SINCE = dt.date.fromisoformat(A.since)
UNTIL = dt.date.fromisoformat(A.until) if A.until else None
os.makedirs(A.out, exist_ok=True)

NAME_MAP = {"陳昱孝": "昱孝陳", "瑋瑋": "昱孝陳", "瑋瑋中古車": "昱孝陳"}
PLACEHOLDER = "Super 8 客服（未署名）"
MENU_SET = set("""線上車庫 熱銷車款 本週新進車款 進口 國產 轎車 休旅 跑車 瑕疵福利 優惠車款 出清專區 汽車地圖 加入會員 圓夢計畫
  我看到影片加入 我看到直播加入 兩個活動我都要看 三天快速交車專區 我要賣車 我要求職 轎車&休旅&跑車 商用車 機車 貨車 休旅車 轎車&休旅
  我要看車 我要買車 想看車 看更多 看更多資訊 查看更多 立即詢問 我要詢問 聯絡客服 真人客服 我要預約 預約看車 分期試算 貸款試算""".split())
MENU_PREFIX = ("我非常想立即知道", "我要了解", "我想了解", "請給我現金總價", "我要一年車貸活動", "我想看這台", "我要這台")
EMOJI_RE = re.compile(r"^[\U0001F000-\U0001FAFF☀-➿️‍\s]+")
MEDIA_RE = re.compile(r"^您收到一則(.{1,6}?)訊息$")
OA_SENT_RE = re.compile(r"^You sent an? (photo|sticker|video|file|voice message|image)\.$", re.I)
MEDIA_TYPE = {"影片": "video", "圖文": "image", "圖片": "image", "照片": "image", "貼圖": "sticker", "語音": "audio", "檔案": "file", "位置": "location"}

def norm(s): return re.sub(r"\s+", " ", s.strip())
def strip_menu(s): return EMOJI_RE.sub("", s).strip()

def file_meta(fn):
    base = os.path.basename(fn)[:-4]
    m = re.match(r"^(\d+)_(?:(\d{8})_(\d{8})_)?(.*)$", base)
    return int(m.group(1)), (m.group(4) or "").strip()

def rows_of(fn):
    with open(fn, encoding="utf-8-sig", newline="") as f:
        for _ in range(3): f.readline()
        r = csv.reader(f); next(r, None)
        for row in r:
            if len(row) >= 5: yield row[0], row[1], row[2], row[3], row[4]

def ts(d, t):
    y, mo, da = map(int, d.split("/")); hh, mi, ss = map(int, t.split(":"))
    return dt.datetime(y, mo, da, hh, mi, ss, tzinfo=TZ)

def iso(x): return x.astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")

files = sorted(glob.glob(os.path.join(A.src, "*.csv")), key=lambda f: file_meta(f)[0])
if A.limit: files = files[:A.limit]
print(f"檔案 {len(files)}，只轉最後一則客戶訊息在 {SINCE} 之後" + (f"、{UNTIL} 之前" if UNTIL else "") + " 的對話")

# ── 第一遍：模板／群發／選單的統計，以及每段的最後客戶訊息日 ──
t0 = time.time()
tpl = collections.Counter(); bc = collections.Counter(); menu_ct = collections.Counter(); named = collections.Counter()
last_user = {}
for fn in files:
    seen_t, seen_b, seen_m = set(), set(), set(); lu = None
    for st, sn, d, t, m in rows_of(fn):
        if st == "User":
            lu = d; s = strip_menu(m)
            if 1 < len(s) <= 20: seen_m.add(s)
        elif st == "Account":
            if sn == "Unknown":
                nm = norm(m); seen_t.add(nm[:80]); seen_b.add((d, t[:5], nm[:60]))
            elif sn not in ("Auto-response", "瑋瑋中古車"): named[sn] += 1   # 瑋瑋中古車＝加好友自動回覆的發送者名（Curry 9/9 確認），不是人
    for k in seen_t: tpl[k] += 1
    for k in seen_b: bc[k] += 1
    for k in seen_m: menu_ct[k] += 1
    if lu: last_user[fn] = lu
print(f"第一遍 {time.time()-t0:.0f}s：模板文字 {sum(1 for v in tpl.values() if v >= 30)}、群發鍵 {sum(1 for v in bc.values() if v >= 50)}、後台打字的人 {len(named)}")

KNOWN_BUTTONS = {"回選單", "一年加油金", "瑋瑋中古車品牌理念", "我要諮詢哪裡瑕疵", "貸款", "售後保固", "想了解月繳款", "線上車庫", "線上估車", "本週新進車款", "出清專區",
                 "國產車", "進口車", "露營車", "圓夢計畫", "我要抽加油金", "我要參加0元起標", "TIKTOK影片 加入", "代操案例", "資金需求", "我要花蓮救災資訊", "1", "2", "3", "4"}
# ↑ 鏡像 src/model/menu.ts MENU_BUTTONS（Python 讀不到 TS）：兩邊要一起改。前後 emoji（❤️國產車、線上車庫🚗）、「X庫存N台」、「X就是你了」也算按鈕
SYMS_RE = re.compile(r"^[^\u4e00-\u9fffA-Za-z0-9]+|[^\u4e00-\u9fffA-Za-z0-9]+$")
def is_menu(text):
    s = strip_menu(text)
    core = SYMS_RE.sub("", text.strip())
    if s in KNOWN_BUTTONS or text.strip() in KNOWN_BUTTONS or core in KNOWN_BUTTONS: return True
    if re.match(r"^.{1,14}庫存\d+台$", core) or re.match(r"^\S{1,6}就是你了$", core): return True
    if not s or len(s) > 24: return False
    if s in MENU_SET or s.startswith(MENU_PREFIX): return True
    return len(s) >= 4 and menu_ct.get(s, 0) >= 200 and text.strip() != s   # 資料裡常見、而且原文帶 emoji 開頭（純文字短句如「好」「了解」不算）

# ── Super 8 那 40 段：沿用編號、拿回真名 ──
s8 = json.load(open(A.super8, encoding="utf-8")) if os.path.exists(A.super8) else {"staff": [], "vehicles": [], "customers": [], "conversations": []}
s8map = json.load(open(A.map, encoding="utf-8")) if os.path.exists(A.map) else {}
def strip_tags(s): return re.sub(r"^[ABCS]\+?@|^\d{1,2}/\d{1,2}(?:\+\d{2})?\s*|-已購車|❌", "", s).strip()
s8_by_name = {}
for c in s8.get("customers", []):
    raw = s8map.get(c["pseudonym"], ""); nm = strip_tags(raw)
    if nm: s8_by_name.setdefault(nm, []).append(c)
s8_conv_by_cust = {cv["customer_key"]: cv for cv in s8.get("conversations", [])}
oa_name_count = collections.Counter(file_meta(fn)[1] for fn in files)

# ── 員工清單：Super 8 的 ＋ 後台打字的人 ＋ 未署名 ──
staff = [dict(s) for s in s8.get("staff", [])]
have = {s["name"] for s in staff}
for s in staff:
    if s["name"] == "昱孝陳": s["aliases"] = sorted(set(s.get("aliases", []) + ["陳昱孝", "瑋瑋", "瑋瑋中古車"]))
k = 0
for nm, cnt in named.most_common():
    name = NAME_MAP.get(nm, nm)
    if name in have: continue
    k += 1; have.add(name)
    staff.append({"name": name, "role": "agent", "team": "訊息組", "email": f"oa{k}@pusen.local", "job": "chat", "aliases": (["軒"] if name == "阿軒" else [])})
staff.append({"name": PLACEHOLDER, "role": "agent", "team": "訊息組", "email": "s8-unknown@pusen.local", "job": "chat", "aliases": []})

# ── 第二遍：轉對話、分批寫出 ──
selected = [fn for fn in files if fn in last_user and dt.date(*map(int, last_user[fn].split("/"))) >= SINCE and (UNTIL is None or dt.date(*map(int, last_user[fn].split("/"))) < UNTIL)]
print(f"選中 {len(selected)} 段")
name_map = {}; next_no = A.start_no; part = 0; buf = {"customers": [], "leads": [], "conversations": []}
stats = collections.Counter(); matched = 0

def flush():
    global part, buf
    if not buf["conversations"]: return
    part += 1
    b = {"source_system": "line_oa_export", "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(), "teams": ["管理", "訊息組"],
         "staff": staff, "vehicles": s8.get("vehicles", []) if part == 1 else [], **buf, "appointments": [], "visits": [], "deals": [], "assignments": []}
    p = os.path.join(A.out, f"part-{part:03d}.json")
    json.dump(b, open(p, "w", encoding="utf-8"), ensure_ascii=False)
    print(f"  寫出 {p}：{len(buf['conversations'])} 段")
    buf = {"customers": [], "leads": [], "conversations": []}

for fn in selected:
    idx, disp = file_meta(fn)
    key = f"oa:{idx}"
    # Super 8 對回
    s8c = None
    cands = s8_by_name.get(disp)
    if cands and oa_name_count[disp] == 1 and len(cands) == 1: s8c = cands[0]
    s8msgs = []
    if s8c:
        matched += 1
        cv = s8_conv_by_cust.get(s8c["key"])
        if cv:
            for mm in cv["messages"]:
                if mm["role"] == "staff" and mm.get("staff_name"):
                    s8msgs.append((norm(mm["text"])[:60], dt.datetime.fromisoformat(mm["at"].replace("Z", "+00:00")), mm["staff_name"]))
    msgs = []; staff_ct = collections.Counter()
    for st, sn, d, t, m in rows_of(fn):
        at = ts(d, t); text = m.strip(); nm = norm(text)
        if st == "User":
            mt = "text"
            mm = MEDIA_RE.match(text)
            if mm: mt = MEDIA_TYPE.get(mm.group(1), "file"); text = f"[{mm.group(1)}]"
            elif is_menu(text): mt = "menu"
            msgs.append({"at": iso(at), "role": "customer", "text": text, "type": mt, "via": "line_oa"}); stats[f"customer:{mt}"] += 1
            continue
        if st != "Account": continue
        media = MEDIA_RE.match(text) or OA_SENT_RE.match(text)
        mt = "text"
        if media:
            g = media.group(1); mt = MEDIA_TYPE.get(g, {"photo": "image", "sticker": "sticker", "video": "video", "file": "file", "voice message": "audio", "image": "image"}.get(g.lower(), "file"))
            text = f"[{g}]"
        if sn in ("Auto-response", "瑋瑋中古車"):   # 瑋瑋中古車＝加好友自動回覆（Curry 9/9 確認）→ bot
            msgs.append({"at": iso(at), "role": "bot", "text": text, "type": mt, "via": "bot"}); stats["bot:auto"] += 1; continue
        if sn == "Unknown":
            if bc.get((d, t[:5], nm[:60]), 0) >= 50: msgs.append({"at": iso(at), "role": "bot", "text": text, "type": mt, "via": "bot"}); stats["bot:broadcast"] += 1; continue
            if not media and tpl.get(nm[:80], 0) >= 30: msgs.append({"at": iso(at), "role": "bot", "text": text, "type": mt, "via": "bot"}); stats["bot:template"] += 1; continue
            who = PLACEHOLDER
            if s8msgs:
                key60 = nm[:60]
                for k60, sat, sname in s8msgs:
                    if k60 == key60 and abs((sat - at).total_seconds()) <= 900: who = sname; break
            msgs.append({"at": iso(at), "role": "staff", "text": text, "type": mt, "staff_name": who, "via": "super8"}); staff_ct[who] += 1; stats["staff:super8"] += 1; continue
        who = NAME_MAP.get(sn, sn)
        msgs.append({"at": iso(at), "role": "staff", "text": text, "type": mt, "staff_name": who, "via": "line_oa"}); staff_ct[who] += 1; stats["staff:console"] += 1
    if not msgs: continue
    cust = [x for x in msgs if x["role"] == "customer"]
    first_at = (cust[0] if cust else msgs[0])["at"]
    first_real = next((x["at"] for x in cust if x.get("type") != "menu"), None)   # 新進線日期：第一則非選單客戶訊息（打字／照片／貼圖）
    if s8c:
        pseudonym = s8c["pseudonym"]; display = s8c["display_name"]; grade = s8c.get("grade") or "C"; blocked = s8c.get("blocked", 0)
    else:
        pseudonym = f"客戶#{next_no:05d}"; next_no += 1; display = pseudonym; grade = "C"; blocked = 0
    name_map[pseudonym] = {"name": disp, "file": os.path.basename(fn)}
    named_staff = [n for n, _ in staff_ct.most_common() if n != PLACEHOLDER]
    assigned = named_staff[0] if named_staff else (PLACEHOLDER if staff_ct else None)
    buf["customers"].append({"key": key, "display_name": display, "pseudonym": pseudonym, "phone": "", "grade": grade, "external_key": key, "first_contact_at": first_at, "blocked": blocked})
    buf["leads"].append({"key": key, "customer_key": key, "staff_name": assigned, "vehicle_key": None, "source": "line_search", "opened_at": first_at, "first_real_at": first_real, "closed_at": None, "outcome": ""})
    buf["conversations"].append({"key": key, "customer_key": key, "lead_key": key, "channel": "line", "assigned_staff": assigned, "messages": msgs, "coverage": "full"})
    stats["conversations"] += 1
    if len(buf["conversations"]) >= A.chunk: flush()
flush()
json.dump(name_map, open(os.path.join(A.out, "oa.map.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=0)
print("統計：", json.dumps(dict(stats), ensure_ascii=False))
print(f"跟 Super 8 對回 {matched} 段；員工 {len(staff)} 人（後台打字的：{[s['name'] for s in staff if s['email'].startswith('oa')]}）")
print(f"對照表 {os.path.join(A.out, 'oa.map.json')}（只留本機）")
