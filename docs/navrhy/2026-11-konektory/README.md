# Hocijaký účet vo Wefte bez banu

Návrh, ako do Weftu pridávať ďalšie účty (Vinted, SMS, TikTok, Spotify a podobné) rýchlo a tak, aby žiadny účet
nemohli zablokovať. Napísali ho agenti 23. 11. 2026 (architektúra Claude Fable 5.2, prieskum a zhrnutie Claude
Opus 5.5) ako plánovací dokument; nič z neho ešte nie je postavené. Zdroje sú na konci.

## Hlavná myšlienka

Dnes každá nová sieť znamená celý ručne písaný most: vlastné prihlásenie, stav, unit, cestu v Caddy, Nastavenia
a kontroly. Pri „blbostiach“ ako Vinted sa to neoplatí a pri ich neoficiálnych API hrozí ban.

Väčšina platforiem už o všetkom dôležitom informuje sama, **mailom a notifikáciou v telefóne**. Keď Weft číta
tieto dva zdroje, platformu nekontaktuje ani raz, takže ban nie je „nepravdepodobný“, ale nemožný. Až keď to
nestačí, ide sa na oficiálne API, potom na udržiavaný most, a neoficiálne API s cookies sa nové nepíšu vôbec.

## Stupne podľa rizika banu

| Stupeň | Ako | Ban | Vie | Nevie |
|---|---|---|---|---|
| **T0 bez kontaktu** | maily, ktoré platforma posiela (už sú v archíve z Gmailu a Outlooku); appka v telefóne číta SMS a notifikácie; export dát (GDPR zip); webhook, RSS, ICS | **žiadny**, platforma nič nové nevidí | čítať; z telefónu hneď, z mailu do 5 min; z exportu celú históriu; SMS a rýchla odpoveď cez appku v telefóne | voľne písať (okrem SMS), často len útržok textu bez médií |
| **T1 oficiálne API** | OAuth s vlastnou appkou alebo kľúč, ktorý platforma vydá | žiadny v rámci limitov; najhoršie zruší kľúč | čítať, písať, niekedy naživo | čo API nemá (zvyčajne správy) |
| **T2 oficiálne prepojené zariadenie** | udržiavaný mautrix most (Telegram, Signal, Google Messages, WhatsApp už dnes) | nízky, nie nulový | všetko | – |
| **T3 vlastná relácia pasívne** | desktopová appka si zapíše, čo Karchi sám otvorí, bez požiadaviek navyše | veľmi nízky | zachytiť, čo pozerá | sync na pozadí; **nestavať, kým netreba** |
| **T4 neoficiálne API s cookies** | ako Messenger, Instagram, Discord dnes | **skutočný, nedá sa odstrániť** | všetko | byť bezpečné; len cez udržiavaný most a s Karchiho áno |
| nikdy | heslo cez most, headless prehliadač v prihlásenom účte, proxy, hromadné sťahovanie histórie | – | – | – |

Poradie pre každú novú platformu: mail → telefón → oficiálne API → most → zastaviť a spýtať sa.

## Konektor = jeden súbor

Jeden hostiteľ `server/connect/` v TypeScripte na Buni (jeden unit `matrix-spike-connect`, asi 30 MB pre všetky
konektory, za Caddy `/_connect/`). Platforma je jeden súbor: `manifest` a buď čisté pravidlá (`rules`), alebo
klient (`client` s `whoami`, `poll`, prípadne `send`). Python mosty ostávajú, ako sú.

```ts
export const manifest = {
  id: 'vinted', name: 'Vinted', icon: 'shopping-bag', tier: 0,
  caps: {},                       // send, realtime, codes, media, history
  auth: { kind: 'none' },         // none | device | export | oauth-pkce | token; heslo neexistuje
  inbox: 'quiet',                 // inbox | quiet | hidden, Karchi to mení v Nastaveniach
} satisfies Manifest

export const rules = {
  mail: [{ from: /@vinted\./, parse: (m) => [/* Item: vlákno, odosielateľ, text, odkaz „Otvoriť vo Vinted“ */] }],
  android: [{ pkg: 'fr.vinted', parse: (n) => [/* … */] }],
} satisfies Rules
```

Kam veci idú, rozhoduje hostiteľ, nie konektor:

- **Nové správy → skutočná Matrix miestnosť** cez jeden spoločný appservice (`@connectbot`, duchovia
  `@cx_<id>_<hash>`). Tým zadarmo fungujú inbox, neprečítané, okná na čítanie, spojené chaty (SMS s niekým sa spojí
  s jeho WhatsAppom), Ctrl+K a `weft`. Bez `caps.send` je namiesto políčka na správu tlačidlo „Otvoriť vo …“.
- **História (export) → archív** `archive:<id>:…`, ako maily.
- **Jednorazový kód → existujúce rohové okno** cez `codes.py` Gmail mosta, takže SMS kódy nepotrebujú novú logiku.
- Dvojité (tá istá správa Vintedu mailom aj notifikáciou): prvý zdroj vyhráva, podľa id alebo odtlačku do 10 min.

