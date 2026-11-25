// What the phone sends (server/connect/phone.ts): SMS, one chat per number, and the notifications of the apps Karchi
// picked in Weft Telefón, one chat per app. Read-only for now.
import type { Connector, Item, PhoneItem } from '../types.ts';

export const sms: Connector = { id: 'sms', name: 'SMS' };
export const notifications: Connector = { id: 'phone', name: 'Telefón' };

/** A number as one thread whatever way the phone wrote it: „+421 900 123 456“, „0900123456“ and „00421900123456“ alike. */
export function number(address: string) {
  const s = address.replace(/[\s()./-]/g, '');
  if (!/^\+?\d+$/.test(s)) return s.toLowerCase(); // a sender name („Packeta“, „O2“)
  if (s.startsWith('+')) return s;
  if (s.startsWith('00')) return `+${s.slice(2)}`;
  if (s.startsWith('0') && s.length === 10) return `+421${s.slice(1)}`; // a Slovak number written at home
  return s;
}

export function parse(p: PhoneItem): [Connector, Item] | null {
  const text = p.text.trim();
  if (!text) return null;
  if (p.kind === 'sms') {
    if (!p.address) return null;
    const who = p.name?.trim() || p.address.trim();
    return [sms, { thread: number(p.address), title: who, from: who, text, mine: !!p.out }];
  }
  if (!p.app) return null;
  const app = p.appName?.trim() || p.app;
  const title = p.title?.trim();
  return [notifications, { thread: p.app, title: app, from: title && title !== app ? title : undefined, text }];
}
