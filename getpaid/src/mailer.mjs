/**
 * Mailer: two transports, chosen by environment.
 *
 *   - **resend**: `RESEND_API_KEY` (+ `EMAIL_FROM`) → real HTTP send.
 *   - **file**  : no key → each message is written as a real RFC-822 `.eml`
 *     file in the outbox directory. Nothing leaves the machine, and you can
 *     open the file in any mail client to see exactly what a customer would
 *     receive. This is also what the tests assert against.
 *
 * Sending mail is the one place where this app can destroy a customer
 * relationship in public, so the file transport exists to make the output
 * inspectable *before* anything is live.
 */
import { mkdirSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const RESEND_API = 'https://api.resend.com/emails';

export function mailerMode(env = process.env) {
  return env.RESEND_API_KEY ? 'resend' : 'file';
}

/** Header fields must not contain CR/LF — otherwise a subject can inject headers. */
export function sanitizeHeader(value) {
  return String(value ?? '').replace(/[\r\n]+/g, ' ').trim();
}

export function createMailer({
  outboxDir,
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
} = {}) {
  const mode = mailerMode(env);
  const from = env.EMAIL_FROM ?? env.SENDER_NAME ?? 'Accounts Receivable <ar@example.invalid>';
  if (mode === 'file') mkdirSync(outboxDir, { recursive: true });

  return {
    mode,
    from,
    /** @param {{to:string, subject:string, text:string, invoiceId:string, stage:string}} message */
    async send(message) {
      const to = sanitizeHeader(message.to);
      const subject = sanitizeHeader(message.subject);
      if (!to.includes('@')) throw new Error(`refusing to send to a non-address: ${JSON.stringify(to)}`);

      if (mode === 'resend') {
        const res = await fetchImpl(RESEND_API, {
          method: 'POST',
          headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: sanitizeHeader(from), to: [to], subject, text: message.text }),
        });
        const body = await res.text();
        if (!res.ok) throw new Error(`resend failed (${res.status}): ${body.slice(0, 300)}`);
        return { mode, id: JSON.parse(body).id ?? null, to, subject };
      }

      const stamp = now().toISOString().replace(/[:.]/g, '-');
      const path = join(outboxDir, `${stamp}__${message.invoiceId}__${message.stage}.eml`);
      const eml = [
        `Date: ${new Date().toUTCString()}`,
        `From: ${sanitizeHeader(from)}`,
        `To: ${to}`,
        `Subject: ${subject}`,
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=utf-8',
        `X-Getpaid-Invoice: ${sanitizeHeader(message.invoiceId)}`,
        `X-Getpaid-Stage: ${sanitizeHeader(message.stage)}`,
        '',
        message.text,
        '',
      ].join('\r\n');
      writeFileSync(path, eml);
      return { mode, path, to, subject };
    },
  };
}

/** Read the outbox back, newest last. Used by tests and the CLI's `outbox` command. */
export function readOutbox(dir) {
  let names;
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.eml')).sort();
  } catch {
    return [];
  }
  return names.map((name) => {
    const raw = readFileSync(join(dir, name), 'utf8');
    const [headerBlock, ...rest] = raw.split('\r\n\r\n');
    const headers = Object.fromEntries(
      headerBlock.split('\r\n').filter(Boolean).map((line) => {
        const idx = line.indexOf(':');
        return [line.slice(0, idx).toLowerCase(), line.slice(idx + 1).trim()];
      }),
    );
    return { file: name, headers, body: rest.join('\r\n\r\n') };
  });
}
