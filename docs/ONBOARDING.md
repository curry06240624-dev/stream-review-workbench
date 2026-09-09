# Onboarding — 訊息到成交 AI 影子控制台 (v0.1)

Written 2026-09-09 for a new developer joining the project. Read top to bottom once (20 minutes), then keep it open while you work.

## 1. What this is, in one paragraph

A used-car dealership (瑋瑋中古車, Taoyuan) sells cars through LINE. Customers message the shop's LINE Official Account; a 訊息組 (message team) chats with them, hands hot ones to 業務 (salespeople), who book visits, take deposits, submit loans and deliver cars. The company also runs internal LINE groups: 成交群 (deposit/sale posts), 估車群 (trade-in appraisal requests), 接待組 (walk-in coordination). This system reads exports of all of that, rebuilds what happened to every customer as a **funnel of events**, grades customers **S/A/B/C**, computes sales per person, finds customers who are being neglected, and writes a daily brief. It is a **shadow**: it never messages a customer, never writes to their CRM (Super 8), and every number on screen links back to the original messages. Numbers come from **rules**; the AI (Gemini) only turns computed numbers into sentences and suggestions.

The client's own three-phase plan (in `專案狀態_2026-09-06.md`): phase 1 read-only analysis (mostly built), phase 2 AI proposes / humans approve (largely built: 決策卡, 管理行動中心, 教練), phase 3 automation and production infrastructure by a professional team.

## 2. Hard rules (these are not suggestions)

1. **No real customer data on your machine**, with one exception: the pseudonymized LINE export pack Curry hands you for the count audit (section 9). It stays on your own disk, never goes into git, a screenshot, a chat or any cloud/AI tool, and you delete it when that task is done. Everything else you work with is the synthetic dataset (`data/mock/`).
2. **Never touch the production site** `ai-command-center.curry06240624.workers.dev`. Your instance is `ai-command-center-rayson.curry06240624.workers.dev` (empty, yours to fill and reset); `-demo` has synthetic data.
3. **No secrets in git.** `.dev.vars` is git-ignored; never paste keys into code, screenshots or chat.
4. **The system recommends, it never acts.** No feature may send a message, assign a customer, or change Super 8.
5. **Every number must be traceable** to messages or records. If you add a number, add the evidence path too.
6. **Never delete anything on Cloudflare** (Workers, KV, Pages projects). Deploy only your own test config.
7. UI text is Traditional Chinese for a boss who is not technical. No emoji as icons; inline SVG only.

## 3. Where things run

| instance | URL | data | who |
|---|---|---|---|
| official | ai-command-center.curry06240624.workers.dev | real, de-identified | 瑋瑋's company, Curry only |
| demo | ai-command-center-demo.curry06240624.workers.dev | synthetic | anyone testing |
| rayson | ai-command-center-rayson.curry06240624.workers.dev | empty | **you** (`wrangler.rayson.toml`) |
| curry | ai-command-center-curry.curry06240624.workers.dev | empty | Curry's own test site |
| frank | ai-command-center-frank.curry06240624.workers.dev | empty | Frank (parallel analysis) |

Login on demo/test sites: click 老闆 (DEMO_MODE) or `boss@test.local` / `test-pass-123`.

Locally: `npm run dev` starts Wrangler on port 8788. Use `--persist-to .wrangler/state-mock` on port 8789 for the mock dataset so the accuracy gates have their own database.

## 4. Stack and repo map

- **Runtime:** Cloudflare Workers. One Durable Object (`AppDB` in `src/db.js`) owns a SQLite database; all heavy work runs inside it. KV `DOCS` stores uploaded files. Gemini for text only.
- **Language:** TypeScript for engines (`src/engine/*.ts`, `src/model/*.ts`), plain JS for the Worker entry (`src/index.js`) and the frontend (`public/app/*.js`, no framework, no build step).
- **Repo:** github.com/curry06240624-dev/stream-review-workbench

