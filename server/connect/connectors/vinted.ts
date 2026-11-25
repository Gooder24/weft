// Vinted's mails: one chat per item bought or offered (a new message, an offer, the receipt, order updates), the
// rest (feedback, favourites, terms) in one chat „Vinted“. Vinted's mails never carry the message itself, so a new
// message says who wrote and the chat's button opens Vinted. Mails Vinted forwards for Packeta go to Packeta.
import type { Connector, Item, Mail } from '../types.ts';
import { between, unquote } from '../mail.ts';

const END = /Go to conversation|View message|Respond to offer|Follow us:|This email was sent|Team Vinted|$/;

/** Vinted's own sentence: after its greeting, before its buttons and footer. */
function sentence(text: string) {
  const body = between(text, /^(?:Vinted Email\s*)?/, END)
    .replace(/^(?:Hi|Hello|Ahoj|Dobrý deň)\b[^,]*,\s*/i, '')
    .replace(/(, [^,]+)\1(?=,)/g, '$1'); // Vinted repeats a pick-up point's street
  const known = SLOVAK.map(([re, say]) => { const m = body.match(re); return m ? say(m) : ''; }).find(Boolean);
  if (known) return known;
  return body.length > 400 ? `${body.slice(0, 399)}…` : body;
}

/** Vinted's usual sentences in Slovak; anything else stays as Vinted wrote it. */
const SLOVAK: [RegExp, (m: RegExpMatchArray) => string][] = [
  [/^Your order is on its way! Estimated delivery is (.+?) for /, (m) => `Je na ceste, príde ${m[1]}.`],
  [/^Your (?:purchase|parcel) is waiting for you at (.+?)\. (?:Go and collect it!|Please pick it up\.)/, (m) => `Čaká na vyzdvihnutie: ${m[1]}.`],
  [/^Your order has been marked as delivered\..*?(?:You have until (.+?) to report an issue|$)/, (m) => `Doručené. Potvrď, že je všetko v poriadku${m[1] ? `, alebo nahlás problém do ${m[1]}` : ''}.`],
  [/^Your order has been cancelled/, () => 'Objednávka je zrušená, peniaze sa vrátia.'],
  [/^Refund sent to your payment method/, () => 'Peniaze sú vrátené na kartu.'],
];

export function parse(m: Mail): Item[] {
  const s = m.subject;
  const thing = (name: string, item: Omit<Item, 'thread' | 'title'>): Item[] => [{ thread: `item:${unquote(name)}`, title: unquote(name), ...item }];
  const about = (re: RegExp) => s.match(re)?.[1];
  let x: string | undefined;
  if ((x = about(/^New message about (.+)$/))) {
    const who = m.text.match(/(\S+) just sent you a message about/)?.[1];
    return thing(x, { from: who, text: 'Nová správa. Prečítaš ju a odpíšeš vo Vinted.' });
  }
  if ((x = about(/^New offer for (.+)$/))) {
    const who = m.text.match(/(\S+) just offered to sell you/)?.[1];
    const price = m.text.match(/New offer: (.+?) instead of (.+?)(?= Respond| Follow|$)/);
    return thing(x, { from: who, text: price ? `Ponuka: ${price[1]} namiesto ${price[2]}.` : 'Nová ponuka.' });
  }
  if ((x = about(/^Your receipt for (.+)$/))) {
    const t = m.text;
    const seller = t.match(/Seller (\S+)/)?.[1];
    const paid = t.match(/Paid (\S+)/)?.[1];
    const parts = [['tovar', /Item (\S+)/], ['poštovné', /Postage (\S+)/], ['poplatok', /Vinted fee (\S+)/]] as const;
    const split = parts.flatMap(([name, re]) => { const v = t.match(re)?.[1]; return v ? [`${name} ${v}`] : []; }).join(', ');
    const text = paid ? `Zaplatené ${paid}${split ? ` (${split})` : ''}${seller ? `, predajca ${seller}` : ''}.` : sentence(t);
    return thing(x, { text });
  }
  if ((x = about(/^Your refund for (.+?) is on its way$/))) return thing(x, { text: 'Peniaze sú na ceste späť.' });
  if ((x = about(/^Order update for (.+)$/))) return thing(x, { text: sentence(m.text) || 'Zmena objednávky.' });
  if ((x = about(/^(.+) - Confirmation needed$/))) {
    return thing(x, { text: sentence(m.text) || 'Potvrď vo Vinted, že je objednávka v poriadku.' });
  }
  return [{ thread: 'vinted', title: 'Vinted', text: s }];
}

export const vinted: Connector = {
  id: 'vinted',
  name: 'Vinted',
  link: 'https://www.vinted.sk/inbox',
  mail: { from: (sender) => /vinted\.[a-z]+>?\s*$/i.test(sender) && !/packeta/i.test(sender), parse },
};