Nastavenia → Účty vykreslí prihlásenie z manifestu krokmi, ktoré appka už pozná: OAuth (otvoriť adresu, vložiť
presmerovanie ako Gmail), token (formulár s nápovedou), telefón (QR), export (výber súboru s náhľadom počtov),
bez prihlásenia (len vypínač). Každý riadok slovami povie stupeň („len čítanie · z mailov · Vinted o Wefte
nevie“), dnešný počet požiadaviek a odosielanie, ktoré je vypnuté, kým ho Karchi nezapne.

## Bezpečnosť ako stavba, nie sľub

- **T0 konektor nemá sieť.** Hostiteľ pred načítaním zmaže globálny `fetch`; kontrola odmietne konektor, ktorý
  importuje niečo iné ako typy alebo spomenie `fetch`, `Bun.spawn`, `node:*`, `WebSocket`.
- **Jeden regulátor pre T1** (`ctx.fetch`): len hostitelia z manifestu; len GET, kým nie je zapnuté odosielanie;
  jedna požiadavka naraz na účet; rozpočet za minútu a deň s náhodným rozptylom. `429` drží `Retry-After`, potom
  exponenciálne až 6 h. `401`, `403`, presmerovanie na prihlásenie, captcha alebo HTML namiesto JSON účet
  **zastaví** a pustí ho až Karchiho „Skúsiť znova“. Výzvu nikdy neskúša znova sám.
- **Vypínač** pre všetko aj pre jeden konektor; **denník** každej požiadavky (bez obsahu) viditeľný v Nastaveniach.
- **Odosielanie** potrebuje `caps.send`, Karchiho vypínač pri účte a `CONNECT_SEND=real`, ktorý nastavuje len unit
  na asuse. Každá kontrola beží s falošným odosielaním.
- **Testy bez siete**: `CONNECT_MODE=replay` hrá požiadavky zo záznamu a na všetko iné spadne.

Úprimne: T0 je bez banu z podstaty, T1 zmluvou, T2 má nízke riziko, ktoré nesú tisíce ľudí s tým istým mostom.
Pri T4 regulátor obmedzí len množstvo; odtlačok klienta, chýbajúca telemetria či zmena pravidiel ostávajú.

## Štyri všeobecné zdroje pokryjú skoro všetko

| Zdroj | Čo to je | Pokryje (z 20 nižšie) |
|---|---|---|
| **Pravidlá na maily** | číta nové riadky Gmailu a Outlooku v archíve, len na čítanie | ~10: Vinted, Bazoš, banka, zásielky, LinkedIn, Reddit, Steam, Twitch, YouTube, TikTok |
| **Appka v telefóne (Android)** | SMS čítať aj posielať, notifikácie vybraných appiek, rýchla odpoveď cez akciu notifikácie; k asusu cez Tailscale | ~17 na úrovni útržkov, SMS úplne |
| **Import exportu** | zip, ktorý si Karchi stiahne, najprv nanečisto, potom do archívu | ~10 na históriu |
| **Webhook + RSS/ICS** | `POST /_connect/in/<tajné>`; RSS a ICS už sú vo Feede a kalendári | skripty, GitHub, domácnosť |

Mail a telefón spolu dosiahnu 19 z 20 platforiem bez jediného kontaktu s nimi. Hranica: útržky textu, často
skrátené, väčšinou bez médií, odpoveď len tam, kde ju notifikácia ponúka.

## Platforma po platforme

| Platforma | Najlepší stupeň | Čítať / písať | Ban | Práca | Poznámka |
|---|---|---|---|---|---|
| SMS (aj „Wi-Fi SMS“) | T0 telefón | celé / áno | žiadny | stredná raz (appka) | SMS cez Wi-Fi volanie je pre Android obyčajná SMS; kódy do rohového okna |
| RCS, Google Messages | T0 telefón; plne T2 mautrix-gmessages | útržky / rýchla odpoveď; s T2 všetko | žiadny / nízky | malá / stredná | Android nedáva RCS API iným appkám |
| Vinted | T0 mail + telefón | správa, ponuka, predaj, zásielka / odkaz von | žiadny | malá | API len pre Vinted Pro; automatizácia je podľa podmienok dôvod na ban |
| TikTok | T0 telefón + mail; export | útržky / nie | žiadny | malá | API na správy pre osobné účty nie je |
| Spotify | T1 OAuth | čo hrá, história, playlisty / ovládanie | žiadny | malá | nie je chat; čo má ukázať, rozhodne Karchi |
| Telegram | T2 mautrix-telegram | všetko | nízky | stredná | Bot API vidí len chaty s botom |
| Signal | T2 mautrix-signal | všetko | nízky | stredná | prepojené zariadenie |
| Slack | T1 vlastná appka; inak T0 | všetko / útržky | žiadny | stredná | workspace môže chcieť súhlas admina |
| LinkedIn | T0 mail + telefón | útržky / nie | žiadny | malá | agresívne odhaľuje automatizáciu: nikdy T3/T4 |
| X DM | T0 telefón + mail; export | útržky / nie | žiadny | malá | DM API je platené |
| Snapchat | T0 telefón | „poslal Snap“ / nie | žiadny | malá | zamyká účty za cudzích klientov: nikdy T4 |
| Reddit | T1 OAuth | inbox, súkromné správy | žiadny | malá | nový chat v API asi nie je (neoverené) |
| Steam | T1 kľúč + T0 mail | priatelia, nákupy, Guard kódy / nie | žiadny | malá | |
| Twitch | T1 Helix | vysiela, chat / chat | žiadny | malá – stredná | „vysiela“ sa hodí do Feedu |
| YouTube komentáre | T1 Data API alebo T0 mail | komentáre / odpoveď | žiadny | malá | Google projekt už je kvôli Gmailu |
| Bazoš | T0 mail | správy kupujúcich / odpoveď mailom, už vo Wefte | žiadny | veľmi malá | formát mailu neoverený |
| iMessage | – | – | – | veľká | potrebuje Mac; bez neho vynechať |
| Banka, platby | T0 mail + telefón + SMS | čítať / nikdy | žiadny | malá na banku | tichá miestnosť, nikdy v texte Web Pushu |
| Zásielky | T0 mail + SMS | čítať, kódy na výdaj | žiadny | malá | neskôr termín vyzdvihnutia do kalendára |

