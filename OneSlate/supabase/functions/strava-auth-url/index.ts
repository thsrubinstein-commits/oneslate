// strava-auth-url — returns the Strava authorize URL for the signed-in user.
// The browser opens it in a popup; strava-oauth-callback finishes the exchange.
import {
  corsHeaders, json, serviceClient, requireUser,
  stravaCreds, signState, callbackUrl, STRAVA_OAUTH,
} from "../_shared/strava.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const svc = serviceClient();
    const userId = await requireUser(req, svc);
    const { id } = stravaCreds();
    const state = await signState(userId);
    const params = new URLSearchParams({
      client_id: id,
      redirect_uri: callbackUrl(),
      response_type: "code",
      approval_prompt: "auto",
      scope: "read,activity:read_all",
      state,
    });
    return json({ url: `${STRAVA_OAUTH}/authorize?${params.toString()}` });
  } catch (e) {
    return json({ error: (e as Error).message || "could not start Strava auth" }, 400);
  }
});
