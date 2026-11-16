/** Minimal DeepSeek client: one stateless JSON-mode completion. */

export type DeepSeekEnv = { DEEPSEEK_API_KEY: string; DEEPSEEK_MODEL?: string };

export async function completeJson(env: DeepSeekEnv, system: string, user: string): Promise<unknown> {
  const res = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify({
      model: env.DEEPSEEK_MODEL || "deepseek-chat",
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      response_format: { type: "json_object" },
      temperature: 0,
    }),
  });
  if (!res.ok) throw new Error(`DeepSeek ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { choices: { message: { content: string | null } }[] };
  const content = data.choices[0]?.message.content;
  if (!content) throw new Error("DeepSeek returned empty content");
  try {
    return JSON.parse(content);
  } catch {
    throw new Error(`DeepSeek returned invalid JSON: ${content.slice(0, 200)}`);
  }
}
