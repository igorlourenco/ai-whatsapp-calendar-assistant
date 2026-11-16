/**
 * Z-API client. Same instance as Movisim: the instance's "on message received"
 * webhook points here; the bot only talks to OWNER_PHONE.
 */

export type ZapiEnv = {
  ZAPI_INSTANCE_ID: string;
  ZAPI_TOKEN: string;
  ZAPI_CLIENT_TOKEN: string;
};

/** Subset of Z-API's ReceivedCallback payload. */
export type ZapiReceived = {
  type?: string;
  messageId?: string;
  phone?: string;
  fromMe?: boolean;
  isGroup?: boolean;
  isNewsletter?: boolean;
  broadcast?: boolean;
  momment?: number;
  senderName?: string;
  text?: { message?: string };
  audio?: unknown;
  image?: { caption?: string };
};

export function digits(phone: string): string {
  return phone.replace(/\D/g, "");
}

/**
 * Compare two phones, tolerant of Brazil's mobile "9th digit": WhatsApp often
 * reports older BR numbers without it (5511 9876-5432 vs 5511 99876-5432).
 */
export function samePhone(a: string, b: string): boolean {
  const canon = (p: string) => {
    const d = digits(p);
    if (d.startsWith("55") && d.length === 13 && d[4] === "9") return d.slice(0, 4) + d.slice(5);
    return d;
  };
  return canon(a) === canon(b);
}

export async function sendText(env: ZapiEnv, phone: string, message: string): Promise<void> {
  const url = `https://api.z-api.io/instances/${env.ZAPI_INSTANCE_ID}/token/${env.ZAPI_TOKEN}/send-text`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Client-Token": env.ZAPI_CLIENT_TOKEN },
    body: JSON.stringify({ phone: digits(phone), message }),
  });
  if (!res.ok) {
    throw new Error(`Z-API send-text failed (${res.status}): ${await res.text()}`);
  }
}
