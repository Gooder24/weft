# Weft oproti Beeperu a AI agenti vo Wefte

Návrh k otázke „čím Weft láka oproti Beeperu, vieme pridať Grok Bot, Dots, Duet a Muse, ako by to fungovalo, a
ako spraviť schvaľovanie tak dobré, aby to bolo v pohode“. Napísali ho agenti 23. 11. 2026: prieskum a zhrnutie
Claude Opus 5.5, nezávislý druhý názor Claude Fable 5.2 (xhigh), ktorý dal hlavne návrh schvaľovania. Je to
plánovací dokument, nič z neho ešte nie je postavené. Stránky cudzích služieb sme čítali v ten deň a zdroje sú na
konci. Čo vieme len z cudzích článkov, je pri tom napísané.

## Krátko

- Weft má oproti Beeperu školu, poštu, Teams, kalendár, okná na čítanie, celý archív a agentov, ktorí bežia aj bez
  zapnutého počítača. Beeper má viac sietí, natívne appky v telefóne a nikto mu nemusí udržiavať server.
- Zo štyroch agentov je zo Slovenska dnes použiteľný najviac Grok Bot. Dots, Duet a Muse v EÚ nie sú. Žiadny z
  nich nemá API, cez ktoré by bol normálnym chatom vo Wefte.
- Dá sa to otočiť: Weft dostane jeden konektor (MCP server), ktorý agenti volajú. Konektor vie čítať a navrhovať,
  ale nevie nič poslať. Všetko, čo agent navrhne, čaká vo Wefte na Karchiho v jednom zozname „Na schválenie“.
- Ako prvý sa postaví zoznam na schválenie a jeho prvý používateľ bude Hermes. Netreba naň žiadnu verejnú adresu
  ani predplatné.

## Čo má Weft a Beeper nie

| Oblasť | Weft | Beeper |
|---|---|---|
| Škola | EduPage most: správy, oznamy, známky, úlohy s textom a súbormi materiálov, testy v kalendári „Testy“, prihlasovania, pravidlá pre každý typ oznamu, písanie učiteľom aj so súbormi | nemá |
| Pošta | Gmail a Outlook v tom istom inboxe, celá pošta v archíve, Nový mail so súbormi, `weft mail` | poštu nemá |
| Teams | chaty jeden na jedného, skupinové a zo stretnutí, oboma smermi, aj „videné“ | nemá |
| Jednorazové kódy | rohové okno pár sekúnd po príchode mailu (IMAP IDLE), Enter ho skopíruje; Web Push dorazí aj do zavretého Weftu | nemá |
| Kalendár | priamo v okne: Kalendarix (opakovanie, kategórie, rok, .ics, odbery), rozvrh so suplovaním, pripomienky; pod správou s časom „Pridať do kalendára“, aj po slovensky | nemá |
| Pozornosť | okná na čítanie: správy čakajú na 1–8 okien za deň a zmena platí až od zajtra; ľudia z „Práce“ prejdú hneď; Feed (RSS, YouTube, X, Instagram) | len stlmenie, štítky a inkognito |
| História | celý archív z exportov a mostov, hľadanie v ňom, karta človeka (počet správ, od kedy si píšete, najdlhšia séria dní, rýchlosť odpovedí, 24 mesiacov) | len toľko histórie, koľko stiahne most |
| Agenti | `weft` beží na serveri 24/7 aj pri vypnutých zariadeniach a jeho koncepty padajú do Odložených; Hermes je chat v inboxe; relay pošle obrázok odpovede kamarátovi | Desktop API a MCP, len kým je zapnutý Beeper Desktop, a `send_message` posiela bez potvrdenia |
| Bez úrovní | neobmedzene účtov; poslať neskôr, pripomienky a spájanie chatov pre všetkých | zadarmo 5 účtov; Plus za 9,99 $ mesačne 10 účtov, poslať neskôr, pripomienky, inkognito a prepis hlasoviek; Plus Plus za 49,99 $ |
| Drobnosti | farba a tvar chatu podľa človeka, karusely z Instagramu, reels a odkazy bez sledovacích parametrov, karty odkazov s prepisom, ankety, servery a profily na Discorde, statusy a nové skupiny na WhatsAppe, okno „Sledovať“ bez feedu Instagramu, hlasovky z klávesnice, offline | – |
| Vlastníctvo | beží na vlastnom stroji, AGPL, po slovensky, celé z klávesnice | firma (Automattic) |

