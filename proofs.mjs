// Merkle stat proofs — the verifiable layer of HORUS.
// TxLINE anchors per-fixture stat roots on Solana; /api/scores/stat-validation
// returns the exact material (statToProve, eventStatRoot, statProof[],
// subTreeProof[]) needed to verify one stat against the on-chain root.
// NB: the parameter is `statKey` (statId returns 400) and seq must be > 0.
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CRED_FILE = join(__dirname, "data", "txline-credentials.json");

// StatKey semantics (period-prefixed: 1xxx = 1st half, 2xxx = 2nd half)
export const STAT_NAMES = { 1: "home goals", 2: "away goals", 3: "home yellows", 4: "away yellows", 5: "home reds", 6: "away reds", 7: "home corners", 8: "away corners" };

async function creds() {
  if (!existsSync(CRED_FILE)) throw new Error("txline credentials missing");
  return JSON.parse(readFileSync(CRED_FILE, "utf8"));
}
async function jwt(api) {
  const r = await fetch(`${api}/auth/guest/start`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  if (!r.ok) throw new Error(`guest/start ${r.status}`);
  return (await r.json()).token;
}

// Fetch the Merkle proof for one stat of one score message (seq).
export async function statProof(fixtureId, seq, statKey) {
  const c = await creds();
  const t = await jwt(c.api);
  const r = await fetch(`${c.api}/api/scores/stat-validation?fixtureId=${fixtureId}&seq=${seq}&statKey=${statKey}`,
    { headers: { Authorization: `Bearer ${t}`, "X-Api-Token": c.apiToken }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`stat-validation ${r.status}`);
  const p = await r.json();
  if (!p || !p.eventStatRoot) throw new Error("no proof material returned");
  return p;
}

const hex = (arr) => Array.isArray(arr) ? Buffer.from(arr).toString("hex") : String(arr);

// Human-readable proof summary for the bot (technical enough to be credible,
// short enough for a chat bubble). All facts come straight from the API.
export async function verifySummary(fixtureId, seq, statKeys = [1, 2]) {
  const parts = [];
  let root = null;
  for (const key of statKeys) {
    try {
      const p = await statProof(fixtureId, seq, key);
      root = hex(p.eventStatRoot);
      parts.push({
        statKey: key, name: STAT_NAMES[key] || `stat ${key}`,
        value: p.statToProve?.value ?? p.statToProve,
        proofNodes: (p.statProof || []).length + (p.subTreeProof || []).length,
      });
    } catch (e) {
      parts.push({ statKey: key, name: STAT_NAMES[key] || `stat ${key}`, error: e.message });
    }
  }
  return { fixtureId, seq, root, parts };
}
