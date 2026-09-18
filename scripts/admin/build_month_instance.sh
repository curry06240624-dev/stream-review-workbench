#!/usr/bin/env bash
# 把一個站灌成「只有某一個月資料」的版本（跟 Super 8 月匯出等價，人工判讀／數字核對用）。
#   bash scripts/admin/build_month_instance.sh <base_url> <month_dir> [start_step]
#   例：bash scripts/admin/build_month_instance.sh https://ai-command-center-curry.curry06240624.workers.dev data/real/2026-09-18/aug
# month_dir 要先用 bundle_slice.mjs／group_txt_slice.mjs 切好：bundles/（主匯出）、bundles_old/（舊歷史，可無）、groups/{成交群,接待組,估車群}.txt
# 步驟（可從 start_step 續跑）：1 主匯出重灌 → 2 舊歷史補灌 → 3 車源表 → 4 三個群 → 5 名冊 → 6 Super 8 發送者 → 7 漏斗／分析／洞察 → 8 人工判讀 → 9 摘要
# 前提：該站已有管理員 boss@test.local / test-pass-123（新站先 /api/setup）。所有步驟都是冪等或可重跑的；名冊的併帳號除外（第二次跑會 skip）。
set -euo pipefail
BASE="${1:?base_url}"; DIR="${2:?month_dir}"; START="${3:-1}"
SHEET="${SHEET:-data/real/2026-09-06/瑋瑋中古車 - 瑋瑋中古車(新).csv}"
PATCH="${PATCH:-data/real/2026-09-15/sender_patch_aug.json}"
GOLDEN="${GOLDEN:-/c/Users/USER/Downloads/golden_super8-2026-08.csv}"
GOLDEN_MAP="${GOLDEN_MAP:-data/real/2026-09-17/frank_golden_map.json}"
DAYS="${DAYS:-30}"
step() { echo; echo "=== [$1] $2  $(date +%H:%M:%S) ==="; }

if [ "$START" -le 1 ]; then step 1 "主匯出重灌 $DIR/bundles"; node scripts/import_parts.mjs "$DIR/bundles" "$BASE" --reset | tail -16; fi
if [ "$START" -le 2 ] && [ -d "$DIR/bundles_old" ]; then step 2 "舊歷史補灌 $DIR/bundles_old（不 reset）"; node scripts/import_parts.mjs "$DIR/bundles_old" "$BASE" | tail -12; fi
if [ "$START" -le 3 ]; then step 3 "車源表 $SHEET"; node scripts/upload_doc.mjs "$SHEET" "$BASE" | tail -3; fi
if [ "$START" -le 4 ]; then step 4 "三個群"; node - "$BASE" "$DIR/groups" <<'EOF'
const fs = require("fs"); const [base, dir] = process.argv.slice(2); let cookie = "";
const api = async (p, b) => { const r = await fetch(base + p, { method: b ? "POST" : "GET", headers: { "content-type": "application/json", cookie, "user-agent": "Mozilla/5.0" }, body: b ? JSON.stringify(b) : undefined }); const sc = r.headers.get("set-cookie"); if (sc) cookie = sc.split(";")[0]; return r.json(); };
(async () => {
  await api("/api/login", { email: "boss@test.local", password: "test-pass-123" });
  for (const [f, kind] of [["成交群", "deal"], ["接待組", "reception"], ["估車群", "appraisal"]]) {
    const p = `${dir}/${f}.txt`; if (!fs.existsSync(p)) { console.log(f, "沒有檔案，略過"); continue; }
    const r = await api("/api/admin/import-group", { kind, text: fs.readFileSync(p, "utf8"), source_system: "line_export" });
    console.log(f, kind, r.ok ? `posts ${r.posts} deal_reports ${r.deal_reports} visits ${r.visits} appraisals ${r.appraisals} auto ${r.auto} suggested ${r.suggested} unmatched ${r.unmatched} dup ${r.duplicates}` : JSON.stringify(r).slice(0, 200));
  }
})();
EOF
fi
if [ "$START" -le 5 ]; then step 5 "名冊（黎 9/9）"; node scripts/admin/apply_roster_2026-09-09.mjs "$BASE" --dry | tail -4; node scripts/admin/apply_roster_2026-09-09.mjs "$BASE" | tail -6; fi
if [ "$START" -le 6 ]; then step 6 "Super 8 發送者 $PATCH（化名＋時間＋文字對）"; node scripts/admin/apply_sender_patch.mjs "$PATCH" "$BASE" | tail -6; fi
if [ "$START" -le 7 ]; then step 7 "漏斗 → 分析 → 車源表同步 → 洞察（days=$DAYS）"; node scripts/run_pipeline.mjs "$BASE" --days="$DAYS" | tail -25; fi
if [ "$START" -le 8 ] && [ -f "$GOLDEN" ]; then step 8 "人工判讀 $GOLDEN"; node scripts/admin/import_golden_labels.mjs "$GOLDEN" "$GOLDEN_MAP" "$BASE" | tail -12; fi
step 9 "摘要"; node - "$BASE" <<'EOF'
const base = process.argv[2]; let cookie = "";
const api = async (p, b) => { const r = await fetch(base + p, { method: b ? "POST" : "GET", headers: { "content-type": "application/json", cookie, "user-agent": "Mozilla/5.0" }, body: b ? JSON.stringify(b) : undefined }); const sc = r.headers.get("set-cookie"); if (sc) cookie = sc.split(";")[0]; return r.json(); };
(async () => {
  await api("/api/login", { email: "boss@test.local", password: "test-pass-123" });
  const me = await api("/api/me"); console.log("data_end", me.data_end, JSON.stringify(me.source_ends));
  const a = await api("/api/analytics?days=31"); if (a.ok) console.log("31 天：新進線", a.funnel.leads, "只加好友／點選單", a.funnel.menu_only_leads, "報價", a.funnel.events.PRICE_MENTIONED, "報價後流失", a.price_dropoff.count, "預約", a.funnel.events.APPOINTMENT_BOOKED, "到店", a.funnel.events.STORE_VISIT, "成交", a.deals.sold, "流失", a.deals.lost, "毛利", a.deals.gross_profit, "SABC", JSON.stringify(a.grades.period)); else console.log("analytics", JSON.stringify(a).slice(0, 200));
  const at = await api("/api/attention"); console.log("需要注意", JSON.stringify(at.counts));
})();
EOF
echo; echo "完成 $(date +%H:%M:%S)"