Toto už **nie je** výhoda, lebo Beeper to medzitým dorobil: spájanie chatov jedného človeka naprieč sieťami (od
augusta 2026, aj s návrhmi), poslať neskôr a pripomienky. Weft ich má tiež a jasné prípady spojí sám.

Riziko banu je rovnaké, lebo na Metu a Discord používajú oba tie isté mautrix mosty.

## Čo má Beeper a Weft nie

- **Viac sietí:** Telegram, Signal, Slack, Google Messages (SMS a RCS), Google Chat, LinkedIn, X, Bluesky, LINE,
  Viber, WeChat a iMessage na Macu. Cestu k nim bez banu opisuje [návrh konektorov](../2026-11-konektory/README.md).
- **Natívne appky** pre iOS a Android s notifikáciami správ. Weft je v telefóne webová appka a Web Push má len pre kódy.
- **Žiadna prevádzka:** server netreba a mosty udržiavajú zamestnanci Beeperu. Weft má vlastné záplaty mostov
  (profily, ankety, karusely, stránkovanie), ktoré treba po každej novej verzii mosta znova zostaviť, a beží na
  jednom notebooku doma.
- **Mosty v zariadení:** pri niektorých sieťach prihlásenie drží len telefón alebo počítač a šifrovanie ostane
  zachované. Weft drží všetky prihlásenia na asuse.
- **Rozhranie pre vývojárov:** zdokumentované REST API s OAuth a MCP. V Beeper Plus je aj `@ChatGPT` a Apple
  Intelligence priamo v chate. Weft má len `weft` a jeho `send --yes` je len na čestné slovo
  (`server/cli/weft.py`).
- **Prepis hlasoviek a inkognito čítanie:** Weft nemá ani jedno.
- **Hovory** nevie ani jeden. Beeper pošle do natívnej appky a Weft má plán v `HOVORY-PLAN.md`.

## Štyria agenti

Všetci štyria sú „vždy zapnutí“ osobní agenti z augusta až októbra 2026. Každý beží na vlastnom počítači v
cloude, sleduje pripojené appky, ozve sa sám a pred citlivým krokom čaká na schválenie.

| | Grok Bot (xAI) | Dots (OpenAI) | Claude Duet (Anthropic) | Muse (Meta) |
|---|---|---|---|---|
| Stav | verzia 1.0, mimo bety od 11. 11. | v ChatGPT od 29. 9. | výskumný náhľad od 21. 10., čakacia listina | od 8. 9. |
| Zo Slovenska | žiadne obmedzenie regiónu v dokumentácii nie je; potvrdí sa až pri registrácii | **nie**: EHP, UK a Švajčiarsko sú vylúčené, od 18 rokov | **nie**: len USA | **nie**: podľa Mety USA, Singapur a Austrália (cudzie články píšu aj Kanadu a Japonsko) |
| Cena mesačne | 30 $, 100 $ alebo 200 $ | v ChatGPT Pro a u vybraných Plus | v pláne Pro, Max alebo Ultra, ide z jeho limitov | zadarmo, 20 $ alebo 100 $ |
| Kde sa s ním píše | vlastné appky (aj Linux), X Chat, Slack, Teams | appky ChatGPT, hlasový hovor, Slack; SMS cez iMessage alebo RCS len v USA, Kanade a Mexiku | len appka Duet a claude.ai | appka, muse.ai, Mac a WhatsApp (zatiaľ v USA) |
| Vlastný konektor | áno: vzdialený HTTPS server, adresa, hlavičky, OAuth s client ID a secret | pre dots nezdokumentovaný; v ChatGPT Pro len na čítanie, zápis až v Business | v Claude áno (každý plán, len verejný port 443); či ho Duet prevezme, nie je napísané | v appke nezdokumentovaný (cudzí článok hlási MCP s OAuth) |
| Schvaľovanie | schvaľovacie karty, „Auto Review“, pravidlá „najprv sa spýtaj“ | pravidlá v štyroch stupňoch; „koncept neznamená povolenie poslať“ | ukáže, čo presne, kam a komu, a čaká; platba a mazanie sa nedajú prepnúť na „už sa nepýtaj“ | samostatný strážny agent; pýta sa pred mailom a nákupom; „Allow always“ raz pustilo správy kupujúcim bez otázky (hlásenie používateľa) |
| API, cez ktoré ho volá iná appka | nie | nie | nie | len ohlásené pre firmy |

