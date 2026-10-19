import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { Webhook } from "npm:standardwebhooks@1.0.0";

const JSON_HEADERS = { "Content-Type": "application/json" };

function response(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function env(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`missing_required_configuration:${name}`);
  return value;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return response(405, { error: "method_not_allowed" });

  let hookSecret: string;
  let apiKey: string;
  let templateId: string;
  let sender: string;
  try {
    hookSecret = env("SEND_SMS_HOOK_SECRET");
    apiKey = env("SENDPK_API_KEY");
    templateId = env("SENDPK_OTP_TEMPLATE_ID");
    sender = env("SENDPK_SENDER");
  } catch (error) {
    console.error("SMS hook configuration incomplete", String(error));
    return response(503, { error: "sms_provider_not_configured" });
  }

  let payload: string;
  try { payload = await req.text(); } catch { return response(400, { error: "invalid_payload" }); }

  let event: { user?: { phone?: string }; sms?: { otp?: string } };
  try {
    const secret = hookSecret.replace(/^v1,whsec_/, "");
    const verifier = new Webhook(secret);
    event = verifier.verify(payload, Object.fromEntries(req.headers)) as typeof event;
  } catch {
    return response(401, { error: "invalid_hook_signature" });
  }

  const phone = event.user?.phone;
  const otp = event.sms?.otp;
  if (typeof phone !== "string" || !/^\+923[0-9]{9}$/.test(phone) ||
      typeof otp !== "string" || !/^\d{4,8}$/.test(otp)) {
    return response(400, { error: "invalid_sms_event" });
  }

  // SendPK fixed/OTP templates must be approved in the provider dashboard.
  // The template body should contain a variable such as #otp# and its approved template_id.
  const form = new URLSearchParams({
    api_key: apiKey,
    sender,
    mobile: phone.replace(/^\+/, ""),
    template_id: templateId,
    message: JSON.stringify({ otp }),
    format: "json",
  });

  let providerResponse: Response;
  try {
    providerResponse = await fetch("https://sendpk.com/api/sms.php", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    console.error("SendPK request failed before receiving a response");
    return response(502, { error: "sms_delivery_unavailable" });
  }

  const raw = await providerResponse.text();
  let result: Record<string, unknown> = {};
  try { result = JSON.parse(raw); } catch { /* response will be treated as failure */ }

  // Do not log phone, OTP, API key, or raw provider response.
  const status = String(result.status ?? result.STATUS ?? "").toLowerCase();
  const success = providerResponse.ok &&
    (status === "success" || status === "successful" || status === "ok" ||
     result.success === true);

  if (!success) {
    console.error("SendPK rejected OTP delivery", {
      http_status: providerResponse.status,
      provider_status: status || "unknown",
    });
    return response(502, { error: "sms_delivery_failed" });
  }

  return new Response("{}", { status: 200, headers: JSON_HEADERS });
});
