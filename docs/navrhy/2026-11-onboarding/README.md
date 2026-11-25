# Prvé pripojenie účtu: koľko histórie, kde a koľko miesta

Návrh pre ľudí, ktorí Weft spustia bez Beeperu a len si pripoja účty. Prechod z Beeperu rieši súbežne
`server/archive/import_beeper.py`; spoločné časti (odhad miesta, výber rozsahu) sú navrhnuté tak, aby ich použil aj
on. Napísal ho agent 24. 11. 2026 ako plánovací dokument a nadväzuje na [prevádzku](../2026-11-prevadzka/README.md):
Weft je softvér na vlastný server, takže „cloud“ nižšie znamená server používateľa (doma alebo VPS), nie službu.
Postavený je z neho len odhad miesta (`server/archive/estimate.py`), ostatné čaká na rozhodnutia na konci. Ako ľudí
prevedie sprievodca a ako sa to postaví, je v [pláne](plan.md) s GIFmi všetkých ciest.

## Krátko

- **Koľko histórie príde, dnes nikto nevyberá.** Každá sieť má svoje pevné číslo z konfigurácie mostu: Messenger,
  Instagram a WhatsApp 50 správ na chat, Discord 50 v DM a nič v kanáloch, Teams 20 na chat (len chaty zo 14 dní), EduPage celý školský
  rok. Gmail a Outlook naopak hneď po pripojení začnú sťahovať **celú** poštu, bez otázky a bez zastavenia.
- **Staršie správy** z Messengera a Instagramu dotiahne most po stránkach, keď človek v chate posúva nahor. WhatsApp,
  Discord a exporty Mety idú len ručným skriptom na serveri a k tomu treba Karchiho áno.
- **Cloud alebo lokálne si dnes vybrať nedá.** Všetko je na serveri a zariadenie má len vyrovnávaciu pamäť:
  posledných 80 správ každého chatu a najviac 3000 fotiek. Úplnú kópiu má len Karchiho x270 (rsync každú hodinu).
  „Len lokálne“ naozaj znamená mosty v zariadení (možnosť D v prevádzke). Pri dnešnej stavbe sa dá len „história aj v
  tomto počítači“ alebo „stará história len v počítači“ a obe majú háčiky (nižšie).
- **Odhad miesta je postavený:** `estimate.py` vopred povie počet správ a miesto za 30 dní, 3 mesiace, rok a celú
  históriu. Údaje berie z veľkostí, ktoré zdroj prezradí sám, bez sťahovania. Na skutočných exportoch odhadol
  Instagram na 1,8 GB a Messenger na 1,5 GB. Po importe tie isté exporty zaberajú 1,6 a 1,8 GB.
- **Najväčšia prekážka nie je história.** Nový človek bez EduPage dnes Weft vôbec nepoužije: po prihlásení ho Weft
  pustí len na obrazovku „Pripoj EduPage“ a tá sa nedá preskočiť.

## Sieť po sieti (stav 24. 11. 2026)

