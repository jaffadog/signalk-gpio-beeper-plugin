/*
 * Rules that decide, per notification, whether it sounds the beeper.
 *
 * Many notifications are worth seeing but not worth being woken by: a
 * sensor fault, a standing low-battery warning. Their state alone cannot
 * tell them from a real alarm, so a rule can name them by path, source or
 * message, and say whether they sound or stay silent.
 */

/**
 * @typedef {object} Rule
 * @property {string} path Notification path, without the leading
 *   "notifications."; `*` matches within one part, `**` any number of parts.
 * @property {string} [source] The update's `$source`; `*` matches any
 *   characters.
 * @property {string} [message] Case-insensitive text the notification's
 *   message must contain.
 * @property {"sound" | "silent"} action
 */

/**
 * Rules in the order given, without entries a hand-edited configuration got
 * wrong: no path or action, or a message or source of the wrong type.
 *
 * @param {unknown} rules
 */
function compileRules(rules) {
  if (!Array.isArray(rules)) return [];
  return rules
    .filter(
      (r) =>
        r != null &&
        typeof r.path === "string" &&
        r.path.length > 0 &&
        (r.action === "sound" || r.action === "silent") &&
        (r.message === undefined || typeof r.message === "string") &&
        (r.source === undefined || typeof r.source === "string"),
    )
    .map((rule) => ({
      action: rule.action,
      path: pathGlob(shortPath(rule.path)),
      source: rule.source ? glob(rule.source, false) : undefined,
      message: rule.message ? rule.message.toLowerCase() : undefined,
    }));
}

/**
 * The action of the first rule the notification matches, or undefined when
 * none does.
 *
 * @param {ReturnType<typeof compileRules>} rules
 * @param {string} path the full path, "notifications." included
 * @param {{ message?: unknown }} value
 * @param {string | undefined} source
 * @returns {"sound" | "silent" | undefined}
 */
function ruleAction(rules, path, value, source) {
  const notification = shortPath(path);
  const message =
    typeof value.message === "string" ? value.message.toLowerCase() : "";
  const match = rules.find(
    (r) =>
      r.path(notification) &&
      (!r.source || (source !== undefined && r.source(source))) &&
      (!r.message || message.includes(r.message)),
  );
  return match?.action;
}

function shortPath(path) {
  return path.replace(/^notifications\./, "");
}

/**
 * A path match where `**` also stands for no part at all, so that
 * `electrical.**.voltage` matches `electrical.voltage` as well.
 *
 * @param {string} pattern
 */
function pathGlob(pattern) {
  const variants = new Set([pattern]);
  for (const v of variants) {
    if (variants.size >= 64) break;
    if (v.startsWith("**.")) variants.add(v.slice(3));
    for (
      let at = v.indexOf(".**.");
      at !== -1;
      at = v.indexOf(".**.", at + 1)
    ) {
      variants.add(v.slice(0, at) + v.slice(at + 3));
    }
  }
  const matchers = [...variants].map((v) => glob(v, true));
  return (text) => matchers.some((m) => m(text));
}

const ANY = 0;
const ANY_IN_PART = 1;

/**
 * A whole-string match where `**` matches anything and `*` matches anything
 * too, or only within one `.`-separated part when `inPart`. It tracks every
 * pattern position the text read so far can reach, so a match takes at most
 * pattern length times text length steps. A regular expression of the same
 * pattern backtracks, exponentially in the number of wildcards.
 *
 * @param {string} pattern
 * @param {boolean} inPart
 * @returns {(text: string) => boolean}
 */
function glob(pattern, inPart) {
  const tokens = [];
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] !== "*") {
      tokens.push(pattern[i]);
    } else if (pattern[i + 1] === "*") {
      tokens.push(ANY);
      i++;
    } else {
      tokens.push(inPart ? ANY_IN_PART : ANY);
    }
  }
  // A wildcard can also match nothing, so reaching it reaches what follows.
  const skipWildcards = (reach) => {
    for (let i = 0; i < tokens.length; i++) {
      if (reach[i] && typeof tokens[i] === "number") reach[i + 1] = true;
    }
    return reach;
  };
  return (text) => {
    let reach = skipWildcards([true]);
    for (let k = 0; k < text.length; k++) {
      const c = text[k];
      const next = [];
      for (let i = 0; i < tokens.length; i++) {
        if (!reach[i]) continue;
        const t = tokens[i];
        if (t === ANY || (t === ANY_IN_PART && c !== ".")) next[i] = true;
        else if (t === c) next[i + 1] = true;
      }
      reach = skipWildcards(next);
    }
    return reach[tokens.length] === true;
  };
}

module.exports = { compileRules, ruleAction };
