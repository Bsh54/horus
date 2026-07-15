// User profiles — language, plan, AI quota. One JSON store, event-driven:
// a profile is created the first time a chat talks to the bot.
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA = join(__dirname, "data");
const USERS_FILE = join(DATA, "users.json");

export const FREE_AI_PER_DAY = 5;
export const PREMIUM_SOL = 0.1;

const users = existsSync(USERS_FILE) ? JSON.parse(readFileSync(USERS_FILE, "utf8")) : {};
function save() {
  if (!existsSync(DATA)) mkdirSync(DATA, { recursive: true });
  writeFileSync(USERS_FILE, JSON.stringify(users));
}

// Returns the profile, creating it on first contact (lang unset until the
// picker is answered — that's how the onboarding flow knows you're new).
export function getUser(chatId, from = {}) {
  const id = String(chatId);
  if (!users[id]) {
    users[id] = {
      createdAt: Date.now(),
      name: from.first_name || from.username || "fan",
      lang: null,          // set by the /start language picker
      plan: null,          // "free" | "premium", set by the plan portal
      premiumTx: null,     // devnet payment signature when upgraded
      ai: { day: today(), used: 0 },
    };
    save();
  }
  return users[id];
}

export function setLang(chatId, lang) { getUser(chatId).lang = lang; save(); }
export function setPlan(chatId, plan, txSig = null) {
  const u = getUser(chatId);
  u.plan = plan;
  if (txSig) u.premiumTx = txSig;
  save();
}

export const isPremium = (chatId) => getUser(chatId).plan === "premium";
export const langOf = (chatId) => getUser(chatId).lang || "en";
export const isOnboarded = (chatId) => { const u = getUser(chatId); return !!(u.lang && u.plan); };

const today = () => new Date().toISOString().slice(0, 10);

// AI question quota: premium unlimited, free FREE_AI_PER_DAY/day.
// Returns { ok, left } and consumes one question when ok.
export function useAiQuestion(chatId) {
  const u = getUser(chatId);
  if (u.plan === "premium") return { ok: true, left: Infinity };
  if (u.ai.day !== today()) u.ai = { day: today(), used: 0 };
  if (u.ai.used >= FREE_AI_PER_DAY) { save(); return { ok: false, left: 0 }; }
  u.ai.used++; save();
  return { ok: true, left: FREE_AI_PER_DAY - u.ai.used };
}

export function allUsers() { return Object.entries(users).map(([chatId, u]) => ({ chatId, ...u })); }
