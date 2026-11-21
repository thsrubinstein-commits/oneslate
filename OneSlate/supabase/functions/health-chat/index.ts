// health-chat — OneSlate's AI coach (Gemini, free tier).
//
// The browser POSTs { messages:[{role,text}], context:{...}, mode?: 'chat'|'brief'|'recap' }
// with the user's Supabase JWT. `context` carries the user's real numbers (recovery, sleep,
// nutrition, training, runs, habits, deadlines, weather). This function:
//   - checks the user is signed in
//   - enforces a per-user daily cap so a leaked login can't burn the free quota
//   - picks the newest Flash model and falls back down the list if one is missing or
//     out of free quota (so it keeps working without a paid plan)
//   - returns plain text the dashboard can show as-is (no markdown asterisks)
//
// Secrets: GEMINI_API_KEY (required, free key from https://aistudio.google.com/apikey)
// Optional: GEMINI_MODEL (override the first model tried), COACH_DAILY_LIMIT (default 80),
//           ALLOWED_ORIGINS (comma list, overrides the built-in list below)
// deno-lint-ignore-file no-explicit-any
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Newest first. All of these are on Gemini's free tier. "-latest" is Google's alias that
// tracks the current Flash release, so the chain still works after a model is retired.
const MODELS = [
  Deno.env.get("GEMINI_MODEL") || "gemini-3.6-flash",
  "gemini-flash-latest",
  "gemini-3.5-flash-lite",
  "gemini-flash-lite-latest",
].filter((m, i, a) => m && a.indexOf(m) === i);

const DEFAULT_ORIGINS = [
  "https://thsrubinstein-commits.github.io",
  "capacitor://localhost",
  "ionic://localhost",
  "http://localhost",
  "https://localhost",
];
const ORIGINS = (Deno.env.get("ALLOWED_ORIGINS") || "").split(",").map((s) => s.trim()).filter(Boolean);
const ALLOWED = ORIGINS.length ? ORIGINS : DEFAULT_ORIGINS;

function cors(req: Request) {
  const o = req.headers.get("Origin") || "";
  const ok = ALLOWED.some((a) => o === a || (a.startsWith("http://localhost") && o.startsWith("http://localhost:")));
  return {
    "Access-Control-Allow-Origin": ok ? o : ALLOWED[0],
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

const DAILY_LIMIT = Number(Deno.env.get("COACH_DAILY_LIMIT") || 80);

const CORE = `You are the coach inside OneSlate, the user's personal dashboard. You coach running
(they're building toward a marathon), strength/hypertrophy, sleep, recovery and nutrition, and
you can see how their week looks (deadlines, habits) so advice fits their actual life.

How to answer:
- Lead with the answer in the first sentence. No preamble, no "Great question".
- Use their real numbers from CONTEXT and name them ("HRV 48 vs your 55 baseline").
  If you used a specific run, say which one ("your Tue Nov 18, 5.1 mi").
- Be specific: distances, paces per mile, HR caps, sets/reps, grams. Give one clear
  recommendation, not a menu of options.
- Keep it short: usually 2 to 5 sentences. Use a short "- " list only for a workout or plan.
- Plain text only. No markdown: no **bold**, no # headers, no tables.
- If data is missing for what they asked, say what's missing in a few words and still give
  your best call. Only ask a follow-up question if you truly can't answer.
- Talk like a knowledgeable friend, casual and direct. Not medical advice, but don't pad
  answers with disclaimers. If something sounds like injury or illness, say see a pro.

Coaching rules you always follow:
- Weekly mileage grows no more than ~10% vs last week. A longer long run counts toward that.
- Down week (20-30% less) every 3-4 weeks. CONTEXT.training.weekPhase says if this is one.
- ~80% of running easy, under CONTEXT.training.easyHrCeilingBpm. Max 2 hard sessions a week,
  never back to back. Follow a long run or workout with an easy day or rest.
- Low recovery/readiness, poor sleep or a rising HR-efficiency trend: hold or back off.
- First run back after 4+ days off is short and easy. Never "make up" missed miles.
- Too hot (CONTEXT.conditions.deferLongRun / deferHardSession): no long run or workout today.
- Lifting + running: separate hard sessions by 6h+ or different days, lift first if strength
  is the goal. Protein 1.6-2.2 g/kg/day. 10-20 hard sets per muscle per week.`;

const MODES: Record<string, string> = {
  chat: "",
  brief: `TASK: Write today's one-line readiness note for the top of their dashboard.
One or two sentences, max 220 characters. Say how ready they are today and the single most
useful thing to do (e.g. the workout to run, or to take it easy and why). Use one or two real
numbers. No greeting, no sign-off.`,
  recap: `TASK: Recap their past 7 days in CONTEXT.week. Structure:
- one line verdict on the week
- 3 to 5 "- " bullets covering running, sleep/recovery, nutrition, habits/deadlines, each
  with a real number (skip any with no data)
- one line: the focus for next week.
Under 900 characters.`,
  // Utility calls from the dashboard (calendar parsing, syllabus import). The prompt says
  // exactly what to return, so no coach persona and no user context.
  raw: "",
};

function clean(s: string) {
  return s
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*\*\s+/gm, "- ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function callGemini(apiKey: string, system: string, contents: any[], mode: string) {
  let lastErr = "coach request failed";
  for (const model of MODELS) {
    for (const withThinking of [true, false]) {
      const generationConfig: any = {
        temperature: mode === "raw" ? 0.1 : mode === "brief" ? 0.4 : 0.6,
        // Thinking tokens count toward this, so leave room or answers get cut off mid-sentence.
        maxOutputTokens: mode === "brief" ? 1024 : mode === "raw" ? 8192 : 4096,
      };
      if (withThinking) generationConfig.thinkingConfig = { thinkingLevel: mode === "chat" || mode === "recap" ? "medium" : "low" };
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
          body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents, generationConfig }),
        },
      );
      const j = await res.json().catch(() => ({}));
      if (res.ok) {
        const parts = j?.candidates?.[0]?.content?.parts || [];
        const text = parts.filter((p: any) => !p.thought).map((p: any) => p.text || "").join("");
        if (text.trim()) return { text: mode === "raw" ? text.trim() : clean(text), model };
        lastErr = j?.candidates?.[0]?.finishReason === "SAFETY" ? "coach couldn't answer that one" : "empty reply";
        break; // try next model
      }
      lastErr = j?.error?.message || `HTTP ${res.status}`;
      // Unknown thinking field on an older model: retry the same model without it.
      if (res.status === 400 && withThinking && /thinking/i.test(lastErr)) continue;
      if (res.status === 400 || res.status === 401 || res.status === 403) {
        // Bad key or bad request: other models won't help.
        if (!/not found|not supported|model/i.test(lastErr)) throw new Error(lastErr);
      }
      break; // 404 / 429 quota / 5xx: fall to the next model
    }
  }
  if (/quota|rate|exhausted|429/i.test(lastErr)) throw new Error("coach hit today's free Gemini limit, try again later");
  throw new Error(lastErr);
}

