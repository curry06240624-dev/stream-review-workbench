# -*- coding: utf-8 -*-
"""
LINE 官方帳號匯出（一段對話一個 CSV）→ 去識別化的複本，格式跟原檔一模一樣（同欄位、同時間字串、同分檔），
給第三方（Rayson）獨立核對「數量對不對」用，不用先看到真名。

  py scripts/adapters/line_oa_scrub_export.py <匯出資料夾> <輸出資料夾> [--map bundles/oa.map.json --map bundles_old/oa.map.json] [--zip 檔名.zip]

做的事：
  1. 檔名裡的顯示名稱換成 客戶#NNNNN（沿用 oa.map.json 的編號，跟正式站對得上；沒對到的從 #99001 起）
  2. User 列的 Sender name 換成同一個化名；訊息文字裡出現顯示名稱（加好友歡迎訊息常帶名字）也換掉
  3. 訊息文字：身分證字號那一整則抹掉、手機號碼抹掉（跟 src/adapters/import.ts 同規則，但這裡對所有人的訊息都抹）
  4. Account 列的 Sender name（員工名／Auto-response／Unknown）保留 —— 員工名已在 docs/staff.yaml 公開
  5. 前三行檔頭與表頭原樣保留；沒有 .csv 副檔名的檔（匯出本身的亂碼檔名）也一併收進來並改成正常檔名
輸出 scrub_report.json（只有數字，沒有內容）。真名對照表不寫出來——正式站那份 oa.map.json 就是對照表，留本機。
"""
import sys, os, re, csv, json, glob, argparse, zipfile, collections

sys.stdout.reconfigure(encoding="utf-8")
csv.field_size_limit(10**9)

ap = argparse.ArgumentParser()
ap.add_argument("src"); ap.add_argument("out")
ap.add_argument("--map", action="append", default=[])
ap.add_argument("--zip", default="")
ap.add_argument("--start-no", type=int, default=99001)
A = ap.parse_args()
os.makedirs(A.out, exist_ok=True)

RE_ID_NUMBER = re.compile(r"[A-Z][12]\d{8}")
RE_PHONE = re.compile(r"09\d{2}[- ]?\d{3}[- ]?\d{3}")
ID_TEXT = "[客戶傳來的證件資料（身分證字號、姓名、生日），已整則抹掉]"
PHONE_TEXT = "[電話已抹掉]"

# 檔名 → 化名（兩份 oa.map.json：{化名: {name, file}}）
by_file = {}
for mp in A.map:
    if not os.path.exists(mp): print("找不到對照表", mp); continue
    for pseudo, v in json.load(open(mp, encoding="utf-8")).items():
        by_file.setdefault(v["file"], pseudo)
print(f"對照表 {len(by_file)} 檔")

def file_meta(base):
    m = re.match(r"^(\d+)_(?:(\d{8})_(\d{8}))?_?(.*?)(?:\.csv)?$", base)
    return m.group(1), m.group(2), m.group(3), (m.group(4) or "").strip()

files = sorted(f for f in os.listdir(A.src) if re.match(r"^\d+_", f) and os.path.isfile(os.path.join(A.src, f)))
print(f"來源 {len(files)} 檔")
stats = collections.Counter(); next_no = A.start_no; seen_pseudo = set()

for fn in files:
    idx, d1, d2, disp = file_meta(fn)
    pseudo = by_file.get(fn)
    if not pseudo:
        pseudo = f"客戶#{next_no:05d}"; next_no += 1; stats["unmapped_files"] += 1
    if pseudo in seen_pseudo: pseudo = f"客戶#{next_no:05d}"; next_no += 1; stats["dup_pseudo_fixed"] += 1
    seen_pseudo.add(pseudo)
    out_name = f"{idx}_{d1}_{d2}_{pseudo}.csv" if d1 else f"{idx}_{pseudo}.csv"
    name_re = re.compile(re.escape(disp)) if len(disp) >= 2 and disp not in ("Unknown",) else None
    with open(os.path.join(A.src, fn), encoding="utf-8-sig", newline="") as f:
        head = [f.readline() for _ in range(3)]
        r = csv.reader(f); header = next(r, None)
        rows = list(r)
    with open(os.path.join(A.out, out_name), "w", encoding="utf-8", newline="") as g:
        g.writelines(head)
        w = csv.writer(g, lineterminator="\n")
        if header: w.writerow(header)
        for row in rows:
            if len(row) < 5: w.writerow(row); stats["short_rows"] += 1; continue
            st, sn, d, t, m = row[0], row[1], row[2], row[3], row[4]
            if st == "User": sn = pseudo
            if RE_ID_NUMBER.search(m): m = ID_TEXT; stats["id_texts"] += 1
            else:
                m, k = RE_PHONE.subn(PHONE_TEXT, m); stats["phones"] += k
                if name_re:
                    m, k = name_re.subn(pseudo, m); stats["names_in_text"] += k
            w.writerow([st, sn, d, t, m] + row[5:]); stats["rows"] += 1
    stats["files"] += 1
    if stats["files"] % 5000 == 0: print("  …", stats["files"])

json.dump(dict(stats), open(os.path.join(A.out, "scrub_report.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print("統計：", json.dumps(dict(stats), ensure_ascii=False))

if A.zip:
    with zipfile.ZipFile(A.zip, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        for f in sorted(os.listdir(A.out)): z.write(os.path.join(A.out, f), f)
    print("zip", A.zip, os.path.getsize(A.zip) // 1048576, "MB")
