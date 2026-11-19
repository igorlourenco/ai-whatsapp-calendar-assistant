/** Emoji guessed from a calendar/category name ("Trabalho" → 💼). */
const EMOJI_HINTS: [RegExp, string][] = [
  [/work|trabalho|job|office|empresa/i, "💼"],
  [/school|faculdade|uni|college|escola|estudo|study/i, "🎓"],
  [/personal|pessoal|home|casa/i, "🏠"],
  [/family|fam[ií]lia|kids|filhos/i, "👨‍👩‍👧"],
  [/gym|academia|sport|esporte|treino/i, "🏋️"],
  [/health|sa[uú]de|m[eé]dico|doctor/i, "🩺"],
  [/birthday|anivers/i, "🎂"],
];

export const suggestEmoji = (name: string) => EMOJI_HINTS.find(([re]) => re.test(name))?.[1] ?? "📅";
