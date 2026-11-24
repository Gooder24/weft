# Prechod z Beeperu do Weftu bez straty histórie

Návrh k otázke „vieme ľuďom, ktorí používajú Beeper, zobrať ich konverzácie (lokálne alebo z cloudu) a presunúť
ich rovno do Weftu, aby nezačínali od začiatku; ideálne s napojením priamo na Beeper, a keď to skriptom nepôjde,
cez MCP s agentom“. Napísal ho agent 24. 11. 2026. Čísla nižšie sú z jedného skutočného Beeper Desktopu
(Linux, verzia z novembra 2026) a z kópie Weft archívu; obsah správ sa pri meraní nečítal, len počty a štruktúra.

## Krátko

- **Áno, ide to a prvý kus je postavený:** `server/archive/import_beeper.py` zoberie kópiu dátového priečinka
  Beeper Desktopu a dá jeho históriu do Weft archívu. Nič neposiela do siete ani do Beeperu, najprv ukáže, čo
  spraví (`--dry-run`), pred zápisom zálohuje archív a druhé spustenie nepridá nič.
- **Chaty sa trafia presne, bez hádania.** Beeper aj Weft používajú mosty mautrix a každý Beeper chat nesie ten
  istý kľúč chatu (ID kanála a prijímateľa), aký má Weftov most. Beeper Messenger chat padne do tej istej živej
  Weft miestnosti, kde už človek píše.
- **Lokálne dáta Beeperu sú len vyrovnávacia pamäť, nie celá história.** Beeper drží v počítači priemerne 15 až
  100 správ na chat (podľa siete) a z príloh len tie, ktoré si človek otvoril. Celá história je v sieti (Messenger,
  Instagram, Discord ju Weftov most vie dotiahnuť sám) alebo v Beeper Cloude, zašifrovaná.
- **Najväčší prínos je tam, kde sieť históriu znova nedá:** WhatsApp (po novom prepojení pošle telefón len časť),
  šifrované chaty Messengera, siete, ktoré Weft nemostí (Telegram, Signal, SMS, Beeper-to-Beeper chaty), a stav
  inboxu (nízka priorita, archív, pripomienky).
- **Agent cez MCP nemá nosiť správy.** Dáta nesie skript; agent ich má nanajvýš nastaviť a skontrolovať. Potom
  stojí centy, nie desiatky dolárov.

## Čo Beeper drží a kde

| Zdroj | Čo v ňom je | Prístup | Stav |
|---|---|---|---|
| **Lokálna databáza** `index.db` v dátovom priečinku Beeper Desktopu (`~/.config/BeeperTexts`, na Windowse `%APPDATA%\BeeperTexts`, na Macu `~/Library/Application Support/BeeperTexts`) | všetky chaty (1 133), posledné správy každého chatu už rozšifrované (spolu 42 907, najstaršie z roku 2020), mená ľudí, kľúč mosta každého chatu, štítky (nízka priorita, archív, pripomienky) | súbor; stačí, aby bol Beeper zavretý, žiadny token | **importér postavený a overený** |
| **Médiá v cache** `media/local.beeper.com/` | 1,2 GB, ale len to, čo si človek pozrel: zo vzorky 21 starších príloh bola v cache 1 | súbor | importér ich skopíruje, keď sú (`--media`) |
| **Beeper Desktop API** (lokálne REST na porte 23373, token v Settings → Integrations → „+“ pri Approved connections alebo OAuth s PKCE; na ňom beží aj vstavaný MCP server) | to isté ako aplikácia: chaty, správy po stránkach dozadu (`GET /v1/chats/{id}/messages`, `direction=before`), sťahovanie príloh (`POST /v1/assets/download`) | len kým Beeper Desktop beží; „Remote Access“ ho vie pustiť aj mimo počítača | návrh, neoverené |
| **Beeper Cloud** (šifrovaná záloha na serveroch Beeperu) | celá história chatov, ktoré išli cez cloudové mosty | Matrix klient s kódom obnovy (Recovery Code), ktorý má len používateľ | len popísané |
| **Sieť samotná** | Messenger, Instagram, Discord: história na ich serveroch; WhatsApp: len to, čo telefón pošle pri prepojení | Weftov most po prihlásení | už funguje bez Beeperu |

Prihlásenia sa z Beeperu **neprenášajú**. Beeper ich má (cookies Mety, kľúče zariadenia WhatsAppu), ale dva
klienti na jednom prihlásení sa navzájom odhlasujú a pri Mete je to presne to, čo vyzerá ako ukradnutý účet.
Človek sa do sietí prihlási vo Wefte nanovo, ako dnes, a až potom príde import.

