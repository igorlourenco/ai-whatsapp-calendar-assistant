/**
 * Voice note → plain text. Unlike an image (content to review), audio is the
 * user speaking a command, so its transcript goes through the same pipeline as
 * a typed message. The reply echoes the transcript so mistakes are visible.
 */

import { fetchMedia } from "./vision";

/** Transcribe audio. Returns "" when nothing intelligible was said. */
export type Transcribe = (audio: Uint8Array, mime: string) => Promise<string>;

/**
 * WhatsApp voice notes are Opus at ~16-24 kbps, so this is ~10 minutes of
 * speech (a forwarded mp3, ~2). Longer isn't a calendar request.
 */
export const MAX_AUDIO_BYTES = 2 * 1024 * 1024;

/** Primes Whisper with the bot's vocabulary and Brazilian time formats (15h). */
export const TRANSCRIBE_HINT = "Agenda, compromissos, tarefas e lista de compras. Ex: marca dentista sexta às 15h.";

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** Whisper (large-v3-turbo) request body; shared with scripts/eval-audio.ts. */
export function whisperInput(audio: Uint8Array) {
  return { audio: toBase64(audio), language: "pt", task: "transcribe", vad_filter: true, initial_prompt: TRANSCRIBE_HINT };
}

/** Whisper repeats the hint or emits filler on silence: treat as nothing said. */
export function normalizeSpeech(t: string): string {
  const text = t.replace(/\s+/g, " ").trim();
  if (!text || text === TRANSCRIBE_HINT) return "";
  return /[\p{L}\p{N}]/u.test(text) ? text : "";
}

/** Workers AI Whisper. */
export function workersAiWhisper(ai: Ai, model: string): Transcribe {
  return async (audio) => {
    const res = (await ai.run(model as never, whisperInput(audio) as never)) as { text?: unknown };
    return normalizeSpeech(typeof res?.text === "string" ? res.text : "");
  };
}

export async function fetchAudio(url: string): Promise<{ bytes: Uint8Array; mime: string }> {
  const { bytes, mime } = await fetchMedia(url, MAX_AUDIO_BYTES);
  return { bytes, mime: mime.startsWith("audio/") ? mime : "audio/ogg" };
}
