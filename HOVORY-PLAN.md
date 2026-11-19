# Hovory vo Wefte: plán

Návrh (Fable, 19. 11. 2026, vetva `noc/10a-hovory-fable`). Pokusy v sekcii „Cesty“ som spravil v noci 19. 11.;
pri žiadnom sa nikomu nevolalo a nič sa neposlalo. Kroky 1 a 2 postavil Opus tú istú noc (sekcia „Stav“); nič
z toho nie je nasadené.

Karchi: „Volanie cez všetky platformy: ako vieme vyriešiť. Minimálne skúšať rôzne riešenia.“ Messenger,
Instagram, WhatsApp, Discord, Teams; prijať aj začať hovor (hlas, video) z Weftu na x270.

## Záver

1. **Hovor, ktorého zvuk a obraz by niesol sám Weft, sa dnes nedá na žiadnej z piatich sietí.** Mosty hovory
   neprenášajú, len o nich píšu do chatu. Rovnako je na tom Beeper: do chatu dá poznámku a pošle ťa do natívnej
   appky ([Beeper help](https://beeper.helpjuice.com/en_US/troubleshooting/can-i-make-calls-or-video-chat-in-beeper)).
2. **Čo sa dá: Weft o hovore vie a otvorí naň správne miesto.** Zvuk a obraz nesie web platformy. Podľa
   dokumentácie a správ o nich vie všetkých päť sietí z prehliadača volať aj hovor prijať (pri Instagrame
   len z nepriamych zdrojov); prihláseného som neskúšal ani jeden. V Electrone 45 na asuse (akú verziu má
   x270, neviem) prešla kamera, mikrofón, WebRTC aj zámok povolení a všetkých päť webov sa odhlásených
   načítalo (pokus B). Načítanie hovory nepotvrdzuje: či ich web po prihlásení naozaj spojí, sa bez hovoru
   overiť nedalo.
3. **Prvé postaviť (krok 1, len `app/`, bez Karchiho rozhodnutia):** hovory v chate ako riadky hovoru po
   slovensky a tlačidlo, ktoré otvorí ten istý chat na sieti; hovor tam spustí Karchi sám. Na x270 to dá
   málo: presný chat na Discorde a pri WhatsAppe len zoznam chatov. Messenger a Instagram tlačidlo v shelli
   nemajú, lebo `facebook.com` si tam blokuje; Teams počká na pripojený účet. Riadok hovoru dnes príde len
   z WhatsAppu (prichádzajúci hovor): mosty Messengera a Instagramu, ako sú nasadené, hovory neoznačujú a
   začnú až po aktualizácii, ktorá čaká na Karchiho áno (rozhodnutie 4).
4. **Druhé (krok 2, `desktop/`, po Karchiho áno): okno hovoru**, najprv len pre Messenger, kde volá najviac.
   Okno Weftu s vlastným prihlásením, zamknuté na jeden chat a jeho hovor, cez tunel na asus. Inú cestu, ako z
   x270 volať cez Messenger, som nenašiel, a je to zároveň diera v jeho vlastnom bloku Facebooku: preto
   rozhoduje on. Až tento krok dá to, o čo žiadal.
5. **Zvonenie vo Wefte** je krok 3 a sľubuje menej, než znie: Weft vie ukázať „Volá ti X“ a otvoriť sieť, ale
   hovor zdvihne až jej web, ak ešte zvoní. Udalosť pri zvonení dnes posiela len WhatsApp most; či príde včas,
   ukáže až skutočný hovor.
6. Vlastné WebRTC a MatrixRTC/Element Call nie teraz: na Messenger ani WhatsApp sa nimi nedovolá.

## Stav (Opus, 19. 11. 2026): postavené, nenasadené

Karchi 19. 11. ráno: „Okno hovoru v desktope, a potom pre ostatné platformy to skús.“ To je áno pre rozhodnutia
1 a 2 (okno a jeho vlastné prihlásenie). Rozhodnutia 3 až 5 nepadli a idú najopatrnejšou cestou: zvonenie
(krok 3) sa nestavia, mosty sa nemenia (ani aktualizácia mautrix-meta, ani čítanie telefónov z databázy
WhatsApp mosta), skúšobný hovor je Karchiho krok v inboxe.

Dva PR do `main`, oba otvorené a nezlúčené (FULL STOP): #22 krok 1 (`app/` a tento plán, vetva
`noc/10b-hovory-opus`) a #23 krok 2 (`desktop/`, vetva `noc/10c-hovory-okno`). Sú nezávislé: appka okno pozná
len z `desktop.callNetworks`, ktoré jej dá shell. Nikomu sa nevolalo, do žiadnej siete sa agent neprihlásil.

**Krok 1 (`app/`)** je postavený podľa sekcie „Krok 1 podrobne“. Odchýlky, väčšinou z councilu:

- Pri videu hovorí aj text „videohovor“ („Zmeškaný videohovor“), nielen ikona, lebo náhľad v inboxe ikonu nemá.
- Hovor, ktorý Karchi začal a nikto nezdvihol, je „Nezdvihnutý hovor“, nie červený „Zmeškaný“.
- Riadok hovoru sa z Weftu nedá upraviť ani zmazať (do siete by odišla úprava či zrušenie záznamu hovoru).
- Discord kanál servera tlačidlo nemá: volať sa dá len v DM a skupinovom DM, hlasové kanály most neprenáša.
  `callTarget` jeho adresu vracia ďalej (kontrola zhody s mostom).
- Instagram id má 39 číslic, preto id smie mať do 64 číslic.
- Hľadanie v správach na serveri riadok hovoru po slovensky nenájde (server pozná len anglický text mosta); v
  správach, ktoré má Weft načítané, ho nájde.

Kontroly (v `overenie/hovory/`, mimo gitu):

| Kontrola | Čo skúša | Výsledok |
|---|---|---|
| `unit.mjs` | `callOf`, `callLabel`, `callTarget` vystrihnuté z `app/app.js`: 15 udalostí z prílohy a 15 tvarov `m.bridge` | 30 z 30 |
| `ui.cjs` (staged appka, skutočné dáta cez tunel, vymyslené miestnosti v prvom `/sync`, každý ne-GET zachytený, `window.open` zachytené) | riadky hovoru a ich ikony, náhľad v inboxe, Discord emote ostane emote, vlastný nezdvihnutý hovor bez úpravy a zmazania, podržaný chat hovor neukáže skôr, tlačidlo (názov, Tab, Enter, adresa) pre 4 druhy chatov, bez tlačidla Teams, kanál servera, zlé id a EduPage, spojený chat podľa prepínača siete, Ctrl+J; shell bez `desktop.call` (Messenger a Instagram bez tlačidla) a s ním (Messenger aj Instagram idú do `desktop.call`, Discord do prehliadača; po zapnutí bety v Nastaveniach DM aj skupinové DM do `desktop.call` s názvom „Hovor: zavolať na Discorde (beta)“), Nastavenia → Účty | všetko PASS |
| `real.mjs` (Karchiho miestnosti, len `/sync` stavu `m.bridge`) | podiel miestností s adresou, Discord adresa == `channel.external_url` mosta | Messenger 169/170, Instagram 48/49, Discord 107/107 a 107 zhôd, WhatsApp 66/66 (zoznam chatov) |
| `tools/ui-check`, `tools/i18n-check`, `rewrite/behave.cjs`, `rewrite/noop-mutations.cjs` | vzhľad, preklady, patchovanie renderu | čisté; `behave.cjs` padá na kroku 6a rovnako na `origin/main` (22 ok pred pádom v oboch) |

**Krok 2 (`desktop/`)** je postavený podľa „Krok 2 v skratke“ pre Messenger a Instagram. Ostatné siete som skúsil
každú zvlášť:

| Sieť | Okno hovoru | Prečo | Čo ukázala sonda (odhlásené, zamknuté okno cez tunel) |
|---|---|---|---|
| Messenger | áno | x270 blokuje facebook.com; iná cesta nie je | skončí na `/login.php`, nič neodmietne, 146 MB |
| Instagram | áno | prihlásenie a Accounts Center idú cez facebook.com; feed a Reels nesmú byť v okne | skončí na `/accounts/login/`, nič neodmietne, 187 až 210 MB |
| Discord | beta (Karchi 19. 11.: „postav Discord s klikom za mňa … daj to ako beta verziu“), vypnutá, kým ju nezapne | okno zamknuté na DM ako Messenger a samo stlačí hovor; bez bety ostáva prehliadač ako doteraz | zámok ide (`/channels/@me/<id>`), skončí na `/login`, 307 MB |
| WhatsApp | nie | WhatsApp Web nemá adresu jedného chatu (`/send?phone=` potrebuje telefón, ktorý miestnosť nenesie, a po otvorení ukazuje celý zoznam), okno by bolo celé WhatsApp Web a ďalšie prepojené zariadenie; x270 ho otvorí v prehliadači | neskúšané, zámok na chat nemá z čoho byť |
| Teams | nie (zatiaľ) | účet nie je pripojený (0 miestností); nový Teams web nedrží chat v ceste adresy; nie je blokovaný a má vlastný skúšobný hovor. Po pripojení: Graph `chat.webUrl` (alebo [odkaz na chat](https://learn.microsoft.com/en-us/microsoftteams/platform/concepts/build-and-test/deep-link-teams#deep-link-to-navigate-to-a-chat)) do `m.bridge` ako Discord `external_url` a otvoriť v prehliadači | neskúšané |

Okno siete má 420 px, bez `preload`, profil `persist:call-<sieť>`, identitu prihlasovacích okien, kameru,
mikrofón a celú obrazovku len pre presný pôvod siete (`https://www.messenger.com`, `https://www.instagram.com`,
podľa adresy žiadajúceho rámca); všetko ostatné (notifikácie, poloha, zdieľanie obrazovky) odmietne, takže
zdieľanie obrazovky v hovore nepôjde. Zostať smie len na chate (Messenger `/t/<id>`, `/e2ee/t/<id>`; Instagram
`/direct/t/<id>/`), na hovore (`/groupcall/…`; Instagram `/call/…`, kým ho prvý hovor nepotvrdí, len odhad) a
na prihlásení či kontrole účtu (aj na facebook.com). Úvodnou stránkou (Messenger: zoznam všetkých chatov;
Instagram: feed a `/direct/inbox/`) smie prejsť len prihlásenie na ceste dnu (vlastné načítanie chatu alebo stránka
prihlásenia): keď na ňu okno príde, ide hneď na chat; z chatu ani z hovoru v okne sa na ňu nedá. Odkaz inam okno
odmietne a stránka ostane, ako bola (rozpísaná správa, hovor v stránke aj hovor bežiaci v okne samom); presmerovanie vráti na chat; pohyb v stránke na iný chat vráti krokom späť bez znovunačítania, na chat aj na hovor v okne. Klik vo Wefte na chat, ktorý okno ešte ukazuje (aj pod inou adresou, napríklad šifrovaný), zastaví načítanie iného chatu, kým sa ukáže; kým sa iný chat načítava, z chatu na obrazovke sa na úvodnú stránku nedá. História
okna sa vymaže, hneď ako sa jeho chat uloží do histórie (ešte pred dokončením načítania), takže krok späť neukáže
predošlý chat ani úvodnú stránku. Keď server siete
presmeruje vlastné načítanie chatu priamo na inú adresu chatu (šifrovaný chat Messengera `/e2ee/t/…`, možno
kratšie id Instagramu), okno ju berie ako ten istý chat; klik nie je presmerovanie a obchádzka cez iné stránky
(napríklad prihlásenie) sa nepočíta, takže iný chat tadiaľ neprejde. Keď stránka sama stále odchádza (napríklad prepíše id chatu v stránke), po
desiatich návratoch za 10 s ukáže vysvetlenie namiesto slučky. Popup smie byť len hovor (alebo prázdna stránka
`about:blank`, z ktorej hovor začína; ostane prázdna, kým ju Karchi nezavrie), s tými istými zámkami, a prežije
zavretie malého okna chatu. Zavretie hlavného okna Weftu ho len skryje (okná hovoru aj tunel bežia ďalej, ďalšie
spustenie ho ukáže); Ctrl+Q zavrie Weft aj okná hovoru a tunel. Ďalší chat otočí to isté okno, klik na ten istý chat ho len ukáže (bez
znovunačítania), aj keď v okne práve beží jeho hovor, a to aj počas načítania iného chatu; počas prihlásenia
rozpísaný formulár nezmaže a kým sa chat ešte len načítava (aj čakanie na stránku prihlásenia), načítanie nezačne
znova. `replaceState` na
iný chat zo stránky hovoru v okne samom hovor ukončí: okno ho bez znovunačítania nevráti a zámok na chat má
prednosť. Okno má stále názov „Hovor · Messenger“ / „Hovor · Instagram“ / „Hovor · Discord (beta)“, aby naň Hyprland
mohol mať pravidlo.

**Discord (beta).** Nastavenia → Účty → „Discord v okne hovoru (beta)“ (len to zariadenie, `localStorage`
`ep_call_discord_beta`, predvolene vypnuté). Zapnutá: telefón v DM a skupinovom DM (aj Ctrl+J) má názov „Hovor:
zavolať na Discorde (beta)“ a otvorí DM v okne „Hovor · Discord (beta)“ (940 px, užšie Discord tlačidlá hovoru
schová), zamknutom ako Messenger: zostane len na DM (`/channels/@me/<id>`, aj odkaz na jeho správu) a na `/login`;
`/channels/@me`, `/app` a `/` len cestou dnu; presmerovanie na iný DM okno odmietne (iné id je iný človek, nie ten
istý chat ako pri Messengeri); žiadne nové okno, ani prázdne; kamera len `https://discord.com`. Keď je DM v okne,
okno do 30 s od kliku nájde tlačidlo „Start Voice Call“ (aj české a nemecké znenie; zapnuté, viditeľné, nezakryté,
hľadá vo vlastnom svete skriptov, ktorý stránka nevidí) a stlačí ho skutočným klikom myši na náhodnom mieste
tlačidla po náhodne zakrivenej ceste kurzora (14 až 30 bodov, pomalý začiatok a koniec, pauzy 6 až 19 ms, pred
stlačením a pri ňom ďalšie náhodné pauzy; tesne pred stlačením znova overí, že presne bod pod kurzorom je to
tlačidlo, nie niečo, čo ho čiastočne zakrýva, inak ho nájde znova; pri priblížení stránky ráta jej zoom). Aj
pustenie tlačidla musí prísť do 30 s od kliku, inak nestlačí. Pred pustením overí to isté znova; keď stránka
medzitým odišla alebo tlačidlo nie je pod kurzorom, pustí mimo stránky (Chromium to ráta ako klik na prázdny koreň
stránky, nie na žiadny ovládač). Skrytú kópiu tlačidla preskočí a stlačí to viditeľné. Keď v okne sám niečo stlačíš
skôr než okno (myšou, klávesom či dotykom, aj tlačidlo hovoru, aj kým sa stránka ešte načítava), okno už nestlačí
nič. Nestlačí na stránke prihlásenia, na inom chate, na neviditeľnom tlačidle (`opacity`, `filter: opacity()`, aj
cez rodiča), na zakázanom (aj cez `fieldset` či `inert`), ani keď sa stránka sama pokúsila odísť z DM (zámok vráti
adresu, no obsah nemusí); klik vo Wefte na DM, ktorý je v okne už otvorený, okno len ukáže (hovor tam môže bežať),
takže druhý hovor po zložení spustíš v okne sám; rýchly klik späť na DM v okne nezavolá nikam. Odhlásený Discord
(aj keď stránka sama prejde na `/login`, alebo ho server pošle cez `/login` hneď späť na DM, alebo stránka na
prihlásenie len zamieri): prihlásiš sa v okne a zavoláš v ňom sám. V skupinovom DM jeden klik zazvoní celej
skupine. Klik na iný DM, kým v okne beží hovor, stránku načíta znova a hovor zloží (Discord nemá hovor v popupe ako
Messenger). Shell Discord prijme len od appky, ktorá pošle `beta: true` (staršia appka teda nikdy sama nezavolá);
vypnutá beta nezaloží ani profil. Nenájdené tlačidlo (iný jazyk, nové znenie) zapíše `login.log` („found no call
button“).

Riziko: Discord automatizáciu používateľských účtov zakazuje a následok je zablokovaný účet (správy a kontakty),
nie len nepodarený hovor. Klik samotný je skutočný klik myšou, ťažko rozoznateľný od ručného, no vzor ostáva
(kurzor príde z okna, klik asi sekundu po tom, čo sa tlačidlo ukáže). Viditeľnejšia je samotná relácia: web
Discordu v okne s identitou Chrome, prihlásený z adresy asusu. Nové riziko bety je aj zavolať niekomu omylom
(klik na telefón v skupine alebo na nesprávny DM). Riziko je malé, nie nulové; Karchi o ňom rozhodol 19. 11. Ide vždy cez tunel
na asus: kým tunel nebeží (štart, zlyhanie, pád), session ide na proxy, ktorá nikam nevedie, takže priame
spojenie stránky nevznikne ani pri druhom kliknutí počas štartu. Zvuk a obraz (WebRTC, UDP) idú mimo tunela
priamo z x270, úmyselne: s `disable_non_proxied_udp` hovor nevznikol (pokus 1). Po páde tunela okno povie, čo
sa stalo, popupy zavrie (aj keď okno chatu už nie je) a ďalšie kliknutie postaví okno znova cez nový tunel.
Tunel žije, kým žije niektoré okno siete. Cesta von: Nastavenia → Účty → „Odhlásiť okno hovorov“ zavrie všetky
okná a zmaže ich prihlásenie. Odmietnuté stránky, popupy aj povolenia (pôvod a druh) idú do `login.log`, aby
prvé skutočné prihlásenie a hovor ukázali, čo v zozname chýba.

`SPRAVY_SELFTEST=call|call-again|call-notunnel` (`desktop/selftest-call.js`, spúšťa `overenie/hovory/selftest.sh`
na asuse v Electrone 45.2.2 pod Xvfb, s falošnou kamerou a dočasným profilom) prešiel celý:

- pravidlá skutočného Messengera, Instagramu a Discordu (iný chat, feed, Reels, server, `…com.evil.net`, `http://`
  nie; úvodná stránka len cestou; popup len hovor, pri Discorde žiadny);
- IPC len z hlavného rámca appky; zlá sieť (aj WhatsApp, Teams) či id okno neotvorí; zoznam sietí
  appke dá shell;
- Discord (beta, `call-discord`, stand-in so skutočným tlačidlom, ktoré zapíše, čo ho stlačilo): okno stlačí hovor
  raz, skutočným klikom (`isTrusted`) po ceste kurzora (aspoň 10 pohybov, Chromium ich môže zlúčiť); dráha
  kurzora je v okne, končí na tlačidle, je zakrivená a zakaždým iná; klik na DM už v okne nevolá znova; iný DM
  volá tam; rýchly klik späť, prihlásenie (aj v stránke), neskorá stránka a presmerovanie na iný DM nevolajú
  nikam; priblížené okno trafí; pohnuté tlačidlo nájde znova bez kliku vedľa; čiastočne zakryté tlačidlo nikdy
  nepošle klik na to, čo ho zakrýva; tlačidlo tesne pred koncom času nestlačí po čase; stránka neotvorí nové
  okno, ani prázdne; tlačidlo na stránke prihlásenia, tlačidlo s iným popisom a zakryté tlačidlo nestlačí; dva
  kliky počas štartu: jedno okno, volá len posledný chat; okno má 940 px a názov „Hovor · Discord (beta)“;
- okno nemá `window.desktop`; kamera pre povolený pôvod, `NotAllowedError` vo vnorenom rámci iného pôvodu;
  notifikácie odmietnuté;
- každá navigácia sa preukázateľne pokúsila (test vidí jej cestu) a skončila na chate: odkaz inam, `/` z chatu a
  `pushState` na iný chat nechajú stránku bez znovunačítania; presmerovanie mimo chatu sa vráti; prihlásenie, ktoré
  skončí na zozname chatov, dá chat; krok späť (ako Alt+←) po prepnutí chatu ani počas načítania nového chatu
  predošlý chat neukáže; klik na ten istý chat stránku nenačíta znova, ani keď v okne beží hovor; hovor v okne
  nechá odkaz inam, `/` aj `pushState` na iný chat; rýchly klik späť na chat, ktorý okno ešte ukazuje, nenechá
  ukázať chat, ktorý sa medzitým načítaval;
- presmerovanie servera na šifrovaný chat okno prijme a drží, obchádzku cez prihlásenie na iný chat nie; stránka, ktorá sama prepíše id chatu, skončí
  vysvetlením, nie slučkou;
- popup mimo hovoru sa neotvorí, popup hovoru má tú istú session a pri odchode (aj na chat okna) sa zavrie;
- druhý klik počas štartu necháva jedno okno na poslednom chate a nič nejde priamo (`resolveProxy` pre
  messenger.com aj pre 127.0.0.1: počas štartu a po páde nikam, inak tunel, nikdy DIRECT; stránka teda nedosiahne
  služby na samotnom x270);
- pád tunela okno oznámi a zavrie popup, aj keď ostal sám; klik po páde dá nové okno cez nový tunel; zavreté
  okno chatu nechá popup aj tunel a tunel skončí s posledným oknom;
- cookie prežije reštart a prihlasovacie okno ju nevidí; odhlásenie ju zmaže a zavrie okno aj popup; bez
  tunela chyba;
- druhé spustenie Weftu s tým istým profilom hneď skončí a prvé beží ďalej (`selftest.sh`, krok „single“).

Pôvodný `SPRAVY_SELFTEST=1` prechádza ďalej. Behy idú z lokálneho stand-inu na 127.0.0.1 asusu, kam vedie aj
tunel; trasu cez tunel preto dokazuje `resolveProxy` pre skutočné meno siete a sonda vyššie.

**Čo ostáva na Karchim: skúšobný hovor, presný postup**

1. Povedz agentovi „zlúč a nasaď hovory“: zlúči #22 a #23, nasadí appku (`tools/deploy-app`) a shell na x270
   (`~/.local/share/spravy`). Shell sa prejaví po reštarte appky Weft na x270.
2. Voliteľne pravidlo Hyprlandu v karchi-os, aby okno plávalo v úzkej šírke: `windowrule = float, size 420 760`
   pre názov `^Hovor · (Messenger|Instagram)$` (Discord nie: v 420 px by schoval tlačidlá hovoru; jeho okno má
   940 px). Bez neho ho Hyprland vydláždi a web môže vedľa chatu ukázať zoznam chatov.
3. Vo Wefte otvor chat na Messengeri a klikni na telefón v hlavičke. Otvorí sa okno „Hovor · Messenger“ (ide cez
   asus, chvíľu to trvá). Prihlás sa v ňom sám (Facebook prihlásenie, prípadne kontrola účtu). Pozri sa:
   ukazuje len ten chat? Sú tam tlačidlá hovoru a videohovoru?
4. To isté pre chat na Instagrame (okno „Hovor · Instagram“). Je to druhé prihlásenie do Instagramu z adresy
   asusu, kontrola účtu je možná; most ostáva prihlásený zvlášť.
5. Discord (beta): Nastavenia → Účty → zapni „Discord v okne hovoru (beta)“. Otvor DM s niekým, s kým máš hovor
   dohodnutý, a klikni na telefón: okno „Hovor · Discord (beta)“ sa otvorí, prihlás sa v ňom; potom klikni na
   telefón vo Wefte na iný dohodnutý DM alebo zavri okno a klikni znova. Okno má samo začať hovor. Keď nezačne,
   riadok `call discord` z `login.log` povie prečo (napríklad Discord hovorí po česky inými slovami).
6. Dohodni si hovor s niekým známym, osobitne na Messengeri a na Instagrame. V každej sieti mu zavolaj z okna:
   počujete sa a vidíte (zvuk a kamera x270, slúchadlá)? Potom nech zavolá on, kým je okno otvorené: zvoní okno?
   Prijmi hovor v okne a over znova, že sa počujete a vidíte oboma smermi.
7. Keď niečo nejde (okno sa vráti, popup sa zavrie, kamera nejde), riadky `call` z `~/.cache/spravy/login.log`
   na x270 povedia, čo zámok odmietol; daj ich agentovi.
8. Kedykoľvek: Nastavenia → Účty → „Odhlásiť okno hovorov“ zavrie okná a zmaže ich prihlásenie.

**Neoverené:** či skutočný Discord v okne ukáže tlačidlo „Start Voice Call“ v tvojom jazyku a na mieste, kde ho
okno nájde (stand-in áno; české a nemecké znenie sú odhad); čo urobí to tlačidlo, keď hovor už beží alebo práve
niekto volá; či adresy Messengera a Instagramu otvoria naozaj ten chat (id z mosta sa s adresou porovnať
nedalo, len pri Discorde; Instagram môže v adrese používať kratšie id); kde Instagram web vedie hovor; či 420 px
neskryje tlačidlá hovoru; x270 má Electron 44.11.2, testy bežali v 45.2.2; či hovor spojí WebRTC, keď x270 blokuje `facebook.com` a STUN či TURN
Mety by boli pod blokovaným menom (DNS ide mimo tunela); výber zvukového výstupu a bluetooth slúchadlá pri
predvolenom odmietaní povolení.

## Čo som zistil o dnešnom stave

| Vec | Stav | Odkiaľ to viem |
|---|---|---|
| WhatsApp most (mautrix-whatsapp v26.10) | Prichádzajúci hovor hneď zapíše do chatu: „Incoming call. Use the WhatsApp app to answer.“ s `com.beeper.action_message: {type: "call", call_type}`. Koniec, prijatie ani odmietnutie nepremostí. Staršie ako 15 min zahodí. | zdroják `pkg/connector/handlewhatsapp.go` (`handleWACallStart`, `convertCallStart`); `call_start_notices: true` v `whatsapp/config.yaml`; v binárke je `convertCallStart` |
| Messenger a Instagram most (mautrix-meta, naše buildy v26.10+dev.6643ca46 a pre Instagram v26.10+dev.14c13fe3, oba zo zdrojáku z 9. 11.) | Hovory neoznačuje vôbec; čo s nimi robí, neviem (živú ukážku nemám). Upstream main to pridal až 13. až 17. 11. 2026: v šifrovaných chatoch `FBCallEvent` premostí „Missed audio call“ a „Audio call (3:12)“ a začiatok hovoru zahodí; v nešifrovaných chatoch a na Instagrame príde záznam hovoru (`xma_rtc_*`) ako tá istá action_message. | zdroják `pkg/connector/handlewhatsapp.go` (`handleWAFBCall`), `pkg/msgconv/from-meta.go` (`CallLogToMatrix`), whatsmeow `notification.go`; v binárkach `mautrix-meta` ani `mautrix-instagram` nie je reťazec `FBCall` ani `xma_rtc_` |
| Discord most (mautrix-discord 0.7.7) | Správa typu CALL príde ako `m.emote` „started a call“; jej úpravu (koniec hovoru) zahodí. | zdroják `portal_convert.go`, `portal.go` |
| Teams most (vlastný, Graph, poll 20 s) | Do 19. 11. hovory nevidel (`apply` v `server/microsoft/bridge.py` bral len `messageType == "message"`); od 20. 11. posiela ukončený hovor ako riadok hovoru (sekcia „Mosty“). Graph v chate dáva aj systémové správy „hovor začal“ a „hovor skončil“ ([Microsoft Learn](https://learn.microsoft.com/en-us/graph/system-messages)); zvonenie prihlásenému používateľovi nedáva. Teams účet zatiaľ nie je pripojený (0 miestností). | kód, dokumentácia, živý stav |
| Živé miestnosti (403) | Nenašiel som žiadnu udalosť `m.call.*` ani MatrixRTC a žiadnu poznámku mosta o hovore. Hľadanie ide cez text správ, takže to nedokazuje, že nikto nevolal; len nemám živú ukážku. | `/sync` a `/search` cez token `weft`, len čítanie |
| Archív | Stovky hovorov na Messengeri a Instagrame („[Hovor 3:12] Audio call ended“, „… started a video chat“), posledné z októbra 2026. Hovory sú pre Karchiho bežná vec, hlavne na Messengeri. | `weft search` |
| Homeserver (Tuwunel 1.9.4) | Hlási `org.matrix.msc4143`, ale `rtc_transports: []`, TURN nie je (404), LiveKit nie je. | `/_matrix/client/versions`, `/voip/turnServer`, `…/org.matrix.msc4143/rtc/transports` |
| Weft appka | Systémové notifikácie nemá vôbec (`Notification` v `app/app.js` nie je). Ikony telefónu a kamery v `app/icons.js` nie sú. `desktop/preload.js` dáva appke len `collect` a `cancelCollect`. | kód |
| x270 | Spal: nainštalované appky, `x-scheme-handler/*`, kamera a verzia Electronu sa nedali prečítať. Z karchi-os: Hyprland, `xdg-desktop-portal-hyprland`, PipeWire, systémový `electron`. `facebook.com` je v `/etc/hosts` zablokované (prihlasovacie okná idú tunelom cez asus). | `ssh x270` timeout; `~/.work/karchi-os`; `desktop/main.js` |

## Mapa: čo ktorá cesta dá na ktorej sieti

| | Messenger | Instagram | WhatsApp | Discord | Teams |
|---|---|---|---|---|---|
| A. Hovor cez most alebo MatrixRTC | nie | nie | nie | nie | nie |
| B. Web siete: začať hovor (podľa dokumentácie, prihlásené neskúšané) | áno | asi áno | áno (od 28. 7. 2026) | áno | áno |
| B. Web siete: prijať, keď je otvorený (to isté) | áno | asi áno | áno | áno | áno |
| C. Adresa správneho chatu z miestnosti | 169 zo 170 | 48 zo 49 | 0 zo 66 (chýba telefón) | 107 zo 107 | neskúšané (účet nie je pripojený) |
| C. Otvoriť v prehliadači x270 | nie (blok) | nie (blok) | áno | áno | áno |
| C. Natívna appka na Linuxe | nie je | nie je | nie je | je | nie je |
| D. Most pošle udalosť pri zvonení (podľa zdrojáku, živú ukážku nemám) | možno po záplate (hypotéza), len šifrované chaty | neisté | áno, so značkou | len neoznačenú správu o začatí hovoru (od emote sa nedá odlíšiť) | nie |
| D. Most ohlási zmeškaný a ukončený (podľa zdrojáku, živú ukážku nemám) | po aktualizácii mosta | po aktualizácii mosta, ako záznam | nie | nie | po úprave vlastného mosta |
| E. Vlastné WebRTC | len odkaz v správe | to isté | to isté | to isté | to isté |

## Cesty

### A. Hovory v mostoch, MSC3401, Element Call

**Ako by to šlo:** most by preložil hovor siete na Matrix hovor (`m.call.*` alebo MatrixRTC) a Weft by mal
vlastné okno hovoru.

**Nefunguje.** Žiadny mautrix most médiá hovoru neprenáša: WhatsApp, Messenger aj Instagram majú vlastný
uzavretý protokol hovoru a whatsmeow z neho vidí len signály (ponuka, prijatie, koniec), nie zvuk. Discord hlas
by sa dal len vlastným klientom na Karchiho účte („selfbot“), čo Discord zakazuje. Teams médiá dáva len botom
v cloude. Element Call je konferencia medzi ľuďmi na Matrixe; na druhej strane mosta nikto taký nie je.

**Pokus:** prečítal som zdrojáky mostov a živý homeserver. V 403 miestnostiach som nenašiel žiadnu udalosť
hovoru, server nemá TURN ani MatrixRTC transport, mosty podľa zdrojákov posielajú len textové poznámky.

**Verdikt:** hovor touto cestou nie. Použiť z nej len poznámky mostov: sú jediný signál, ktorý Weft o hovore
má, a sú označené strojovo (`com.beeper.action_message`), takže ich netreba hádať z textu (pokus D).

### B. Webový klient platformy vo vlastnom okne Electronu

**Ako by to šlo:** `desktop/` dostane druhý druh okna, „okno hovoru“: trvalý profil pre sieť, v ktorom sa
Karchi raz prihlási sám, a Weft ho otvára na správnom chate. Hovor beží vo webe platformy, s jej vlastným
zvonením, šifrovaním a tlačidlami.

**Pokus 1 (asus, Electron 45.2.2 = Chromium 156, pod Xvfb, falošná kamera):**

- Kamera a mikrofón: `getUserMedia` dal zvuk aj obraz; dva `RTCPeerConnection` v jednej stránke sa spojili a
  tiekol opus aj VP8. Kodeky videa VP8, VP9, H264, AV1.
- Zámok povolení: bez handlera Electron povolí kameru a mikrofón každej stránke. S
  `setPermissionRequestHandler` a `setPermissionCheckHandler` dostal povolený pôvod kameru, iný pôvod
  `NotAllowedError`. Rozhoduje len adresa rámca, ktorý žiada (`details.requestingUrl`); prišla pri všetkých
  štyroch žiadostiach (kamera, obrazovka, cudzí pôvod, popup), žiadosť bez nej sa zamieta.
- Popup: Messenger otvára hovor v novom okne. `window.open` s tou istou session prešiel a hovor v ňom tiež.
- Zdieľanie obrazovky: `getDisplayMedia` cez `setDisplayMediaRequestHandler` vrátil „Entire screen“ (na X).
- Tunel: s HTTP cez SOCKS (ako prihlasovacie okná cez asus) sa hovor v slučke spojil ďalej, lebo UDP ide
  mimo tunela. S politikou `disable_non_proxied_udp` nevznikol žiadny kandidát: tú nenastavovať. Slučka na
  jednom stroji nedokazuje, že hovor prejde medzi dvoma sieťami.

**Pokus 2 (to isté okno, odhlásené weby s identitou shellu):** všetkých šesť sa načítalo, žiadny nehlási
nepodporovaný prehliadač a každý vidí `RTCPeerConnection` aj `getUserMedia`. Čísla sú z prvého behu
(`run-sites.log`); druhý beh o pol hodiny dal podobné (načítanie 0,5 až 1,4 s, pamäť do 60 MB inak).

| Web | Kde skončil | Načítanie | Pamäť renderera |
|---|---|---|---|
| messenger.com | úvodná stránka | 0,6 s | 148 MB |
| instagram.com/direct | prihlásenie | 0,8 s | 197 MB |
| web.whatsapp.com | QR kód | 0,8 s | 292 MB |
| discord.com/app | prihlásenie | 0,5 s | 353 MB |
| teams.microsoft.com | prihlásenie Microsoft | 1,4 s | 136 MB |
| teams.live.com | úvodná stránka | 1,1 s | 262 MB |

**Čo funguje:** technický základ v Electrone 45 na asuse. Podľa dokumentácie a správ web každej siete volať
vie (WhatsApp Web od 28. 7. 2026,
[Android Authority](https://androidauthority.com/whatsapp-web-audio-video-calls-3692027)) a otvorený web má
zvoniť sám; skupinové hovory, zdieľanie obrazovky a šifrovanie rieši platforma. Odhlásené načítanie z pokusu 2
z toho nepotvrdzuje nič okrem toho, že web Electron neodmietne.

**Čo nefunguje alebo je neisté:**

- **Obchádza Karchiho vlastné zábrany.** `facebook.com` si na x270 blokuje úmyselne a správy vo Wefte čakajú
  na okná čítania. Celý messenger.com alebo instagram.com v okne ukáže všetky chaty a Reels hneď. Okno preto
  musí byť zamknuté na jeden chat a jeho hovor, a aj tak je to jeho rozhodnutie.
- **Druhé prihlásenie.** Okno nesmie použiť cookies mosta (jednu session z dvoch miest Meta ukončí;
  preto `forgetSession` v `desktop/main.js`). Má vlastné prihlásenie, pri WhatsAppe ďalšie prepojené
  zariadenie. Či druhé prihlásenie vyvolá kontrolu účtu alebo odhlási most, neviem; je to zmena na účtoch, kde
  platí „no bans“.
- **Prijatie, keď okno nebeží.** Web sa po kliknutí musí načítať a prihlásený WhatsApp Web synchronizovať;
  hovor medzitým môže doznieť. Držať weby na pozadí je na x270 priveľa: už prihlasovacie stránky majú 136 až
  353 MB na sieť.
- **Sieť.** HTTP okna Messengera pôjde z adresy asusu, zvuk a obraz z adresy x270. V škole býva UDP
  blokované. Keď asus nebeží, okno Messengera nejde vôbec.
- **Hyprland a zvuk.** Kamera, mikrofón, zdieľanie obrazovky cez portál a prepnutie bluetooth slúchadiel pri
  zapnutí mikrofónu som neskúšal (x270 spal). Či shell beží natívne na Waylande alebo cez XWayland, neviem.
- **Po prihlásení.** Či weby v Electrone s identitou Chrome hovor naozaj povolia a spoja, a či Instagram
  hovory Karchiho účtu ponúka, sa bez prihlásenia a hovoru nedá zistiť.

**Verdikt:** jediná z piatich ciest, ktorá môže dať hovor z x270 na Messengeri a Instagrame; že ho naozaj dá,
ukáže až prihlásenie a prvý hovor. Stavať ako krok 2, najprv jedna sieť, po Karchiho áno.

### C. Otvorenie natívnej appky alebo webu na správnom mieste (deep link)

**Ako by to šlo:** Weft z miestnosti zostaví adresu toho istého chatu na sieti a otvorí ju v prehliadači,
v natívnej appke alebo v okne z cesty B.

**Pokus (nasucho, nič sa neotváralo):** skript prešiel stav všetkých miestností s `m.bridge` a zostavil adresu.

| Sieť | Miestností | Adresa sa dá zostaviť | Tvar |
|---|---|---|---|
| Messenger | 170 (156 DM) | 169 | `https://www.messenger.com/t/<id vlákna>` |
| Instagram | 49 (44 DM) | 48 | `https://www.instagram.com/direct/t/<id vlákna>/` |
| Discord | 107 (8 DM, z nich 2 skupinové; 99 kanálov serverov) | 107 | DM a skupinové DM `https://discord.com/channels/@me/<id kanála>`, kanál servera `…/channels/<id servera>/<id kanála>` |
| WhatsApp | 66 (49 DM) | 0 | DM majú id `…@lid`; telefón v stave miestnosti nie je |
| Teams | 0 | | účet nie je pripojený |

Discord: id servera je `network.id` v `m.bridge` (má ho 99 miestností); 8 miestností ho nemá a nesú
`com.beeper.room_type: "dm"`, medzi nimi aj 2 skupinové DM, ktoré tiež patria pod `@me`. Takto zostavená
adresa je vo všetkých 107 miestnostiach tá istá, akú most sám píše do `channel.external_url`
(`deeplinks3.py`). Prvá verzia skriptu brala za DM každú miestnosť s jedným človekom a šiestim kanálom
serverov by dala nesprávne `@me`; počet 107 vtedy správnosť adries nedokazoval.

Odhlásené odpovede zdokumentovaných odkazov (neplatný cieľ, žiadna session, nikomu sa nevolalo):
`teams.microsoft.com/l/call/0/0?users=…` vráti 302 na spúšťač s voľbou „Continue on this browser“;
`wa.me/<číslo>` vráti 302 na `api.whatsapp.com/send/?phone=…`; `discord.com/channels/@me/<id>` vráti 200.

**Čo funguje:** správny chat na Messengeri, Instagrame a Discorde priamo z dát, ktoré Weft už má. Teams má
zdokumentovaný odkaz podľa mena účtu (UPN), ktorý ponúkne hovor a pred zvonením sa pýta
([Microsoft Learn](https://learn.microsoft.com/en-us/microsoftteams/platform/concepts/build-and-test/deep-link-workflow)):
`https://teams.microsoft.com/l/call/0/0?users=<upn>[&withVideo=true]`. Miestnosť Teams mosta nesie id chatu,
nie UPN: tvar odkazu treba určiť, až bude účet pripojený. Na Discorde a WhatsAppe stačí bežný prehliadač, v
ktorom je Karchi prihlásený; okno Weftu na to netreba.

**Čo nefunguje:**

- **Messenger a Instagram v prehliadači x270:** `facebook.com` je zablokované, prihlásenie tam neprejde.
- **WhatsApp:** web otvorí chat len podľa telefónu (`web.whatsapp.com/send?phone=`). Most ho má v databáze
  (`whatsmeow_lid_map`, 567 riadkov), miestnosť ho nenesie. Kým sa to nedorieši, otvorí sa zoznam chatov.
- **Odkaz, ktorý rovno zavolá,** okrem Teams zdokumentovaný nie je. Messenger hovor je adresa
  `messenger.com/groupcall/…` s parametrami, ktoré Meta nepublikuje. A nechceme ho: adresa, ktorá sama zazvoní
  cudziemu človeku, je to, čo Weft robiť nesmie. Weft otvorí chat, zavolá Karchi klikom v ňom.
- **Natívne appky:** na Linuxe existuje len Discord. Čo je na x270 nainštalované, som neprečítal.

**Verdikt:** prvý krok. Lacné, bez nových prihlásení, a adresár chatov z neho použije aj cesta B.

### D. Notifikácia prichádzajúceho hovoru z mosta

**Ako by to šlo:** most zapíše do miestnosti udalosť hovoru, Weft ju rozpozná a ukáže pruh „Volá ti X“ s
tlačidlom, ktoré otvorí tú sieť na tom chate.

**Pokus:** napísal som rozpoznávač `callOf(ev)` (príloha) a pustil ho na 13 udalostí zostavených presne
podľa zdrojákov mostov a na živú históriu. 13 z 13 správne (prichádzajúci, zmeškaný, ukončený s dĺžkou, video). Zo
31 živých správ so slovami call, hovor, missed, incoming, started, video neoznačil ako hovor žiadnu. Ručne
napísaná veta „Incoming call. Use the WhatsApp app to answer.“ hovorom nie je, lebo nemá
`com.beeper.action_message`. Discord „started a call“ značku nemá a tú istú udalosť dá aj `/me started a
call` napísané človekom, takže ho rozpoznávač za hovor neberie a v chate ostane ako doteraz.

**Čo funguje:** riadok hovoru v chate a zmeškaný hovor ako neprečítaná položka pre udalosti, ktoré most
označí značkou (Discord teda nie). Na dnes nasadených mostoch ju dáva len WhatsApp; Messenger a Instagram až
po aktualizácii mautrix-meta.
WhatsApp udalosť má podľa zdrojáku prísť pri zvonení.

**Čo nefunguje:**

- **„Prijať“ je priveľký sľub.** Weft hovor nezdvihne; vie otvoriť sieť. Hovor zdvihne jej web, ak sa stihne
  načítať a ešte zvoní. Tlačidlo sa má volať „Otvoriť WhatsApp“. Systémová notifikácia na Linuxe sa nemá
  spoliehať na vlastné tlačidlá: stačí klik, ktorý prinesie Weft dopredu.
- **Udalosť hovorí len, že hovor začal.** Koniec zvonenia, zdvihnutie na telefóne ani odmietnutie žiadny most
  nepošle. Tuwunel navyše drží inkrementálny `/sync` aspoň 5 s (`server/cli/weft.py`), takže pruh príde
  neskoro a po prebudení notebooku môže ukazovať hovor, ktorý už nie je. Skutočné oneskorenie som nemeral,
  lebo živú udalosť hovoru som nenašiel.
- **Messenger:** upstream začiatok hovoru zahadzuje. Záplata na pár riadkov v `handleWAFBCall` by ho mohla
  premostiť; je to hypotéza, lebo aké hodnoty `event_type` pri zvonení chodia, zo zdrojáka nevidno.
- **Discord:** začiatok hovoru príde bez značky, na zvonenie sa bez záplaty mosta použiť nedá.
- **Instagram a Teams:** most zvonenie nevidí.
- **Okná čítania:** Weft správy zámerne drží. Či hovor smie zvoniť aj vtedy, rozhoduje Karchi.

**Verdikt:** riadky hovoru hneď v kroku 1. Zvonenie až v kroku 3 a len tam, kde skutočný hovor ukázal, že
udalosť príde včas.

### E. Vlastné WebRTC

**Ako by to šlo:** Weft by mal vlastný hovor (stránka s `RTCPeerConnection` alebo Element Call na LiveKite).
Na cudzie siete sa tým nedovolá; do chatu by poslal odkaz „Pripoj sa“ a druhá strana by ho otvorila v
prehliadači.

**Pokus:** tá istá stránka s hovorom v slučke v headless Chromiu na e540 so STUN serverom: spojené, tečie
zvuk aj obraz a vznikol aj verejný kandidát (`srflx`), takže UDP sa cez domáci NAT von dostane. V Electrone
na asuse verejný kandidát v prvých dvoch behoch nevznikol a v treťom áno (8 kandidátov `srflx`, priamo aj
s HTTP cez tunel); prečo nie vždy, som nehľadal. Funnel je v politike
tailnetu povolený (porty 443, 8443, 10000), Weft cez neho nejde a porty 443 a 10000 už slúžia T3.

**Čo funguje:** technika prehliadača. Hovor Weft↔Weft medzi Karchiho strojmi by šiel.

**Čo nefunguje:** druhému človeku to nezvoní, musí kliknúť na odkaz. Treba verejnú stránku so signalizáciou a
TURN server (asus je len na Tailscale). Odkaz v správe je navyše správa skutočnému človeku za Karchiho.

**Verdikt:** odložiť. Zmysel má len ako pozvánka na videohovor pre ľudí z rôznych sietí naraz; to Karchi
nežiadal.

### F. Web siete bežiaci na asuse, obraz a zvuk prenášaný do Weftu (zamietnuté)

Headless prehliadač na asuse by držal prihlásené weby a ich zvuk a obraz by sa cez vlastné WebRTC prenášal do
Weftu. Dalo by to hovor „vo Wefte“ na každom zariadení, aj v telefóne. Zamietam: prihlásená session bežiaca
nonstop na serveri vyzerá pre Metu ako automat, zvuk prejde dvoma kódovaniami a krehkosť je najväčšia zo
všetkých ciest.

## Odporúčané poradie

1. **Riadky hovoru a tlačidlo, ktoré otvorí chat na sieti** (C a časť D; len `app/`). Nasadí sa bez
   Karchiho, nič sa neprihlasuje.
2. **Okno hovoru, najprv Messenger** (B; `desktop/`). Po Karchiho áno na rozhodnutia 1 a 2 nižšie; shell na
   x270 aktualizuje on. Ďalšie siete do okna až podľa toho, ako pilot dopadne.
3. **Zvonenie** pre WhatsApp, až keď jeden skutočný hovor ukáže, kedy udalosť mosta príde.
4. **Mosty** po Karchiho áno: vlastný Teams most (záznam hovoru zo systémových správ; len číta, čo Graph
   už vracia), mautrix-meta na upstream main (až potom majú riadky hovoru z kroku 1 čo ukázať na Messengeri
   a Instagrame), prípadne záplata na začiatok hovoru; čítanie telefónu pre WhatsApp. Keď Karchi povie áno
   skôr, aktualizácia mosta môže ísť hneď po kroku 1.
5. **Discord natívne** (`discord://`) ako voľba, ak ho Karchi na x270 má.
6. E a A nie, kým o ne Karchi nepožiada. Okná na pozadí nie.

## Krok 1 podrobne (pre Opus)

**Cieľ:** hovory sú v chate vidieť ako hovory a z otvoreného chatu sa Karchi jedným tlačidlom dostane na ten
istý chat na sieti, kde hovor spustí sám. Mení sa len `app/`.

1. **Rozpoznanie.** `callOf(ev)` z prílohy do `app/app.js`. Rozhoduje značka `com.beeper.action_message`,
   nikdy samotný text. Discord „started a call“ značku nemá a ostáva emote ako dnes. Výsledok nezávisí od
   času: čerstvosť zvonenia pridá až krok 3. Na dnes nasadených mostoch značku posiela len WhatsApp pri
   prichádzajúcom hovore; tvary Messengera a Instagramu sú z upstream zdrojáku a v Karchiho chatoch sa
   objavia až po aktualizácii mosta (rozhodnutie 4). Na testoch to nič nemení, bežia na vymyslenom `/sync`.
2. **Riadok hovoru.** V bubline (`bubbleBody`/`textMessage`) namiesto anglickej vety riadok s ikonou:
   „Prichádzajúci hovor“, „Zmeškaný hovor“, „Hovor 3:12“, „Videohovor 3:12“, s časom ako ostatné správy.
   Záznam bez dĺžky (`seconds: null`, napríklad Instagram „… started a video chat“) je len „Hovor“ alebo
   „Videohovor“: rozpoznávač z neho nevie, či hovor ešte trvá. To isté v náhľade riadku inboxu. Riadok
   hovoru je správa ako každá iná: podržaný chat ho ukáže až v okne čítania a v kroku 1 nič nezvoní.
3. **Adresa chatu.** `callTarget(room)` vráti `{ network, url }` z `m.bridge` (`protocol.id`, `channel.id`,
   pri Discorde `network.id`); pri spojenom chate pre sieť zvolenú prepínačom pri poli správy. Počet ľudí v
   miestnosti nerozhoduje o ničom.

   | Sieť | Adresa | Kedy `null` |
   |---|---|---|
   | Messenger | `https://www.messenger.com/t/<id>` | id nie sú len číslice |
   | Instagram | `https://www.instagram.com/direct/t/<id>/` | id nie sú len číslice |
   | Discord DM a skupinové DM (`m.bridge` bez `network.id`) | `https://discord.com/channels/@me/<channel.id>` | `channel.id` nie sú len číslice |
   | Discord kanál servera (`network.id` je id servera) | `https://discord.com/channels/<network.id>/<channel.id>` | `channel.id` alebo `network.id` nie sú len číslice |
   | WhatsApp | `https://web.whatsapp.com/` (zoznam chatov; telefón miestnosť nenesie) | |
   | Teams, EduPage, maily, archív | | vždy |

4. **Tlačidlo.** V hlavičke chatu (`chead`) jedno tlačidlo s ikonou telefónu (pixelarticons `phone`, pridať
   do `app/icons.js`) a názvom „Hovor: otvoriť v Discorde“ (podľa siete), len keď `callTarget` niečo vráti;
   to isté v palete (Ctrl+J). Otvorí `window.open(url)`, čo shell pošle do prehliadača. Jedno tlačidlo, nie
   Hlas a Video: Weft len otvára chat, hovor a jeho druh spustí Karchi tam. Tlačidlo je dostupné aj mimo okna
   čítania: je to jeho zámerný krok do prehliadača, ktorý má aj bez Weftu. V shelli (`window.desktop`) sa pri
   Messengeri a Instagrame tlačidlo ukáže až s oknom hovoru (`desktop.call`, krok 2): prehliadač x270 by tam
   narazil na jeho blok a tlačidlo by viedlo do slepej uličky.
5. **Texty** v `T()` s angličtinou v `app/i18n-en.js`; vzhľad podľa `DESIGN.md`.

Mimo kroku 1: `weft read` (vypíše anglickú vetu mosta ako doteraz), Teams, telefón pre WhatsApp, zvonenie.

**Hotové keď** (každé sa dá overiť bez hovoru; testy bežia v staged appke s vymysleným `/sync`, nie na
Karchiho dátach, a skúšajú `callOf` a `callTarget` appky, nie kópiu v `overenie/`; vzor harnessu, ktorý
pridá udalosti do prvého `/sync` a každý ne-GET zachytí, je `overenie/polls-members.cjs` a
`overenie/agent-drafts/ui.cjs` v hlavnom checkoute; udalosti sú v prílohe):

1. Udalosť WhatsApp „Incoming call…“ so značkou `com.beeper.action_message` sa v chate ukáže ako
   „Prichádzajúci hovor“; tá istá veta bez značky ako obyčajná správa; „Missed video call“ ako „Zmeškaný
   hovor“ s ikonou kamery; „Audio call (3:12)“ ako „Hovor 3:12“; Instagram „X started a video chat“ so
   značkou ako „Videohovor“ bez dĺžky; Discord emote „started a call“ ako emote.
   Náhľad v inboxe má ten istý slovenský text.
2. V podržanom chate (okno čítania zavreté) sa riadok hovoru ani jeho náhľad neukáže skôr ako ostatné správy.
3. `callTarget` dá presne adresu z tabuľky pre: Messenger DM, Instagram DM, Discord DM, Discord skupinové DM
   (viac ľudí, bez `network`: `@me`), Discord kanál servera s jediným ďalším členom (adresa servera, nie
   `@me`), WhatsApp DM s id `…@lid`; `null` pre Discord kanál, ktorého `channel.id` nie sú číslice, pre Teams,
   EduPage, mail a miestnosť bez `m.bridge`.
4. V Discord DM je v hlavičke tlačidlo s názvom pre čítačku, Tab naň príde, Enter zavolá `window.open` s
   adresou toho chatu (test `window.open` zachytí, nič sa neotvorí). V EduPage chate tlačidlo nie je. V
   spojenom chate ide adresa za zvolenou sieťou. S vymysleným `window.desktop` bez `call` tlačidlo v
   Messenger chate nie je, bez `window.desktop` je.
5. `tools/ui-check` a `tools/i18n-check` prejdú; `overenie/rewrite/behave.cjs` ostane zelené.
6. Na skutočných dátach len na čítanie (tunel, každý ne-GET zachytený): `callTarget` má adresu pre väčšinu
   Messenger, Instagram a Discord miestností. V noci 19. 11. to bolo 169 zo 170, 48 zo 49 a 107 zo 107; čísla
   sa menia, kontrola pýta aspoň 95 %. Pri Discorde sa adresa musí zhodovať s `channel.external_url` z
   `m.bridge` v každej miestnosti, ktorá ho má.
7. 👁 Karchiho oko: ako riadok hovoru a tlačidlo vyzerajú (snímka vedľa `DESIGN.md`).

## Krok 2 v skratke: okno hovoru (po Karchiho áno)

- `desktop/preload.js` pridá `desktop.call({ network, id })`; adresu zostaví `main.js` z overeného id (len
  číslice, pevná šablóna), nie appka. Volať smie len hlavný rámec okna Weftu: pôvod ako pri `collect` a
  navyše `event.senderFrame === main.webContents.mainFrame` (samotný pôvod vnorený rámec neodlíši).
- Jedno okno na sieť, na požiadanie; pri zatvorení sa zničí. Profil `persist:call-<network>`, oddelený od
  prihlasovacích okien a od mosta, nikdy sa nemaže sám. Cesta von: Nastavenia → Účty → „Odhlásiť okno
  hovorov“ profil zmaže.
- Okno nemá `preload` (žiadne `window.desktop`). Identita ako prihlasovacie okná (`CHROME_UA`, `presentAs`).
- Zámok povolení: `setPermissionRequestHandler` aj `setPermissionCheckHandler` s predvoleným odmietnutím;
  `media` (a `fullscreen`) len pre vymenované HTTPS pôvody siete (presná zhoda celého pôvodu, nie vzor; zdieľanie
  obrazovky postavené nie je),
  podľa adresy rámca, ktorý žiada; žiadosť bez nej sa zamietne (príloha).
- Zámok na chat: `will-navigate`, `will-redirect`, `did-navigate-in-page` a `setWindowOpenHandler` pustia
  len cestu toho chatu (`/t/<id>`, `/e2ee/t/<id>`), jeho hovor (`/groupcall/`) a stránky prihlásenia a kontroly účtu na
  vymenovaných HTTPS pôvodoch. Iná cesta vráti okno na chat. Okno, ktoré stránka otvorí (hovor Messengera),
  dostane tie isté zámky (`did-create-window`), inak by sa z neho dalo odísť kamkoľvek. Úzke okno (okolo
  420 px), aby web ukazoval len konverzáciu.
- **Podmienka nasadenia:** cesta ani šírka okna nezaručia, že web neukáže zoznam ostatných chatov. Po
  Karchiho prihlásení sa pozrie on, čo okno ukazuje. Kým zámok na jeden chat nedrží, okno sa nenasadí ako
  hotové a Karchi sa rozhodne, či ho chce aj tak.
- Tunel pre Messenger vždy cez asus (`openTunnel`), držaný, kým okno žije. Keď tunel nevznikne, okno ukáže
  chybu; priame spojenie ako pri prihlasovacích oknách tu nie je. `setWebRTCIPHandlingPolicy` predvolená.
- Kontroly bez hovoru: `SPRAVY_SELFTEST=call` pod Xvfb na miestnej stránke (kamera a mikrofón pre povolený
  pôvod, `NotAllowedError` pre iný, popup zdedí session, navigácia a presmerovanie mimo chatu sa vráti, aj v
  popupe, cookie prežije
  reštart a prihlasovacie okno ju nevidí, bez tunela chyba). Základ je v `overenie/hovory/shell.js`.
- Prihlasuje sa Karchi sám; agent sa do žiadnej siete neprihlasuje a nikomu nevolá. Zvuk a kameru si Karchi
  overí bez volania človeku: Teams má skúšobný hovor („Make a test call“), na Discorde vlastný prázdny server
  s hlasovým kanálom. Messenger a WhatsApp skúšobný hovor nemajú.

## Krok 3: zvonenie (postavené 19. 11. 2026)

Karchi 19. 11.: „Smie zvoniť, ale vytvor na to nastavenie, či aj hovory zastaviť alebo iba správy.“

- Len z inkrementálneho `/sync` po prvom, raz na udalosť, len kým je čerstvá (do 45 s od `origin_server_ts`):
  okno v rohu „Volá ti X“ (sieť, videohovor) s „Otvoriť WhatsApp“ a „Zavrieť“ (aj Esc), tón a, keď Weft nie je
  vpredu, systémová notifikácia bez vlastných tlačidiel. Zmizne po 45 s, po ďalšej udalosti hovoru v chate
  alebo po kliknutí. Riadok hovoru v chate čaká so správami vždy.
- Nastavenia → Správy → Hovory a Ctrl+J (`sk.karchi.calls` `ring`): „Zvoniť vždy“ (predvolené, aj keď správy
  čakajú), „Len keď správy nečakajú“ (hovor počká so správami; ľudia „Práca“ a hovor počas okna zazvonia),
  „Nezvoniť“. Platí hneď, lebo neukáže nič, čo už čaká.
- Zvoní len WhatsApp (jediný most, ktorý hovor počas zvonenia ohlási). Či udalosť príde včas, ukáže až skutočný
  prichádzajúci hovor (rozhodnutie 5).
- Kontrola bez hovoru: `overenie/hovory/zvonenie.cjs` (falošný `/sync`, zachytené notifikácie a zvuk).

## Karchiho rozhodnutia a kroky

1. **Messenger na x270 v okne Weftu, áno alebo nie?** `facebook.com` si tam blokuje sám. Okno by bolo
   zamknuté na jeden chat a hovor a šlo by cez asus; ten chat by v ňom videl hneď, aj keď ho Weft drží do
   okna čítania. Inú cestu, ako z x270 volať cez Messenger a Instagram, som nenašiel.
   **19. 11.: áno** („Okno hovoru v desktope, a potom pre ostatné platformy to skús“); okno je v `main`
   (PR #23). **20. 11. pri prechádzaní inboxu prišlo opačné:** „okno Messengera na x270 nerob (blok FB)“.
   Okno už postavené je, preto som k nemu 20. 11. nič nepridal ani neubral. Či má pre Messenger ostať,
   vypnúť sa, alebo zmiznúť, je otázka na Karchiho.
2. **Druhé prihlásenie do Messengera v tom okne** (most ostáva prihlásený zvlášť). Ide o jeho účet.
   **20. 11.: podľa plánu**, teda len v okne, oddelene od mosta, a prihlasuje sa Karchi sám; agent nikdy.
   Platí, len kým okno ostáva.
3. **Smie hovor zvoniť, aj keď sú správy podržané** (okná čítania)? Rozhodnuté 19. 11.: smie, s nastavením (krok 3).
4. **Zásah do mostov.** Aktualizácia mautrix-meta minule spustila 133 nových DM; áno má platiť aj na to.
   Čítanie telefónu pre WhatsApp znamená, že Weft dostane súkromné čísla jeho kontaktov z databázy mosta.
   **20. 11.: áno, v odporúčanom poradí** (sekcia „Mosty“ nižšie).
5. **Dohodnuté hovory.** Po kroku 2 jeden na Messengeri; pred krokom 3 jeden prichádzajúci na WhatsAppe,
   aby bolo vidieť, kedy udalosť mosta príde. Volá Karchi sám a niekto, s kým sa dohodol; agent nevolá
   nikdy. Jediný spôsob, ako overiť to, čo je nižšie.
   **20. 11.: skúšobný hovor s človekom až s Karchim.** Postup je v sekcii „Stav“ („Čo ostáva na Karchim“).

## Mosty (od 20. 11. 2026)

- **Teams: postavené.** Vlastný most (`server/microsoft/bridge.py`, `call_log`) číta systémovú správu Graphu
  o ukončenom hovore alebo mítingu (`callEndedEventMessageDetail`) a pošle ju do miestnosti ako riadok hovoru
  v tvare, aký appka už pozná: text „Call (3:12)“ so značkou `com.beeper.action_message`, od toho, kto hovor
  začal. Graph hovorí, kto ho začal a ako dlho trval; či šlo o video a či ho niekto zdvihol, nehovorí, takže
  zmeškaný hovor sa od ukončeného nedá odlíšiť a hovor bez dĺžky je len „Hovor“. Začiatok hovoru, zdieľanie
  obrazovky a ostatné systémové správy do miestnosti nejdú. Kontrola proti falošnému Microsoftu:
  `overenie/microsoft/check.py` (štyri nové prípady). Tvar správy je z dokumentácie Graphu; živú ukážku
  nemám, lebo Teams účet nie je pripojený.
- **mautrix-meta (Messenger a Instagram).** Záznamy hovorov sú v upstreame: Instagram a nešifrovaný Messenger
  od v26.11 (16. 11.), šifrovaný Messenger až v `main` po vydaní (17. 11.). Naše mosty bežia na vlastných
  zostaveniach so záplatami (archív, opätovné prihlásenie, galéria), Instagram ešte na základe v26.10.
  Aktualizácia teda znamená preniesť záplaty na upstream `main`, zostaviť oba mosty a vymeniť ich so zálohou
  binárok a databáz.
- **Začiatok hovoru na Messengeri** (zvonenie) ostáva hypotéza: záplatu má zmysel písať až po skúšobnom
  hovore, ktorý ukáže, aké udalosti chodia.
- **Telefón pre WhatsApp** (tlačidlo by otvorilo chat namiesto zoznamu chatov): zatiaľ nepostavené.

## Čo sa bez hovoru overiť nedalo

- Či web siete po prihlásení v Electrone hovor naozaj povolí a spojí.
- Či Messenger z x270 cez tunel hovor spojí, a čo v sieti, kde je UDP blokované.
- Či druhé prihlásenie vyvolá kontrolu účtu alebo odhlási most.
- Kamera, mikrofón, bluetooth slúchadlá a zdieľanie obrazovky na Hyprlande.
- Aké udalosti mosty pri skutočnom hovore posielajú a s akým oneskorením.
- Či Instagram web hovory Karchiho účtu ponúka.
- Čo je na x270 nainštalované (natívny Discord, obsluha `discord://`, verzia Electronu).

## Council

Kolo 1 posudzovalo návrh pred napísaním plánu: Claude Opus 5.5 a GPT Sol 6.2. Tretí člen nebežal: Kimi K3.1
Pro narazil na päťhodinový limit OpenCode Go a jeho náhrada DeepSeek V4.1 Flash Free na limit bezplatného
modelu.

Z prvého kola je v pláne: okno hovoru až ako druhý krok a po Karchiho rozhodnutí (obchádza jeho blok Facebooku
a okná čítania); „Otvoriť“ namiesto „Prijať“; žiadne okná na pozadí; adresu zostavuje hlavný proces z
overeného id; okno bez `preload`, s predvoleným odmietnutím povolení a bez priameho spojenia pri výpadku
tunela; záznam hovoru z Teams systémových správ; zvonenie až po overení živého signálu; skúšobný hovor Teams
a vlastný Discord server ako test bez volania človeku.

Kolo 2 posudzovalo hotový dokument (Opus 7/10, Sol 7/10). Z neho je v pláne: záver hovorí priamo, že krok 1
dá na x270 presný chat len na Discorde; tlačidlo chat otvára, nevolá; Discord „started a call“ sa za hovor
neberie, lebo nemá značku; rozpoznávač nezávisí od času; Teams v kroku 1 nie je; testovacie udalosti sú v
prílohe; tvrdenia o weboch sietí sú označené ako neoverené; zámok okna na jeden chat je podmienka nasadenia.

Kolo 3 posudzovalo opravený dokument (Opus 8,5/10, Sol 8/10). Obaja našli chybu v adrese Discordu: plán
nehovoril, odkiaľ je id servera, a pokus rátal za úspech aj nesprávne adresy. Opravené a prepočítané (cesta
C). Ďalej z neho: zámok povolení berie len adresu žiadajúceho rámca, zámok na chat platí aj pre
presmerovania a popupy, Instagram „started a video chat“ je medzi testovacími udalosťami, a tvrdenia podľa
zdrojáku či dokumentácie sú tak aj označené.

Kolo 4 posudzovalo tieto opravy (Opus 9/10, Sol 9/10). Z neho: zámok povolení porovnáva celý pôvod s
vymenovaným zoznamom namiesto vzoru na meno hosta, a Instagram záznam je aj v „Hotové keď“. Ďalšie kolo som
nepúšťal.

Nezávislý overovateľ (Codex na asuse) potom našiel dve tvrdenia, ktoré dôkazy nepodporovali, a obe som
opravil: záznamy hovorov z Instagramu a nešifrovaného Messengera nasadený most ešte nevie (sú len v upstream
zdrojáku), a verejný kandidát v Electrone na asuse v treťom behu vznikol.

Kolo 5 (Opus, stavba, 19. 11.) posudzovalo návrh stavby pred kódom: Opus 7/10, Sol a Kimi nebežali (limity).
Z neho sú odchýlky kroku 1 v sekcii „Stav“.

Kolo 6 posudzovalo hotové diffy oboch PR:

| Recenzent | krok 1 (`app/`) | krok 2 (`desktop/`) |
|---|---|---|
| Claude Opus 5.5 | 8/10 | 6/10 |
| GPT Sol 6.2 | 8/10 | 5/10 |
| DeepSeek V4.1 Flash Free (náhrada za Kimi, Go bol na limite) | 8,5/10 | 7/10 |

Opravené: priame spojenie mimo tunela pri druhom kliknutí počas štartu alebo po zlyhaní tunela (všetci traja);
mŕtve okno po páde tunela; zavretie okna chatu zabilo tunel aj popup s hovorom; odhlásenie nezavrelo popupy;
krok späť v histórii obišiel zámok; úvodná stránka Messengera (zoznam všetkých chatov) bola povolená stále;
Ctrl+J ponúkal hovor aj chatu bez cieľa; chyba okna len po slovensky v anglickom Wefte; `selftest.sh` skrýval
návratový kód; test prihlasovacieho okna čítal nepoužitú partition; sonda na živý messenger.com bola v repe.

Neprijaté, s dôvodom: viazať `/groupcall/` na chat (id hovoru s id chatu nesúvisí a bežiaci hovor musí prežiť
otočenie okna na iný chat); vyhodiť tlačidlo WhatsAppu, adresu kanála servera v `callTarget` a pokusy v prílohe
(plán ich chce, pokusy sú žiadaný záznam); „Prichádzajúci hovor“ pri starom zázname WhatsAppu (rovnaký štítok
ako v zozname hovorov telefónu). Zoznam sietí okna z hlavného procesu kolo 6 odložilo; v kole 7 prišiel
s Instagramom (`sendSync` v `preload`).

Druhý nezávislý overovateľ (po kole 8, 125 PASS) našiel: klik na chat, keď v okne samom beží jeho hovor, chat
znovu načítal; obchádzka presmerovaní (chat, prihlásenie, iný chat) urobila z iného chatu alias; krok späť po
prepnutí chatu na chvíľu ukázal predošlý chat; dve vety plánu boli zastarané. Všetko opravené a v teste. Jeho
druhý beh (126 PASS, vlastné pokusy potvrdili opravy) našiel ešte: krok späť, kým sa nový chat ešte načítava;
odkaz inam zo stránky hovoru v okne samom znovu načítal chat; úvodná stránka sa dala otvoriť aj zo stránky
hovoru. Opravené a v teste (test kroku späť so starým kódom padá). Tretí beh (131 PASS) našiel: rýchly klik späť
na chat, ktorý okno ešte ukazuje, kým sa iný načítava, nechal ten iný na chvíľu ukázať; `pushState` na iný chat
zo stránky hovoru v okne samom hovor zahodil; veta kola 6 o zozname sietí bola zastaraná. Opravené a v teste (oba testy
so starým kódom padajú). Štvrtý beh (131 PASS, potvrdil opravy tretieho) našiel ešte dva prípady s hovorom v okne
samom počas prepínania na iný chat: krok späť ukázal chat hovoru a klik na chat hovoru hovor zahodil. Opravené a
v teste (so starým kódom padajú). Neprijaté: `replaceState` na iný chat zo stránky hovoru (stránku bez
znovunačítania vrátiť nejde, iný chat ukázať nesmie) a prázdny popup `about:blank`, ktorý sa nikam nepohne
(neukazuje nič; zatvárať ho časovačom by mohlo zabiť hovor, ktorý sa v ňom práve začína). Piaty beh (131 PASS,
potvrdil opravy štvrtého) našiel: kým sa iný chat načítaval, odkaz z chatu na obrazovke prešiel na úvodnú
stránku; rýchly klik späť na chat pod inou adresou (šifrovaný) ho znovu načítal; test obchádzky kontroloval až
po dvoch prepnutiach; postup hovoru nekázal prijatý hovor overiť. Opravené a v teste (oba testy so starým kódom
padajú; odkaz skutočným klikom, lebo skript bez neho vlastné načítanie okna nezruší). Šiesty beh (potvrdil
opravy piateho, plán a postup hovoru sedia) našiel: opätovný klik na chat zrušil stránku hovoru, ktorá sa v okne
ešte načítavala. Klik teraz zastaví len načítanie iného chatu; opravené a v teste (so starým kódom padá).
Siedmy beh (138 PASS, potvrdil opravy šiesteho) našiel: klik na ten istý chat počas prihlásenia načítal
prihlásenie znova a zmazal formulár. Opravené a v teste (so starým kódom padá). Ôsmy beh (potvrdil opravu
siedmeho) našiel: druhý klik, kým okno ešte čakalo na stránku prihlásenia, načítanie začal znova; a `run.sh` by
pri páde Electron testu ohlásil ALL OK. Opravené a v teste (so starým kódom padá); `run.sh` je v `overenie/`.

Po kole 6 nezávislý overovateľ (Codex na asuse, 107 PASS) našiel ešte popup, ktorý po páde tunela ostal otvorený,
keď okno chatu už bolo zavreté: opravené a v teste. Jeho ďalšie dva body sú úmyselné: zvuk a obraz idú mimo
tunela (inak hovor nevznikne) a vnorené rámce riadi stránka siete, nie Karchi.

Kolo 7 posudzovalo návrh pre ďalšie siete (Opus 6/10, Sol 6/10; Kimi narazil na týždenný limit OpenCode Go).
Z neho: Discord do okna nie (prehliadač stačí, hovor v stránke by návrat ohrozil); Instagram `/` je feed, takže
úvodné stránky sú len prechodné, okno na nich nikdy neostane; návrat po pohybe v stránke krokom späť bez
znovunačítania; test siete, ktorá prepíše id chatu; `/call/` aj v povolených stránkach popupu; WhatsApp a Teams
nestavať. Neprijaté: šírka okna ako nastavenie siete (zatiaľ jedna pre obe, uvidí sa pri prihlásení),
odovzdať zoznam sietí cez `additionalArguments` (zoznam ide z hlavného procesu cez `sendSync`; sandboxovaný
preload `process.argv` nemá spoľahlivo).

Kolo 8 posudzovalo diff #23 s Instagramom (Opus 7/10, Sol 5/10, DeepSeek V4.1 Flash Free 7/10). Opravené: popup smel ostať na
chate či prihlásení; druhý klik na ten istý chat a odmietnutý odkaz stránku znovu načítali (rozpísaná správa,
hovor v stránke); úvodná stránka sa dala otvoriť aj z chatu; pád tunela počas štartu mohol prepísať vysvetlenie
alebo nechať okno prázdne; presmerovanie na šifrovaný chat by okno zacyklilo; stránka prepisovala názov okna;
testy navigácie mohli prejsť skôr, než sa niečo pohlo; tunel, ktorého štart hodil chybu, ostal pokazený do
reštartu; zavretý Weft počas hovoru nechal appku bežať bez cesty späť (teraz jedna inštancia: ďalšie spustenie
ukáže okno); popup `/call?…` a `/groupcall` bez lomítka by sa neotvoril; klik po „stále odchádza z chatu“ skončil
v tej istej chybe. Neprijaté, s dôvodom: SPA môže ukázať iný obsah bez zmeny
adresy (zámok drží cestu, nie obsah, preto podmienka nasadenia); úvodná stránka na ceste dnu na chvíľu blikne
(prihlásenie ňou musí prejsť); pád tunela
ukončí aj bežiaci hovor (bez tunela stránka stratí spojenie so sieťou tak či tak); odkaz `target=_blank` z chatu
sa len zapíše do logu, prehliadač x270 by väčšinu odkazov Mety aj tak neotvoril; trieda okna je „Správy“ ako
Weft (Electron ju má jednu na appku), pravidlo Hyprlandu preto podľa názvu; s `SPRAVY_LOGIN_VIA=` (bez tunela)
okno hovoru neide vôbec, úmyselne; `collect` (prihlasovacie okná) má starší strážca IPC, mimo tohto PR.

Kolo 9 posudzovalo diff Discord bety (Opus 7/10, DeepSeek V4.1 Flash Free 7/10 namiesto Kimiho, ktorý narazil
na týždenný limit OpenCode Go; Sol nebežal: oba účty Codexu na limite, Codex na asuse neprihlásený). Opravené:
rýchly klik späť na DM v okne zavolal na ten DM (lístok kliku teraz nesie svoj chat); prihlásenie do 20 s
zavolalo samo; shell prijal Discord aj bez bety (staršia appka by volala); zatvorené okno počas hľadania tlačidla
mohlo hodiť chybu v hlavnom procese; zoom stránky posunul klik; 20 s sa rátalo až od načítania (teraz 30 s od
kliku); klik po ceste kurzora mohol padnúť vedľa tlačidla, ktoré sa medzitým pohlo (pred stlačením nové
overenie); vypnutá beta zakladala profil Discordu; anglický text; plán opisuje riziko, skupiny a zloženie
hovoru poctivejšie; testy pre všetko to (so starým kódom padajú) a pre Ctrl+J a vypnutie bety v appke.
Neprijaté: znova stlačiť hovor po kliku na DM, ktorý je v okne už otvorený (hovor tam môže bežať a druhé
stlačenie by ho zložilo); potvrdenie pred hovorom v skupinovom DM (Karchi chcel klik bez otázok; rozhodne on).

Nezávislý overovateľ Discord bety (180 PASS) našiel: presmerovanie DM na iný DM urobilo z iného DM alias a okno tam
zavolalo; prekrytie, ktoré nechalo voľný len stred tlačidla, dostalo klik (posledná kontrola brala obdĺžnik
tlačidla, nie bod); tlačidlo tesne pred koncom 30 s dostalo klik po čase (čas sa nekontroloval tesne pred
stlačením); stránka otvorila prázdny popup napriek „popup žiadny“. Všetko opravené a v teste (so starým kódom
padajú). Druhý beh (184 PASS) našiel: stránka sama prešla na iný DM a zámok vrátil len adresu, takže na obrazovke
mohlo ostať tlačidlo iného DM (teraz každé odmietnutie zámku zruší hovor toho kliku); neviditeľné tlačidlo
(`opacity: 0`, aj cez rodiča) dostalo klik; požiadavky stránky na 127.0.0.1 išli mimo tunela priamo na x270 (teraz
`<-loopback>`, idú tunelom ako všetko); voliteľné pravidlo Hyprlandu by zúžilo aj okno Discordu. Opravené a v teste
(so starým kódom padajú). Tretí beh (186 PASS) našiel: stránka prešla na iný DM medzi stlačením a pustením a
pustenie dalo klik tomu istému tlačidlu, už pre iný DM (teraz pred pustením nová kontrola a pustenie mimo stránky);
presmerovanie cez `/login` hneď späť na DM nechalo hovor kliku živý (teraz ho ruší aj prihlásenie na ceste); skrytá
kópia tlačidla pred viditeľným zabránila stlačeniu. Opravené a v teste (so starým kódom padajú). Štvrtý beh (189
PASS) našiel: tlačidlo pod `filter: opacity(0)` dostalo klik; tlačidlo v zakázanom `fieldset` klik zahodilo a hovor
kliku sa minul. Opravené a v teste (so starým kódom padajú). Piaty beh (190 PASS) našiel: cesta na prihlásenie,
ktorá sa nikdy neukáže (odpoveď 204), nechala hovor kliku živý; Karchiho vlastné stlačenie tlačidla počas čakania
by okno zopakovalo; stránka sa mohla sama prepnúť na prázdnu `about:blank` a okno tam ostalo. Opravené a v teste
(so starým kódom padajú). Šiesty beh (193 PASS) našiel, že stránka Karchiho stlačenie nezachytí, kým sa ešte
načítava, ani stlačenie klávesom Enter: teraz ho sleduje hlavný proces (`input-event`, okno svoje stlačenia
odráta). Opravené a v teste (so starým kódom padajú). Neprijaté: ďalšie spôsoby, ako tlačidlo skryť (`mask`,
`clip-path`, priehľadná farba); kontrola je pre skutočnú stránku Discordu, nie pre stránku, ktorá sa chce nechať
kliknúť.

## Príloha: pokusy

Skripty sú v `overenie/hovory/` tohto worktree na e540 (mimo gitu, ako všetko v `overenie/`).

| Skript | Čo robí | Kde bežal |
|---|---|---|
| `shell.js` + `page.html` | okno hovoru v Electrone: zámok povolení, popup, slučka WebRTC, SOCKS tunel, šesť webov odhlásených | asus, `tools/browser-slot xvfb-run -a electron --no-sandbox shell.js` |
| `callevents.py` | tvar udalostí hovoru v živých miestnostiach, `m.call.*`, TURN, MatrixRTC | asus, token `weft`, len čítanie |
| `deeplinks.py`, `deeplinks2.py`, `deeplinks3.py` | adresa chatu z `m.bridge` po sieťach, telefóny pri WhatsAppe, id servera na Discorde | asus, len čítanie |
| `callof.mjs` | rozpoznávač udalostí hovoru na syntetických a živých udalostiach | asus |
| `loop.cjs`, `stun.py` | slučka WebRTC v headless Chromiu so STUN, odpoveď STUN | e540, asus |

Rozpoznávač (pokus D), ako ho má dostať `app/app.js`:

```js
/** What a bridged event says about a call, or null. Only events a bridge marked as a call count; the text alone never does. */
function callOf(ev) {
  const c = ev.content || {};
  const act = c['com.beeper.action_message'];
  if (act?.type !== 'call') return null;
  const body = c.body || '';
  const video = act.call_type === 'video' || /video/i.test(body);
  if (/^Incoming\b/.test(body)) return { state: 'incoming', video }; // mautrix-whatsapp
  if (/missed/i.test(body)) return { state: 'missed', video };
  const m = /\((?:(\d+):)?(\d+):(\d\d)\)\s*$/.exec(body);
  return { state: 'ended', video, seconds: m ? (+(m[1] || 0)) * 3600 + +m[2] * 60 + +m[3] : null };
}
```

Udalosti, na ktorých prešiel (obsah `content`; `mark(t)` je `'com.beeper.action_message': { type: 'call',
call_type: t }`), zostavené podľa zdrojákov mostov:

| Odkiaľ | `content` | Výsledok |
|---|---|---|
| WhatsApp, hovor 1:1 | `m.text` „Incoming call. Use the WhatsApp app to answer.“, `mark('')` | `incoming` |
| WhatsApp, videohovor | `m.text` „Incoming video call. Use the WhatsApp app to answer.“, `mark('video')` | `incoming`, video |
| Messenger šifrovaný, zmeškaný | `m.text` „Missed audio call“, `mark('voice')` | `missed` |
| Messenger šifrovaný, zmeškaný video | `m.text` „Missed video call“, `mark('video')` | `missed`, video |
| Messenger šifrovaný, ukončený | `m.text` „Audio call (3:12)“, `mark('voice')` | `ended`, 192 s |
| Messenger šifrovaný, dlhý | `m.text` „Video call (1:02:03)“, `mark('video')` | `ended`, video, 3723 s |
| Instagram, záznam s vlastným titulkom | `m.text` „Video chat ended“, `mark('video')` | `ended`, video, bez dĺžky |
| Instagram, záznam o začatom hovore | `m.text` „X started a video chat“, `mark('video')` | `ended`, video, bez dĺžky (riadok „Videohovor“) |
| Discord, správa typu CALL | `m.emote` „started a call“, bez značky | `null` |
| Discord, `/me` napísané človekom | `m.emote` „started a call“ s `formatted_body`, bez značky | `null` |
| Bežná správa so slovom | `m.text` „I will call you, missed call yesterday“ | `null` |
| Veta mosta napísaná ručne | `m.text` „Incoming call. Use the WhatsApp app to answer.“, bez značky | `null` |
| Emote v inej sieti | `m.emote` „started a call“ | `null` |

Zámok povolení (pokus B), ako ho má dostať `desktop/main.js`:

```js
// Exact HTTPS origins per network, never a pattern: messenger.com.evil.net and http:// must not pass.
// The pilot starts with this one; add an origin only after a real call showed the page asks from it.
const CALL_ORIGINS = { messenger: ['https://www.messenger.com'] };
const mayUse = (url, permission) => ['media', 'display-capture'].includes(permission) && !!url && CALL_ORIGINS[network].includes(new URL(url).origin);
// Only the asking frame's own address counts: contents.getURL() is the top page, so a request without requestingUrl is refused.
ses.setPermissionRequestHandler((contents, permission, done, details) => done(mayUse(details.requestingUrl, permission)));
ses.setPermissionCheckHandler((contents, permission, origin) => mayUse(origin, permission));
```
