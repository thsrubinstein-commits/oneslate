// strava-oauth-callback — Strava redirects here with ?code&state after the user
// approves. Runs WITHOUT a JWT (deploy with --no-verify-jwt), so it trusts the
// HMAC-signed `state` to identify the OneSlate user, exchanges the code for
// tokens, stores them server-side, and closes the popup.
import {
  serviceClient, verifyState, stravaCreds, callbackUrl, STRAVA_OAUTH,
} from "../_shared/strava.ts";

function closePage(message: string, ok: boolean) {
  // Supabase serves function responses as text/plain with nosniff, so HTML/JS
  // won't render or run here — return clean ASCII plain text. OneSlate's connect
  // flow detects the popup closing and then runs the sync, so no script is needed.
  const body = `${message}\n\nYou can close this window and return to OneSlate.`;
  return new Response(body, {
    status: ok ? 200 : 400,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state") || "";
  const err = url.searchParams.get("error");
  if (err) return closePage(`Strava authorization was ${err}.`, false);
  if (!code) return closePage("Missing authorization code.", false);

  try {
    const userId = await verifyState(state);
    const { id, secret } = stravaCreds();
    const res = await fetch(`${STRAVA_OAUTH}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: id, client_secret: secret,
        code, grant_type: "authorization_code", redirect_uri: callbackUrl(),
      }),
    });
    if (!res.ok) return closePage("Strava rejected the authorization.", false);
    const j = await res.json();
    const svc = serviceClient();
    const now = new Date().toISOString();

    await svc.from("strava_tokens").upsert({
      user_id: userId,
      access_token: j.access_token,
      refresh_token: j.refresh_token,
      expires_at: new Date(j.expires_at * 1000).toISOString(),
      scope: url.searchParams.get("scope"),
      updated_at: now,
    });
    const ath = j.athlete || {};
    await svc.from("strava_connections").upsert({
      user_id: userId,
      athlete_id: ath.id ?? null,
      athlete_name: [ath.firstname, ath.lastname].filter(Boolean).join(" ") || null,
      status: "active",
      scope: url.searchParams.get("scope"),
      updated_at: now,
    });
    return closePage("Strava connected.", true);
  } catch (e) {
    return closePage(`Could not connect Strava: ${(e as Error).message}`, false);
  }
});
