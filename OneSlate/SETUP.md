# OneSlate — setup

Your personal cross-device dashboard. The frontend (`index.html`) is already built,
deployed to GitHub Pages, and syncing via Supabase. This file covers the **Garmin sleep
sync** — the one part that needs a few secrets only you can provide.

## How it works

```
  Garmin Connect ──(daily GitHub Action, garth login)──▶ Supabase `sleep` table
                                                              │
                                          index.html reads ───┘  shows on the front card
```

- A GitHub Actions cron (`.github/workflows/garmin-sync.yml`) runs every morning.
- It runs `scripts/garmin_sync.py`, which logs into Garmin, pulls last night's sleep
  score + recovery fields, and upserts them into the Supabase `sleep` table.
- The dashboard's front-middle **Recovery** card reads the latest row, caches it locally,
  shows "synced from Garmin · …", and degrades to "—" / "waiting for first sync" if data
  is missing. A failed sync never blanks the card.

## One-time setup (≈10 min)

### 1. Database
Supabase → **SQL Editor** → paste & run **`supabase/migrations/0001_sleep.sql`**.

### 2. Get your Garmin token (on your computer)
```
pip install garth
python scripts/garmin_token.py
```
Enter your Garmin email/password (+ MFA code if asked). Copy the printed
`GARMIN_TOKEN_BASE64` string.

### 3. Find the two Supabase values
- **service_role key**: Supabase → Settings → **API** → copy the `service_role` secret.
- **your user id**: Supabase → Authentication → **Users** → click your user → copy **User UID**.

### 4. Add GitHub secrets
Repo → **Settings → Secrets and variables → Actions → New repository secret**, add:

| Secret | Value |
|---|---|
| `GARMIN_TOKEN_BASE64` | from step 2 |
| `SUPABASE_URL` | `https://xspojczmywydubmttued.supabase.co` |
| `SUPABASE_SERVICE_KEY` | service_role key (step 3) |
| `SUPABASE_USER_ID` | your User UID (step 3) |

(Accounts without MFA can skip step 2 and instead add `GARMIN_EMAIL` + `GARMIN_PASSWORD`.)

### 5. Test it
Repo → **Actions → Garmin sleep sync → Run workflow**. When it goes green, refresh the
dashboard — your score appears on the Recovery card. After that it runs automatically each
morning (`cron: "10 11 * * *"`, ~7:10am ET — edit the time in the workflow if you like).

## Files
- `index.html` — the dashboard (compiled; edit `OneSlate.dc.html` and re-bundle to change).
- `supabase/migrations/0001_sleep.sql` — sleep table + security.
- `.github/workflows/garmin-sync.yml` — the daily job.
- `scripts/garmin_sync.py` — Garmin → Supabase sync.
- `scripts/garmin_token.py` — one-time token generator (run locally).
- `.env.example` — every secret, documented.

---

# Strava — running sync (≈15 min, one time)

Connects your Strava account so the **Running** module and the **AI Coach** work from
real runs (splits, HR, elevation, cadence, and a per-run pace/HR stream the coach reasons
over). Tokens are stored **server-side only** (a `strava_tokens` table the browser can
never read) and refreshed automatically.

```
  Browser ──(popup)──▶ Strava OAuth ──▶ strava-oauth-callback (stores tokens)
     │                                          │
     └──"Sync"──▶ strava-sync ◀──refresh──── strava_tokens (service-role only)
                     │  pulls new runs + splits + downsampled streams
                     ▼
                  runs table ───▶ index.html reads it (coach + charts)
```

### 1. Database
Supabase → **SQL Editor** → paste & run **`supabase/migrations/0002_strava.sql`**.
(Idempotent — safe to re-run. Adds the Strava tables and the rich run columns.)

### 2. Register a Strava API application
https://www.strava.com/settings/api → **Create App**.
- **Authorization Callback Domain**: your Supabase functions host, e.g.
  `xspojczmywydubmttued.supabase.co` (domain only, no path).
- Copy the **Client ID** and **Client Secret**.

### 3. Deploy the edge functions
Install the Supabase CLI, then from `OneSlate/`:
```
supabase link --project-ref <your-project-ref>
supabase functions deploy strava-auth-url
supabase functions deploy strava-sync
supabase functions deploy strava-oauth-callback --no-verify-jwt   # Strava hits it directly
```
> The `--no-verify-jwt` flag on the callback is required (Strava's redirect carries no
> user JWT — the function trusts the HMAC-signed `state` instead). It's also encoded in
> `supabase/config.toml`.

### 4. Set the Strava secrets
```
supabase secrets set STRAVA_CLIENT_ID=<client id> STRAVA_CLIENT_SECRET=<client secret>
```
(`SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` are injected automatically.)

### 5. Connect + sync
Open the dashboard → **Running → Goal → Connect Strava**. Approve in the popup; it closes
and the first sync runs. Re-sync any time with **↻ Sync** on the Recent-runs tab. First
sync pulls the last ~180 days (bounded by Strava's rate limits — 100/15min, 1000/day —
and resumes automatically if it hits the ceiling). Ask the coach *"how was my last run's
pacing?"* and it answers from the run and shows a **"Based on: …"** citation.

## Coach (health-chat) function
The conversational coach is the `health-chat` edge function (Gemini). `supabase/functions/
health-chat/index.ts` is a **reference** version that adds run-awareness; if you already
have a tuned function deployed, you only need the `RUN_AWARENESS` prompt block from it —
the browser now sends your recent + focused runs in the request `context` automatically.
Set its key with `supabase secrets set GEMINI_API_KEY=...`.

## Strava files
- `supabase/migrations/0002_strava.sql` — Strava tables + rich run columns + RLS.
- `supabase/functions/strava-auth-url/` — starts OAuth (returns the authorize URL).
- `supabase/functions/strava-oauth-callback/` — exchanges the code, stores tokens.
- `supabase/functions/strava-sync/` — incremental run sync (splits + downsampled streams).
- `supabase/functions/_shared/strava.ts` — token refresh, rate-limit budget, downsampler.
- `supabase/functions/health-chat/` — the conversational coach (reference).
- `supabase/config.toml` — per-function JWT settings.
