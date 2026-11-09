import { logger, sanitizeError } from "@/lib/logger";

export type Email = { to: string; subject: string; text: string; html?: string };

/**
 * Sends through Resend's HTTP API when RESEND_API_KEY is set and returns true.
 * Without it, the message (including any sign-in link) is printed to the server log and it returns false,
 * so callers can tell the user the email didn't actually go out.
 */
export async function sendEmail(msg: Email): Promise<boolean> {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    // no email provider configured: links are single-use and short-lived
    console.info(`\n[email:dev] to=${msg.to}\nsubject: ${msg.subject}\n${msg.text}\n`);
    return false;
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: process.env.EMAIL_FROM ?? "Social Planner <onboarding@resend.dev>", to: [msg.to], subject: msg.subject, text: msg.text, html: msg.html }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    logger.error({ status: res.status, err: sanitizeError(body, 300) }, "email send failed");
    throw new Error(`Email could not be sent (${res.status})`);
  }
  return true;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** Minimal, readable HTML matching the app's colours. */
export function actionEmail(opts: { heading: string; body: string; cta: string; url: string; footnote?: string }): Pick<Email, "text" | "html"> {
  const text = `${opts.heading}\n\n${opts.body}\n\n${opts.cta}: ${opts.url}\n${opts.footnote ? `\n${opts.footnote}\n` : ""}`;
  const html = `<!doctype html><html><body style="margin:0;background:#0b1020;font-family:Inter,Segoe UI,Arial,sans-serif;color:#e6ecff">
<div style="max-width:480px;margin:0 auto;padding:40px 24px">
<p style="font-size:22px;font-weight:700;margin:0 0 24px">planner<span style="color:#8b7bff">.</span></p>
<h1 style="font-size:20px;margin:0 0 12px">${esc(opts.heading)}</h1>
<p style="color:#a3b0cf;line-height:1.55;margin:0 0 24px">${esc(opts.body)}</p>
<a href="${esc(opts.url)}" style="display:inline-block;background:#8b7bff;color:#0b1020;text-decoration:none;font-weight:600;padding:12px 22px;border-radius:99px">${esc(opts.cta)}</a>
${opts.footnote ? `<p style="color:#a3b0cf;font-size:13px;margin:24px 0 0">${esc(opts.footnote)}</p>` : ""}
</div></body></html>`;
  return { text, html };
}