| Sieť | Ako sa pripája | Čo príde samo | Vyberie si človek? | Staršie správy | Kde to skončí | Čo chýba |
|---|---|---|---|---|---|---|
| **Messenger** | okno v desktopovej appke (cookies), len v nej | všetky chaty (`thread_backfill.batch_count: -1`), v každom posledných 50 správ (`max_initial_messages`) | nie | pri posúvaní nahor most stiahne ďalšiu stranu z Mety (patch `messenger-archivefetch`, strana raz za 2 s) a uloží ju do archívu aj s fotkami do 50 MB; export šifrovaných chatov (`messages.zip`) cez `import_messenger.py` ručne | homeserver (posledných 50), archív na serveri (všetko, čo prišlo alebo sa doťahalo), zariadenie 80 posledných | výber rozsahu; import exportu z appky; web bez desktopu text „na x270“ |
| **Instagram** | okno v desktopovej appke | len prvá strana chatov (`batch_count: 0`), ostatné keď príde správa; 50 správ na chat | nie | ako Messenger (patch `instagram-archivefetch`); export „Stiahnuť informácie“ cez `archive.py instagram` ručne | ako Messenger | ako Messenger; staré chaty bez novej správy sa neukážu, kým ich niekto neotvorí cez export |
| **WhatsApp** | QR kód (aj na webe), záloha kódom cez číslo | telefón pri spárovaní pošle **3 mesiace** (`request_full_sync: false`); most z nich spraví 50 chatov (`max_initial_conversations`) po 50 správ, zvyšok čaká v databáze mostu, médiá si vyžiada (`auto_request_media`) | nie, a **neskôr sa to zmeniť nedá**: rozsah (`full_sync_config.days_limit`, až asi 3 roky) sa pošle telefónu len pri spárovaní | `collect_history.py whatsapp` + `import_history.py` ručne prenesie zvyšok z databázy mostu do archívu; most ho po čase maže | homeserver, archív, zariadenie 80 | otázka „koľko histórie“ pred QR kódom |
| **Discord** | okno v desktopovej appke (token) | DM: 50 správ; kanály serverov: nič (`initial.channel: 0`), server sa zapína v Nastaveniach | servery áno, históriu nie | `collect_history.py discord` (len GET) ručne, súbory sa stiahnu až na klik | homeserver, archív (súbory na požiadanie), zariadenie 80 | rozsah; hromadné čítanie cez token je riziko banu, preto len s výslovným áno |
| **EduPage** | prihlásenie menom a heslom (jediné povinné, pri prvom spustení) | celý školský rok od 1. 9. (`school_year_start`), staršie ako 7 dní ako prečítané; potom 7 dní dozadu pri každom čítaní | nie, netreba: je to pár MB | – | jedna miestnosť na homeserveri, archív, zariadenie celé | **dá sa preskočiť?** Nie, a to blokuje každého, kto EduPage nemá |
| **Gmail** | Google (vlastný Desktop klient v `gmail/state/google-client.json`) alebo heslo aplikácie | **celá pošta** (All Mail), od najnovšej, 100 mailov na prechod a prechod každých 5 s, prílohy po 20 (`import_mail.py`); nové každých 5 min | nie | – (všetko príde samo) | len archív na serveri (`archive:gmail:…`), prílohy v `media/gmail/` | rozsah, pauza a stav („koľko ešte“); Google klient musí mať každý server svoj |
| **Outlook** | stránka Microsoftu (klient Graph CLI, bez vlastnej appky) | **celá pošta**, od najnovšej, 100 na stranu (`import_batch`) | nie | – | len archív | ako Gmail |
| **Teams** | ako Outlook | chaty aktívne posledných 14 dní (`FIRST_DAYS`), v každom 20 posledných správ (`FIRST_MESSAGES`), potom nové | nie | nič; Graph by dal aj staršie | homeserver (appservice), archív, zariadenie 80 | rozsah; oficiálne API, takže tu sa história dá bez rizika banu |

Spoločné pre všetky: archív raz za hodinu skopíruje všetko z homeservera (`archive.py mirror`), takže archív má
nadmnožinu. Homeserver drží všetko, čo mosty kedy preniesli, vrátane médií, a mazať nevie (Tuwunel, na asuse 3,4 GB).

### Ďalšie prekážky pri prvom spustení

1. **EduPage je povinná.** `show(S.logins.length ? 'main' : 'connect')` pustí do Weftu len s pripojenou EduPage.
   Riadok EduPage v Nastaveniach → Účty nemá tlačidlo Pripojiť, len Odhlásiť.
2. Prihlasovací formulár má predvyplnené meno `karchi`.
3. Messenger, Instagram a Discord sa dajú pripojiť len v desktopovej appke a na webe Weft píše „v desktopovej appke
   Weft na x270“.
4. Pripájanie je len v Nastaveniach → Účty, žiadny sprievodca. Človek po prihlásení nevie, že tam má ísť.
5. Gmail cez Google potrebuje vlastný OAuth klient servera. Bez neho ostáva heslo aplikácie, a to vyžaduje
   dvojstupňové overenie v Google účte.

## Cloud alebo lokálne

Dnes:

| Čo | Server | Zariadenie |
|---|---|---|
| mosty, prihlásenia do sietí | vždy (musia bežať stále: nové správy, odoslať neskôr, okná na čítanie, kódy z Gmailu) | nič |
| homeserver (Matrix miestnosti) | všetko, čo mosty preniesli, bez mazania | – |
| archív (`archive.db` + `media/`) | celá história | – |
| offline kópia | – | IndexedDB `weft-offline`: posledných 80 správ každého živého chatu a EduPage; staré chaty len z archívu nie; fotky do 8 MB, najviac 3000 (`sw.js`) |
| úplná kópia | `archive.py local` ju pripravuje každú hodinu | len x270 cez `weft-spravy.timer` (rsync; dnes 0,4 GB databáza, 0,1 GB textov, 4,8 GB médií) |

Čo by výber znamenal:

- **„Na serveri“** je dnešok. Vyhľadávanie, galéria, štatistiky v profile, `weft` pre agentov a každé zariadenie vidia
  celú históriu.
- **„Na serveri aj v tomto počítači“** zovšeobecňuje x270: desktopová appka by si sama sťahovala `archive.py local`
  (dnes timer a SSH kľúč, ktoré má len Karchi). Webový prehliadač na to nestačí, pretože jeho úložisko môže
  prehliadač vyprázdniť a Safari ho drží malé. Miesto na disku počítača: ako na serveri, plus asi štvrtina databázy
  na textové súbory.
