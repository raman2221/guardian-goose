// =============================================================================
//  behavior.js — content and rate heuristics that flag likely spam. State is
//  kept in memory and resets on restart, which is acceptable for these signals.
// -----------------------------------------------------------------------------
//  Definitions:
//    rate         phone -> recent message timestamps (burst detection)
//    crossGroup   normalized text -> senders/groups that posted it (broadcast)
//    URL_RE       regex matching links, invite links, shorteners, payment links
//    INVITE_RE    regex matching group-invite links (WhatsApp / Telegram / Discord)
//    DM_RE        regex matching "contact me / DM me" solicitations
//    solicit_kw   finance / charity solicitation vocabulary (weak on its own;
//                 STRONG when paired with a link)
//    signal       a named spam indicator returned by inspect()
//    strong       a signal combination confident enough to delete on
// =============================================================================

// In-memory rolling counters for behavior detection. Reset on restart (fine).
const rate = new Map();          // phone -> [timestamps]
const crossGroup = new Map();    // normalizedText -> Map(phone -> Set(gid), ts)

const now = () => Date.now();
const norm = (s) => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();

// Links (URLs, invite links, shorteners, bare domains) and "DM me / contact me" solicitations.
const URL_RE = /(https?:\/\/|www\.|wa\.me\/|chat\.whatsapp\.com\/|t\.me\/|bit\.ly\/|tinyurl|cash\.app|venmo\.com|paypal\.me|gofundme\.com|gofund\.me|\b[\w-]+\.(com|net|org|io|xyz|link|info|ru|cn|top|shop|vip|me)\b)/i;
// Group-invite links: nobody legitimately recruits a whole club into another chat via a drive-by.
const INVITE_RE = /(chat\.whatsapp\.com\/|t\.me\/(joinchat\/|\+)|t\.me\/[\w]+|discord\.gg\/)/i;
const DM_RE = /\b(dm me|message me|inbox me|text me|hit me up|whatsapp me|contact me|reach out|reach me|hmu|slide in|check my bio|link in bio)\b/i;

// Hard scam vocabulary: any hit is STRONG by itself. Word-anchored so "investigate",
// "non-profit" and the like never match. Merged with cfg.behavior.scamKeywords (plain strings,
// matched as whole-word prefixes).
const DEFAULT_SCAM = [
  /\bgofund/, /\bcryptocurrenc/, /\bcrypto[- ]?(trad|invest|wallet|profit|signal|market|coin|mining)/, /\bforex\b/,
  /guaranteed (return|profit)/, /double your/, /binary option/, /cash ?app flip/, /\bpre[- ]?ipo\b/, /passive income/,
  /\bget rich/, /\bhalal (stock|invest|wealth)/, /\bstock (selection|tips?|picks?|signals?)\b/,
];
// Solicitation vocabulary (finance, trading, charity appeals). Weak alone — clubs do talk
// about stocks and fundraisers — but STRONG when the same message carries a link.
const DEFAULT_SOLICIT = [
  /\binvest(?!igat)/, /\bstocks?\b/, /\btrad(ing|ers?)\b/, /(?<!non-?)\bprofits?\b/, /\bearn(ings?)?\b/, /\bincome\b/, /\bwealth\b/,
  /\binvestors?\b/, /\bbitcoin\b/, /\bbtc\b/, /\busdt\b/, /\bloans?\b/, /\bdonat(e|ions?)\b/, /\bfundrais/,
  /\bcharity\b/, /\borphan/, /\bsponsor me\b/, /\bsignals\b/, /\bshari(a|ah)\b/, /\bmarket (insight|update|tip)/,
];

