// Weft speaks Slovak, Karchi's language, or English (Settings → Správy → Jazyk, kept per device). Text in code stays
// Slovak and is wrapped: T('Uložiť') or T`Prezývka pre ${name}`. Its English is in i18n-en.js under the same Slovak
// text, with `{}` for each ${…} in order, or {0}, {1} where English needs another order. Text that goes to other
// people (message bodies) and data keys are never wrapped. `tools/i18n-check` lists text that is missing either.
const stored = (() => { try { return localStorage.getItem('ep_lang'); } catch { return null; } })();
export const LANG = stored === 'en' ? 'en' : 'sk';
export const LOCALE = LANG === 'en' ? 'en-GB' : 'sk-SK';
const EN = LANG === 'en' ? (await import('./i18n-en.js')).default : null;
const keys = new WeakMap();
const join = (parts, vals) => parts.reduce((out, q, i) => out + vals[i - 1] + q);
export function T(text, ...vals) {
  if (typeof text === 'string') return EN?.[text] ?? text;
  if (!EN) return join(text, vals);
  let key = keys.get(text);
  if (key === undefined) keys.set(text, (key = text.join('{}')));
  const en = EN[key];
  if (en === undefined) return join(text, vals);
  let n = 0;
  return en.replace(/\{(\d*)\}/g, (_, i) => String(vals[i === '' ? n++ : Number(i)]));
}
/** Switching reloads the page: every view, constant and date then speaks the new language. */
export function setLang(lang) {
  localStorage.setItem('ep_lang', lang === 'en' ? 'en' : 'sk');
}
