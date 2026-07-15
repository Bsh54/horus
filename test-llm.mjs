// Direct DeepSeek smoke test: shows the raw API answer.
import { readFileSync } from "fs";
const cfg = JSON.parse(readFileSync("data/deepseek.json", "utf8"));
const r = await fetch("https://api.deepseek.com/chat/completions", {
  method: "POST",
  headers: { "Content-Type": "application/json", "Authorization": `Bearer ${cfg.key}` },
  body: JSON.stringify({
    model: cfg.model,
    thinking: { type: "disabled" },
    temperature: 0.9,
    max_tokens: 500,
    messages: [
      { role: "system", content: "Rewrite each numbered line as one short vivid line of live football commentary. Return ONLY a JSON array of strings, same count and order." },
      { role: "user", content: "Match: Mexico vs South Korea.\n0| ⚽ Goal! Mexico 1, Korea Republic 0. Luis Romo right footed shot from the centre of the box.\n1| 🟨 Lee Kang-In (Korea Republic) is shown the yellow card for a bad foul." },
    ],
  }),
  signal: AbortSignal.timeout(30000),
});
console.log("status", r.status);
const j = await r.json();
console.log(JSON.stringify(j, null, 2).slice(0, 2500));