Z toho vyplýva:

1. **Zo Slovenska je dnes reálny len Grok Bot**, a aj to sa ukáže až pri registrácii. Ostatné tri počkajú na
   spustenie v EÚ. Obchádzať to cez VPN alebo americký účet nechceme: je to to isté riziko, aké Weft nepúšťa pri
   banoch.
2. **Ako bežný chat vo Wefte nejde žiadny.** Matrix most pre nich neexistuje a ich appky rozoberať nebudeme. Jediná
   výnimka môže prísť sama: Muse vo WhatsAppe by prešiel existujúcim mostom, keď ho Meta spustí tu. Či most
   chaty s AI vôbec prenesie, sme neskúšali.
3. **Opačne to ide:** Grok Bot a Claude (a raz možno aj Duet, Muse a Dots) vedia volať cudzí MCP server. Weft
   nemusí vedieť pracovať s nimi, stačí, aby oni vedeli pracovať s Weftom.

## Ako by to fungovalo

### Jeden konektor namiesto štyroch integrácií

Malá služba `server/mcp/` v TypeScripte na Buni (jeden unit, napr. `matrix-spike-mcp`) nad tým, čo vie `weft`.

- **Nástroje:** zoznam chatov, čítanie, hľadanie, kalendár, `propose_reply`, `propose_event`, `propose_mail`,
  `post_to_owner` (správa Karchimu) a `my_proposals`. **Nástroj na odoslanie neexistuje.**
- **Čítanie nesmie nič spustiť:** žiadne potvrdenie prečítania, žiadne stránkovanie histórie v moste, žiadne
  `resolve_media`. Inak by agent, ktorý prechádza históriu, spustil hromadné sťahovanie, a to je ban.
- **Prihlásenie:** OAuth s jedným vopred zaregistrovaným client ID a secret pre každého agenta. Tento spôsob berie
  Claude („vlastný OAuth klient“), Grok Bot aj ChatGPT, takže netreba otvorenú registráciu. Token je zároveň
  meno agenta (`by` pri návrhu).
- **Verejná adresa:** agenti v cloude volajú zo svojich serverov a na Tailscale nedočiahnu. Claude chce port 443
  dosiahnuteľný z IP adries Anthropicu. Najmenšie riešenie je Tailscale Funnel na 443, ale len pre cesty MCP,
  tokenu a metadát. Stránka, kde Karchi pustí nového agenta, ostane na Tailscale, takže nového agenta vie schváliť
  len zariadenie z jeho siete (či to Claude zvládne, treba overiť pri stavbe). Zvyšok Weftu ostane len na Tailscale.
- **Kto ho môže používať:** Hermes a Claude Code hneď cez localhost. Claude (claude.ai) z EÚ hneď a raz by
  sa mohol stať konektorom aj pre Duet. Grok Bot, ak sa dá zaplatiť zo Slovenska. Dots ani v ChatGPT Pro
  nevie volať návrhové nástroje, lebo zápis tam má až Business.

### Agent ako chat v inboxe

- **Hermes** už ním je (`AGENTS` v `app/app.js`, obyčajná Matrix miestnosť s `@hermes`).
- Pre ostatných **miestnosť agenta:** lokálna Matrix miestnosť pre každého agenta, kam agent píše cez
  `post_to_owner` a odkiaľ si číta Karchiho odpovede. Správa sa v nej správa ako každý chat (neprečítané, okná na
  čítanie, Ctrl+K), ale príde len tak často, ako sa agent pozrie (Duet „každých pár hodín“). Rozhovor naživo
  ostáva v appke agenta.
