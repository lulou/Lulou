// Client-side content filter.
// Returns an array of detected category strings (empty = clean).
// Used by the "Comment filter" setting to warn senders before sending.

const PROFANITY: RegExp[] = [
  /\bf+u+c+k+\b/i,
  /\bs+h+i+t+\b/i,
  /\ba+s+s+h+o+l+e+\b/i,
  /\bb+i+t+c+h+\b/i,
  /\bc+u+n+t+\b/i,
  /\bd+i+c+k+\b/i,
  /\bp+r+i+c+k+\b/i,
  /\bw+h+o+r+e+\b/i,
  /\bs+l+u+t+\b/i,
  /\bb+a+s+t+a+r+d+\b/i,
  /\bd+a+m+n+\b/i,
  /\bh+e+l+l+\b/i,
];

const HARASSMENT: RegExp[] = [
  /\b(kill yourself|kys)\b/i,
  /\byou(?:'re| are) (stupid|dumb|ugly|fat|worthless|pathetic|disgusting|trash|garbage)\b/i,
  /\bgo (die|kill yourself|f+u+c+k yourself)\b/i,
  /\b(nobody|no one) (likes|wants|cares about) you\b/i,
  /\b(loser|idiot|moron|imbecile|retard)\b/i,
  /\bstop (breathing|existing|living)\b/i,
];

const HATE_SPEECH: RegExp[] = [
  /\b(n[i1]gg[ae3]r|n[i1]gg[ae3])\b/i,
  /\b(sp[i1]c|sp[i1]ck|ch[i1]nk|k[i1]ke|k[i1]ke|g[o0]{2}k|w[e3]tb[a4]ck)\b/i,
  /\b(f[a4]gg[o0]t|f[a4]g)\b/i,
];

const SPAM: RegExp[] = [
  /\b(click here|buy now|limited offer|act now|free money|earn \$|make money fast)\b/i,
  /\b(crypto|bitcoin|invest now|guaranteed returns)\b/i,
  /https?:\/\/[^\s]{20,}/i,
];

export interface FilterResult {
  categories: string[];
  blocked: boolean;
}

export function scanContent(text: string): FilterResult {
  const categories: string[] = [];

  if (HARASSMENT.some(p => p.test(text))) categories.push("harassment");
  if (HATE_SPEECH.some(p => p.test(text))) categories.push("hate speech");
  if (SPAM.some(p => p.test(text))) categories.push("spam");

  const profanityCount = PROFANITY.filter(p => p.test(text)).length;
  if (profanityCount >= 2) categories.push("excessive profanity");

  return {
    categories,
    blocked: categories.some(c => c === "harassment" || c === "hate speech"),
  };
}
