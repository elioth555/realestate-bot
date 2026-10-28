import type { AlertEmail, SendResult } from './saved-search-alerts'

/**
 * Server-only Resend sender shared by the manual send action and the daily cron.
 * Deliberately not a 'use server' module so it can never be called from the browser.
 */
export const EMAIL_NOT_CONFIGURED = 'Email sending is not configured. Add RESEND_API_KEY and ALERT_EMAIL_FROM to the project variables.'

export async function sendWithResend(email: AlertEmail, idempotencyKey: string): Promise<SendResult> {
  const apiKey = process.env.RESEND_API_KEY
  const from = process.env.ALERT_EMAIL_FROM
  if (!apiKey || !from) return { ok: false, message: EMAIL_NOT_CONFIGURED, notConfigured: true }
  const replyTo = process.env.ALERT_EMAIL_REPLY_TO
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify({ from, to: [email.to], subject: email.subject, html: email.html, text: email.text, ...(replyTo ? { reply_to: replyTo } : {}) }),
    signal: AbortSignal.timeout(15000),
  })
  if (response.ok) return { ok: true }
  const detail = await response.text().catch(() => '')
  console.error('[saved-search-alerts] email provider rejected the send:', response.status, detail.slice(0, 300))
  return { ok: false, message: `The email provider rejected the send (HTTP ${response.status}). Nothing was marked as sent.` }
}