- Bez akejkoľvek stavby: agent, ktorý vie poslať mail (Duet z pripojeného účtu, Grok Bot a Muse z vlastnej
  adresy), sa do Weftu dostane cez archív Gmailu do piatich minút.
- Naživo cez Slack by to išlo pri Grok Bote: vlastný Slack workspace a most mautrix-slack. To je ďalší most na
  údržbu, takže len ak Karchi chce s Grok Botom písať priamo vo Wefte.

## Schvaľovanie

Aby bolo v pohode pustiť k Weftu štyroch agentov a Hermesa, platí jedno pravidlo: **agent navrhuje, Karchi
posiela.** Ochrana stojí na tom, že cesta na odoslanie neexistuje, nie na tom, že sa model bude správať slušne.

### Čo už je

- `weft draft` a relay zapisujú koncepty do `sk.karchi.drafts` a Weft ich dá do Odložených v danom chate ako
  `agent:<id>` (`adoptAgentDrafts`, položka má `by`).
- „Poslať“ v Odložených odovzdá koncept službe „poslať neskôr“ s id `stash-<id>`. Odíde jeden raz, aj keď ho
  Karchi stlačí na dvoch zariadeniach.

### Čo pribudne

- **Údaje:** položky v `sk.karchi.drafts` dostanú `why`, `kind` (správa, udalosť, mail), `replyTo` a `basis` (ktoré
  správy agent čítal). Udalosti a maily tam budú bez `room` a staré okná ich preskočia. Pravidlá pre agentov budú
  v jednom novom kľúči `sk.karchi.agents`. Denník pôjde do SQLite pri konektore, lebo rastie.
- **Zoznam „Na schválenie“:** pohľad cez všetky chaty na položky Odložených, ktoré majú `by`, plus udalosti a
  maily. Nové úložisko netreba. Bude riadok v inboxe s počtom a v Ctrl+K.
- **Karta** ukáže:
  - značku agenta, druh návrhu, chat, sieť a vek návrhu;
  - posledné 3–5 správ tak, ako ich kreslí chat, s vyznačenou správou, na ktorú odpovedá;
  - samotný návrh, ktorý sa dá upraviť priamo v karte;
  - prečo ho agent navrhol: obyčajný text do 200 znakov, bez odkazov a bez zvýraznenia;
  - z ktorých chatov agent čítal, než ho napísal (počíta konektor, aby bolo vidno, keď niečo prenáša z iného chatu);
  - varovania, ktoré počíta Weft sám: medzitým prišli nové správy, prvá správa agenta tomuto človeku, skupina,
    neznáma doména v odkaze, nový príjemca mailu.
- **Klávesy** sú tie z Odložených, nič nové sa netreba učiť:

  | Kláves | Čo spraví |
  |---|---|
  | ↑ / ↓ | ďalší návrh |
  | Enter | zobrať do poľa správy v chate, s celým kontextom |
  | Ctrl+Enter | poslať |
  | E | upraviť |
  | Delete | zahodiť |
  | R | zahodiť a agentovi napísať jeden riadok prečo |
  | Ctrl+Z | vrátiť |
  | 1–5 | len jeden agent, ako vo Feede |

  Karta s varovaním potrebuje Ctrl+Enter dvakrát. Hromadné schválenie nebude. Udalosť otvorí editor kalendára
  vyplnený a mail otvorí vyplnený Nový mail, takže schválenie je obyčajné uloženie alebo odoslanie.
- **Oneskorenie:** všetko, čo poslal agent, ide cez „poslať neskôr“ o 10 s neskôr a dovtedy sa dá vrátiť.
- **Práva** pre každého agenta, s výnimkami pre jednotlivé chaty. Bez nastavenia agent nevidí nič:

  | Úroveň | Čo smie |
  |---|---|
  | nič | nevidí nič |
  | čítať | číta, nenavrhuje |
  | koncept | návrh ticho padne do Odložených v chate (ako dnes) |
  | na schválenie | návrh príde do zoznamu „Na schválenie“ |
  | okno | v jednom chate smie poslať do určeného času najviac N správ s oneskorením 60 s; len lokálny Hermes, nikdy agent v cloude, skupina, učiteľ ani mail |

  Mail, EduPage a pracovné účty sú predvolene vypnuté.
