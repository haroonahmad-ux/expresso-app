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
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return reply(405, { error: "method_not_allowed" });
  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) return reply(503, { error: "auth_service_not_configured" });
  let body: { msisdn?: unknown; purpose?: unknown; otp?: unknown };
  try { body = await req.json(); } catch { return reply(400, { error: "invalid_request" }); }
  if (!validMsisdn(body.msisdn) ||
      !["CUSTOMER_LOGIN", "RETAILER_LOGIN"].includes(String(body.purpose)) ||
      typeof body.otp !== "string" || !/^\d{6}$/.test(body.otp)) {
    return reply(400, { error: "invalid_request" });
  }

  // Deliberately fail closed. Verification must atomically increment attempts,
  // compare a keyed HMAC in constant time, consume the challenge exactly once,
  // and then establish a supported Supabase Auth session. The latter cannot be
  // safely emulated by inventing a JWT or returning a service-role token.
  // Until an approved session-issuance flow and atomic DB RPC are implemented,
  // this endpoint must not accept OTPs or be deployed as a working login API.
  const db = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
  void db;
  return reply(503, { error: "otp_verification_and_session_issuance_not_implemented" });
});
