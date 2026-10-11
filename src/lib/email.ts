export type OutboundEmail = {
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
  idempotencyKey: string;
  headers: Record<string, string>;
};

export interface MailSender {
  send(message: OutboundEmail): Promise<{ id: string }>;
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
          headers: message.headers
        }),
        signal: AbortSignal.timeout(20000)
      });
      if (!response.ok) throw new Error("Email provider rejected the reminder");
      const body = await response.json() as { id?: string };
      if (!body.id) throw new Error("Email provider rejected the reminder");
      return { id: body.id };
    }
  };
}