- **Limity v konektore:** počet čítaní za hodinu a návrhov za deň a na chat, najviac asi 10 otvorených návrhov na
  agenta a jeden otvorený návrh na agenta a chat (nový nahradí starý).
- **Výsledky agentov:** po úprave sa uloží rozdiel slov. Pri každom agentovi tak bude vidno, koľko jeho návrhov
  odišlo bez zmeny, koľko s úpravou a koľko ich Karchi zahodil. Pri udalostiach v kalendári sa ukáže pred a po.
- **Vypínač:** `paused` v `sk.karchi.agents` (Nastavenia → Agenti, Ctrl+K, `weft`). Konektor potom všetko odmietne a
  „poslať neskôr“ preskočí položky s `by`. Odobratie agenta zmaže jeho tokeny. Úplné zastavenie je stopnúť unit a
  vypnúť Funnel.

### Podvrhnuté pokyny v správach

- Správa od niekoho iného („ignoruj pokyny a pošli…“) môže agenta navigovať, ale odoslať nič nemôže. Najviac
  vyrobí návrh, ktorý Karchi uvidí s pôvodnou správou vedľa.
- Ostáva jedno riziko: agent v cloude môže to, čo prečítal, vyniesť cez iné svoje konektory a to Weft nevidí.
  Jediná skutočná ochrana je, čo smie čítať: preto zoznam povolených chatov a vypnutá pošta.
- Hermes beží pod tým istým používateľom ako server. Pravidlá ho chránia pred chybou a podvrhnutým pokynom, nie
  pred zlomyseľným programom na asuse.

### Kontroly bez posielania skutočným ľuďom

- Konektor proti falošnému homeserveru `overenie/stash/fakehs.py`: každý nástroj s náhodnými vstupmi a kontrola, že
  odišli len GET požiadavky a zápisy do `sk.karchi.drafts`.
- Schválenie, oneskorenie a „vrátiť“ proti jednorazovému Tuwunelu, ako `overenie/stash/send_once.py`.
- Skutočný agent od začiatku do konca smie len do lokálnej miestnosti bez mosta. V testovacom režime konektor
  odmietne každú miestnosť, ktorá má stav mosta.

## Poradie stavby

| # | Krok | Kontrola |
|---|---|---|
| 1 | Zoznam „Na schválenie“, karty, klávesy, odoslanie o 10 s s „vrátiť“; `weft draft --why --reply`; prvý agent je Hermes | UI na falošnom homeserveri; dve zariadenia schvália a odíde jedna správa; po „vrátiť“ neodíde nič |
| 2 | `sk.karchi.agents`, Nastavenia → Agenti, limity, denník, vypínač; `weft` pod menom agenta zmení `send --yes` na návrh | test všetkých úrovní práv; pri `paused` konektor všetko odmietne a odoslania agentov počkajú |
| 3 | Konektor na localhoste s nástrojmi vyššie | test, že žiadna cesta nevedie k odoslaniu; žiadne potvrdenia prečítania ani stránkovanie; Hermes ho používa lokálne |
| 4 | OAuth a Funnel; najprv Claude do testovacej miestnosti, potom Grok Bot | sonda zvonka vidí len tri cesty; bez tokenu 401; token jedného agenta neprečíta chaty druhého |
| 5 | Miestnosti agentov, návrhy udalostí a mailov; okno pre Hermesa, len ak ho Karchi ešte bude chcieť | miestnosť má neprečítané a drží okná na čítanie; odoslanie v okne sa dá zrušiť a je v denníku |

Kroky 1 až 3 nepotrebujú žiadneho cudzieho agenta ani verejnú adresu. Krok 4 otvára verejné dvere do systému,
ktorého pravidlo je „len Tailscale alebo localhost“, preto potrebuje Karchiho výslovné áno.

