// email.ts — transactional email via Resend (https://resend.com)
//
// House soft-degrade pattern (same as GOOGLE_CLIENT_SECRET / GEMINI_API_KEY):
// if RESEND_API_KEY or MAIL_FROM is unset, emailEnabled() is false and callers
// fall back to console-logging the OTP (the original stub behaviour), so
// dev/staging keep working with no secrets. Do NOT add these to
// REQUIRED_SECRETS until they are set in prod:
//
//   fly secrets set RESEND_API_KEY=re_xxxx \
//     MAIL_FROM='Beast Mode <verify@YOURDOMAIN>' --app beast-mode
//   (and again with --app beast-mode-staging)
//
// MAIL_FROM's domain must be verified in the Resend dashboard (DNS records)
// or every send 403s. Resend's shared onboarding sender only delivers to the
// account owner's own address — fine for a first smoke test, useless beyond.
//
// The admin pass (next) reuses sendEmail() for its OTP handshake; Stripe
// receipts stay Stripe's job.

const RESEND_ENDPOINT = "https://api.resend.com/emails";
const SEND_TIMEOUT_MS = 10_000;

export function emailEnabled(): boolean {
  return !!(Deno.env.get("RESEND_API_KEY") && Deno.env.get("MAIL_FROM"));
}

/**
 * Send one email via Resend. Never throws — returns true on accepted (2xx),
 * false on any failure (logged). Callers decide what a failure means; for
 * OTP flows the answer is "log it, keep the response generic" so delivery
 * problems can't become an account-enumeration signal.
 */
export async function sendEmail(opts: {
  to: string;
  subject: string;
  html: string;
  text: string;
}): Promise<boolean> {
  if (!emailEnabled()) return false;
  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      headers: {
        "Authorization": `Bearer ${Deno.env.get("RESEND_API_KEY")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: Deno.env.get("MAIL_FROM"),
        to: [opts.to],
        subject: opts.subject,
        html: opts.html,
        text: opts.text,
      }),
    });
    if (!res.ok) {
      // Resend errors are JSON: { statusCode, name, message }
      const detail = await res.text().catch(() => "");
      console.error(`Resend send failed (${res.status}): ${detail.slice(0, 300)}`);
      return false;
    }
    return true;
  } catch (e) {
    console.error("Resend send error:", (e as Error).message);
    return false;
  }
}

/**
 * Verification-code email, Beast Mode styled. Inline styles only (email
 * clients strip <style> blocks); dark card on neutral background with the
 * app's acid-yellow accent. Plain-text part included for deliverability.
 */
export function otpEmail(code: string): { subject: string; html: string; text: string } {
  const subject = `${code} is your Beast Mode verification code`;
  const text = [
    `Your Beast Mode verification code is: ${code}`,
    ``,
    `It expires in 15 minutes.`,
    ``,
    `If you didn't create a Beast Mode account, you can ignore this email —`,
    `no account will be activated without this code.`,
  ].join("\n");
  const html = `<!doctype html>
<html><body style="margin:0;padding:0;background:#101216;">
  <div style="max-width:480px;margin:0 auto;padding:32px 16px;font-family:Arial,Helvetica,sans-serif;">
    <div style="background:#16191f;border:1px solid #2a2e36;border-radius:8px;padding:28px 24px;">
      <div style="font-size:20px;font-weight:800;letter-spacing:3px;color:#d7ff00;margin-bottom:4px;">// BEAST MODE</div>
      <div style="font-size:11px;letter-spacing:2px;color:#8b919c;margin-bottom:24px;">EMAIL VERIFICATION</div>
      <div style="font-size:14px;color:#e6e8eb;line-height:1.6;margin-bottom:18px;">
        Enter this code to verify your email address:
      </div>
      <div style="background:#101216;border:1px solid #d7ff00;border-radius:6px;padding:16px;text-align:center;font-size:32px;font-weight:800;letter-spacing:10px;color:#d7ff00;margin-bottom:18px;">${code}</div>
      <div style="font-size:12px;color:#8b919c;line-height:1.7;">
        The code expires in <strong style="color:#e6e8eb;">15 minutes</strong>.<br>
        If you didn't create a Beast Mode account, ignore this email — no account
        is activated without the code.
      </div>
    </div>
    <div style="font-size:10px;color:#5a5f68;letter-spacing:1px;text-align:center;margin-top:14px;">SENT BY BEAST MODE &middot; DO NOT REPLY</div>
  </div>
</body></html>`;
  return { subject, html, text };
}
