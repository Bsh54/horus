// Smoke test: fetch a real Merkle proof for a finished demo fixture.
import { verifySummary } from "./proofs.mjs";
const v = await verifySummary(18218149, 500); // Spain-Belgium, mid-match seq
console.log(JSON.stringify(v, null, 1).slice(0, 800));
