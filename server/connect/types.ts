// A connector turns what a platform already sends Karchi (its mails, his phone's SMS and notifications) into chats in
// Weft. It never talks to the platform: rules are pure functions over text, so a connector cannot get an account banned.

/** One mail from the archive (Gmail or Outlook), its HTML already flattened to text. */
export type Mail = { id: string; from: string; subject: string; text: string; ts: number };

/** One message for Weft. `thread` picks the chat (one per Vinted item, one per parcel); `from` is the person in it,
 *  the connector itself when left out. */
export type Item = { thread: string; title: string; from?: string; text: string; mine?: boolean }; // mine: Karchi wrote it

export type Connector = {
  id: string; // also the m.bridge protocol id Weft reads, and the ghosts' prefix
  name: string;
  link?: string; // the platform's own page, for „Otvoriť vo …“
  mail?: { from: (sender: string) => boolean; parse: (mail: Mail) => Item[] };
};

/** What Karchi's phone (android/, Weft Telefón) sends: an SMS or a notification of an app he picked there. `id` is the
 *  phone's own and unique on it, so a resend never posts twice. */
export type PhoneItem = {
  id: string; kind: 'sms' | 'notification'; ts: number; text: string;
  address?: string; name?: string; out?: boolean; // sms: the number, its contact's name on the phone, sent by Karchi
  app?: string; appName?: string; title?: string; // notification: package, its label, the notification's title
};