Deno.serve(async (req) => {
  const headers = { "Content-Type": "application/json", ...cors(req) };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers });
  if (req.method === "OPTIONS") return new Response("ok", { headers });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  try {
    const svc = createClient(
      Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { persistSession: false } },
    );
    const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: u } = await svc.auth.getUser(jwt);
    if (!u?.user) return json({ error: "sign in to use the coach" }, 401);

    const apiKey = Deno.env.get("GEMINI_API_KEY");
    if (!apiKey) return json({ error: "coach isn't set up yet (missing GEMINI_API_KEY)" }, 500);

    // Per-user daily cap. If the coach_usage migration hasn't been run, skip quietly.
    try {
      const { data: n, error } = await svc.rpc("coach_bump", { p_user: u.user.id });
      if (!error && typeof n === "number" && n > DAILY_LIMIT) {
        return json({ error: `that's ${DAILY_LIMIT} coach messages today, back tomorrow` }, 429);
      }
    } catch (_) { /* no limiter table yet */ }

    const body = await req.json().catch(() => ({}));
    const mode = MODES[body.mode] !== undefined ? body.mode : "chat";
    const context = body.context ?? {};
    const ctxText = JSON.stringify(context);
    if (ctxText.length > 120_000) return json({ error: "context too large" }, 413);

    const system = mode === "raw"
      ? "Follow the instructions in the user's message exactly and return only what it asks for."
      : [CORE, MODES[mode], "\nCONTEXT (the user's live data, JSON):\n" + ctxText].filter(Boolean).join("\n\n");

    // Last 16 turns, alternating user/model, starting with a user turn (Gemini requires it).
    let msgs = (Array.isArray(body.messages) ? body.messages : [])
      .filter((m: any) => m && typeof m.text === "string" && m.text.trim())
      .slice(-16)
      .map((m: any) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.text.slice(0, mode === "raw" ? 60000 : 4000) }] }));
    while (msgs.length && msgs[0].role !== "user") msgs = msgs.slice(1);
    // merge back-to-back turns from the same side (e.g. a retry after a failed send)
    msgs = msgs.reduce((acc: any[], m: any) => {
      const last = acc[acc.length - 1];
      if (last && last.role === m.role) last.parts[0].text += "\n\n" + m.parts[0].text;
      else acc.push(m);
      return acc;
    }, []);
    if (!msgs.length) {
      msgs = [{ role: "user", parts: [{ text: mode === "recap" ? "Recap my week." : "What's my readiness today?" }] }];
    }

    const { text, model } = await callGemini(apiKey, system, msgs, mode);
    return json({ reply: text, model });
  } catch (e) {
    return json({ error: (e as Error).message || "coach error" }, 502);
  }
});
