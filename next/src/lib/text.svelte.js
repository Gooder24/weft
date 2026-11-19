import { norm, S } from './core.js';

/** Message text as pieces for <Text>: links stay clickable, `find` marks the words a search matched. */
export function segments(text, find = '') {
  const out = [];
  const tokens = find ? norm(find).split(/\s+/).filter(Boolean) : [];
  for (const part of String(text).split(/(https?:\/\/\S+)/g)) {
    if (!part) continue;
    if (/^https?:\/\//.test(part)) out.push({ t: 'a', s: part });
    else if (!tokens.length) out.push({ t: '', s: part });
    else for (const [w] of part.matchAll(/[\p{L}\p{N}]+|[^\p{L}\p{N}]+/gu)) out.push({ t: tokens.some((tk) => norm(w).startsWith(tk)) ? 'mark' : '', s: w });
  }
  return out;
}

/** The search words to mark in a message: only in the one a search result opened. */
export const findIn = (ev) => (S.findQuery && ev?.event_id === S.focusEvent ? S.findQuery : '');

export const fileSize = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1).replace('.', ',')} MB` : `${Math.max(1, Math.round(n / 1e3))} kB`);

export async function download(mxc, name) {
  const [server, id] = mxc.slice(6).split('/');
  const res = await fetch(`/_matrix/client/v1/media/download/${encodeURIComponent(server)}/${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${S.token}` } }).catch(() => null);
  if (!res?.ok) return alert('Súbor sa nepodarilo stiahnuť.');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(await res.blob());
  a.download = name || 'subor';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 60e3);
}

/** UI-only state the old app kept in S: the open image and the view menu. */
export const ui = $state({ image: null, menu: false });
