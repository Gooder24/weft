# Discord vo Wefte: návrh (Fable, 18. 11. 2026)

Návrh, podľa ktorého sú postavené fázy 0 a 1. Zadanie: „Čerstvo si pripojím Discord k Weftu a rok ho
striedam s originálnou appkou.“ Cieľ: aby dôvodov otvoriť appku Discord ostalo čo najmenej a aby žiadny krok
neohrozil účet. Návrh prešiel štyrmi kolami rady (sekcia 9).

**Rozhodnutie (Karchi, 20. 11. 2026): stavajú sa fázy 0 a 1. Fáza 2 (zápisy na Discord: nový chat, správa
ne-priateľovi, žiadosť o priateľstvo, správa po jej prijatí) sa zatiaľ nestavia.** Jej návrh v tomto súbore
ostáva pre neskôr a je označený ako odložený; staviteľ z neho nestavia nič.

**Zmena 25. 11. 2026:** fázy 0 a 1 bežia od 19. 11. Dve veci sa z klienta a archívu presunuli do mosta, lebo
rozhádzané po Wefte stále niekde unikali: poistka odpovedí na správy z vlákien (bod 1, krok 4) a otvorenie
starého chatu (bod 1, krok 2), ktoré už neposiela príkaz do miestnosti bota.

## 1. Zhrnutie pre Karchiho

- **„Dá sa písať len priateľom“ nie je celá pravda.** Discord má 101 tvojich DM kanálov a 13 skupín. Weft
  z nich má 6 DM a 2 skupiny. Chýba teda aj 53 chatov s priateľmi, nielen tých 31 s ne-priateľmi. Príčiny sú
  tri a všetky sú v našom moste, nie v Discorde: most pri štarte otvorí len 5 najnovších chatov, nevie začať
  nový a správu ne-priateľovi sám odmietne.
- **Najväčšia časť sa dá opraviť malým zásahom do mosta.** Most vie otvoriť jeden existujúci DM (dnes len
  príkazom). Patch mu dá na to adresu a Weft ju zavolá, keď starý chat otvoríš. Vráti sa tak 95 chatov, po
  jednom a len na kliknutie; priateľom v nich hneď napíšeš.
- **Zvyšok chce malý patch mosta.** Fáza 1 len číta: zoznam priateľov, stav priateľstva, hľadanie členov
  servera pri „@“. Stavia sa.
- **Fáza 2 sa zatiaľ nestavia (tvoje rozhodnutie z 20. 11.).** Zapisovala by na Discord: nový chat, správa
  ne-priateľovi, žiadosť o priateľstvo a správa, ktorá odíde po jej prijatí. Na toto všetko ostáva appka
  Discord a Weft na ňu dá odkaz. Rada sa na fáze 2 nezhodla (Sol by ju nechal v appke úplne, Opus by ju
  staval s presným tvarom požiadavky ako z appky) a pre žiadnu z jej akcií neexistuje doložený bezpečný
  počet.
- **Kanály s jednou funkciou:** miestnosťou sú dnes len textové a oznamové kanály. Oznamy dostanú vlastnú
  značku (do Nízkej priority si ich dáš sám, ako každý iný chat). Hlasové kanály a fóra most neprenáša vôbec
  a z jeho dát sa nedá ani zistiť, ku ktorému serveru patria; prídu až s novým mostom. Vlákna: z 4888
  premostených správ nie je vo vlákne ani jedna, takže ich nestaviam; pridávam len poistku v moste, aby
  odpoveď na správu z vlákna neskončila v celom kanáli.
- **Nový most.** Upstream práve píše prepis (`megadiscord`), ktorý vie polovicu z tohto. Nie je vydaný a mení
  sa desaťkrát denne, preto naň teraz neprechádzam; patch píšem tak, aby prechod neskôr nebolel.
- **Riziko.** Discord účty ovládané mimo appky zakazuje (článok „Automated User Accounts (Self-Bots)“); to
  platí pre most od 3. 11. Fázy 0 a 1 pridávajú len čítanie (a to, čo most robí pri každom chate už dnes:
  prečítanie novo otvoreného chatu vo Wefte ho označí za prečítaný aj na Discorde). Odložená fáza 2 by
  pridala akcie, ktoré Discord sleduje najviac.

## 2. Čo som zistil (všetko len čítaním)

