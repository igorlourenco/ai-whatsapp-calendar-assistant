/**
 * Per-deployment settings. They come from the environment (uploaded by
 * `pnpm configure` from .dev.vars), never from wrangler.jsonc, so a `git pull` +
 * deploy can't overwrite anyone's configuration.
 */
export type Settings = {
  tz: string;
  morningAt: string;
  eveningAt: string;
  defaultReminder: number;
  visionModel: string;
  /** Workers AI model that transcribes voice notes. */
  transcribeModel: string;
  /** Pending tasks are re-sent every N minutes on/after their due date. */
  taskNagMinutes: number;
  /** No task nags after this local time (they resume at the morning digest). */
  taskNagUntil: string;
};

export const DEFAULTS = {
  TIMEZONE: "America/Sao_Paulo",
  MORNING_DIGEST_TIME: "07:00",
  EVENING_DIGEST_TIME: "21:00",
  DEFAULT_REMINDER_MINUTES: "30",
  DEEPSEEK_MODEL: "deepseek-flash",
  /** Workers AI model that transcribes images (picked by an eval, see README). */
  VISION_MODEL: "@cf/mistralai/mistral-small-3.1-24b-instruct",
  /** Workers AI speech-to-text for voice notes (reads WhatsApp's Ogg/Opus). */
  TRANSCRIBE_MODEL: "@cf/openai/whisper-large-v3-turbo",
  TASK_NAG_MINUTES: "30",
  TASK_NAG_UNTIL: "22:00",
} as const;

type SettingsEnv = Partial<Record<keyof typeof DEFAULTS, string>>;

const hhmm = (v: string | undefined, fallback: string) => (v && /^\d{2}:\d{2}$/.test(v) ? v : fallback);

export function validTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function validTz(tz: string | undefined): string {
  if (!tz) return DEFAULTS.TIMEZONE;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    console.warn(`[config] invalid TIMEZONE "${tz}", using ${DEFAULTS.TIMEZONE}`);
    return DEFAULTS.TIMEZONE;
  }
}

export function settings(env: SettingsEnv): Settings {
  const reminder = Number(env.DEFAULT_REMINDER_MINUTES);
  return {
    tz: validTz(env.TIMEZONE),
    morningAt: hhmm(env.MORNING_DIGEST_TIME, DEFAULTS.MORNING_DIGEST_TIME),
    eveningAt: hhmm(env.EVENING_DIGEST_TIME, DEFAULTS.EVENING_DIGEST_TIME),
    defaultReminder: Number.isFinite(reminder) && reminder >= 0 ? reminder : Number(DEFAULTS.DEFAULT_REMINDER_MINUTES),
    visionModel: env.VISION_MODEL || DEFAULTS.VISION_MODEL,
    transcribeModel: env.TRANSCRIBE_MODEL || DEFAULTS.TRANSCRIBE_MODEL,
    taskNagMinutes: Number(env.TASK_NAG_MINUTES) >= 5 ? Number(env.TASK_NAG_MINUTES) : Number(DEFAULTS.TASK_NAG_MINUTES),
    taskNagUntil: hhmm(env.TASK_NAG_UNTIL, DEFAULTS.TASK_NAG_UNTIL),
  };
}