## Čo importér robí (overené)

Na kópii Weft archívu a skutočnom `index.db` (nič sa nezapísalo do živého archívu):

| Sieť | Chatov v Beeperi | Do živej Weft miestnosti | K staršiemu exportu | Vlastné zobrazenie | Správ v Beeperi | Weft už mal | Pribudne |
|---|---|---|---|---|---|---|---|
| Discord | 214 | 106 | 51 | 57 | 21 803 | 9 546 | 11 819 |
| WhatsApp | 164 | 64 | 0 | 100 | 4 317 | 1 612 | 2 642 |
| Instagram | 522 | 46 | 256 | 220 | 7 550 | 6 138 | 1 370 |
| Messenger | 196 | 170 | 0 | 26 | 3 761 | 3 120 | 591 |
| Beeper chaty | 2 | 0 | 0 | 2 | 176 | 0 | 176 |

Spolu 16 598 nových správ za 3,8 s; druhé spustenie pridalo 0. V živých miestnostiach pribudlo 11 590 starších
správ na Discorde, 2 446 na WhatsAppe, 481 na Instagrame a 351 na Messengeri, teda históriu, ktorú Weft vôbec
nemal. „Weft už mal“ nezahŕňa správy z obdobia, ktoré živá miestnosť už drží (spolu 593): tie sa nepridajú, ani keď
ich Weft nemá, aby sa nemiešali do živej histórie.

Pravidlá, podľa ktorých sa rozhoduje:

1. **Kam chat patrí.** Kľúč mosta (`m.bridge` kanál + prijímateľ) nájde portál vo Weftovom moste a tým jeho
   miestnosť; s iným prijímateľom (druhý účet tej istej siete) sa nespáruje. Chat bez miestnosti ide k archívnemu
   chatu, ktorý už drží väčšinu jeho správ (napríklad starší Instagram export), a ide s ním aj pri jeho prepojení
   či odpojení; inak dostane vlastné zobrazenie len na čítanie. Tak ostane čitateľný aj Telegram či SMS.
2. **Žiadne duplikáty.** Správa, ktorú ten istý chat vo Wefte už má (čas do 3 s a rovnaký text alebo text s
   citátom odpovede; pri prílohe príloha alebo názov súboru v tej chvíli), sa nepridá. Iné chaty sa neporovnávajú.
3. **Do živej histórie sa nemieša.** V živej miestnosti pribudne len to, čo je staršie než jej prvá správa vo
   Wefte; to isté pravidlo už archív používa pre exporty. Na rozdiel od exportu ale Beeper drží len posledné
   správy chatu, preto archív pri posúvaní nahor ďalej pýta staršie strany od mosta a Beeper správy ukáže až pod
   nimi (`room_export_end` v `server/archive/archive.py` Beeper neráta).
4. **Prílohy:** riadok prílohy vznikne vždy (typ, veľkosť, rozmery), súbor len keď ho Beeper mal v cache; príloha
   bez súboru sa v archíve neukazuje ako súbor na stiahnutie a neskorší beh s `--media` súbory doplní, keď ich
   Beeper medzitým má. Súbor si nechá meno, aké mal v Beeperi. Kľúč šifrovaného súboru z odkazu sa do archívu
   neukladá nikde, ani do uloženej pôvodnej správy.
5. **Záloha:** pred každým zápisom sa archív zálohuje; beh, ktorý nič nepridá, nezapisuje ani nezálohuje.

Kontrola na vymyslených dátach (pokrýva všetky pravidlá vyššie, opakovaný import aj zálohu) je
`overenie/beeper-import/check.py`.

## Ako má vyzerať prechod pre človeka

1. **Nastavenia → Účty → „Prejsť z Beeperu“.** Weft najprv ukáže, ktoré siete má človek v Beeperi (účty z
   `index.db`), a pripojí ich svojimi prihlasovacími oknami ako dnes.
2. **Nájdenie Beeperu.** Desktopová appka Weftu (Electron) pozná priečinok Beeperu na tom istom počítači. Keď je
   Beeper zavretý, skopíruje `index.db` (a so súhlasom cache médií) a pošle ich na server; keď beží, použije
   Desktop API s tokenom, ktorý človek vloží raz.
3. **Prehľad pred importom:** tabuľka ako vyššie („pribudne 2 642 správ z WhatsAppu, z toho 2 446 starších, než
   má Weft“) a čo pribudne na disku. Až potom tlačidlo „Preniesť“.
4. **Stav inboxu:** nízka priorita, archív a pripomienky sa prenesú na zodpovedajúce Weft miestnosti (kľúč už
   vieme; zápis do Weftových account data je ďalší krok, dnes ich importér len spočíta).