```
src/index.js            Worker entry: routes (/api/...), auth, admin endpoints, cron warm-up
src/db.js               Durable Object: schema bootstrap, caches, *Local() methods that engines run inside
src/model/schema.ts     migrations (ADD_COLUMNS, NEW_TABLES, one-time backfills) — add columns here
src/model/types.ts      row types; bundle.ts = import bundle format; menu.ts = menu-button text list
src/adapters/import.ts  bundle → database (de-identification happens here)
src/engine/funnel.ts    the rules that turn messages into funnel events (the heart of the system)
src/engine/grade.ts     SABC grading (company rules in docs/SABC_RULES.md)
src/engine/analytics.ts numbers for 總覽／漏斗／成交／需要注意
src/engine/staff.ts     per-staff metrics, rankings, 表現最佳／需關注
src/engine/coaching.ts  decision cards, coaching plans, action before/after
src/engine/loss.ts      why customers were lost
src/engine/behavior.ts  per-lead behaviour features (did the rep ask a question after quoting, etc.)
src/engine/attribution.ts who touched a lead (roles: handoff, support, reactivation)
src/engine/posts.ts     parsers for LINE group posts (收訂囉 templates, 估車 templates, exports)
src/engine/reconcile.ts matches group posts to cars/customers/staff, creates deals
src/engine/sheetdeals.ts 車源表 (stock sheet) → deals
src/engine/documents.ts upload box: detects file kind and processes it
src/engine/insights.ts  rule-derived insights; ai.ts = Gemini wrapper + facts pack + brief; ask.ts = 問 AI
src/routes/views.ts     read-only list/detail endpoints for the pages
public/app/router.js    SPA router; api.js = fetch wrapper; ui.js = shared helpers (h, raw, esc, chips, tables)
public/app/pages/*.js   one file per page (overview, funnel, attention, conversations, deals, staff, decisions…)
scripts/                gen_mock.ts (synthetic data), import_bundle.mjs, run_pipeline.mjs, eval_*.mjs (accuracy gates), test_posts.ts
docs/                   design and rule documentation (index in section 10)
data/mock/              synthetic bundle + truth.json (ground truth for the gates)
```

## 5. Run it locally (15 minutes)

```bash
git clone https://github.com/curry06240624-dev/stream-review-workbench.git
cd stream-review-workbench
npm install
printf "SETUP_CODE=devsetup\n" > .dev.vars        # any value; GEMINI_API_KEY optional (without it, AI text falls back to templates)
npx wrangler dev --port 8789 --persist-to .wrangler/state-mock
```

In a second terminal:

```bash
node scripts/import_bundle.mjs data/mock/bundle.json http://127.0.0.1:8789 --reset   # creates the admin and loads 588 synthetic customers
node scripts/run_pipeline.mjs http://127.0.0.1:8789 --no-insights                     # funnel → analysis → grades → caches
```

Open http://127.0.0.1:8789, log in as 老闆. Then run the checks you will run before every PR:

```bash
npm run typecheck
node scripts/test_posts.ts
node scripts/eval_funnel.mjs http://127.0.0.1:8789
node scripts/eval_loss.mjs http://127.0.0.1:8789
node scripts/eval_reconcile.mjs http://127.0.0.1:8789
```

All three gates must print ✓. They compare the rules against `data/mock/truth.json`.

Known local quirk: Wrangler's local runtime sometimes crashes on requests longer than ~10 seconds. Restart it; it is not your bug.

## 6. Data model, the short version

