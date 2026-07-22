// health-chat — the conversational AI Coach (Gemini-backed).
//
// ⚠️ REFERENCE VERSION. A health-chat function is already deployed to your
// Supabase project (it predates this repo's versioned functions). This file
// brings it into version control AND adds run-awareness. If your live function
// has custom tuning you want to keep, you don't need to replace it wholesale —
// the ONLY change the new coach features require is that the model is told to
// use the `runs` / `focusRuns` fields the browser now sends in `context` and to
// reference the specific run(s) it relied on. The RUN_AWARENESS block below is
// that change; splice it into your existing system prompt if you prefer.
//
// The browser (sendHealthChat) POSTs { messages:[{role,text}], context:{...} }
// with the user's JWT. `context` already carries recovery/sleep/nutrition/training
// plus, now: context.runs (recent runs) and context.focusRuns (the run(s) the
// question is about), each with pace/HR/elevation/splits and a within-run `shape`
// (negative/positive split, HR drift).
// deno-lint-ignore-file no-explicit-any
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

const RUN_AWARENESS = [
  "When the user's context includes 'runs' or 'focusRuns', treat that as their real",
  "Strava data. Ground pacing/effort answers in it:",
  "- 'focusRuns' are the run(s) this question is about — answer about those first.",
  "- each run has splits (per-km pace/HR) and a 'shape' summary (even / negative /",
  "  positive split, plus hr_drift_bpm) — use it to reason about pacing strategy and",
  "  effort distribution WITHIN the run, not just totals.",
  "- 'runs' is the recent set — use it for trend/aggregate questions (e.g. is easy-pace",
  "  HR drifting down over the month).",
  "TIME OFF / RETURNING FROM A LAYOFF: if context.training.returnFromLayoff is set (or",
  "context.training.daysSinceLastRun is >= 4), the user has been away from running (travel,",
  "illness, rest). The FIRST run back must be easy and short — do NOT recommend a long run,",
  "tempo, or interval as the first session back, and do not tell them to 'catch up' the",
  "missed mileage. Ease volume back up gradually (~8%/week), and only resume long runs and",
  "quality once they've strung together a few easy days. Acknowledge the break in your answer.",
  "Always make clear which run(s) you're drawing on (e.g. \"On your Sat Jul 11, 8.2mi…\").",
  "Be specific and practical. Not medical advice.",
].join("\n");

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    // Auth: require a valid Supabase session (same contract as the other functions).
    const svc = createClient(
      Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { persistSession: false } },
    );
    const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: u } = await svc.auth.getUser(jwt);
    if (!u?.user) return json({ error: "not signed in" }, 401);

    const { messages, context } = await req.json();
    const apiKey = Deno.env.get("GEMINI_API_KEY");
    if (!apiKey) return json({ error: "coach is not configured (missing GEMINI_API_KEY)" }, 500);

    const system = [
      "You are OneSlate's coach: an evidence-based hybrid-training, endurance and",
      "muscle-hypertrophy coach. Ground every answer in the user's real numbers in",
      "`context`. If a question is vague, ask one short follow-up rather than guess.",
      RUN_AWARENESS,
      "\nUSER CONTEXT (JSON):\n" + JSON.stringify(context ?? {}),
    ].join("\n");

    // Gemini expects alternating user/model turns; map our {role,text} history.
    const contents = (messages || []).map((m: any) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.text }],
    }));

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents,
          generationConfig: { temperature: 0.5, maxOutputTokens: 700 },
        }),
      },
    );
    const j = await res.json();
    if (!res.ok) return json({ error: j?.error?.message || "coach request failed" }, 502);
    const reply = j?.candidates?.[0]?.content?.parts?.map((p: any) => p.text).join("") ||
      "Something went wrong — try again.";
    return json({ reply });
  } catch (e) {
    return json({ error: (e as Error).message || "coach error" }, 500);
  }
});
