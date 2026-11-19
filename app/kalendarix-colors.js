// Kalendarix 2's subject-colour rules (MIT, Copyright 2026 esyst).
// Source: Gooder24/kalendarix src/core/colors.ts; license in kalendarix-LICENSE.
const HEX = /^#[0-9a-f]{6}$/i;
export const isHex = (v) => typeof v === 'string' && HEX.test(v);
// Also less EduPage's "Odpadlo:", "Suplovanie:", "Zmena:" (Kalendarix EduPage's titles): a changed lesson is still its
// subject, and a new key would move other subjects' colours.
export const titleKey = (title) => title.replace(/^\s*(zrušené|zrusene|cancelled|canceled|odpadlo|suplovanie|zmena)\s*:\s*/i, '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
/** Second colours to pick from, as Kalendarix offers them. */
export const ACCENT_PALETTE = ['#7fb3ff', '#ffb86b', '#ff8fa3', '#c49bff', '#5fd4c8', '#ffe07a', '#ff9de1', '#6fd0ff', '#e6a37a', '#b9c2ff', '#d8e56a', '#f58f6c', '#8ee3d0', '#d0a4e8', '#c9b68a', '#9be37a'];
const rgb = (hex) => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
export function autoAccents(calendar, base) {
  const b = rgb(base);
  const palette = ACCENT_PALETTE.filter((c) => Math.hypot(...rgb(c).map((v, i) => v - b[i])) > 70);
  const keys = [...new Set(calendar.events.map((e) => titleKey(e.title)))].filter(Boolean).sort();
  const taken = palette.map(() => false), out = new Map();
  for (const key of keys) {
    let h = 2166136261;
    for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
    let slot = (h >>> 0) % palette.length;
    for (let tries = 0; tries < palette.length && taken[slot]; tries++) slot = (slot + 1) % palette.length;
    taken[slot] = true; out.set(key, palette[slot]);
    if (taken.every(Boolean)) taken.fill(false);
  }
  return out;
}
export function eventAccent(calendar, event, auto) {
  if (isHex(event.accent)) return event.accent.toLowerCase();
  const pinned = calendar.accents?.[titleKey(event.title)];
  if (isHex(pinned)) return pinned.toLowerCase();
  return auto?.get(titleKey(event.title)) ?? null;
}
export function textOn(hex) {
  const values = rgb(hex).map((c) => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * values[0] + 0.7152 * values[1] + 0.0722 * values[2] > 0.179 ? '#000000' : '#ffffff';
}
