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
};

export const DEFAULTS = {
  TIMEZONE: "America/Sao_Paulo",
  MORNING_DIGEST_TIME: "07:00",
  EVENING_DIGEST_TIME: "21:00",
  DEFAULT_REMINDER_MINUTES: "30",
  DEEPSEEK_MODEL: "deepseek-flash",
} as const;

type SettingsEnv = Partial<Record<keyof typeof DEFAULTS, string>>;

const hhmm = (v: string | undefined, fallback: string) => (v && /^\d{2}:\d{2}$/.test(v) ? v : fallback);

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
  };
}
