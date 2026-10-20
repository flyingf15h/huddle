// What the tokens people's agents used would cost at API prices, per million tokens. People on a
// Claude or ChatGPT subscription don't pay per token, so for them it's the API-equivalent value of
// what they used; for API-key users it's close to the real bill. A project owner can add or change
// prices (projectSettings.prices), e.g. for OpenAI models or a negotiated rate.
'use strict';

// [input, output, cache read, cache write (5 minute)] in US dollars per million tokens.
// Anthropic first-party API list prices, October 2026. Cache reads are 0.1x input and 5-minute
// cache writes 1.25x input unless Anthropic lists a different number.
const CLAUDE = {
  'claude-fable-5-1': [10, 50, 0.25, 12.5],
  'claude-fable-5': [10, 50, 1, 12.5],
  'claude-mythos-5-1': [10, 50, 0.25, 12.5],
  'claude-opus-5-5': [4, 20, 0.2, 5],
  'claude-opus-5': [5, 25, 0.5, 6.25],
  'claude-opus-4-8': [5, 25, 0.5, 6.25],
  'claude-opus-4-7': [5, 25, 0.5, 6.25],
  'claude-opus-4-6': [5, 25, 0.5, 6.25],
  'claude-opus-4-5': [5, 25, 0.5, 6.25],
  'claude-sonnet-5-5': [2, 10, 0.2, 2.5],
  'claude-sonnet-5': [2, 10, 0.2, 2.5],
  'claude-sonnet-4-6': [3, 15, 0.3, 3.75],
  'claude-sonnet-4-5': [3, 15, 0.3, 3.75],
  'claude-haiku-5-5': [0.1, 0.5, 0.01, 0.125],
  'claude-haiku-4-5': [1, 5, 0.1, 1.25],
};

// a model name as an agent reports it ("claude-opus-5-5[1m]", "claude-sonnet-4-5-20250929",
// "us.anthropic.claude-opus-5-5") to the key in the table
function canonical(model) {
  let m = String(model || '').toLowerCase().replace(/\[[^\]]*\]$/, '').replace(/^(us|eu|apac|global)\./, '').replace(/^anthropic\./, '');
  m = m.replace(/-\d{8}$/, '').replace(/@\d{8}$/, '');
  return m;
}

function priceFor(model, custom = {}) {
  const key = canonical(model);
  const own = custom && (custom[key] || custom[model]);
  if (Array.isArray(own) && own.length >= 2) return own.map(Number);
  if (CLAUDE[key]) return CLAUDE[key];
  // "claude-opus-5-5-fast" and other variants: the longest known prefix
  const hit = Object.keys(CLAUDE).filter(k => key.startsWith(k)).sort((a, b) => b.length - a.length)[0];
  return hit ? CLAUDE[hit] : null;
}

// dollars for one model's token counts, or null when the price isn't known
function costOf(model, u, custom) {
  const p = priceFor(model, custom);
  if (!p || !u) return null;
  const [inp, out, read = inp * 0.1, write = inp * 1.25] = p;
  return ((u.input || 0) * inp + (u.output || 0) * out + (u.cacheRead || 0) * read + (u.cacheWrite || 0) * write) / 1e6;
}

// the total over { model: usage }, and which models had no price
function costOfModels(models, custom) {
  let total = 0;
  const unpriced = [];
  for (const [m, u] of Object.entries(models || {})) {
    const c = costOf(m, u, custom);
    if (c == null) { if ((u.input || 0) + (u.output || 0) > 0) unpriced.push(m); } else total += c;
  }
  return { total, unpriced };
}

// prices an owner typed in: { model: [input, output, cacheRead?, cacheWrite?] }, sane numbers only
function cleanPrices(given) {
  const out = {};
  for (const [m, v] of Object.entries(given && typeof given === 'object' ? given : {}).slice(0, 40)) {
    const key = canonical(m).slice(0, 80);
    if (!key || !Array.isArray(v)) continue;
    const nums = v.slice(0, 4).map(Number);
    if (nums.length < 2 || nums.some(n => !isFinite(n) || n < 0 || n > 10000)) continue;
    out[key] = nums;
  }
  return out;
}

module.exports = { CLAUDE, canonical, priceFor, costOf, costOfModels, cleanPrices };
