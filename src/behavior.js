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

// Hard scam vocabulary: any hit is STRONG by itself, link or not. Bare "stock" / "invest" are
// NOT here (see DEFAULT_SOLICIT); what is here is the recruitment-pitch phrasing every scam so
// far shared: "stock information and discussion platform", "investors are welcome to join",
// "learn from each other", "daily market updates", "stock selection recommendations".
// Word-anchored so "investigate" never matches. Merged with cfg.behavior.scamKeywords (plain strings,
// matched as whole-word prefixes).
const DEFAULT_SCAM = [
  /\bgofund/, /\bcryptocurrenc/, /\bcrypto[- ]?(trad|invest|wallet|profit|signal|market|coin|mining)/, /\bforex\b/,
  // recruitment-pitch phrasing (finance "information group" scams)
  /\b(stock|invest\w*|trading|financ\w*|crypto\w*|forex|market) (information|discussion|study|learning|sharing|exchange|research)( and \w+)? (group|platform|community|club|channel)/,
  /\b(information|discussion|knowledge)[- ]sharing (group|platform|community)/,
  /\b(stock|invest\w*|trading|financ\w*|crypto\w*) (community|group|platform|club|channel)\b/,
  /\b(enthusiasts?|investors?|traders?|beginners?)( and \w+( \w+)?)? (are|is) welcome/,
  /\blearn from each other\b/, /\b(grow|progress|profit) together\b/,
  /\b(daily|weekly|real[- ]time) market (updates?|analysis|insights?|news)\b/, /\bmarket insights?\b/,
  /\bstock (selection|recommendations?|picks?|tips?|signals?)\b/,
  /\b(share|exchange|discuss) (\w+ ){0,3}(investment|trading|stock|market) (knowledge|experience|philosoph|insight|strateg|skill)/,
  // donation-appeal scam phrasing (orphan / sick mother / roof repair chain letters)
  /\bplease do not ignore this message/, /\b(no matter how small|little or much|however small|small or large|big or small)\b/,
  /\bmay (god|allah) (reward|bless) (everyone|all|those|anyone|whoever|who)/, /\b(i am|i'm|i’m) (an orphan|a widow|wounded|a refugee)\b/,
  /\b(even|just) (\$|£|€)\s?\d+ (could|can|would|will|may) (help|make|feed|protect|save|bring)/,
  /\b(donat\w+|contribut\w+|send (money|support)) (link|via|through|by) (paypal|cash ?app|venmo|zelle|gofund|bank|western union|moneygram)/,
  /\b(bedridden|dying) (mother|father|child|son|daughter|sister|brother)\b/, /\bthe story of \w+, the orphan/,
  /guaranteed (return|profit)/, /double your/, /binary option/, /cash ?app flip/, /\bpre[- ]?ipo\b/, /passive income/,
  /\bget rich/, /\bhalal (stock|invest|wealth)/, /\bstock (selection|tips?|picks?|signals?)\b/,
];
// Solicitation vocabulary (finance, trading, charity appeals). Weak alone — clubs do talk
// about stocks and fundraisers — but STRONG when the same message carries a link.
const DEFAULT_SOLICIT = [
  /\binvest(?!igat)/, /\bstocks?\b/, /\btrad(ing|ers?)\b/, /(?<!non-?)\bprofits?\b/, /\bearn(ings?)?\b/, /\bincome\b/, /\bwealth\b/,
  /\binvestors?\b/, /\bbitcoin\b/, /\bbtc\b/, /\busdt\b/, /\bloans?\b/, /\bdonat(e|ions?)\b/, /\bfundrais/,
  /\bcharity\b/, /\borphan/, /\bwidow/, /\bbedridden/, /\burgent(ly)? need/, /\bgod bless/, /\bsponsor me\b/, /\bsignals\b/, /\bshari(a|ah)\b/, /\bmarket (insight|update|tip)/,
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
// verified) member: cross-group broadcast, any scam-vocabulary hit (the phrase patterns are
// precise enough to stand alone), or an invite link paired with solicitation vocabulary. A bare
// subgroup invite, or a fundraiser link on a non-scam domain, from an existing member stays
// flag-only.
export const isHardStrong = (signals) => {
  const has = (x) => signals.includes(x);
  return has('cross_group') || has('scam_keyword') || (has('invite_link') && has('solicit_kw'));
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
