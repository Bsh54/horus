// One-off: render a card from the CURRENT live match state and send it to a
// chat, proving the premium card pipeline end to end. Usage: node test-send-card.mjs <chatId>
import { readFileSync } from "fs";
import { renderCard, buildEventJob } from "./cards.mjs";
import { quoteFor } from "./personas.mjs";
import { translate } from "./i18n.mjs";
import { langOf } from "./users.mjs";

const chatId = process.argv[2];
if (!chatId) { console.error("usage: node test-send-card.mjs <chatId>"); process.exit(1); }

// live state from the running server
const fx = await (await fetch("http://localhost:80/api/live/fixtures")).json();
const live = fx.find((f) => f.inRunning) || fx[0];
if (!live) { console.error("no live fixture"); process.exit(1); }
const states = JSON.parse(readFileSync("data/score-states.json", "utf8"));
const st = states[live.fixtureId] || {};
const meta = { home: "England", away: "Argentina" }; // 18241006

const lang = langOf(chatId);
const quote = quoteFor("market", { fixtureId: live.fixtureId, team: meta.home, minute: st.minute, score: (st.score || []).join("-"), move: `1X2 ${live.odds.home} / ${live.odds.draw} / ${live.odds.away}` });
const job = buildEventJob(
  { kind: "market", isHome: true, quote: { author: quote.author, text: await translate(quote.text, lang) } },
  { meta, state: st, probs: null, prevProbs: null, odds: live.odds,
    texts: { odds_moved: (await translate("LIVE MARKET", lang)).toUpperCase(), win_probability: await translate("Win probability", lang), consensus: await translate("Consensus 1X2", lang) } });
const png = await renderCard(`manual-${live.fixtureId}-${Date.now()}`, job);
console.log("rendered:", png);

const token = JSON.parse(readFileSync("data/telegram.json", "utf8")).token;
const form = new FormData();
form.append("chat_id", chatId);
form.append("photo", new Blob([readFileSync(png)], { type: "image/png" }), "card.png");
form.append("caption", await translate(`⭐ Premium active — this is your card engine, live on ${meta.home} vs ${meta.away}. Goals, reds and half-time will arrive like this.`, lang));
const r = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, { method: "POST", body: form });
console.log("telegram:", (await r.json()).ok);
