// =============================================================================
//  roast.js — the goose's comeback. After the bot deletes a stock-scam message
//  in a group that opted in (/roast on), it may post ONE randomized line making
//  fun of the scam. Never the person: no name, no tag, no number, so a mistaken
//  delete never turns into a public call-out of a real member.
// -----------------------------------------------------------------------------
//  Definitions:
//    ROASTS      the lines; picked at random, never the same line twice in a row
//                in one group
//    cooldown    minimum minutes between roasts in one group, so a raid of twenty
//                scam posts gets one joke, not twenty (every send is paced and
//                counts toward the daily cap, and a chatty bot risks its number)
//    stock scam  the spam model's score >= its cutoff when the model is loaded;
//                otherwise finance vocabulary in the cleaned text
// =============================================================================
import { normalize } from './ml.js';

export const ROASTS = [
  '🪿 HONK. Another "stock study group" plucked. The only thing going up today is my delete count.',
  '🪿 That "free investment group" has been deleted. The real insider tip: it was a scam.',
  '🪿 The Professor of Stocks, PhD from the University of Trust Me Bro, has left the chat.',
  '🪿 Scam detected. Projected returns: 0%. Goose satisfaction: 100%.',
  '🪿 New stock tip: $HONK. Strong sell on whoever sent that message.',
  '🪿 Deleted. Even a goose knows a pump-and-dump when it sees one.',
  '🪿 "Beginners and investment enthusiasts are welcome to join"... and watch me delete it. Again.',
  '🪿 That message promised greater returns. The only thing returning is it, to the void.',
  '🪿 Market update: scam group shares are down 100% after an unexpected goose.',
  '🪿 Sorry, the VIP group is full. Full of other scammers.',
  '🪿 Honk honk. Translation: nobody here is joining your WhatsApp stock academy.',
  '🪿 Every "guaranteed return" ever posted in this chat has been guaranteed deleted.',
  '🪿 Dear "assistant of the Professor": the goose has reviewed your portfolio and sold it.',
  '🪿 If that group really made 300% a month, it would not need to spam a student group chat.',
  '🪿 That was not financial advice. That was financial bait. Removed.',
  '🪿 Plucked another one. Reminder: real investing clubs do not recruit through random invite links.',
];

const FINANCE_RE = /\b(stocks?|invest\w*|trading|traders?|crypto\w*|forex|market|portfolio|profits?|ipo|nasdaq|dividends?|shares?|professor|signals?|returns?)\b/;

const lastLine = new Map();    // gid -> index of the last line posted there
const lastRoastAt = new Map(); // gid -> ms timestamp of the last roast there

// Random line for this group, never the one it got last time.
export function pickRoast(gid, rand = Math.random) {
  let i = Math.floor(rand() * ROASTS.length);
  if (ROASTS.length > 1 && i === lastLine.get(gid)) i = (i + 1) % ROASTS.length;
  lastLine.set(gid, i);
  return ROASTS[i];
}

// Claim this group's roast slot if the cooldown has passed. Synchronous, so two scam posts
// arriving together can't both win it.
export function takeRoastSlot(gid, cooldownMin, nowMs = Date.now()) {
  const last = lastRoastAt.get(gid);
  if (last !== undefined && nowMs - last < cooldownMin * 60_000) return false;
  lastRoastAt.set(gid, nowMs);
  return true;
}

// Is this deleted message a STOCK scam (the thing worth joking about)? Asks the model when it is
// loaded; falls back to finance vocabulary when it isn't, or its backlog is full.
export async function isStockScam(text, ml) {
  if (ml) {
    const score = await ml.score(text).catch(() => null);
    if (score != null) return score >= ml.cutoff;
  }
  return FINANCE_RE.test(normalize(text));
}
