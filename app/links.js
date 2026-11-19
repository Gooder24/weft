// Shared links in messages: which links a text carries, what the bridge already says about them, and the reader on
// asus (/_links/resolve) for the rest. The same card comes out whichever network delivered the link.
import { T } from './i18n.js';

const MAX_LINKS = 3; // cards under one message

/** A link as written in a text, without the punctuation that closes the sentence around it: a trailing ")" stays only
 *  when the link opened one itself (Wikipedia); .,;:!? and closing quotes never end a link. */
export function trimLink(url) {
  for (;;) {
    const last = [...url].at(-1) || '';
    if (/[.,;:!?'"»“”’…\uFE0F]|\p{So}|\p{Sk}|\p{Cf}/u.test(last)) url = url.slice(0, -last.length); // also an emoji right after it
    else if (last === ')' && (url.match(/\(/g) || []).length < (url.match(/\)/g) || []).length) url = url.slice(0, -1);
    else if (last === ']' && !url.includes('[')) url = url.slice(0, -1);
    else return url;
  }
}
// Brackets end a link ("[url](url)" from Markdown), and a second "https://" starts the next one.
export const LINK_RE = /https?:\/\/(?:(?!https?:\/\/)[^\s<>"[\]])+/gi;

/** The http(s) links in a text worth a card, in order, each page once (at most three). Not one inside an HTML
 *  attribute (a mail's markup) and not a picture: a mail's pictures are often its sender's tracking pixels. */
export function linksIn(text) {
  const out = [];
  text = String(text || '');
  for (const m of text.matchAll(LINK_RE)) {
    if (/=["']?$/.test(text.slice(Math.max(0, m.index - 2), m.index))) continue;
    let url = trimLink(m[0]);
    try { url = new URL(url).href; } catch { continue; }
    if (/\.(gif|png|jpe?g|webp|svg|ico|bmp)$/i.test(new URL(url).pathname)) continue;
    if (!out.some((u) => same(u, url))) out.push(url);
    if (out.length === MAX_LINKS) break;
  }
  return out;
}

/** In mail only a link to a known platform is read by itself: any other may be the sender's click tracking, so it
 *  waits for Karchi's click (or `weft link`). */
export const readsItself = (url, app) => !['gmail', 'outlook'].includes(app) || classify(url)[0] !== 'web';
export const HELD = { status: 'held', reason: T('Odkaz z mailu sa nečíta sám — môže byť sledovací.') };

const NAMES = { instagram: 'Instagram', youtube: 'YouTube', tiktok: 'TikTok', facebook: 'Facebook', x: 'X' };
const KINDS = { profile: T('profil'), post: T('príspevok'), reel: 'reel', video: 'video', short: 'Shorts', story: T('príbeh'), page: T('stránka'), short_link: T('krátky odkaz') };

/** [platform, kind] from the address alone (the reader on asus decides the same way and follows short links). */
export function classify(url) {
  let u;
  try { u = new URL(url); } catch { return ['web', 'page']; }
  const host = u.hostname.toLowerCase().replace(/^(www|m)\./, '');
  const parts = u.pathname.split('/').filter(Boolean);
  if (host === 'instagram.com' || host === 'instagr.am') {
    if (parts[0] === 'p') return ['instagram', 'post'];
    if (['reel', 'reels', 'tv'].includes(parts[0])) return ['instagram', 'reel'];
    if (parts[0] === 'stories') return ['instagram', 'story'];
    return ['instagram', parts.length ? 'profile' : 'page'];
  }
  if (['youtube.com', 'music.youtube.com', 'youtu.be', 'youtube-nocookie.com'].includes(host)) {
    if (host === 'youtu.be' || ['watch', 'live', 'embed'].includes(parts[0])) return ['youtube', 'video'];
    if (parts[0] === 'shorts') return ['youtube', 'short'];
    return ['youtube', parts[0]?.startsWith('@') || ['channel', 'c', 'user'].includes(parts[0]) ? 'profile' : 'page'];
  }
  if (host === 'vm.tiktok.com' || host === 'vt.tiktok.com' || (host === 'tiktok.com' && parts[0] === 't')) return ['tiktok', 'short_link'];
  if (host === 'tiktok.com') {
    if (parts.length >= 3 && (parts[1] === 'video' || parts[1] === 'photo')) return ['tiktok', parts[1] === 'video' ? 'video' : 'post'];
    return ['tiktok', parts[0]?.startsWith('@') ? 'profile' : 'page'];
  }
  if (['facebook.com', 'fb.com', 'fb.watch', 'web.facebook.com'].includes(host)) {
    if (host === 'fb.watch' || parts.includes('videos') || ['watch', 'reel'].includes(parts[0])) return ['facebook', 'video'];
    if (parts[0] === 'share' || parts.includes('posts') || parts[0] === 'permalink.php') return ['facebook', 'post'];
    return ['facebook', parts.length ? 'profile' : 'page'];
  }
  if (['x.com', 'twitter.com', 'mobile.twitter.com'].includes(host)) return ['x', parts.includes('status') ? 'post' : parts.length ? 'profile' : 'page'];
  return ['web', 'page'];
}

/** One page under two spellings (www., m., a trailing slash, a time or tracking parameter, youtu.be for a YouTube
 *  video); ?v= and ?id= name the page. */
export const same = (a, b) => {
  try {
    const key = (u) => (u.hostname === 'youtu.be' ? ['youtube.com', '/watch', u.pathname.split('/')[1] || '', '']
      : [u.host.replace(/^(www|m)\./, ''), u.pathname.replace(/\/$/, ''), u.searchParams.get('v') || '', u.searchParams.get('id') || '']).join(' ');
    return key(new URL(a)) === key(new URL(b));
  } catch { return false; }
};

/** What the bridge put in the message about its links: Beeper link previews (Messenger, Instagram, WhatsApp, Discord)
 *  and the post a Meta share carries (its media is the message itself). Keyed by the link as it appears in the text. */
export function fromBridge(content, links) {
  const out = new Map();
  const previews = Array.isArray(content?.['com.beeper.linkpreviews']) ? content['com.beeper.linkpreviews'] : [];
  for (const url of links) {
    const p = previews.find((x) => x && [x.matched_url, x['og:url']].some((u) => typeof u === 'string' && (u === url || same(u, url))));
    if (p) {
      out.set(url, {
        title: str(p['og:title']), description: str(p['og:description']),
        image: typeof p['og:image'] === 'string' && p['og:image'].startsWith('mxc://') ? p['og:image'] : '',
        source: 'bridge',
      });
    }
  }
  const shared = typeof content?.external_url === 'string' ? content.external_url : '';
  const caption = str(content?.['com.beeper.meta.caption_body_text']);
  const title = str(content?.['com.beeper.meta.full_post_title']);
  if (shared && (caption || title)) {
    const key = links.find((u) => same(u, shared)) || shared;
    out.set(key, { ...(out.get(key) || {}), title: title || out.get(key)?.title || '', description: caption, source: 'bridge-post' });
  }
  return out;
}
const str = (v) => (typeof v === 'string' ? v : '');

/** One card: what the reader found, filled in from the bridge, with the truth about what was and was not read. */
export function card(url, bridge, read) {
  const [platform, kind] = read?.platform ? [read.platform, read.kind] : classify(url);
  const ok = !read || ['ok', 'partial'].includes(read.status);
  const c = {
    url, platform, kind,
    name: NAMES[platform] || hostOf(read?.final_url || url),
    kindName: KINDS[kind] || kind,
    // Once read, the card says what the reader found, whichever network brought the link; a bridge's own preview
    // fills in only until then. A Meta share's caption is the post's own text, so it stays when the page had none.
    title: (read && ok ? read.title : '') || ((!read || !ok || bridge?.source === 'bridge-post') && bridge?.title) || '',
    description: (read && ok ? read.description : '') || ((!read || !ok || bridge?.source === 'bridge-post') && bridge?.description) || '',
    author: (ok && read?.author?.name) || '',
    image: bridge?.image || (ok && read?.image ? read.image : ''),
    status: read ? read.status : bridge ? 'bridge' : 'loading',
    reason: read?.reason || '',
    source: [bridge && (bridge.source === 'bridge-post' ? T('príspevok z mosta') : T('náhľad z mosta')), read && ok && sourceName(read.source)].filter(Boolean).join(' + '),
  };
  const video = ['video', 'short', 'reel'].includes(kind);
  const cap = read?.captions;
  c.transcript = !video ? '' : cap?.state === 'listed' ? T`Prepis: nečítaný — ${c.name} má titulky (${cap.languages.join(', ')}), ale bez prehliadača ich nevydá.`
    : cap?.state === 'read' ? T`Prepis z titulkov${cap.language ? ` (${cap.language})` : ''}: ${cap.text}`
    : T('Prepis: nie je k dispozícii — video samo nikto neprečítal, toto je iba jeho popis.');
  return c;
}
const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return 'web'; } };
const sourceName = (s) => ({ oembed: 'oEmbed', 'oembed+watch-page': T('oEmbed + stránka videa'), opengraph: T('metadáta stránky'), 'video-page': T('stránka videa'), 'video-page+subtitles': T('stránka videa + titulky') }[s] || s || '');

/** The card as plain lines, the way an agent reads it (`weft read` prints the same). */
export function cardText(c) {
  const head = `[${c.name} · ${c.kindName}${c.author ? ` · ${c.author}` : ''}]`;
  if (!['ok', 'partial', 'bridge'].includes(c.status) && !c.title) return [`${head} ${c.status === 'loading' ? T('načítavam…') : c.reason || T('nedostupné')}`];
  return [`${head} ${c.title}`.trim(), c.description, c.transcript, c.reason && c.status !== 'ok' ? c.reason : '', c.source ? T`zdroj: ${c.source}` : ''].filter(Boolean);
}

/** The reader on asus, asked once per link (also across messages and chats), two at a time. */
export function createLinkReader({ request, changed }) {
  const known = new Map(); // url -> result, or null while it is asked
  const queue = [];
  let running = 0;
  function pump() {
    while (running < 2 && queue.length) {
      const url = queue.shift();
      running++;
      request(url).then((res) => known.set(url, { ...res, at: Date.now() }),
        () => known.set(url, { status: 'error', reason: T('Čítačka odkazov na asuse neodpovedala.'), at: Date.now() })).finally(() => { running--; changed(url); pump(); });
    }
  }
  const retry = (res) => res && ['error', 'timeout', 'limited'].includes(res.status) && Date.now() - (res.at || 0) > 60e3;
  return {
    /** undefined: never asked; null: being asked; else the reader's answer. */
    get: (url) => (known.has(url) ? known.get(url) : undefined),
    /** Asks for a link once; one that failed for a passing reason is asked again a minute later. */
    want(url) {
      if (known.has(url) && !retry(known.get(url))) return;
      known.set(url, null);
      queue.push(url);
      pump();
    },
  };
}
