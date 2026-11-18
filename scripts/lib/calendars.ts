import { existsSync, readFileSync } from "node:fs";

import { slugify } from "../../src/worker/calendar/store";
import type { RemoteCalendar } from "../../src/worker/icloud/caldav";

/** One iCloud calendar picked as a bot category (what PUT /debug/categories and /debug/icloud take). */
export type CalChoice = {
  calendarName: string;
  calendarUrl: string;
  color: string | null;
  slug: string;
  name: string;
  emoji: string;
  description: string;
  isDefault: boolean;
};

export type Io = {
  ask(q: string, def?: string): Promise<string>;
  confirm(q: string, def?: boolean): Promise<boolean>;
  die(s: string): never;
  log(s: string): void;
  /** Previous answers to offer again (calendars.json for the owner). */
  savedFile?: string;
};

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

const EMOJI_HINTS: [RegExp, string][] = [
  [/work|trabalho|job|office|empresa/i, "💼"],
  [/school|faculdade|uni|college|escola|estudo|study/i, "🎓"],
  [/personal|pessoal|home|casa/i, "🏠"],
  [/family|fam[ií]lia|kids|filhos/i, "👨‍👩‍👧"],
  [/gym|academia|sport|esporte|treino/i, "🏋️"],
  [/health|sa[uú]de|m[eé]dico|doctor/i, "🩺"],
  [/birthday|anivers/i, "🎂"],
];
const suggestEmoji = (name: string) => EMOJI_HINTS.find(([re]) => re.test(name))?.[1] ?? "📅";
const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Interactive: which iCloud calendars become categories (name, emoji, description, default). */
export async function chooseCalendars(cals: RemoteCalendar[], io: Io): Promise<CalChoice[]> {
  const { ask, confirm, die, log, savedFile } = io;
  if (savedFile && existsSync(savedFile)) {
    const saved = JSON.parse(readFileSync(savedFile, "utf8")) as CalChoice[];
    const stillThere = saved.filter((s) => cals.some((c) => c.url === s.calendarUrl));
    log(saved.map((s) => `    ${s.emoji} ${s.name} ${dim(`← iCloud "${s.calendarName}"`)}${s.isDefault ? dim(" (default)") : ""}`).join("\n"));
    if (stillThere.length === saved.length && (await confirm(`Keep this mapping from ${savedFile}?`))) return saved;
  }
  log(dim("  Each iCloud calendar you pick becomes a category the bot can read and write."));
  const picked: CalChoice[] = [];
  for (const cal of cals) {
    if (!(await confirm(`Use iCloud calendar "${cal.name}"?`))) continue;
    const name = titleCase(await ask("  Category name", titleCase(cal.name)));
    picked.push({
      calendarName: cal.name,
      calendarUrl: cal.url,
      color: cal.color,
      slug: slugify(name),
      name,
      emoji: await ask("  Emoji", suggestEmoji(`${cal.name} ${name}`)),
      description: await ask("  What goes here? (helps the AI pick; optional)", ""),
      isDefault: false,
    });
  }
  if (!picked.length) die("Pick at least one calendar.");
  const answer =
    picked.length === 1 ? picked[0]!.slug : await ask(`Default category when nothing fits (${picked.map((p) => p.slug).join(", ")})`, picked[0]!.slug);
  const def = picked.find((p) => p.slug === slugify(answer)) ?? picked[0]!;
  def.isDefault = true;
  return picked;
}
