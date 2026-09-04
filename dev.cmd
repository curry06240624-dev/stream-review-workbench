@echo off
rem 本機開發伺服器（Browser pane 的 preview_start 會呼叫這支）
cd /d "%~dp0"
npx wrangler dev --port 8788
