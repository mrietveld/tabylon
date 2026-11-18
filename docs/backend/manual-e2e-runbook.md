# Tabylon Manual End-to-End Runbook

Tabylon is the current Firefox add-on in this repository, maintained by mrietveld. It is based on the former Simple Tab Groups add-on; use Tabylon when referring to the current project. Source: https://github.com/mrietveld/tabylon.

This runbook walks through a manual test of the full system:
- local Python backend
- Tabylon Firefox add-on

## Preconditions
- Firefox is installed.
- The repositories exist at:
  - `/Users/mrietveld/Workspaces/various/tabylon`
- Python 3.11 is available at `/opt/homebrew/bin/python3.11`.
- Node/npm are available for rebuilding the Tabylon add-on.
- You have a valid LLM API key for an OpenAI-compatible endpoint.

## 1. Prepare the backend environment
From `tab-organizer/`:

```bash
/opt/homebrew/bin/python3.11 -m venv .venv
source .venv/bin/activate
pip install -r backend/requirements.txt
cp backend/.env.example backend/.env.local
```

Edit `backend/.env.local` and set at least:

```bash
TAB_ORGANIZER_LLM_API_KEY=your-real-key
TAB_ORGANIZER_LLM_MODEL=gpt-4o-mini
TAB_ORGANIZER_LLM_BASE_URL=https://api.openai.com/v1
```

The backend reads `backend/.env.local` automatically on startup, so you do not need to export these values into your shell.

## 2. Run backend verification tests

```bash
source .venv/bin/activate
cd backend
pytest -q
cd ..
```

Expected result:
- all backend tests pass

## 3. Start the backend
From `tab-organizer/`:

```bash
source .venv/bin/activate
uvicorn app.main:app --app-dir backend --host 127.0.0.1 --port 5050
```

Expected result:
- Uvicorn starts successfully
- backend listens on `http://127.0.0.1:5050`
- backend accepts `moz-extension://...` origins via CORS for the extension requests

Optional health check in a second terminal:

```bash
curl http://127.0.0.1:5050/health
```

Expected response:

```json
{"status":"ok","service":"tab-organizer-backend"}
```

## 4. Check backend logging
Confirm the log file exists:

```bash
ls -l backend/logs/
```

Expected result:
- `tab_organizer_backend.log` exists

Optional live tail:

```bash
tail -f backend/logs/tab_organizer_backend.log
```

## 5. Rebuild and load the Tabylon add-on
From the Tabylon repository:

```bash
cd /Users/mrietveld/Workspaces/various/tabylon/addon
npm run build
```

In Firefox:
1. Open `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on**
3. Select:
   - `/Users/mrietveld/Workspaces/various/tabylon/addon/dist/manifest.json`

Expected result:
- Tabylon loads without runtime errors

## 6. Start the Tabylon organizer
Start the local Python backend, then use Tabylon’s **Smart organize** action to generate and review the grouping plan.

Expected result:
- Tabylon contacts the configured backend
- the review page opens when a plan is ready

## 7. Prepare browser tabs for grouping
Open at least 15 tabs with a few obvious themes, for example:
- 5 Python/backend tabs
- 5 Firefox/WebExtension tabs
- 5 project management or documentation tabs

Expected result:
- there are enough tabs to allow at least one or more groups of size 5+

## 8. Start the grouping flow
1. Click the **Tab Organizer** toolbar button
2. Click **Organize Tabs** in the popup

Expected result:
- popup reports that it is checking the backend and generating a plan
- review page opens automatically when the plan returns

If this fails:
- check the popup error message and its JSON details block
- check Firefox extension console logs
- check backend terminal/log output
- confirm the failing step is `health-check` or `generate-grouping`

## 9. Review the generated plan
On the review page, confirm:
- a summary is shown
- one or more proposed groups are listed
- each group shows a reason
- each group shows 5 or more tabs
- any leftover tabs appear under ungrouped tabs

Expected result:
- the plan matches the visible browser context reasonably well

## 10. Apply the grouping plan
1. Click **Approve and apply**

Expected result:
- STG receives the external message
- new STG groups are created
- listed tabs move into the created groups
- the review page status updates with the apply result JSON

## 11. Inspect STG results
Inside STG, confirm:
- the new groups exist
- moved tabs match the approved groupings
- no unexpected extra tabs were moved

## 12. Inspect backend logs after the run
In a terminal:

```bash
tail -n 50 backend/logs/tab_organizer_backend.log
```

Expected log sequence includes entries like:
- backend startup
- grouping request received
- start of each chunked grouping pass
- chunk number/size within each pass
- retry log if a large ungrouped remainder is reprocessed
- plan validation succeeded

## 13. Negative-path checks
Run at least these manual failure checks:

### A. Backend offline
- stop the backend
- try **Organize Tabs** again

Expected result:
- popup shows a backend connection error
- no review/apply action occurs

### B. STG not loaded
- unload STG from `about:debugging`
- keep Tab Organizer loaded
- generate a plan
- click **Approve and apply**

Expected result:
- review page shows an STG apply error
- browser tabs are not silently changed by Tab Organizer itself

### C. Invalid or missing LLM credentials
- stop backend
- start backend with missing or invalid API key
- run the organize flow again

Expected result:
- backend returns an LLM failure
- extension shows the error cleanly
- backend log captures the failure

## 14. Record results
For each run, capture:
- whether backend health succeeded
- whether plan generation succeeded
- whether the plan looked correct
- whether STG apply succeeded
- any discrepancies between approved groups and applied groups
- relevant backend log excerpts

## Exit criteria
The system passes the manual end-to-end run when:
- backend starts and logs to file
- both extensions load in Firefox
- Tab Organizer generates a grouping plan from the real backend
- review page renders the plan
- approved plan is applied through STG
- backend logs show the request lifecycle
- failure cases remain visible and safe
