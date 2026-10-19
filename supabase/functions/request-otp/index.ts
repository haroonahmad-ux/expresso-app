import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": Deno.env.get("APP_ORIGIN") ?? "null",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

function reply(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), { status, headers: cors });
}
function validMsisdn(v: unknown): v is string {
  return typeof v === "string" && /^\+923[0-9]{9}$/.test(v);
}
async function hmacHex(secret: string, message: string) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(sig), b => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return reply(405, { error: "method_not_allowed" });

  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const hmacSecret = Deno.env.get("OTP_HMAC_SECRET");
  if (!url || !serviceKey || !hmacSecret) return reply(503, { error: "auth_service_not_configured" });

  let body: { msisdn?: unknown; purpose?: unknown };
  try { body = await req.json(); } catch { return reply(400, { error: "invalid_request" }); }
  const { msisdn, purpose } = body;
  if (!validMsisdn(msisdn) || !["CUSTOMER_LOGIN", "RETAILER_LOGIN"].includes(String(purpose))) {
    return reply(400, { error: "invalid_request" });
  }

  const db = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
  // Eligibility is checked before creating a challenge or contacting an SMS provider.
  if (purpose === "RETAILER_LOGIN") {
    const { data, error } = await db.schema("private").from("retailer_allowlist")
      .select("msisdn").eq("msisdn", msisdn).eq("is_enabled", true).maybeSingle();
    if (error) return reply(503, { error: "eligibility_check_unavailable" });
    if (!data) return reply(403, { error: "not_eligible" });
  } else {
    const { data, error } = await db.from("profiles").select("id").eq("msisdn", msisdn).maybeSingle();
    if (error) return reply(503, { error: "eligibility_check_unavailable" });
    if (!data) return reply(403, { error: "not_eligible" });
  }

  // Fail closed until a real SMS adapter is explicitly configured.
  const provider = Deno.env.get("SMS_PROVIDER");
  if (!provider || provider === "unconfigured") return reply(503, { error: "sms_provider_not_configured" });
  if (provider !== "sendpk" && provider !== "veevotech" && provider !== "generic_webhook") {
    return reply(503, { error: "unsupported_sms_provider" });
  }
  // Provider adapters must be implemented and configured before this endpoint is deployable.
  // Do not create a challenge until delivery is integrated and rate limits are enforced.
  const code = crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000;
  const otp = String(code).padStart(6, "0");
  const digest = await hmacHex(hmacSecret, msisdn + ":" + purpose + ":" + otp);
  // Deliberately do not persist or send OTP in this draft: no provider adapter/rate-limit
  // implementation is present, so pretending to deliver would be unsafe.
  void digest;
  return reply(503, { error: "sms_adapter_and_rate_limits_not_implemented" });
});