| # | Zistenie | Dôkaz |
|---|---|---|
| Z1 | Discord 18. 11.: 101 DM kanálov (59 priatelia, 31 bez priateľstva, 8 boti, 3 zmazané účty), 13 skupín, 71 priateľov, 2 odoslané žiadosti, 4 blokovaní; 12 priateľov bez DM kanála. Posledná správa v DM s ne-priateľom: 14× v 2026, 12× v 2025. Žiadny DM nie je žiadosť o správu ani spam. Je to jedno meranie, nie stála hodnota. | dve GET požiadavky (`/users/@me/relationships`, `/users/@me/channels`), vypísané len počty |
| Z2 | Weft má miestnosť pre 6 DM a 2 skupiny. Že tých 6 sú priatelia, je z merania Z1, nie z DB. | `bridge.db`: `portal` typ 1: 101 riadkov, 6 s `mxid`; typ 3: 13, 2 s `mxid` |
| Z3 | Most pri READY otvorí 5 najnovších zo spoločného zoznamu DM a skupín. Ostatné až keď v nich príde nová správa alebo keď Discord pošle udalosť o vzniku či zmene toho kanála. | config `startup_private_channel_create_limit: 5`; `user.go:810-819`, `portal.go:572-576`, `user.go:936-947`, `:1159-1174`, `:1210-1214` |
| Z4 | Z Weftu sa nový DM začať nedá. | `portal.go:1827` (`HandleMatrixInvite` je prázdna), `provisioning.go:64-73` (žiadne `create_dm`) |
| Z5 | Správu ne-priateľovi (okrem botov) odmieta most sám. Keby ju pustil, Discord ju stále môže odmietnuť (50007). | config `forbid_dming_strangers: true`; `portal.go:1551-1567`; v logu 1× (4. 11.) |
| Z6 | Otvoriť existujúci DM kanál vie most už dnes príkazom. Odpovedá obyčajnou hláškou bez väzby na príkaz či ID kanála; pri už premostenom kanáli Karchiho znova nepozve. Správcovskú miestnosť má most zapísanú. | `commands.go:790-826` `!discord create-portal <ID kanála>`; `bridge.db` `user.management_room` |
| Z7 | @: Weft ponúka len členov Matrix miestnosti. Most prevedie na `<@id>` každého ducha, ktorý je odkazom vo formátovanom texte a v `m.mentions`; členstvo nepotrebuje. | `app.js` `mentionHits`/`mentionsIn`; `formatter.go:143-152` |
| Z8 | Gateway op 8 vráti členov servera podľa predpony mena (najviac 100); na predponu netreba práva. Či to rovnako robí appka pri „@“, či hľadá aj prezývky a či to prejde na reláciu mosta, je **neoverené**. | docs.discord.food a oficiálna dokumentácia (Gateway Events); discordgo `wsapi.go` `RequestGuildMembers` |
| Z9 | Most premosťuje len textové (0) a oznamové (5) kanály. Hlasové (9), stage (1) a fóra (19) má v DB len ako riadky bez servera (`dc_guild_id` prázdne, aj kategórie), takže sa nedajú priradiť serveru. | `discord.go:9-19`; `bridge.db` |
| Z10 | Premostené: 94 textových, 5 oznamových. Weft `m.thread` nepozná, ale zatiaľ to nevadí: 18. 11. nebola z 4888 premostených správ vo vlákne žiadna. Dva rôzne prípady, obidva končia v rodičovskom kanáli: (a) odpoveď na správu z vlákna od klienta, ktorý `m.thread` neposiela, ide do rodičovského kanála a stratí odkaz na pôvodnú správu, lebo tá patrí inému vláknu; (b) keď sa vlákno nepodarí založiť, most len zapíše varovanie a správu pošle do rodičovského kanála. | `bridge.db` (`message.dc_thread_id`); (a) `portal.go:1632-1650`, (b) `portal.go:1597-1619` |
| Z11 | Knižnica vo verzii, ktorú 0.7.7 pripína (8051e14), má všetko potrebné: `RequestWithBucketID`, `WithContextProperties`, `WithReferer`, `WithRetryOnRatelimit`, `WithRestRetries`, `UserChannelCreate`, `RequestGuildMembers`, `GuildMembersChunk`, `RequiredAction`, `IsMessageRequest`. Jej hotová funkcia na žiadosť posiela `{"type":4}` bez hlavičiek appky a predvolene opakuje 429 a niektoré 5xx. | beeper/discordgo na commite 8051e14 |
| Z12 | Upstream: starý most je zmrazený (3 commity od augusta). Prepis `megadiscord` má ~40 commitov za dva týždne. Vie: priatelia ako kontakty, hľadanie medzi známymi, nový DM, miestnosti pre DM pri synchronizácii (#371), jemnejšie pravidlo pre cudzích, migráciu zo schémy 24 (naša). Vo vetvách: fóra a hlasový chat, ankety, prijatie žiadosti. Nevie: poslať žiadosť, hľadať členov. Nevydaný, ROADMAP neodškrtnutý. | `git ls-remote`, `git log origin/megadiscord`, `pkg/connector/startchat.go` |
| Z13 | Oficiálna cesta (Social SDK, `sdk.social_layer`) vie žiadosti aj DM, ale je pre hry, má obmedzený prístup a limit na appku, servery nečíta. | docs.discord.com |
| Z14 | `sendlater.py`: položka bez `at` prejde filtrom splatných a worker na nej spadne pri triedení (KeyError), skôr než čokoľvek pošle; splatnú položku (`at` v minulosti, ešte neodoslanú ani nezlyhanú) pošle bez ďalšej podmienky a „odoslané“ zapíše, keď správu prijme homeserver, nie Discord. `/_archive/chats/link` overuje len to, že Karchi je v cieľovej miestnosti, nie že je to ten istý Discord kanál; presúva aj pripojené staré chaty a nový import `room` prepíše. | `sendlater.py:74-81`, `:92-94`; `archive.py:538-545`, `archive.py:1067-1090`; `import_history.py:64-67` |
| Z15 | Most spracúva každú udalosť z Discordu vo vlastnej gorutine, takže dve udalosti o tom istom priateľstve môžu prísť v opačnom poradí. Stav priateľstva prepisuje bez toho, aby si pamätal predchádzajúci. Správy posiela s predvoleným opakovaním knižnice. | `user.go:653-655` (`eventHandlerSync`), `user.go:881-896`, `portal.go:1747` |

Pokus zo 17. 11. skončil pri Z3. Z1, Z4, Z5, Z6, Z8, Z12 a Z15 sú nové. Kontrola Z2–Z12, Z14 a Z15 sa dá
zopakovať: `overenie/discord-plan/run.sh` (len čítanie). Skript dokazuje len to, čo sa dá vidieť v kóde,
configu a `bridge.db`. Z1 je jedno meranie; správanie gateway (Z8) a to, čo vie `megadiscord` (Z12), sú
z čítania dokumentácie a zdroja, nie z behu. Aj Z10 je z čítania `portal.go`: skript pri ňom overuje len,
že citované miesta v kóde sú, nie kam správa naozaj odíde; to dokáže až test v Go proti falošnému Discordu.

## 3. Architektúra: čo som zvážil

| Možnosť | Prečo áno / nie |
|---|---|
| A. Len config (limit 5 → 200, `forbid_dming_strangers: false`) | Nie. Pri štarte naraz ~95 miestností a sťahovaní histórie; cudzí povolení bez poistky. |
| B0. Archív pošle mostu existujúci príkaz `create-portal` | Bolo prvé (19. 11.), 25. 11. nahradené adresou mosta (B1): odpoveď bota nemá väzbu na príkaz, archív len čakal, či miestnosť vznikne. |
| **B1. Patch starého mosta, len čítanie a poistky** | **Áno.** Most už má spojenie a priateľov v pamäti. Základ je zmrazený, patch nebude treba prepisovať. Precedens: `server/bridges/instagram-relogin.patch`. |
| B2. Patch starého mosta, zápisy | Odložené (Karchi, 20. 11.): zatiaľ nestavať. |
| C. Prejsť na `megadiscord` teraz | Nie teraz: nevydaný, denne sa mení, žiadosť a hľadanie členov by som patchoval aj tam. |
| D. Vlastná služba s tokenom (Python) | Nie na zápisy: iný odtlačok než most, nevidí gateway. |
| E. Social SDK | Nie (Z13). |

Patch písať podľa upstreamu, nie po svojom: `contacts` a `create_dm` podľa `megadiscord` `startchat.go`. Pre
odoslanie žiadosti upstream vzor nemá (vetva `iFixRobots/discord-friend-requests` vie len prijať cudziu), preto
bod 2 žiada vlastný doložený vzor. Rovnaký tvar odpovede uľahčí neskorší prechod, ale nezaručí ho (iná
autentifikácia, `login_id`).

## 4. Riešenie bodov

### Bod 1: písať každému, komu sa dá v appke

**Čo uvidí Karchi.**
- Fáza 0: starý Discord chat (z archívu alebo zo zoznamu DM mosta) má namiesto „pošli mu jednu v appke“
  tlačidlo „Otvoriť chat“. Po kliknutí sa objaví živá miestnosť s poslednými 50 správami a dá sa písať.
  Ne-priateľovi správa neodíde a Weft to povie po slovensky s odkazom „Otvoriť v Discorde“.
- Fáza 1: Ctrl+N ponúka aj priateľov, s ktorými ešte chat vo Wefte nemá; pri mene je „Priateľ“, „Žiadosť
  odoslaná“, „Nie ste priatelia“ alebo „Zablokovaný“. Kto má na Discorde DM kanál, otvorí sa ako vo fáze 0;
  12 priateľov bez kanála má len odkaz „Otvoriť v Discorde“.
- Fáza 2 (odložená, nestavia sa): nový chat s priateľom bez DM; pri ne-priateľovi otázka „Poslať aj tak?“,
  raz na človeka, v Nastaveniach sa dá vziať späť.

**Ako.**
1. F0, zoznam: `archive.py` (už číta `discord/bridge.db` len na čítanie) pridá `GET /_archive/discord/dms`:
   Karchiho DM (`portal` typu 1 s `receiver` = jeho Discord ID) a skupiny (typ 3 s riadkom v `user_portal`
   pre jeho Matrix účet; skupiny majú `receiver` prázdny) s ID kanála, druhou stranou, menom (z
   `portal.name`, inak z archívu, inak z `puppet`) a miestnosťou, ak je. Prepojiť sa dá len kanál z tohto
   zoznamu a otvoriť len kanál, ktorý rovnakým pravidlom uzná most (krok 2). Skupinu otvorí, len kým má most jediného prihláseného používateľa (dnes áno): pri
   vzniku miestnosti most pozýva každého účastníka, ktorý je sám prihlásený v moste (`portal.go:1046-1056`).
   Počet účtov sa kontroluje tesne pred vznikom miestnosti; prihlásenie v tej chvíli sa nezamyká, lebo účet
   prihlásený neskôr most do miestností jeho skupín pozve sám pri READY (`handlePrivateChannel` → `UpdateInfo`,
   test `TestWeftLaterAccountIsInvitedByUpstream`), zámok by ho len o chvíľu zdržal.
2. F1, otvorenie robí most, nie klient ani archív, a vždy podľa kanála: `POST /v1/channels/<id>/open`
   v provisioningu (Weft cez `/_bridges/discord/_matrix/provision/v1`, Karchiho token ako pri `contacts`).
   Rovnako sa otvára chat z Ctrl+N, keď človek kanál už má. Je to kód príkazu `create-portal` bez príkazu
   v miestnosti bota (19.–25. 11. ho posielal archív a čakal, či miestnosť vznikne; odpoveď bota nemá väzbu na
   príkaz, Z6).
   - Len Karchiho kanál: DM s `receiver` = jeho Discord ID, skupina s riadkom v `user_portal` a len kým je
     v moste jediný prihlásený používateľ (inak 409; kontrola pred GET kanála a znova tesne pred vznikom
     miestnosti, súbežné prihlásenie sa nezamyká, pozri krok 1). Cudzí alebo neznámy kanál → 404; most bez READY → 503.
   - Miestnosť je a Karchi je v nej → `joined`, nula požiadaviek na Discord. Je, ale Karchi v nej nie je → most
     ho znova pozve (double puppet ho pridá sám) a vráti `invited`; Weft pozvánku prijme. Nie je → jedna GET
     kanála na Discord a vznik miestnosti s poslednými správami ako pri novej správe; Discord kanál odmietne
     → 502 a miestnosť nevznikne.
   - Odpoveď `{state: joined|invited|not_joined, room_id}`; pri `not_joined` Weft ponúkne „Otvoriť
     v Discorde“. Jedno otvorenie naraz: zámok v moste, takže dvojklik ani dve zariadenia nespravia dve.
   - Miestnosť bota nie je vo Wefte chat (`isChat`, `app.js:741`).
3. F0, prepojenie histórie: `/_archive/chats/link` pre Discord prijme miestnosť, len keď sedí účet aj kanál:
   archívny chat má oboje v `history_data`, miestnosť musí patriť kanálu zo zoznamu z kroku 1. To isté
   platí pre každý starý chat, ktorý sa presúva spolu s ním (`link_chat` ich berie hromadne); jeden
   nesediaci → 409 a nepresunie sa nič. Odpojenie (`archive.py unlink`) dostane tlačidlo v menu chatu a
   zapíše sa ako príznak pri chate aj pri chatoch presunutých s ním: samotné `archive:…` nerozlíši ručne
   odpojený chat od nikdy neprepojeného. `import_history.py` pri riadku, ktorý už existuje, `room` nemení:
   dnes ho pri každom importe prepíše (Z14) a zruší tým ručné prepojenie, zlúčenie (`join_chat`) aj odpojenie.
4. F1, poistka pre vlákna je v moste, v `handleMatrixMessage`, kadiaľ ide každá Matrix správa na Discord
   (písanie, poslanie znova, naplánované, GIF, hlasovka, `weft send --reply`, fronta odchádzajúcich). Správa,
   ktorá odpovedá na udalosť, a most cieľ nepozná, alebo je cieľ v inom vlákne než správa (Weft `m.thread`
   neposiela, takže odpoveď na správu z vlákna by odišla do celého kanála, Z10), alebo sa vlákno nepodarilo
   založiť, **neodíde vôbec**, ani ako obyčajný text do kanála. Weft dostane existujúcu hlášku „not bridged“
   (`message_error_notices`) a povie dôvod po slovensky (`failReason`). Poistky vo Wefte ostávajú ako pohodlie
   (tlačidlo odpovede a Ctrl+R správu z vlákna za cieľ nenastavia, ukáže sa „vo vlákne“ a „Otvoriť
   v Discorde“), ale nič nechránia samy.
5. F1: `GET /v1/account` a `GET /v1/contacts`: priatelia a druhé strany DM, každý so stavom priateľstva, z
   pamäte mosta, nula požiadaviek na Discord. Kým most po štarte nemá READY, odpovie 503; nikto to nesmie
   čítať ako „nie je priateľ“. DM označené ako spam sa nevracajú (ako upstream #322). Žiadosť o správu má
   príznak a Weft v nej písať nedá (odpoveď je v appke vedomé prijatie); dnes taká nie je (Z1). `account`
   hovorí aj `member_search` (bod 3); pole `writes` nemá, lebo zápisy (fáza 2) sa nestavajú.
6. F2 (odložené): `POST /v1/create_dm/<user id>` len pre človeka **bez** DM kanála: `UserChannelCreate` s
   `X-Context-Properties` a `Referer` ako appka. Podľa dokumentácie druhá strana prázdny DM kanál neuvidí,
   kým v ňom nie je správa; overené to nie je. Keď kanál už existuje, vráti ho bez požiadavky na Discord.
7. F2 (odložené), cudzí: stráž mosta ostáva. Patch ju pustí, len keď sú zápisy zapnuté **a** človek je v zozname
   povolených: `PUT /v1/strangers/<id>` po Karchiho „Poslať aj tak?“, `DELETE` to vezme späť, zoznam je
   v súbore vedľa `bridge.db`. Kontrola je pred každým volaním, ktoré na Discord zapisuje: úprava
   (`portal.go:1582`), príprava prílohy (`:1685`) a odoslanie (`:1747`), nielen na začiatku (`:1551`), takže
   vypnutie zápisov počas nahrávania súboru zastaví aj finálnu správu. Všetky tri idú povolenému cudziemu
   bez opakovania (`WithRestRetries(0)`, `WithRetryOnRatelimit(false)`). Blokovaný človek sa povoliť nedá.
   `weft` (CLI) príkaz na povolenie nedostane. To chráni pred omylom, nie pred agentom, ktorý by adresu
   zavolal úmyselne: má Karchiho token.
8. Limit 5 pri štarte sa nemení. Riadok v inboxe zo 17. 11. („viac než 5 starých DM?“) tým stráca zmysel.

**Pokus (nič nepošle).**
- Go, otvorenie: pred READY 503; kanál s miestnosťou, v ktorej Karchi je → `joined` bez požiadavky na
  Discord; miestnosť, z ktorej odišiel → `invited` bez požiadavky na Discord; cudzí DM, skupina bez
  `user_portal`, skupina pri dvoch prihlásených účtoch, kanál servera a zlé ID → 404, 409, 404, 400;
  kanál bez miestnosti → práve jedna GET kanála, a keď ju Discord odmietne, 502 bez miestnosti.
- F0 `link`: miestnosť iného kanála alebo iného účtu → 409; pripojený starý chat iného kanála → 409 a nič sa
  nepresunie; opakovaný import nechá prepojený chat prepojený, zlúčený zlúčený a odpojený odpojený (aj ten,
  čo bol presunutý spolu s iným).
- Go, vlákna, proti falošnému Discordu: odpoveď na neznámu udalosť, na správu z vlákna mimo vlákna, mimo
  vlákna na správu z neho a do vlákna, ktoré Discord odmietol založiť → nula požiadaviek na posielanie a
  hláška s dôvodom; povolená odpoveď → práve jedna `POST /channels/<id>/messages`. Bez riadkov poistky
  v `portal.go` tieto testy padnú.
- Naživo, jeden chat, so zálohou, **bez prehliadača a bez Weftu**: `curl` na `POST …/v1/channels/<id>/open`
  s testovacím tokenom (`mint-login-token.py`, na konci odhlásiť). Živý Weft sa na to nesmie použiť: pri
  štarte a po obnovení spojenia odošle správy, ktoré mu ostali vo fronte (`app.js:321-333`, `:411-447`), a
  prečítanie chatu ho označí za prečítaný aj na Discorde. Starý DM s priateľom → miestnosť a Karchiho
  členstvo; v logu mosta jedna GET na `/channels/<id>` a jedna na `/channels/<id>/messages`, žiadna POST.
- F1: `contacts` vracia každého práve raz a každý `dm_room_mxid` sedí s `portal` (kanál, druhá strana,
  miestnosť); počas volania nula požiadaviek na Discord. Počty zo Z1 netestovať natvrdo.
- F2 (odložené), Go proti falošnému Discordu: nepovolený cudzí → odmietnuté pri správe aj pri úprave; po `PUT
  strangers` prejde; po `DELETE` nie; povolený cudzí pri vypnutých zápisoch → odmietnuté; zápisy vypnuté medzi
  prípravou prílohy a správou → správa neodíde; 429 na správu, úpravu aj prípravu prílohy povolenému cudziemu
  → žiadna druhá požiadavka; blokovaný sa povoliť nedá; `create_dm` bez kanála pošle jednu požiadavku a test
  porovná jej telo aj hlavičky so vzorom, s kanálom žiadnu; šiesty nový DM s cudzím za deň → odmietnuté bez
  požiadavky.

**Riziko.** F0 a F1: nízke, pribudne len čítanie, ktoré most robí aj dnes pri každej novej správe. F2: nový
DM s cudzím a prvá správa cudziemu sú hlavný signál spamu, keď sa dejú hromadne. Strop 5 nových DM s cudzími
za 24 h je odhad, nie doložená bezpečná hodnota. Captcha most nerieši, Weft pošle do appky.

### Bod 2: žiadosť o priateľstvo a správa po prijatí (celé vo fáze 2, odložené)

Nestavia sa (Karchi, 20. 11.). Vo fázach 0 a 1 Weft pri ne-priateľovi ukáže stav priateľstva a odkaz
„Otvoriť v Discorde“; žiadosť aj správu po jej prijatí posiela Karchi v appke. Zvyšok tohto bodu je návrh
pre prípad, že sa k tomu vráti.

**Čo uvidí Karchi.** Pri ne-priateľovi „Požiadať o priateľstvo“; potom „Žiadosť odoslaná“ (zrušiť ju ide len
v appke, Weft dá odkaz). Enter v takom chate ponúkne „Poslať, keď prijme žiadosť“. Čakajúca správa je v chate
označená „čaká na prijatie“, dá sa zrušiť alebo upraviť. Keď most prijatie uvidí naživo, správa odíde. Keď si
most nie je istý (bol vtedy vypnutý, spojenie malo medzeru), neodíde sama: Weft povie „Prijal žiadosť“ a správa
čaká v poli na Enter.

**Ako.**
1. Odoslanie žiadosti: `PUT /v1/relationships/<id>` v patchi pošle jednu požiadavku cez `RequestWithBucketID`
   s vypnutým opakovaním. Jej telo, `X-Context-Properties` a `Referer` musí staviteľ doložiť z dokumentácie
   docs.discord.food pre *odoslanie* žiadosti a zapísať do testu aj s odkazom na zdroj. Hotová funkcia
   knižnice nestačí (Z11) a vzor z upstream vetvy je pre *prijatie*, nie odoslanie. Bez doloženého vzoru sa
   táto adresa nepostaví a bod 2 končí pri odkaze „Požiadať v Discorde“.
2. Zrušenie žiadosti v patchi nie je (`RelationshipDelete` maže vzťah všeobecne; keby druhá strana práve
   prijala, zmazalo by čerstvé priateľstvo). Weft ponúkne odkaz do appky.
3. Chyby (80000 neprijíma žiadosti, 80007 už ste priatelia, captcha, required action) vracia most ako kód,
   Weft ich povie po slovensky; pri captcha ponúkne profil v appke. Nič sa neopakuje.
4. Cyklus žiadosti je jeden stavový stroj v moste pod jedným zámkom. Záznam `{request_id, user, state,
   writes_epoch}` vznikne v súbore mosta v stave `requesting` **pred** PUT (prijatie môže z gateway prísť
   skôr, než sa PUT vráti) a `request_id` sa vráti volajúcemu. Do toho istého stroja idú v poradí z gateway
   výsledok PUT, zoznam vzťahov z READY (`reconstructRelationships`, `user.go:800`), RESUMED, odpojenie a
   udalosti o priateľstvách (RELATIONSHIP_ADD, UPDATE, REMOVE): priamo v `eventHandlerSync`, nie v gorutine
   (Z15). Inak môže starší zoznam z READY prepísať prijatie, ktoré prišlo hneď po ňom. Synchrónne ide len
   zápis do mapy vzťahov a do záznamu (predchádzajúci typ sa prečíta pred prepisom, `user.go:885`, `:893`);
   `handleRelationshipChange`, ktorá píše do Matrixu, a zvyšok READY ostávajú v gorutine, aby pomalý
   homeserver nezdržal spojenie s Discordom.
   - PUT zlyhal → záznam sa zruší; PUT uspel → `sent` (alebo rovno `accepted`, ak „priateľ“ prišiel skôr);
   - „priateľ“ pri tom istom človeku, kým je `requesting` alebo `sent` a od založenia záznamu neprišlo nové
     READY → `accepted`;
   - REMOVE, kým je `sent` alebo `accepted` → `gone`;
   - nové READY, kým je `requesting`, `sent` alebo `accepted` → záznam je navždy `unwatched`: most nevie, čo
     sa stalo medzitým, a „stále odoslaná“ môže byť už iná žiadosť, poslaná z appky. Z `unwatched` vedie len
     „priateľ“ → `accepted_unseen` a „bez vzťahu“ → `gone`. RESUMED medzera nie je: zmeškané udalosti doručí
     v poradí.
   `GET /v1/requests/<request_id>` vráti `{state, user}`; odpovedá aj pri vypnutých zápisoch. Žiadne
   porovnávanie hodín.
5. Čakajúca správa: jedna na žiadosť, v **vlastnom kľúči** account data `sk.karchi.discord.pending`
   (`{items: [{id, user, request_id, content, created}]}`), nie v `sk.karchi.sendlater` (Z14: dnešný worker
   by na položke bez `at` spadol a zastavil aj ostatné naplánované správy, s `at` by ju poslal bez ohľadu
   na prijatie). Starý `sendlater.py` kľúč nepozná, takže žiadne poradie nasadenia ani návrat nič
   neodošle. `sendlater.py` dostane oddelenú slučku: len kým je v kľúči položka, raz za minútu sa cez Caddy
   (`/_bridges/discord/_matrix/provision/v1/requests/<request_id>`, svojím Matrix tokenom ako Weft) pýta
   mosta.
   - O tom, či správa smie odísť a či už odišla, **rozhoduje most pri samotnom odoslaní**, nie worker ani
     account data (kľúč prepisuje celý worker aj každé zariadenie s Weftom a podmienený zápis neexistuje).
     Worker pri `accepted` pošle do miestnosti (z `create_dm`) Matrix správu s poľom
     `sk.karchi.discord.request: <request_id>`. Most takú udalosť pošle na Discord, len keď v tej chvíli
     platí všetko: záznam je `accepted` a ešte nepoužitý, príjemca portálu je `user` záznamu, zápisy sú
     zapnuté, `writes_epoch` záznamu je aktuálny (most ho zvýši pri každom zapnutí zápisov) a človek je
     stále priateľ. Potom záznam označí `delivered` s ID udalosti, pri chybe Discordu `failed` s kódom;
     inak správu nepošle a záznam ostáva. Jeden záznam pustí jednu udalosť: druhá s tým istým `request_id`
     (reštart workera, nové zariadenie po výmene tokenu, stará kópia kľúča) na Discord nejde. Správy bez
     poľa idú ako dnes.
   - Worker číta výsledok z `requests/<id>`: `delivered` → „odoslané“; `failed` → „neodoslané“ s dôvodom;
     udalosť poslal a záznam ostal `accepted` → „most ju nepustil, pošli sám“. Hlášku „not bridged“ nečíta
     (nenesie ID správy) a nič neopakuje. Potvrdzovanie cez archív netreba.
   - Do kľúča worker aj Weft zapisujú len zmenu jednej položky podľa `id` v čerstvo načítanom zozname,
     nikdy svoju staršiu kópiu. Zvyškový súbeh: zápis z dvoch miest v tom istom okamihu môže jeden z nich
     stratiť (koncept, úpravu alebo zrušenie). Najhorší koniec je správa, ktorú Karchi práve zrušil alebo
     upravil a odišla v znení spred sekundy; druhýkrát odísť nemôže. Weft preto po výsledku ukáže znenie,
     ktoré odišlo.
   - `accepted_unseen` → „prijal, pošli sám“: text čaká v poli na Enter. Sem padne aj žiadosť spred vypnutia
     zápisov (`requests` pri vypnutých zápisoch alebo starom `writes_epoch` vracia `accepted_unseen`); po
     opätovnom zapnutí sa sama nerozbehne.
   - `gone` → „žiadosť nebola prijatá“, natrvalo; nová žiadosť má nové `request_id` a starú položku neoživí.
   - 404 (starý most), 503 (most ešte nemá READY), nepripojený most → čaká. Nikdy z toho nevznikne
     „neprijatá“.
   - po 30 dňoch od `created` → „vypršalo“. Vo všetkých koncoch text ostáva Karchimu ako koncept.
6. Stropy v moste: 5 žiadostí za 24 h, 30 s odstup. `weft` (CLI) príkaz na žiadosť nedostane.

**Pokus (nič nepošle).**
- Go proti falošnému Discordu: `PUT` pošle práve jednu požiadavku a test porovná telo, `X-Context-Properties`
  a `Referer` so zapísaným vzorom; odpoveď 429 alebo 5xx → žiadna druhá požiadavka; `captcha_key` → kód
  `DISCORD_CAPTCHA`; šiesta žiadosť za deň → 429 z mosta bez požiadavky; pri vypnutých zápisoch 403 bez
  požiadavky.
- Go, cyklus: vložené udalosti „odoslaná“ → „priateľ“ → `accepted`; tie isté dve v jednom okamihu (dve
  gorutiny v pôvodnom kóde) → stále `accepted`, nie náhodne; „priateľ“ doručený skôr, než sa PUT vráti →
  `accepted`; READY so starým zoznamom a hneď za ním prijatie → `accepted_unseen` a v mape ostáva „priateľ“;
  RESUMED medzi PUT a prijatím → `accepted`; REMOVE pri `sent` aj pri `accepted` → `gone`, a nové
  priateľstvo ho neoživí; READY, kým je `sent`, potom „stále odoslaná“ a neskôr „priateľ“ →
  `accepted_unseen`, nikdy `accepted`; priateľstvo, ktoré vzniklo bez nášho PUT → žiadny záznam; homeserver,
  ktorý neodpovedá, nezdrží spracovanie ďalšej udalosti.
- Go, odoslanie s `sk.karchi.discord.request`: `accepted` → jedna správa na falošný Discord a `delivered`;
  druhá udalosť s tým istým `request_id` → žiadna požiadavka; iný príjemca než v zázname → žiadna; zápisy
  vypnuté medzi `accepted` a udalosťou → žiadna; vypnuté a znova zapnuté → žiadna; priateľstvo medzitým
  skončilo → žiadna; chyba Discordu → `failed` a žiadny druhý pokus; správa bez poľa priateľovi ide ako dnes.
- Dnešný neupravený `sendlater.py` s položkou v `sk.karchi.discord.pending`: neodošle nič a nespadne.
- Nový `sendlater` proti falošnému mostu a homeserveru: čaká pri `sent`; po `accepted` pošle jednu udalosť
  s poľom žiadosti; `requests` vráti iného `user` než položka → nepošle nič; `accepted_unseen`, 404 a 503 →
  nepošle nič; položka zrušená pred `accepted` neodíde; reštart po odoslaní udalosti ju pošle nanajvýš
  znova do Matrixu a most druhú nepustí; záznam ostal `accepted` → „pošli sám“ bez opakovania.
- Skutočná žiadosť a jej prijatie: Karchiho krok, s kamarátom, ktorý o tom vie.

**Riziko.** Najvyššie z návrhu. Dokumentácia: „Suspicious friend request activity may be flagged by Discord
and require additional verification steps“, až po zrušenie účtu. Rozhoduje tvar požiadavky a to, že ide
z rovnakej relácie; počet 5 denne je odhad. Preto je to vypnuté, kým to Karchi nezapne.

### Bod 3: označiť člena, ktorý ešte nenapísal

**Čo uvidí Karchi.** Po „@“ ako doteraz ľudia z miestnosti. Pod nimi ďalší ľudia servera: vo fáze 0 tí, čo
na serveri niekedy písali (z uloženej histórie), vo fáze 1 od druhého písmena aj členovia, ktorých meno tak
začína. Človek mimo miestnosti sa označí len výberom zo zoznamu, nie dopísaním mena.

**Ako.**
1. F0: `archive.py` `GET /_archive/discord/people?guild=<id>&q=<text>`: autori z uloženej histórie servera
   (ID, meno, prezývka), nula požiadaviek na Discord. História je uložená pre dva servery; inde F0 nepridá
   nič.
2. F1: `GET /v1/guilds/<guild id>/members?query=<predpona>&limit=10`: gateway op 8 cez existujúce spojenie
   (`RequestGuildMembers`), patch pridá obsluhu GUILD_MEMBERS_CHUNK (0.7.7 žiadnu nemá) a čaká na odpoveď
   s rovnakým `nonce` najviac 3 s. Pamäť 10 minút na (server, predpona bez ohľadu na veľkosť písmen), jedna
   požiadavka naraz, najmenej 1 s medzi dvoma. Nikdy prázdna predpona (celý zoznam je vzor scrapera) ani
   dlhšia než 32 znakov; len server, na ktorom Karchi je (`user_portal`). Odpoveď bez Karchiho samého, meno je
   prezývka, inak globálne meno, inak používateľské.
   Za vypínačom `bridge.weft.member_search`, **predvolene vypnutým**, lebo správanie appky je neoverené
   (Z8); vypnutý odpovie `{enabled: false, members: []}`, nie chybou. Zapína sa krokom 4b nasadenia (Karchiho
   áno je toto zadanie); hneď po zapnutí sa spraví živý pokus nižšie a keď neprejde, vypínač sa vráti.
3. Weft: `mentionHits` pridá vzdialené výsledky pod miestnych, bez duplicít. Most sa pýta až po 400 ms pokoja
   a len keď je slovo po „@“ stále to isté; výsledok, ktorý príde po zmene textu alebo chatu, sa zahodí.
   Vypnuté hľadanie si Weft pamätá 10 minút a dovtedy sa nepýta. Vybraný človek mimo miestnosti sa zapíše do `picked`; `mentionsIn` ho uzná len
   odtiaľ (dve rovnaké mená ani čiastočný zoznam tak nemôžu označiť nesprávneho). Zvyšok (`textMessage`,
   most → `<@id>`) už funguje (Z7).
4. Obmedzenia: op 8 vracia členov servera, nie kanála; hľadá podľa používateľského mena, prezývky sú neoverené
   (Z8). Role a @everyone sú mimo rozsahu.

**Pokus.**
- Weft v prehliadači s falošným archívom a mostom: „@“ → nula volaní mosta; „@ja“ → jedno; pri vypnutom
  hľadaní žiadne; neskorá odpoveď po prepnutí chatu sa neukáže; výber človeka mimo miestnosti → zachytená
  správa má jeho `matrix.to` odkaz a `m.mentions`; dopísané meno človeka mimo miestnosti bez výberu →
  obyčajný text; dve rovnaké mená → označí sa len vybraný.
- Go: vypnuté → `enabled: false` bez požiadavky; zlé ID, prázdna predpona → 400; cudzí server → 404; obsluha
  zloží odpoveď z vloženej udalosti GUILD_MEMBERS_CHUNK, cudzí `nonce` ignoruje, `limit` nad 10 oreže, tú
  istú predponu vráti z pamäte bez požiadavky, dve požiadavky dá najmenej odstup od seba a bez odpovede vráti
  `timeout: true`, ktoré si nepamätá.
- Naživo v kroku 4b nasadenia (jedna gateway požiadavka, Karchiho áno): predpona mena člena, ktorý na jeho
  serveri ešte nepísal → je vo výsledku. Overí to len, že relácia mosta na
  predponu dostane odpoveď; prezývky a to, čo robí appka, ostávajú neoverené. Keď to neprejde, ostáva F0.
- Skutočná zmienka tichého člena: Karchiho krok (sekcia 7).

**Riziko.** F0 žiadne. F1 nízke, ale je to nová vzdialená požiadavka pri písaní; preto pamäť, odstup a
vypínač.

### Bod 4: kanály s jednou funkciou

**Stav.** Zvlášť nie je zaradené nič; každý premostený kanál je riadok „#kanál · Server“. Miestnosťou sú len
textové (94) a oznamové (5 zo 49) kanály. Vlákna idú do rodičovského kanála, fóra, hlasové a stage most
neprenáša a nevie ani, ku ktorému serveru patria (Z9).

**Čo uvidí Karchi (fáza 0).** Oznamový kanál má v zozname aj v hlavičke vlastnú značku. Nič viac: do Nízkej
priority si kanál dá sám tak ako iný chat. (Prepínač „Oznamy do Nízkej priority“ na server som po druhom kole
rady vyhodil: jeho vypnutie by prepísalo prioritu, ktorú si Karchi nastavil ručne.)

**Ako.** `archive.py` `GET /_archive/discord/channels` → pre každú miestnosť `{type, guild}` z `bridge.db`;
Weft si pri načítaní miestností doplní `r.kind`, značka z `app/icons.js`, `weft chats` ukáže druh.

**Čo nerobiť teraz.**
- Vlákna: žiadna správa vo vlákne za 15 dní (Z10); stavia sa len poistka z bodu 1, krok 4. Keď sa objavia
  (`select count(*) from message where dc_thread_id<>''` > 0), najprv len zobrazenie pod koreňovou správou,
  odpovedanie až potom. Pozor aj na `autojoin_thread_on_open: true`: otvorenie vlákna ťa doň pridá.
- Hlasové kanály a fóra: ani odkazy, dáta mosta ich nevedia priradiť serveru. Upstream ich rieši vo vetve
  `iFixRobots/discord-forum-voice-chat`; prídu s `megadiscord`.

**Pokus.**
- `GET /_archive/discord/channels` naživo: počet miestností podľa typu sedí s
  `select type,count(*) from portal where mxid<>'' group by 1`.
- Weft v prehliadači s pripravenými dátami: oznamový kanál má značku, textový nie.

**Riziko.** Žiadne voči Discordu.

## 5. Poradie stavby (pre Opus)

Stavia sa na vlastnej vetve; do `main` ide cez PR po recenzii a overení, lebo `main` nasadzuje každé vlákno,
ktoré spustí `tools/deploy-app`. Nasadzuje sa z čistého stromu, a každá časť (most, archív, Weft) sa dá vrátiť
bez ostatných.

**Fáza 0, bez zásahu do mosta** (`app/`, `server/archive/archive.py`, `server/archive/import_history.py`,
`server/cli/weft.py`)
- zoznam DM, overené prepojenie histórie a jeho zrušenie (bod 1, kroky 1 a 3);
- poistky pre správy z vlákien vo Wefte aj v `weft` ako pohodlie (bod 1, krok 4; chráni most);
- slovenské znenie odmietnutia mosta („You can't message users who aren't on your friends list…“) s odkazom
  „Otvoriť v Discorde“ (`https://discord.com/users/<id>`), v mieste, kde Weft číta hlášky „not bridged“
  (`app.js:60`);
- značka oznamov (bod 4);
- „@“ z uloženej histórie servera a výber človeka mimo miestnosti (bod 3, kroky 1 a 3).

**Fáza 1, patch mosta, len čítanie** (`server/bridges/discord-weft.patch` na tag `v0.7.7`,
`server/bridges/build-discord`; Go je na asuse v `~/sdk/go1.27.3`)
- `account` (`relationships_ready`, aktuálne `required_action`, príznaky účtu, `member_search`; bez
  `writes`), `contacts` so stavom priateľstva, `channels/<id>/open` (bod 1, krok 2), `guilds/<id>/members`
  (vypnuté), poistka odpovedí v `handleMatrixMessage` (bod 1, krok 4);
- Weft: otvorenie starého chatu a Ctrl+N cez most, Ctrl+N s priateľmi a stavom priateľstva, hľadanie členov
  pri „@“, slovenské dôvody odmietnutých odpovedí. Weft sa pri štarte spýta na `GET /v1/account`; pri 404
  (starý most) chat neotvorí a povie, že most treba aktualizovať;
- archív: `discord/open` a príkaz do miestnosti bota preč;
- nové kľúče configu (`bridge.weft.*`) pridať aj do `config/upgrade.go`, inak ich most pri štarte vymaže;
- zostaviť na asuse `server/bridges/build-discord-weft` (aplikuje patche, `go vet`, `go test -race`), binárku
  nechať vedľa živej pod iným menom, živú meniť až pri nasadení.

**Fáza 2, zápisy na Discord: odložená, nestavať (Karchi, 20. 11.).** Patch fázy 1 preto nemá žiadnu
zapisujúcu adresu, žiadny vypínač `bridge.weft.writes` a stráž cudzích v moste ostáva, ako je. Čo nasleduje,
je návrh pre neskôr (ten istý patch, `server/sendlater/sendlater.py`, `app/`):
- `create_dm`, `strangers/<id>` (PUT, DELETE); `relationships/<id>` (PUT) len ak je doložený tvar požiadavky
  (bod 2, krok 1), inak sa nepostaví ani to, čo na ňom stojí (`requests/<id>`, cyklus žiadosti, čakajúca
  správa), a Weft dá pri ne-priateľovi odkaz do appky; záznam cyklu žiadosti, vzťahy z READY a
  udalosti priateľstiev v jednom poradí, jednorazové odoslanie udalosti s `sk.karchi.discord.request`, slučka
  `sk.karchi.discord.pending`;
- všetko za vypínačom `bridge.weft.writes: false`. Zapisujúce adresy (`create_dm`, `strangers` PUT,
  `relationships` PUT) pri ňom odpovedajú 403 a `account` to hovorí, takže Weft tlačidlá fázy 2 neukáže.
  V mieste odoslania správy vypínač rozhoduje len o cudzích; správy priateľom idú ako dnes. Čítacia adresa
  `requests/<id>` odpovedá vždy (pri vypnutých zápisoch nikdy `accepted`) a udalosť s poľom žiadosti most
  pri vypnutých zápisoch nepustí;
- keď má účet `required_action` (z READY aj z neskoršej udalosti USER_REQUIRED_ACTION_UPDATE, most drží
  aktuálnu hodnotu) alebo je označený, zápisy odmietne most sám a Weft povie „Discord
  chce overenie účtu, otvor appku“;
- zoznam povolených, cykly žiadostí, stropy a časy akcií v súbore vedľa `bridge.db`, nie v jej schéme (aby
  migrácia na `megadiscord` nenašla cudziu tabuľku); tam je aj `writes_epoch`;
- testy v Go proti `httptest` falošnému Discordu (prepísaním `discordgo.Endpoint*`); žiadny test sa nepripája
  na discord.com.

**Nasadenie** (po zlúčení PR, každý krok so zálohou, keď do `~/matrix-spike` práve nikto iný nenasadzuje)

| Krok | Služba | Čo | Kontrola | Návrat |
|---|---|---|---|---|
| 1 | `matrix-spike-discord` | nová binárka zo zlúčeného `main`, `member_search: false`; záloha binárky (`mautrix-discord.bak-<dátum>-<čo>`) a `config.yaml`; `MemoryMax` ostáva | `…/v1/account` connected, `relationships_ready`, bez required action | stará binárka, reštart |
| 2 | `matrix-spike-archive` | `archive.py`, `discord_weft.py` bez `discord/open` | `GET /_archive/discord/dms` odpovedá | staré súbory, reštart |
| 3 | Weft (`tools/deploy-app`) | otvorenie cez most, „@“ s členmi | `curl` na `POST …/v1/channels/<id>/open` pri chate, ktorý už je (bod 1), nie v prehliadači | predchádzajúce vydanie |
| 4b | `matrix-spike-discord` | `bridge.weft.member_search: true` a reštart, hneď potom živý pokus z bodu 3 cez `curl` | hľadaný člen je vo výsledku | riadok späť, reštart |

Živé kontroly pri nasadení robí agent cez `curl` s testovacím tokenom, nikdy otvorením živého Weftu (ten pri
štarte odošle, čo má vo fronte). Vzhľad a správanie sa overujú v testovacom prehliadači so zachytenými
zápismi; naživo si ich pozrie Karchi. Kroky fázy 2 (worker pre čakajúce správy, jej tlačidlá, zapnutie
zápisov) v nasadení nie sú, lebo sa nestavia.

Caddy netreba meniť: `/_bridges/discord/_matrix/provision/*` a `/_archive/*` už vedú na most a archív.
Reštart mosta je pre Discord znovupripojenie tej istej relácie. Návrat na starú binárku: jej `upgrade.go`
kľúče `bridge.weft.*` z configu vymaže, takže po opätovnej výmene je hľadanie členov znova vypnuté
(bezpečná strana); skontrolovať v `account`.

**Hotové keď** (všetko bez odoslania čohokoľvek skutočnému človeku)
1. Fáza 0: pokusy F0 z bodov 1, 3 a 4 prejdú (okrem živého, ten patrí k nasadeniu); `tools/ui-check`,
   `overenie/discord-servers/run.sh`, `overenie/mentions/run.sh` a `overenie/merged-chats/run.sh` ostávajú
   zelené.
2. Patche sa aplikujú na čistý `v0.7.7`, `go vet` a `go test -race` prejdú vrátane pokusov F1 z bodov 1 a 3;
   patch nepridáva žiadnu požiadavku, ktorá na Discord zapisuje.
3. Weft s falošným mostom v oboch stavoch (404 = starý most, most s fázou 1): v každom ukáže len to, čo most
   vie, bez chyby v konzole a bez tlačidiel fázy 2.
4. Z fázy 2 sa nestavia nič: žiadna zmena `sendlater.py`, žiadny kľúč `sk.karchi.discord.pending`.
5. Počas všetkých testov nula požiadaviek na discord.com. Živé pokusy (otvorenie jedného chatu cez `curl`,
   krok 4b) sú až pri nasadení a robia len vymenované čítania.
6. Nezávislý overovateľ cez `tools/verify-on-asus`.

**Čo zámerne nie je v rozsahu:** prijímanie cudzích žiadostí, zrušenie vlastnej žiadosti, blokovanie,
vytvorenie skupinového DM, role a @everyone, kto je v hlasovom kanáli, fóra a hlasový chat, zobrazenie
vlákien, pravidlá na druh kanála, prechod na `megadiscord`, zmena limitu 5. A celá fáza 2 (Karchi, 20. 11.).

## 6. Riziká a poistky

| Akcia | Fáza | Požiadavka na Discord | Kto ju spustí | Poistka | Riziko |
|---|---|---|---|---|---|
| zoznam DM, druhy kanálov, „@“ z histórie | 0 | žiadna (`bridge.db`, archív) | Weft | – | žiadne |
| otvoriť existujúci DM | 1 | 2 GET (kanál, posledné správy), keď miestnosť ešte nie je; čítanie vo Wefte potom označí prečítané ako pri každom chate | klik | len Karchiho kanál, jedno otvorenie naraz v moste, nikdy hromadne | nízke |
| odpoveď na správu z vlákna alebo neznámu správu | 1 | žiadna (most ju nepustí) | Enter | poistka v moste | žiadne |
| priatelia, stav priateľstva | 1 | žiadna (pamäť mosta) | Weft | – | žiadne |
| hľadať členov pri „@“ | 1 | 1 gateway op 8 | písanie | vypnuté do živého overenia; pamäť, 1 / s | nízke, neoverené (Z8) |
| nový DM s priateľom |2, odložená | 1 POST | klik | vypínač zápisov | nízke |
| nový DM s cudzím |2, odložená | 1 POST | klik | 5 / deň, tvar ako appka | stredné až vyššie |
| správa cudziemu |2, odložená | 1 POST | Enter, človek povolený raz | zoznam povolených, bez opakovania | stredné |
| žiadosť o priateľstvo |2, odložená | 1 PUT | klik | 5 / deň, 30 s, doložený tvar ako appka | vyššie |
| správa po prijatí žiadosti |2, odložená | 1 POST priateľovi (a 1 POST na DM kanál, ak ešte nie je) | sendlater | len po prijatí videnom naživo, jednorazovo v moste | nízke |

Spoločné pravidlá: všetko cez jedinú reláciu mosta; zápisy z patchu bez automatického opakovania; captcha a
„required action“ sa neobchádzajú; pri označenom účte sa zápisy vypnú; každá akcia je v logu mosta s časom
(nie s obsahom). Počty v poistkách sú odhady: Discord žiadne bezpečné hodnoty nezverejňuje. Nulové riziko to
nie je a nebude ani po prechode na `megadiscord`.

## 7. Karchiho kroky

1. Rozhodnuté 20. 11.: fáza 2 sa zatiaľ nestavia, fázy 0 a 1 áno. Keď sa k nej vrátiš, lacnejšia cesta
   (Opus) je správa, ktorá po prijatí neodíde sama: Weft povie „Prijal žiadosť“ a text čaká na tvoj Enter.
2. Rozhodnuté 25. 11.: otvorenie a poistka vlákien do mosta, nasadiť po recenzii a zapnúť hľadanie členov
   s jedným živým pokusom (krok 4b).
3. Otvoriť vo Wefte jeden starý Discord chat.
4. Skutočná zmienka tichého člena servera (bod 3): napísať „@“, vybrať ho a poslať; v appke Discord má byť
   zmienka modrá.

## 8. Kedy sa vrátiť k `megadiscord`

Keď vyjde prvé vydanie po v0.7.7 (`git ls-remote --tags https://github.com/mautrix/discord`). Potom skúška
migrácie na kópii `bridge.db` bez tokenu a porovnanie mapovaní miestností, správ a vlákien. Pozor: `megadiscord`
od #371 pri prvej synchronizácii vytvára miestnosti pre DM hromadne (u nás desiatky miestností a sťahovaní
histórie). Prechod preto až s Karchiho výslovným áno na túto jednorazovú dávku, alebo s nastavením, ktoré ju
vypne. Z patchu sa prenesú `channels/<id>/open`, `members` a poistka odpovedí.

## 9. Rada (council)

Členovia: Claude Opus 5.5 a GPT Sol 6.2. Kimi K3.1 Pro nebežal (päťhodinový limit OpenCode Go) a nebežala ani
jeho náhrada DeepSeek V4.1 Flash Free (bezplatný limit); iný model som nedosadil.

| Člen | Kolo 1 | Kolo 2 | Kolo 3 | Kolo 4 |
|---|---|---|---|---|
| Claude Opus 5.5 | 6/10 | 7/10 | 8/10 | 8/10 |
| GPT Sol 6.2 | 4/10 | 6/10 | 6/10 | 6/10 |

Z kola 1 prijaté: vlastný kľúč pre čakajúce správy a potvrdenie až podľa mosta (Opus, Sol); žiadosť
v tvare appky, nie hotovou funkciou knižnice (Opus); povolenie cudzieho na človeka namiesto príznaku
v správe (Opus, Sol); automatické odoslanie len po živo videnom prijatí, inak ručne (Sol); overenie cieľa
pri prepojení archívu (Sol); najprv fáza bez zásahu do mosta s existujúcim príkazom (Sol); zápisy ako
posledná, vypnutá fáza (Sol); vyhodené pravidlá na druh kanála, zbalené vlákna, odkazy na hlasové kanály,
náhodné oneskorenie a strop na otváranie existujúcich DM (Opus, Sol); označenie človeka mimo miestnosti len
výberom (Sol); prechod na `megadiscord` podmienený hromadnou dávkou z #371 (Opus).

Z kola 2 prijaté: príkaz mosta len do overenej správcovskej miestnosti a úspech podľa `bridge.db`, nie podľa
textu odpovede; jeden príkaz naraz aj z dvoch zariadení (Opus, Sol); Weft `!discord` správy neskrýva natrvalo,
ako som tvrdil (Opus); prepojenie archívu overuje účet, kanál aj pripojené chaty a import ho nevráti (Sol);
poistka pre odpoveď na správu z vlákna už vo fáze 0 (Sol); `create_dm` pre existujúci kanál bez POST už vo
fáze 1 (Opus; v kole 3 nahradené otvorením podľa kanála); hľadanie členov predvolene vypnuté do živého
overenia (Sol); vzor pre odoslanie žiadosti doložiť zvlášť, nie odvodiť z prijatia (Opus, Sol); zrušenie
žiadosti z patchu preč (Sol); čakajúca správa viazaná na konkrétnu žiadosť a na udalosti v poradí z gateway,
bez porovnávania hodín (Sol, Opus); „odoslané“ až keď udalosť má záznam v moste, inak „stav neznámy“ bez
opakovania (Sol); vypínač zápisov aj v mieste odoslania správy a bez opakovania knižnice (Sol); 404 a
nepripojený most nikdy neznamenajú „neprijatá“ (Opus); prepínač „Oznamy do Nízkej priority“ preč (Opus, Sol);
nasadenie rozpísané po službách (Sol).

Z kola 3 prijaté: import nemení `room` existujúceho chatu a ručné odpojenie má vlastný príznak (Opus, Sol);
zoznam, otvorenie aj prepojenie len pre kanály, ktoré sú preukázateľne Karchiho (Sol); otvorenie je hotové až
po členstve v miestnosti a `pending` sa pamätá (Sol, Opus); otvorenie existujúceho chatu vždy podľa kanála,
bez `create_dm` vo fáze 1 a bez `GET /v1/relationships` (Sol, Opus); poistka pre vlákna aj na Ctrl+R (Sol);
kontrola zápisov pred každým zapisujúcim volaním vrátane prílohy a úpravy (Sol); záznam žiadosti vzniká pred
PUT, READY a udalosti priateľstiev idú jedným poradím a do Matrixu sa pri tom nepíše (Opus, Sol); po novom
READY už žiadosť nikdy nevedie k automatickému odoslaniu (Sol); o vypnutí zápisov rozhoduje most číslom
zapnutia, nie worker (Opus, Sol); worker si položku pred odoslaním vezme stavom `sending` a po reštarte ju
neposiela (Opus, Sol); „neodoslané“ sa z hlášky mosta neodvodzuje (Sol).

Neprijaté: Sol navrhuje žiadosti o priateľstvo a prvé oslovenie cudzieho nechať úplne v appke Discord.
Karchi o ne výslovne žiadal, preto ostávajú v návrhu ako fáza 2, postavená a vypnutá; zapnutie je jeho krok
(sekcia 7). Opus v kole 3 navrhol vyhodiť automatické odoslanie po prijatí a nechať len „Prijal žiadosť“
s textom čakajúcim na Enter; Karchi žiadal „odíde sama“, takže ostáva a jednoduchšia cesta je uvedená ako
jeho možnosť (sekcia 7).

Z kola 4 prijaté: o tom, či čakajúca správa smie odísť a či už odišla, rozhoduje most pri samotnom
odoslaní, jednorazovo na žiadosť, príjemcu a zapnutie zápisov; tým odpadlo potvrdzovanie cez archív aj
spoliehanie sa na account data (Sol, Opus); zrušenie priateľstva a nové READY platia aj pre už prijatú
žiadosť a prijatie pred návratom PUT má vlastný stav (Sol); poistka vlákien aj v `weft send --reply` (Sol);
`required_action` sa berie aktuálne, nie z READY (Sol); vypínač zápisov sa v mieste odoslania týka len
cudzích a `requests` odpovedá vždy (Opus, Sol); potvrdenie prečítania na Discorde druhá strana nevidí
(Opus); cesta k živému overeniu hľadania členov je v nasadení (Sol).

Verdikty kola 4: fázy 0 a 1 sú pripravené na stavbu (Opus aj Sol). Fáza 2: Opus ju po svojich nálezoch
považuje za bezpečnú na postavenie a nasadenie vo vypnutom stave; Sol žiadal záväznú kontrolu pri samotnom
odoslaní a spoľahlivé uloženie čakajúcich správ. Prvé je zapracované; druhé ostáva so zvyškovým súbehom
pomenovaným v bode 2 (account data nemá podmienený zápis). Piate kolo som nespustil: zmeny po kole 4 rada
nevidela.

Po rade (Karchi, 20. 11.): fáza 2 sa zatiaľ nestavia, fáza 1 ostáva. Spor rady o fázu 2 tým ostáva
nerozhodnutý do chvíle, keď sa k nej Karchi vráti; vtedy ju treba dať rade posúdiť znova.