- **„Stará história len v počítači“** znamená, že archív na serveri staré správy po skopírovaní do počítača zmaže.
  Háčiky: správy stále prechádzajú cez mosty na serveri a homeserver si posledné správy každého chatu nechá. Ostatné
  zariadenia, vyhľadávanie a `weft` starú históriu nevidia. Keď sa počítač pokazí, história je preč. Na vlastnom
  serveri to súkromie skoro nezlepší: server patrí tomu istému človeku. Zmysel to má len pri malom VPS, kde chýba
  miesto.
- **„Len v zariadení“** naozaj sú mosty v zariadení (možnosť D v [prevádzke](../2026-11-prevadzka/README.md#možnosti)).
  To je mesiace práce, nie nastavenie.

Ako ďalej: na vlastnom serveri je výber „na serveri“ alebo „aj v tomto počítači“. Pri pozvánke na cudzí server drží
server len 30 dní a stará história je len v počítači (Karchi, 25. 11.). Postup je v [pláne](plan.md).

## Odhad miesta: `server/archive/estimate.py` (postavené)

Povie dopredu počet správ, miesto v databáze archívu, fotky a súbory, náhľady a súčet za posledných 30 dní,
3 mesiace, rok a celú históriu, po sieťach. Ako JSON pre appku, s `--text` po slovensky:

```
python3 server/archive/estimate.py gmail niekto@example.com --text
python3 server/archive/estimate.py instagram ~/exports/instagram/*.zip --text
python3 server/archive/estimate.py beeper ~/imports/BeeperTexts --text
```

| Zdroj | Odkiaľ berie počty | Presnosť |
|---|---|---|
| `gmail ADRESA` | jeden `UID FETCH 1:* (RFC822.SIZE INTERNALDATE)` v All Mail, otvorenom len na čítanie (EXAMINE): dátum a veľkosť každého mailu, žiadny obsah | počet a veľkosť mailov presne; deľba na text a prílohy odhadom z veľkosti |
| `messenger ZIP…`, `instagram ZIP…` | správy z JSON v exporte, veľkosť každej fotky a súboru z adresára ZIP (nič sa nerozbaľuje); číta ako importéry | presne, ako to importér naozaj uloží (odstránená správa ostane riadkom, chýbajúca príloha nie) |
| `beeper PRIEČINOK` | `index.db` Beeper Desktopu a veľkosti súborov v jeho vyrovnávacej pamäti | správy presne, súbory presne keď ich Beeper má, inak odhadom |
| `whatsapp` | čo telefón poslal pri spárovaní a ešte je v databáze mostu | počet presne, médiá odhadom |
| `archive` | dnešný archív; k tomu skutočné miesto na disku na porovnanie | presne (správy), médiá bez zdvojených súborov o pár percent viac |

Čo zdroj nepovie, doplní z veľkostí nameraných v skutočnom archíve (asi 260 tisíc správ, tabuľka `PROFILES`):
správa zaberie v databáze asi 0,8 kB k svojmu textu. Súbor, ktorý v exporte chýba, sa nepočíta, ako ho nenaimportuje ani importér. S fotkou alebo súborom je 4 až 16 % správ podľa siete
a súbor má 0,4 MB (Instagram) až 1,8 MB (WhatsApp). `--calibrate` tieto čísla prepočíta z archívu daného servera.
Výsledok hovorí, koľká časť médií je presná (`media_exact`), a `--text` dopíše „prílohy odhadom“.

Kontrola na skutočných dátach (24. 11., len čítanie): model dnešného archívu dal 0,39 GB databázy a 5,4 GB médií,
na disku je 0,39 GB (hlavný súbor databázy, bez dočasného WAL) a 5,2 GB. Exporty Mety pozri vyššie v Krátko. Test proti falošnému IMAP serveru a falošným
exportom: `tests/estimate/estimate_test.py`.

Na čo ešte nie je zdroj:

- **Outlook**: Graph `GET /me/messages/$count?$filter=receivedDateTime ge …` dá počet za obdobie; veľkosť odhadom
  ako pri Gmaile. Patrí do mosta `server/microsoft/bridge.py` (drží tokeny), postaviť spolu s výberom rozsahu.
- **Messenger a Instagram cez most** neprezradia počty bez sťahovania. Presne to vie len export. Stránka Mety
  „Stiahnuť informácie“ sama ponúka rozsah dátumov aj kvalitu médií.
- **Discord** má počet len vo vyhľadávaní cez token, čo je riziko banu. Jeho export („Request my data“) obsahuje len
  správy, ktoré človek sám poslal. Odhad teda zostane z počtu chatov.
- **WhatsApp pred spárovaním**: nič. Telefón ukáže veľkosť každého chatu v Nastavenia → Úložisko a dáta → Spravovať
  úložisko a to vie prečítať len človek.

**Pre Beeper import:** `import_beeper.py --dry-run` môže na správy, ktoré ide pridať, zavolať `estimate.summarize()`
(zoznam `estimate.Item`). Dostane tak tie isté obdobia a tú istú vetu o mieste ako pri novom účte. `estimate.py beeper` už
číta celý priečinok sám, s rovnakými menami sietí ako importér, a nepotrebuje ho.

## Návrh: pripojenie s otázkou „koľko histórie“

1. **Prvé spustenie** bez povinnej EduPage: po prihlásení sprievodca „Čo chceš mať vo Wefte?“ so sieťami ako
   dlaždicami. EduPage je jedna z nich a Weft funguje aj bez nej. V Nastaveniach → Účty dostane EduPage tlačidlo
   Pripojiť ako ostatné.
2. **Po prihlásení do siete** jedna obrazovka „Koľko histórie?“:
   *Len nové* / *3 mesiace* (predvolené) / *rok* / *všetko*. Pri každej možnosti je počet a miesto z `estimate.py` a
   pod tým voľné miesto na serveri. Druhý prepínač: *fotky a súbory: všetky / len náhľady / žiadne staršie*.
   Pri WhatsAppe musí táto otázka prísť **pred** QR kódom, potom sa už nedá zmeniť.
3. **Weft to spraví sám, pomaly a viditeľne:** riadok účtu v Nastaveniach → Účty ukáže „história: 34 % · 1,2 GB z 3,1
   GB“ s tlačidlami Pozastaviť a Zastaviť (cesta von). Rozsah sa dá neskôr zväčšiť, nikdy sa sám nezmenší.
4. **Ako to každá sieť spraví:**
   - Gmail, Outlook: `since` pri účte v `accounts.json`. Importér to už robí po dávkach od najnovšieho, stačí hranica.
   - Teams: oficiálne API, ďalšie strany cez `@odata.nextLink` až po hranicu.
   - WhatsApp: `request_full_sync` + `days_limit` pri spárovaní, potom `collect_history.py whatsapp` sám (nie ručne).
     Na vlastnom serveri je konfigurácia mosta konfiguráciou toho jedného človeka, takže ju môže zapísať inštalátor
     alebo táto obrazovka.
   - Messenger, Instagram: cez most nič hromadne (ban). *3 mesiace* a viac znamená: Weft ukáže, ako si stiahnuť export
     z Mety s tým istým rozsahom, a súbor, ktorý človek pustí do okna, prečíta `estimate.py` a naimportuje. Do vtedy
     dotiahne staršie správy posúvanie nahor ako dnes.
   - Discord: len DM a len posúvaním nahor (to ešte nie je postavené). Hromadne nič.
   - EduPage: bez otázky, školský rok je malý.
5. **Rovnaká obrazovka pre Beeper:** zdroj „Beeper Desktop“ je ďalšia dlaždica. Dostane ten istý odhad a ten istý
   výber rozsahu (`--since`) a médií (`--media`).

## Rozhodnutia pre teba

1. **Gmail a Outlook budú pýtať rozsah a predvolené budú 3 mesiace** (dnes celá pošta bez otázky)? Odporúčam áno. Pre
   teba sa nič nezmení, tvoje účty už sú celé.
2. **Messenger a Instagram: história len cez export z Mety a posúvanie, nikdy hromadne cez most?** Odporúčam áno
   (pravidlo bez banu, rovnaké ako v [konektoroch](../2026-11-konektory/README.md)).
3. **WhatsApp: otázka na rozsah pred QR kódom** (`request_full_sync`, `days_limit`)? Mení to konfiguráciu mosta, preto
   tvoje áno. Pre teba platí až pri ďalšom spárovaní.
4. **„Kde“:** rozhodnuté 25. 11., pozri [plán](plan.md).
5. **EduPage nepovinná pri prvom spustení**: toto je oprava bez rozhodnutia. Treba ju ale skúsiť s novým prázdnym
   účtom na skúšobnom homeserveri a nasadiť do `~/matrix-spike`, kde má byť naraz len jedno vlákno. Spravím ju,
   keď povieš.

## Neoverené

- Skutočný počet chatov na prvej strane Instagramu (`batch_count: 0`); vyčítané z konfigurácie, nie zmerané na novom
  účte.
- Či Graph v1.0 dáva veľkosť priečinka pošty (`sizeInBytes`). Návrh preto počíta len s `$count`.
- Či Tuwunel vie mazať staré udalosti miestností; „mazať nevie“ je z toho, že asus nič také nemá nastavené.
- Odhad pre Gmail delí veľkosť mailu na text a prílohy hrubo (mail nad asi 60 kB má prílohy: zvyšok nad 11 kB, z base64 ¾). Celkovú
  veľkosť mailov pozná presne. Na skutočnom účte sa zatiaľ nespúšťal, test beží proti falošnému IMAP serveru.
