// Packeta's mails (also those Vinted forwards): one chat per parcel, each mail one line: handed over, taken in,
// ready with its box, deadline and opening code, last day. A mail without a parcel number goes to „Packeta“.
import type { Connector, Item, Mail } from '../types.ts';
import { between } from '../mail.ts';

/** „Z-BOX Mesto, Ulica 1 Ulica 1 000 00 Mesto“: the mail repeats the street; this keeps the box and its street once. */
export function place(text: string) {
  const raw = between(text, /(?:uložená|bude vaša zásielka uložená)\s+/, /\s+Zobraziť na mape|$/);
  if (!raw) return '';
  const comma = raw.indexOf(', ');
  if (comma < 0) return raw.slice(0, 80);
  const head = raw.slice(0, comma);
  const rest = raw.slice(comma + 2);
  for (let k = 4; k < rest.length / 2 + 1; k++) {
    if (rest[k] === ' ' && rest.slice(k + 1).startsWith(rest.slice(0, k))) return `${head}, ${rest.slice(0, k)}`;
  }
  return `${head}, ${rest}`.slice(0, 80);
}

export function parse(m: Mail): Item[] {
  const t = m.text;
  const number = t.match(/Z \d{3} \d{4} \d{3}/)?.[0];
  const sender = t.match(/(?:odosielateľa|odosielateľ|obchod|zásielku od) ([^\s.,]+)/)?.[1];
  const box = place(t);
  const until = t.match(/najneskôr do (\d{1,2}\.\d{1,2}\.\d{4}(?: \d{1,2}:\d{2})?)/)?.[1];
  const code = t.match(/Kód pre otvorenie schránky ((?:\d ){5}\d)/)?.[1]?.replace(/ /g, '');
  const pickup = [box, until ? `do ${until}` : '', code ? `kód ${code}` : ''].filter(Boolean).join(', ');
  const s = m.subject;
  const text =
    /^Posledná možnosť/.test(s) ? `Dnes je posledný deň na vyzdvihnutie: ${pickup}.`
    : /čaká na vyzdvihnutie/.test(s) ? `Stále čaká na vyzdvihnutie: ${pickup}.`
    : /pripravená na vyzdvihnutie/.test(s) ? `Pripravená na vyzdvihnutie: ${pickup}.`
    : /prevzatá/.test(s) ? `Packeta ju prevzala a doručí ju${box ? ` do ${box}` : /do Z-BOXu/.test(t) ? ' do Z-BOXu' : ''}.`
    : /prijatá do prepravy/.test(s) ? `${sender || 'Odosielateľ'} ju odovzdal Packete${box ? `, pôjde do ${box}` : ''}.`
    : s;
  if (!number) return [{ thread: 'packeta', title: 'Packeta', text }];
  return [{ thread: `parcel:${number.replace(/ /g, '')}`, title: `Zásielka ${number}${sender ? ` od ${sender}` : ''}`, text }];
}

export const packeta: Connector = {
  id: 'packeta',
  name: 'Packeta',
  link: 'https://tracking.packeta.com/',
  mail: { from: (sender) => /packeta/i.test(sender), parse },
};