## Čo ľudia chcú mať na jednom mieste

Z toho, čo Beeper podporuje a čo od neho ľudia pýtajú:

- **Chaty, ktoré už majú mosty:** WhatsApp, Messenger, Instagram, Telegram, Signal, Discord, Slack, Google
  Messages (SMS a RCS), Google Chat, LinkedIn, X, Bluesky, Google Voice, iMessage.
- **Najčastejšie žiadané bez mosta:** Snapchat (Beeper ho menuje ako častú žiadosť), LINE (Japonsko), Viber,
  TikTok, Reddit chat, GroupMe.
- **Mimo chatov**, čo ľudia inak lovia po desiatich appkách: bazáre (Vinted, Bazoš, OLX, eBay), zásielky (Packeta,
  SPS, DPD, pošta), banka a platby, jednorazové kódy, škola (EduPage, Weft má), kalendár (Weft má), hudba
  (Spotify), notifikácie YouTube, TikTok a Twitch, GitHub, hry (Steam), úradná schránka a faktúry.

Väčšinu druhej a tretej skupiny pokryjú pravidlá na maily a appka v telefóne, teda T0.

## Poradie stavby

1. **Týždeň 1: hostiteľ a pravidlá na maily.** Kostra, spoločný appservice, čítanie archívu, pravidlá pre Vinted,
   Bazoš, zásielky a jednu banku, v Účtoch ako vypínače. Kontrola bez siete: `bun test` s vymyslenými mailmi;
   jednorazový Tuwunel overí jednu miestnosť na vlákno a že znovu prehratý mail nespraví druhú udalosť; UI kontrola
   cez `tools/browser-slot`. Na asuse suchý beh nad posledných 30 dní pošty vypíše počty a nezachytených
   odosielateľov a nič nezapíše.
2. **Týždeň 2: appka v telefóne.** SMS oboma smermi (odosielanie vypnuté), SMS kódy do rohového okna, notifikácie
   vybraných appiek, spárovanie cez QR. Kontrola: emulátor na asuse (`adb emu sms send`, falošná appka s
   notifikáciami); falošné odosielanie dokáže, že žiadna SMS neodíde.
3. **Týždeň 3: regulátor, OAuth a prvý T1 klient** (Spotify). Kontrola: falošný OAuth a API server; testy regulátora
   na podvrhnutých hodinách: rozpočet sa neprekročí, `Retry-After` drží, výzva zastaví a ostane zastavená.

Zámerne nestavať: vlastný jazyk pravidiel (TypeScript stačí), konektory zvonka repa, proces na konektor, T3.

## Zdroje

- Beeper: [ktoré siete](https://beeper.helpjuice.com/en_US/chat-networks/which-chat-networks-can-you-connect-in-beeper),
  [roadmap 2022](https://blog.beeper.com/p/product-roadmap-april-2022),
  [stav 2023](https://blog.beeper.com/p/state-of-the-app-spring-2023),
  [Product Hunt, Beeper 4](https://www.producthunt.com/p/beeper-2/beeper-4?page=3)
- Mosty: [mautrix](https://github.com/mautrix), [docs.mau.fi](https://docs.mau.fi/bridges/toc.html),
  [mau.fi blog](https://mau.fi/blog/tags/matrix), [Matrix: SMS mosty](https://matrix.org/ecosystem/bridges/sms/),
  [mautrix-gmessages](https://docs.mau.fi/bridges/go/gmessages/),
  [SMS Matrix 2](https://f-droid.org/packages/su.mya.sms_matrix/)
- Vinted: [zákazy a blokovania](https://www.vinted.co.uk/help/92-bans-and-blocks),
  [Crosslist o Pro API](https://crosslist.com/blog/does-vinted-allow-resellers),
  [automatizované bany 2026](https://novadata.io/resources/news/vinted-seller-bans-automated-enforcement-august-2026)