- `contacts` (a customer, pseudonym like 客戶#01234) → `leads` (one journey per customer: stage, outcome, staff_id, grade_auto, first_real_at) → `conversations` → `messages` (sender_role customer/staff/bot, msg_type text/menu/sticker/image…).
- `funnel_events` (type, at, confidence, source) + `evidence` (event → message ids). The funnel is recomputed from scratch by `runFunnel`; it is idempotent.
- `deals` (sold cars: price, cost, staff, closed_at, delivered, loan_status, closed_at_source). Sources: 成交群 posts (`deal_reports`), 車源表 (`sheetdeals`), ledger.
- `group_posts`, `deal_reports`, `appraisals`, `visits`, `appointments`: raw and parsed group data.
- `users` (staff) + `staff_aliases` (every nickname a person appears under). Names are messy; see `docs/staff.yaml`.
- `behaviors`, `loss_analyses`, `insights`, `briefs`, `actions`, `coaching_plans`, `lead_roles`: analysis outputs. `documents` + `source_records` track uploaded files and where each imported row came from.
- `cache_json`: durable cache of page results; `bust()` clears it whenever data changes.

Full column list: `docs/DATA_MODEL.md` and `src/model/schema.ts`.

## 7. How a request flows

1. Frontend page calls `api("/api/analytics?days=7")` (`public/app/api.js` adds `anchor=today` when the user toggled it).
2. `src/index.js` `route()` checks login (`currentUser` from `src/auth.js`) and role (`canSeeAll` from `src/inbox.js`), then calls a Durable Object method such as `db.analyticsLocal({ days, anchor })`. Read-only list/detail endpoints live in `src/routes/views.ts` (`handleViews`).
3. `src/db.js` resolves the analysis window (`resolveTo`: default ends at the data's last message), checks the cache, and runs the engine (`computeAnalytics`) inside the DO.
4. The page renders with `h` tagged templates (`ui.js`): `h` escapes values; wrap trusted HTML in `raw()`.

Conventions that bite: never call `.call`/`.apply` on `db` methods (it is an RPC proxy); `Date.now()` does not advance inside the DO without I/O; SQLite allows at most 100 bound parameters, so batch id lists at 90; add columns through `ADD_COLUMNS` in `schema.ts` (they run once, idempotently).

## 8. Glossary (the business words you will see in code and UI)

| term | meaning |
|---|---|
| 進線 / 新進線 | a new customer conversation. Counted only when the customer sent something that is not a menu tap |
| 訊息組 | the chat team answering LINE; 業務 = salespeople; 運營 = operations; 老闆 = the owner |
| 報價 | a salesperson quoting a price or monthly payment (customers tapping a car card do not count) |
| 約看 / 預約 / 到店 | proposing a visit / booked visit / customer came to the shop |
| 收訂 | deposit taken = counted as a sale (company rule); 送貸 = loan submitted; 過件 = loan approved; 撥款 = loan paid out; 交車 = car delivered |
| 車源表 | the stock sheet; 開價 = list price; 調作價 = real selling price; 成本 = cost |
| 估車 | trade-in appraisal; 權威 / 天書 = two price guides; 車換車 = trade-in; 純賣 = selling only |
| 同行車 | a car sourced from another dealer (no cost data) |
| SABC | customer grades: S high-progress, A core info known, B talking but incomplete, C no real conversation |
| 需要注意 | today's neglected customers; 決策卡 = decision cards for the manager; 管理行動 = tracked actions |
| Super 8 | the CRM/chat console the company uses on top of LINE; we only read its exports |

## 9. Your first task: the count audit (資料量時間核對)

**Why:** the boss reads one number first: 新進線 for the last 7 days (his screen says 319, down 29 from the previous week). If the amount of data per time window is wrong, every number downstream is wrong. Nobody outside the project has recounted it from the raw export yet. You are that person, and the point is to check whether *you* get the same answer, so work independently: raw files first, project code second.

**What you get from Curry (not in the repo):** a pack with the pseudonymized LINE export (54,498 CSV files, about 5.5 million rows), the production numbers as of 2026-09-09, and a `README.md` with the exact definitions, windows and steps. That README is the spec; read it before anything else.

**Steps, short version**

1. Recount from the CSVs with your own script (any language). Per Taiwan day and for the 7/14/30-day windows in the README.
2. Compare with the production numbers. Explain every difference with conversation ids.
3. Reproduce on your instance with the project's own tools, then compare all three (your count, your instance, production):

```bash
py scripts/adapters/line_oa_csv_to_bundles.py <unzipped folder> out/bundles --since 2024-01-01 --today 2026-09-06
node scripts/import_parts.mjs out/bundles https://ai-command-center-rayson.curry06240624.workers.dev
node scripts/run_pipeline.mjs https://ai-command-center-rayson.curry06240624.workers.dev --no-insights --days=7
```

The adapter is `scripts/adapters/line_oa_csv_to_bundles.py` (its docstring explains the export format and every rule). The first import on an empty instance needs the instance's `SETUP_CODE` in your local `.dev.vars`; it is in the pack, not in git. The pipeline on 5 million rows takes a while; the scripts print progress.

4. Report as markdown: your numbers vs production, discrepancies with causes, and anything about "amount of data by time" that looks wrong.

**Done means:** the report exists, every number in it is reproducible from your script, and each discrepancy has either a cause or an explicit "unexplained".

## 9b. Second task: 人工抽查標記工具 (manual accuracy labelling)

**Why:** the client's success criterion is "system numbers match manual counts". A student auditor and a second team (Frank) will judge system labels by hand. Today they write in a Google Sheet; the system should record their verdicts and compute precision itself.

**What to build**

1. Table `label_reviews` (add to `NEW_TABLES` in `src/model/schema.ts`): `id, lead_id, target_kind ('event' | 'grade' | 'attention'), target_key (event type or 'grade' or attention kind), event_id (nullable), verdict ('right' | 'wrong' | 'unsure'), correct_value TEXT, note TEXT, reviewer_user_id, created_at`. One row per judgement; later judgements on the same target supersede earlier ones.
2. Endpoints in `src/index.js` (login required, any role): `POST /api/labels` to record a verdict, `GET /api/labels?lead_id=` to read them, `GET /api/labels/summary?days=30` returning, per target_key, counts of right/wrong/unsure and precision = right / (right + wrong). Put the SQL in a `labelsLocal` method in `src/db.js`, following how `reconcileLocal` is wired.
3. UI: on the conversation detail page (`public/app/pages/conversations.js`, the 系統推算 block that lists events and the SABC grade), add three small buttons after each label: 對 / 錯 / 不確定. On 錯, show a one-line input for the correct value. Save via `api()`, repaint the row to show the verdict and who gave it.
4. A page `/labels` (add `["/labels", "labels"]` to `ROUTES` in `router.js`, create `public/app/pages/labels.js` exporting `render` like the other pages, and add an `<a href="/labels" data-link data-key="labels">` entry to the nav in `public/index.html`) with a table: label, reviewed, right, wrong, unsure, precision, and a link that opens the next unreviewed lead for that label (`/api/leads?event=PRICE_MENTIONED` already exists for listing leads by event).

**Done means:** on the demo site you can review 20 leads, the summary page shows the counts, and a hand count of your own 20 verdicts matches it. Typecheck and the three gates still pass. Screenshots in the PR.

**Where to look first:** `public/app/pages/conversations.js` (how the detail renders events), `src/routes/views.ts` (the lead detail endpoint `/api/leads/:id`, which already returns events with their evidence message ids), `src/index.js` `/api/mgmt-actions` (a small GET/POST example with login and role checks), `src/model/schema.ts` (`NEW_TABLES`). Node 24 runs `.ts` files directly, so `node scripts/test_posts.ts` needs no flags.

## 10. Working agreement

- Branch per task (`rayson/labels`), small commits, PR to `main`. Curry reviews; nothing merges without typecheck plus the three gates passing.
- Test on your local mock DB and on your `-rayson` site. Deploy there only with `npx wrangler deploy --config wrangler.rayson.toml` after Curry adds you to the Cloudflare account; ask before your first deploy. Until then, Curry deploys for you.
- If a rule looks wrong (a funnel event fires on a message it shouldn't), do not patch the regex silently. Note the example in `docs/FUNNEL_MODEL.md` style and raise it; every rule change goes through the gates.
- Questions: write them down in the PR or the group chat with the exact lead id and message text from the **mock** data.

## 11. Docs index

| doc | read when |
|---|---|
| `README.md` | overview and run commands |
| `docs/ARCHITECTURE.md`, `docs/DATA_MODEL.md` | how it is built, what the tables mean |
| `docs/FUNNEL_MODEL.md` | every funnel rule and the six accuracy rounds on real data |
| `docs/SABC_RULES.md` | the company's grading rules and how the system approximates them |
| `docs/DATA_FLOW.md` | where each data source comes from and how it is read (groups, stock sheet, LINE export) |
| `docs/STAFF_EFFECTIVENESS.md`, `docs/COACHING_DECISIONS.md` | staff metrics, decision cards, coaching |
| `docs/AI_ANALYSIS.md` | what goes to Gemini and how numbers are gated |
| `docs/PERFORMANCE.md` | caching and the data-end window |
| `docs/labels.yaml`, `docs/staff.yaml` | the shared label definitions and the staff/alias list |
| `docs/FRONTEND.md`, `docs/IA.md` | page structure and UI conventions |
