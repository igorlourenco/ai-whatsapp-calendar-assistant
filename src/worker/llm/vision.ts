/**
 * Image → plain text. The vision model only TRANSCRIBES; interpreting dates
 * is left to the same extractor used for text messages, and nothing read
 * from an image is saved without the user confirming a preview.
 */

/** Transcribe an image. Returns "" when there's no relevant text. */
export type Vision = (image: Uint8Array, mime: string) => Promise<string>;

export const NO_TEXT = "SEM TEXTO";

export const VISION_PROMPT = `Transcreva fielmente todo texto desta imagem que indique compromissos, eventos, provas, prazos, reuniões, aulas ou lembretes: títulos, datas, dias da semana, horários, períodos e locais.
- Copie exatamente como aparece. Mantenha tabelas e listas, uma linha por item.
- Não interprete, não complete e não invente nada: nenhuma data, ano ou horário que não esteja escrito.
- Ignore textos de interface (horas de mensagens, botões, menus).
- Se não houver nenhum texto assim, responda exatamente: ${NO_TEXT}`;

/** WhatsApp photos are well under this; anything bigger is refused upfront. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** Workers AI vision model (OpenAI-style message with a data-URI image). */
export function workersAiVision(ai: Ai, model: string): Vision {
  return async (image, mime) => {
    const res = (await ai.run(model as never, {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: VISION_PROMPT },
            { type: "image_url", image_url: { url: `data:${mime};base64,${toBase64(image)}` } },
          ],
        },
      ],
      max_tokens: 1500,
      temperature: 0,
    } as never)) as { response?: unknown };
    return normalizeTranscript(typeof res?.response === "string" ? res.response : "");
  };
}

export function normalizeTranscript(t: string): string {
  const text = t.trim();
  return !text || text.toUpperCase().includes(NO_TEXT) ? "" : text;
}

/** Download a media URL (Z-API serves temporary public links). */
export async function fetchImage(url: string): Promise<{ bytes: Uint8Array; mime: string }> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`image download failed (${res.status})`);
  const len = Number(res.headers.get("content-length") ?? 0);
  if (len > MAX_IMAGE_BYTES) throw new Error(`image too large (${len} bytes)`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > MAX_IMAGE_BYTES) throw new Error(`image too large (${bytes.length} bytes)`);
  const mime = (res.headers.get("content-type") ?? "image/jpeg").split(";")[0]!.trim();
  return { bytes, mime: mime.startsWith("image/") ? mime : "image/jpeg" };
}
