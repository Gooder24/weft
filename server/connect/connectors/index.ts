// Every connector the host runs. A new platform is a file next to this one and a line here (plus its icon and
// name in app/app.js `CONNECTORS`).
import { packeta } from './packeta.ts';
import { notifications, sms } from './phone.ts';
import { vinted } from './vinted.ts';

export const CONNECTORS = [vinted, packeta, sms, notifications];