5. **Beeper môže bežať ďalej**, kým si človek zvykne. Weft sa ho nič nepýta a nič v ňom nemení.

## „Napojenie priamo na Beeper“

Dá sa ísť ešte o krok ďalej: kým človek prechádza, Weft by čítal nové správy z Beeper Desktop API ako ďalší
zdroj, len na čítanie, a človek by videl všetko vo Wefte hneď, ešte pred prihlásením Weftových mostov. Odporúčam
to **nerobiť ako predvolené**: Desktop API žije len kým beží Beeper Desktop na počítači človeka, server by sa k nemu
musel dostať cez „Remote Access“ a odpovede by išli cez Beeper, nie cez Weft. Ako jednorazový zdroj histórie je
API dobré (vie aj prílohy, ktoré cache nemá); ako trvalé napojenie je to dvojitá prevádzka.

## Keď skript nestačí: agent cez MCP

Beeper Desktop má vstavaný MCP server (`http://localhost:23373/v0/mcp`; pre klientov, ktorí vedia len stdio, most
`@beeper/mcp-remote`), takže agent s tokenom vie chaty a správy čítať.
Nosiť cez neho celú históriu je ale drahé a pomalé, lebo každá správa prejde modelom:

| Spôsob | Tokenov na 43 000 správ (asi 30 tokenov na správu) | Claude Haiku 5.5 ($0,10 / $0,50 za milión vstupu / výstupu) | Claude Sonnet 5.5 ($2 / $10) |
|---|---|---|---|
| Agent číta a zapisuje každú správu sám (kontext sa pri každom volaní posiela znova, odhad 10×; správy idú von znova ako výstup) | ~13 mil. vstup, ~1,3 mil. výstup | ~2 $ | ~39 $ |
| Agent len nastaví a spustí skript, skontroluje prehľad a opraví chyby | ~50 tis. vstup, ~5 tis. výstup | menej ako 0,01 $ | ~0,15 $ |

Haiku má túto cenu len pre volania do 100 000 tokenov vstupu; nad tým stojí $0,50 / $2,50, takže agent, ktorý drží
v kontexte veľa správ naraz, zaplatí v prvom riadku až päťnásobok (~10 $).

Pri človeku so stovkami tisíc správ rastie prvý riadok úmerne. Agent preto patrí na to, čo skript nevie:
nájsť priečinok Beeperu na cudzom počítači, zistiť, prečo nesedí sieť, vysvetliť prehľad a rozhodnúť nejasné
spárovania. Ceny sú z cenníka API k 3. 11. 2026.

## Čo ostáva

| Čo | Prečo ešte nie | Ďalší krok |
|---|---|---|
| Ostrý import Karchiho Beeperu do živého archívu | mení `~/matrix-spike`, chce Karchiho áno | `--dry-run`, záloha, import; služba archívu sa na ten čas zastaví ako pri Messenger importe |
| Zdroj cez Desktop API (história nad rámec cache, prílohy) | treba token z bežiaceho Beeperu | doplniť do importéra čítanie po stránkach (najviac 1 požiadavka za sekundu) a overiť na Karchiho Beeperi |
| Prenos stavu inboxu | zápis do account data Weftu | mapovať štítky na Weftove stavy po miestnostiach |
| Tlačidlo „Prejsť z Beeperu“ v appke a v desktopovom obale | návrh, nie postavené | po rozhodnutí, či Weft pôjde iným ľuďom (`docs/navrhy/2026-11-prevadzka`) |
| Beeper Cloud cez kód obnovy | najviac práce, neoficiálne prihlásenie do Beeperu | len ak API nestačí |

## Zdroje

- [Beeper Desktop API](https://developers.beeper.com/desktop-api/), [prihlásenie a tokeny](https://developers.beeper.com/desktop-api/auth),
  [MCP](https://developers.beeper.com/desktop-api/mcp), [zoznam správ](https://developers.beeper.com/desktop-api-reference/resources/messages/methods/list),
  [prílohy](https://developers.beeper.com/desktop-api-reference/resources/assets), [changelog](https://developers.beeper.com/desktop-api/changelog)
- [Beeper FAQ](https://www.beeper.com/faq), [kód obnovy](https://help.beeper.com/reset-secure-storage-recovery-code-restore),
  [pripojenia v zariadení](https://help.beeper.com/using-on-device-chat-network-connections-in-beeper)
- [beepex](https://awesome.ecosyste.ms/projects/github.com%2Fjohnburnett%2Fbeepex): cudzí export Beeperu do HTML cez Desktop API
