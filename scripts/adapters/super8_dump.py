# -*- coding: utf-8 -*-
"""
綠化 9/15 給的 SUPER8 匯出（一段對話一個 .txt，zip 打包）的讀取器。

  每則訊息長這樣：
    [123456] 2026/08/21 10:24:29｜Jing（客戶）            ← 客戶
    [123457] 2026/08/21 10:24:29｜系統／自動訊息           ← 機器人（歡迎、群發、範本…）
    [123458] 2026/08/21 10:30:01｜趙 君岳（客服）          ← 業務／訊息組在 Super 8 打的（座位名「名 姓」）
    類型：text/plain | application/x-template | application/x-broadcast | application/x-image …
    {…JSON 內容…}
    ------------------------------------------------------------
  時間是台灣時間。這份匯出解決了 LINE 官方匯出「透過 Super 8 發的都叫 Unknown」的問題：誰發的寫得清清楚楚。

用法（當模組）：
    from super8_dump import iter_conversations
    for conv in iter_conversations("SUPER8_2026年8月對話與進人_25321份對話.zip"):
        conv["customer"], conv["file"], conv["messages"] → [{id, at_tw, at_utc, who, name, kind, mime, text}]
  who ∈ customer | staff | bot ； name＝客戶顯示名或客服座位名 ； kind＝text/template/broadcast/image/sticker/event/…
"""
import zipfile, re, json, datetime as dt

HDR = re.compile(r"^\[(\d+)\] (\d{4})/(\d{2})/(\d{2}) (\d{2}):(\d{2}):(\d{2})｜(.+)$")
SEP = "-" * 60
TZ = dt.timezone(dt.timedelta(hours=8))
KIND = {"text/plain": "text", "application/x-template": "template", "application/x-broadcast": "broadcast", "application/x-notify-event": "event",
        "application/x-image-set": "image", "application/x-image": "image", "application/x-share": "share", "application/x-line-sticker": "sticker",
        "application/x-video": "video", "application/x-file": "file", "application/x-audio": "audio", "application/x-form": "form"}


def _text_of(kind, body):
    """把 JSON 內容抽成可比對的文字：純文字取 text；範本／群發取所有 text/title 串起來。"""
    body = body.strip()
    if not body: return ""
    try: obj = json.loads(body)
    except Exception: return body
    if kind == "text" and isinstance(obj, dict): return str(obj.get("text") or obj.get("content") or "")
    out = []
    def walk(o):
        if isinstance(o, dict):
            for k, v in o.items():
                if k in ("text", "title", "label", "altText") and isinstance(v, str): out.append(v)
                else: walk(v)
        elif isinstance(o, list):
            for v in o: walk(v)
    walk(obj)
    return " ".join(out)


def parse_file(raw):
    lines = raw.split("\n")
    head = {}
    for L in lines[:12]:
        if L.startswith("客戶："): head["customer"] = L[3:].strip()
        elif L.startswith("目前 SUPER8 顯示名稱："): head["display_now"] = L.split("：", 1)[1].strip()
        elif L.startswith("SUPER8 標記："): head["tag"] = L.split("：", 1)[1].strip()
        elif "加入時間" in L: head["joined"] = L.split("加入時間", 1)[1].strip(" ：:")
    msgs = []; i = 0; n = len(lines)
    while i < n:
        m = HDR.match(lines[i])
        if not m: i += 1; continue
        mid, Y, Mo, D, h, mi, s, who = m.groups()
        at = dt.datetime(int(Y), int(Mo), int(D), int(h), int(mi), int(s), tzinfo=TZ)
        who = who.strip(); role, name = "customer", who
        if who == "系統／自動訊息": role, name = "bot", ""
        elif who.endswith("（客服）"): role, name = "staff", who[:-4].strip()
        elif who.endswith("（客戶）"): name = who[:-4].strip()
        mime = ""; body = []; i += 1
        if i < n and lines[i].startswith("類型："): mime = lines[i][3:].strip(); i += 1
        while i < n and lines[i] != SEP and not HDR.match(lines[i]): body.append(lines[i]); i += 1
        if i < n and lines[i] == SEP: i += 1
        kind = KIND.get(mime, mime or "unknown")
        msgs.append({"id": int(mid), "at_tw": at.strftime("%Y-%m-%d %H:%M:%S"), "at_utc": at.astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z"),
                     "who": role, "name": name, "kind": kind, "mime": mime, "text": _text_of(kind, "\n".join(body))})
    return head, msgs


def iter_conversations(zip_path, limit=0):
    z = zipfile.ZipFile(zip_path); k = 0
    for name in z.namelist():
        if name.startswith("0000_") or not name.endswith(".txt"): continue
        head, msgs = parse_file(z.read(name).decode("utf-8-sig"))
        yield {"file": name, **head, "messages": msgs}
        k += 1
        if limit and k >= limit: return
