// Smoke test: start TxSim, replay backlog, watch 20s of live emission.
import { TxSim } from "./simulator.mjs";

let catchupScores = 0, liveScores = 0, catchupOdds = 0, liveOdds = 0;
const liveSamples = [];

const sim = new TxSim({
  onOdds: (o) => { o.catchup ? catchupOdds++ : (liveOdds++, liveSamples.length < 5 && liveSamples.push(`odds ${o.fixtureId} ${o.home}/${o.draw}/${o.away}`)); },
  onScore: (s) => {
    if (s.catchup) catchupScores++;
    else {
      liveScores++;
      const r = s.raw || {};
      if (liveSamples.length < 15) liveSamples.push(`score ${s.fixtureId} state=${r.GameState} action=${r.Action} stats=${JSON.stringify(r.Stats || {}).slice(0, 60)}`);
    }
  },
  onStatus: (st) => console.log("[status]", JSON.stringify(st)),
});

await sim.start();
console.log("meta:", [...sim.meta.entries()].map(([id, m]) => `${id} ${m.home}-${m.away} [${m.demoPhase}]`).join("\n      "));
console.log(`backlog: ${catchupScores} scores + ${catchupOdds} odds (catchup)`);

setTimeout(() => {
  sim.stop();
  console.log(`after 20s live: ${liveScores} scores, ${liveOdds} odds`);
  console.log(liveSamples.join("\n"));
  const state = [...sim.fixtures.entries()].map(([id, f]) => `${id} inRunning=${f.lastOdds?.inRunning} odds=${f.lastOdds ? [f.lastOdds.home, f.lastOdds.draw, f.lastOdds.away].join("/") : "none"}`);
  console.log("fixture state:\n" + state.join("\n"));
  process.exit(0);
}, 20000);
