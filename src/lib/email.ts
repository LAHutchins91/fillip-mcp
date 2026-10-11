export type OutboundAttachment = {
  filename: string;
  content: string;
  contentType: string;
};

export type OutboundEmail = {
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
  idempotencyKey: string;
  headers: Record<string, string>;
  attachments?: OutboundAttachment[];
};

export interface MailSender {
  send(message: OutboundEmail): Promise<{ id: string }>;
}

/** Resend rate limit or quota. The delivery job backs off and retries with the same idempotency key. */
export class ProviderQuotaError extends Error {
  readonly status: number;
  constructor(status: number) {
    super("Email provider asked Fillip to back off");
    this.name = "ProviderQuotaError";
    this.status = status;
  }
}

export function isProviderQuota(status: number, body: string): boolean {
  if (status === 429) return true;
  return /quota|rate limit|too many requests|sending limit/i.test(body);
}

export function assertSingleRecipient(to: string) {
  const address = to.trim();
  if (!address || address.includes(",") || address.includes(";") || address.split(/\s+/).length !== 1 || !address.includes("@")) {
    throw new Error("Fillip emails one verified address");
  }
  return address;
}

export function createResendSender(apiKey: string, fetchImpl: typeof fetch = fetch): MailSender {
  return {
    async send(message: OutboundEmail) {
      const to = assertSingleRecipient(message.to);
      if (!message.from.trim()) throw new Error("Sender identity is not configured");
      const response = await fetchImpl("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "Idempotency-Key": message.idempotencyKey
        },
        body: JSON.stringify({
          from: message.from,
          to: [to],
          subject: message.subject,
          text: message.text,
          html: message.html,
          headers: message.headers,
          ...(message.attachments?.length
            ? {
              attachments: message.attachments.map((item) => ({
                filename: item.filename,
                content: Buffer.from(item.content, "utf8").toString("base64"),
                content_type: item.contentType
              }))
            }
            : {})
        }),
        signal: AbortSignal.timeout(20000)
      });
      const raw = await response.text();
      if (!response.ok) {
        if (isProviderQuota(response.status, raw)) throw new ProviderQuotaError(response.status);
        throw new Error("Email provider rejected the reminder");
      }
      const body = (raw ? JSON.parse(raw) : {}) as { id?: string };
      if (!body.id) throw new Error("Email provider rejected the reminder");
      return { id: body.id };
    }
  };
}