const esc = (k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Config strings match as whole words plus common inflections: 'invest' hits invest/investing/
// investors/investment(s) but not 'investigate'.
const toRe = (k) => (k instanceof RegExp ? k : new RegExp('\\b' + esc(String(k).toLowerCase()) + '(s|es|ed|ing|ment|ments|or|ors|er|ers)?\\b'));
const hasAny = (low, list) => list.some((re) => re.test(low));

// Strong = high-confidence spam worth deleting: drive-by first-message spam, cross-group
// broadcast, hard scam vocabulary, a group-invite link, or a link paired with solicitation
// vocabulary. Bare link / dm_solicit / media / wall_of_text / burst alone -> flag only.
export const STRONG = ['first_msg_spam', 'cross_group', 'scam_keyword', 'invite_link', 'solicit_link'];
export const isStrong = (signals) => signals.some((s) => STRONG.includes(s));
// Hard-strong = confident enough to delete even from a grandfathered (pre-trusted, never
// verified) member. Every real spam post seen so far carried a link, so vocabulary alone
// is never enough here ("crypto" means cryptography in a CS group; clubs "invest time"):
//   cross-group broadcast, OR scam vocabulary WITH a link, OR an invite link WITH
//   solicitation vocabulary. A bare subgroup invite or fundraiser link from an existing
//   member stays flag-only.
export const isHardStrong = (signals) => {
  const has = (x) => signals.includes(x);
  return has('cross_group')
    || (has('scam_keyword') && (has('link') || has('invite_link')))
    || (has('invite_link') && has('solicit_kw'));
};

// opts: { hasMedia:bool, isFirstMessage:bool }
// Returns triggered signals: burst | cross_group | scam_keyword | solicit_kw | link |
//   invite_link | solicit_link | dm_solicit | media | wall_of_text | first_msg_spam.
export function inspect(cfg, phone, gid, body, opts = {}) {
  const b = cfg.behavior || {};
  const signals = [];
  const t = now();

  // burst rate
  const arr = (rate.get(phone) || []).filter((x) => t - x < 60_000);
  arr.push(t);
  rate.set(phone, arr);
  if (arr.length > (b.maxMsgPerMinute || 8)) signals.push('burst');

  const low = norm(body);
  const scamKw = hasAny(low, [...DEFAULT_SCAM, ...(b.scamKeywords || []).map(toRe)]);
  const solicitKw = hasAny(low, [...DEFAULT_SOLICIT, ...(b.solicitKeywords || []).map(toRe)]);
  if (scamKw) signals.push('scam_keyword');
  if (solicitKw) signals.push('solicit_kw');

  // content-shape signals
  const hasLink = URL_RE.test(low);
  const hasInvite = INVITE_RE.test(low);
  const dm = DM_RE.test(low);
  if (hasLink) signals.push('link');
  if (hasInvite) signals.push('invite_link');
  if (hasLink && solicitKw) signals.push('solicit_link');
  if (dm) signals.push('dm_solicit');
  if (opts.hasMedia) signals.push('media');
  if (low.length > (b.wallOfTextLen || 500)) signals.push('wall_of_text');

  // Classic drive-by scam: a member's VERY FIRST message in the group is a link plus
  // solicitation, a DM-solicit, an invite link, or scam vocabulary. Media alone, a bare link
  // alone, or a long post alone are NOT enough — new members share gifs, photos, and event
  // links all the time (those stay weak signals: flag, never delete).
  if (opts.isFirstMessage && (hasInvite || dm || scamKw || (hasLink && solicitKw)))
    signals.push('first_msg_spam');

  // cross-group broadcast: same text sent to >=threshold distinct groups in window
  if (low.length > 12) {
    const rec = crossGroup.get(low) || { by: new Map() };
    const gids = rec.by.get(phone) || new Set();
    gids.add(gid);
    rec.by.set(phone, gids);
    rec.ts = t;
    crossGroup.set(low, rec);
    if (gids.size >= (b.crossGroupThreshold || 3)) signals.push('cross_group');
  }

  // opportunistic GC
  if (crossGroup.size > 5000) {
    for (const [k, v] of crossGroup)
      if (t - v.ts > (b.crossGroupWindowMin || 10) * 60_000) crossGroup.delete(k);
  }
  return signals;
}