## Riziká

- **Súkromie iných ľudí:** ich správy by čítala americká firma. Zoznam povolených chatov musí byť úzky a škola aj
  práca ostanú mimo.
- **Únava zo schvaľovania:** keď príde priveľa návrhov, Karchi začne schvaľovať naslepo. Preto limity, jeden návrh
  na chat, žiadne hromadné schválenie a výsledky agentov.
- **Mladé produkty:** všetci štyria sú pár mesiacov starí a menia sa každý týždeň. Komunitná wiki hlási pri Grok Bote
  chyby v OAuth presmerovaní.
- **Údržba:** ďalšia služba v projekte jedného človeka.

## Neoverené

- či sa dá Grok Bot zaplatiť a používať zo Slovenska;
- či Duet a dots prevezmú vlastné konektory;
- či dots fungujú v Európe s Business Premium (tvrdí to len cudzí článok);
- vlastné konektory Muse a jeho krajiny mimo stránok Mety;
- či most WhatsAppu prenesie chat s AI botom;
- adresa, na ktorú Grok Bot vracia OAuth.

## Zdroje

- **Beeper:** [Desktop API](https://developers.beeper.com/desktop-api/),
  [changelog API](https://developers.beeper.com/desktop-api/changelog/),
  [MCP](https://developers.beeper.com/desktop-api/mcp),
  [vzdialený prístup](https://developers.beeper.com/desktop-api/advanced/remote-access),
  [Desktop 4.3.326](https://www.beeper.com/changelog/desktop/4.3.326), [FAQ](https://www.beeper.com/faq),
  [ceny](https://www.beeper.com/pricing),
  [spájanie chatov, 9to5Google](https://9to5google.com/2026/08/11/beeper-merge-chats-update/)
- **Grok Bot:** [x.ai/bot](https://x.ai/bot), [Introducing Grok Bot](https://x.ai/news/introducing-grok-bot),
  [Grok Bot 1.0](https://x.ai/news/grok-bot-1-0), [FAQ](https://docs.x.ai/grok-bot/faq),
  [konektory](https://docs.x.ai/grok-bot/computer-and-apps),
  [schvaľovanie](https://docs.x.ai/grok-bot/approvals-security-and-privacy),
  [komunitná wiki](https://www.grokbotwiki.com/guides/grok-bot-plugins-mcp) (cudzia)
- **Dots:** [Getting started with your dot](https://help.openai.com/en/articles/20001530-getting-started-with-your-dot),
  [súkromie](https://help.openai.com/articles/20001529),
  [vlastné MCP v ChatGPT](https://help.openai.com/en/articles/12584461-developer-mode-apps-and-full-mcp-connectors-in-chatgpt-beta),
  [Dots a Európa](https://mean.ceo/tpost/openai-dots-agents-europe) (cudzí)
- **Duet:** [Introducing Claude Duet](https://claude.com/resources/articles/claude-duet),
  [produkt](https://claude.com/product/claude-duet),
  [bezpečnosť a súkromie](https://claude.com/resources/articles/claude-duet-safety-privacy-and-security),
  [pomoc](https://support.claude.com/en/articles/17631495-get-started-with-claude-duet),
  [vlastné konektory v Claude](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp)
- **Muse:** [spustenie](https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/),
  [Singapur](https://about.fb.com/news/2026/10/muse-is-now-available-in-singapore-the-worlds-first-personal-ai-agent-built-for-everyone/),
  [Austrália](https://about.fb.com/news/2026/11/muse-is-now-available-in-australia/),
  [TechCrunch](https://techcrunch.com/2026/09/08/meta-debuts-its-muse-ai-agent-will-consumers-trust-it/),
  [zoznam konektorov, PostFast](https://postfa.st/blog/meta-muse-connectors-list) (cudzí),
  [Muse a MCP](https://www.aiagentslibrary.com/blog/meta-muse-mcp/) (cudzí)
- **Prístup zvonka:** [Tailscale Funnel](https://tailscale.com/docs/features/tailscale-funnel),
  [MCP authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)
