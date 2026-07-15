// Smoke test: render a goal card and a mini card through the full Node->Python
// pipeline (SofaScore logos included). Prints the output paths.
import { renderCard, buildEventJob } from "./cards.mjs";

const ctx = {
  meta: { home: "Argentina", away: "Egypt" },
  state: { score: [3, 2], minute: 83, yellow: [2, 1], red: [0, 0], corners: [6, 1] },
  probs: { home: 0.62, draw: 0.25, away: 0.13 },
  prevProbs: { home: 0.41, draw: 0.30, away: 0.29 },
  odds: { home: 1.85, draw: 3.9, away: 8.2 },
  texts: { goal: "GOAL", win_probability: "Win probability", live_odds: "Live odds" },
};

const goal = buildEventJob({ kind: "goal", isHome: true, quote: { author: "HORUS", text: "Argentina jump from 41% to 62% win probability — the comeback is on." } }, ctx);
console.log(await renderCard("test-goal-en", goal));

const yellow = buildEventJob({ kind: "yellow", isHome: true, title: "Yellow card — Argentina", subtitle: "Late tackle in midfield, the referee reaches for his pocket." }, { ...ctx, texts: { yellow_card: "YELLOW CARD", cards: "Cards" } });
console.log(await renderCard("test-yellow-en", yellow));
