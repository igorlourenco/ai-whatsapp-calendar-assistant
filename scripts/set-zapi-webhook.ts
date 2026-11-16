/**
 * Points the Z-API instance's "on message received" webhook at this worker.
 * Usage: pnpm zapi:webhook https://ai-assistant-wpp.<sub>.workers.dev
 *
 * Only touches the RECEIVED webhook. Movisim's message-status webhook is a
 * separate setting and is left alone.
 */
const base = process.argv[2] ?? process.env.APP_URL;
const { ZAPI_INSTANCE_ID, ZAPI_TOKEN, ZAPI_CLIENT_TOKEN, ZAPI_WEBHOOK_TOKEN } = process.env;
if (!base || !ZAPI_INSTANCE_ID || !ZAPI_TOKEN || !ZAPI_CLIENT_TOKEN || !ZAPI_WEBHOOK_TOKEN) {
  console.error("Missing app URL arg or ZAPI_* vars in .dev.vars");
  process.exit(1);
}

const value = `${base.replace(/\/$/, "")}/webhooks/zapi?token=${ZAPI_WEBHOOK_TOKEN}`;
const res = await fetch(
  `https://api.z-api.io/instances/${ZAPI_INSTANCE_ID}/token/${ZAPI_TOKEN}/update-webhook-received`,
  {
    method: "PUT",
    headers: { "Content-Type": "application/json", "Client-Token": ZAPI_CLIENT_TOKEN },
    body: JSON.stringify({ value }),
  },
);
console.log(res.status, await res.text());
export {};
