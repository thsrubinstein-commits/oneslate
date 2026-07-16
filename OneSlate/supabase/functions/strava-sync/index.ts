// strava-sync — pull new run activities since the last watermark, enrich each
// with splits + a downsampled stream, and upsert into `runs`. Respects Strava's
// rate limits via a persisted budget and never advances the watermark past a run
// it hasn't fully stored (so an interrupted sync resumes cleanly).
// deno-lint-ignore-file no-explicit-any
import {
  corsHeaders, json, serviceClient, requireUser, validAccessToken,
  RateBudget, downsampleStreams, parseSplits, classifyRun, paceSecKm,
  STRAVA_API,
} from "../_shared/strava.ts";

const RUN_TYPES = new Set(["Run", "TrailRun", "VirtualRun"]);
const FIRST_SYNC_LOOKBACK_DAYS = 180;

async function stravaGet(url: string, token: string) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 429) { const e: any = new Error("rate limited"); e.rateLimited = true; throw e; }
  if (!res.ok) throw new Error(`Strava ${res.status}`);
  return res.json();
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const svc = serviceClient();
  let userId = "";
  try {
    userId = await requireUser(req, svc);
  } catch (e) {
    return json({ error: (e as Error).message }, 401);
  }

  const { data: conn } = await svc.from("strava_connections")
    .select("*").eq("user_id", userId).maybeSingle();
  if (!conn) return json({ error: "Strava not connected" }, 400);

  const { data: state } = await svc.from("strava_sync_state")
    .select("*").eq("user_id", userId).maybeSingle();
  const budget = new RateBudget(state);

  let token: string;
  try {
    token = await validAccessToken(svc, userId);
  } catch (e) {
    await svc.from("strava_sync_state").upsert({
      user_id: userId, last_error: (e as Error).message, updated_at: new Date().toISOString(),
      ...budget.toState(),
    });
    return json({ error: (e as Error).message }, 400);
  }

  const nowIso = new Date().toISOString();
  const watermark = state?.last_activity_start
    ? new Date(state.last_activity_start)
    : new Date(Date.now() - FIRST_SYNC_LOOKBACK_DAYS * 864e5);
  const afterEpoch = Math.floor(watermark.getTime() / 1000);

  let synced = 0;
  let throttled = false;
  let lastError: string | null = null;
  let newWatermark = watermark;

  try {
    // 1) Page the activity list (1 request per page) collecting new runs.
    const newRuns: any[] = [];
    let page = 1;
    while (budget.canSpend(1)) {
      budget.spend(1);
      const list: any[] = await stravaGet(
        `${STRAVA_API}/athlete/activities?after=${afterEpoch}&per_page=50&page=${page}`,
        token,
      );
      if (!Array.isArray(list) || list.length === 0) break;
      for (const a of list) if (RUN_TYPES.has(a.type) || RUN_TYPES.has(a.sport_type)) newRuns.push(a);
      if (list.length < 50) break;      // last page
      page++;
    }

    // 2) Oldest → newest so the watermark only moves past fully-stored runs.
    newRuns.sort((a, b) => new Date(a.start_date).getTime() - new Date(b.start_date).getTime());

    for (const a of newRuns) {
      if (!budget.canSpend(2)) { throttled = true; break; }   // detail + streams
      budget.spend(1);
      const detail = await stravaGet(`${STRAVA_API}/activities/${a.id}?include_all_efforts=false`, token);
      budget.spend(1);
      let stream: any[] = [];
      try {
        const streamSet = await stravaGet(
          `${STRAVA_API}/activities/${a.id}/streams?keys=time,distance,heartrate,altitude,velocity_smooth,cadence&key_by_type=false`,
          token,
        );
        stream = downsampleStreams(streamSet, 120);
      } catch (_) { /* streams optional (e.g. manual entry) — keep summary */ }

      const km = (detail.distance || 0) / 1000;
      const row = {
        user_id: userId,
        provider: "strava",
        strava_id: a.id,
        name: detail.name || "Run",
        type: classifyRun(detail),
        started_at: detail.start_date,
        distance_km: km || null,
        moving_sec: detail.moving_time || null,
        elapsed_sec: detail.elapsed_time || null,
        avg_pace_sec_km: paceSecKm(detail),
        max_pace_sec_km: detail.max_speed ? Math.round(1000 / detail.max_speed) : null,
        avg_hr: detail.average_heartrate != null ? Math.round(detail.average_heartrate) : null,
        max_hr: detail.max_heartrate != null ? Math.round(detail.max_heartrate) : null,
        avg_cadence: detail.average_cadence != null ? Math.round(detail.average_cadence * 2) : null,
        elev_gain_m: detail.total_elevation_gain ?? null,
        perceived_effort: detail.perceived_exertion ?? detail.suffer_score ?? null,
        splits: parseSplits(detail),
        stream,
        raw: {
          id: detail.id, name: detail.name, type: detail.type, sport_type: detail.sport_type,
          start_date_local: detail.start_date_local, has_heartrate: detail.has_heartrate,
        },
        synced_at: nowIso,
      };

      const { error } = await svc.from("runs")
        .upsert(row, { onConflict: "user_id,strava_id" });
      if (error) { lastError = error.message; break; }
      synced++;
      newWatermark = new Date(detail.start_date);
    }
  } catch (e) {
    if ((e as any).rateLimited) { throttled = true; lastError = "Strava rate limit reached — try again later"; }
    else lastError = (e as Error).message;
  }

  // 2b) Self-heal: collapse any duplicate rows for the same activity. Rows can
  // predate the unique(user_id,strava_id) constraint — e.g. a strava_id-null twin
  // from an older import sits beside the synced row, and NULLs are distinct so both
  // survive. We group Strava rows by start instant (an activity can't start twice)
  // and keep the most complete one (has strava_id, then newest sync). Manual runs
  // (provider 'manual', strava_id null) are left untouched. Best-effort: never fails
  // the sync.
  try {
    const { data: existing } = await svc.from("runs")
      .select("id, provider, strava_id, started_at, synced_at")
      .eq("user_id", userId);
    if (existing && existing.length) {
      const groups = new Map<string, any[]>();
      for (const r of existing) {
        if (r.strava_id == null && r.provider !== "strava") continue; // leave manual runs alone
        const key = String(Math.floor(new Date(r.started_at).getTime() / 1000));
        let arr = groups.get(key);
        if (!arr) { arr = []; groups.set(key, arr); }
        arr.push(r);
      }
      const toDelete: any[] = [];
      for (const rows of groups.values()) {
        if (rows.length < 2) continue;
        rows.sort((a, b) =>
          (Number(b.strava_id != null) - Number(a.strava_id != null)) ||
          (new Date(b.synced_at || 0).getTime() - new Date(a.synced_at || 0).getTime())
        );
        for (let i = 1; i < rows.length; i++) toDelete.push(rows[i].id);
      }
      if (toDelete.length) await svc.from("runs").delete().in("id", toDelete);
    }
  } catch (_) { /* dedupe is best-effort; never fail the sync over it */ }

  // 3) Persist watermark + budget + status.
  await svc.from("strava_sync_state").upsert({
    user_id: userId,
    last_activity_start: newWatermark.toISOString(),
    last_synced_at: nowIso,
    last_error: lastError,
    updated_at: nowIso,
    ...budget.toState(),
  });
  await svc.from("strava_connections").update({
    last_synced_at: nowIso,
    status: "active",
    updated_at: nowIso,
  }).eq("user_id", userId);

  return json({ synced, throttled, error: lastError });
});
