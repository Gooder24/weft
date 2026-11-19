# Kto prevádzkuje Weft bežným ľuďom

Návrh k otázke z [PR #4](https://github.com/Gooder24/weft/pull/4) („Kto mu spustí server“). Napísal ho agent
19. 11. 2026 ako plánovací dokument; v žiadosti do NLnetu ho treba priznať (pravidlá o AI 2.0). Stránky cudzích
služieb som otvoril v ten deň, zdroje sú na konci.

## O čo ide

Weft nie je len appka. Pod ňou beží homeserver a sedem mostov a každý most drží prihlásenie do siete: cookies
Messengera a Instagramu, kľúče prepojeného zariadenia WhatsAppu, token Discordu, Google a Microsoft tokeny alebo
heslo aplikácie a heslo do EduPage v čitateľnej podobe (most sa ním znova prihlasuje). Kto prevádzkuje server,
drží všetko toto a vidí všetky správy, aj keď Matrix šifruje cestu ku klientovi: most správu musí prečítať, aby ju
preložil. Otázka „kto prevádzkuje server“ je preto otázka „komu človek dá prihlásenia do všetkých sietí“.

Na asuse to dnes pre jedného človeka zaberá asi 1,1 GB RAM (homeserver 0,8 GB, mosty po 10 až 50 MB; bez archívu
a služby s jazykovým modelom, meranie 19. 11., časť pamäte je vo swape).

## Možnosti

| | Kto drží prihlásenia | Dôvera, GDPR | Ban od Mety | Náklady a údržba | NLnet |
|---|---|---|---|---|---|
| **A. Každý sám, s inštalátorom** (starý notebook doma alebo VPS) | používateľ | nikomu inému nedôveruje; domáca výnimka GDPR, ty nie si prevádzkovateľ | jeho riziko; z domácej siete najmenšie, z IP dátového centra väčšie | VPS asi 5 € mesačne alebo stroj doma; mosty na Metu treba aktualizovať často, takže bez automatických aktualizácií to bežný človek neudrží | sedí: otvorený softvér, žiadna centrálna služba, „deployment innovation“ je v rozsahu Restacku |
| **B. Ty pre rodinu a známych** (na asuse) | ty, za všetkých | musia ti veriť, technicky čítaš všetko; pri rodine pravdepodobne domáca výnimka, pri známych mimo domácnosti už si prevádzkovateľ podľa GDPR, aj voči ľuďom, s ktorými si píšu | všetky účty z jednej IP; keď Meta niekoho zablokuje, príde za tebou | asus už beží, každý ďalší človek pridá pamäť; keď asus spí alebo padne, nikomu nič nechodí a opravuješ ty | NLnet nefinancuje prevádzku; nevadí, ale nepomáha |
| **C. Služba pre verejnosť** (platený Weft) | ty, za cudzích ľudí | plný GDPR: zmluvy, záznamy, únik, ktorý ohrozuje ľudí, hlásiť úradu bez zbytočného odkladu, spravidla do 72 hodín od zistenia; komerčná služba nad neoficiálnym klientom Mety | najvyššie a právne tvoje; Beeper to roky robil ako firma a odchádza z toho | servery, podpora a Google: neoverená appka s prístupom k celej pošte má najviac 100 nových používateľov; overenie tohto rozsahu s poštou na serveri znamená každoročný bezpečnostný audit (CASA) | služba nevadí, FAQ Restacku výslovne pripúšťa „a hosted version with a monthly subscription fee“; prevádzku ako takú („not R&D but a service“) ale grant neplatí |
| **D. Mosty v zariadení** (bez servera, ako Beeper On-Device) | zariadenie používateľa | najlepšia: nikto iný nič nevidí | podľa mňa najnižšie, jedno zariadenie z domácej siete; či to Meta toleruje, nepovedala | najväčšia prestavba: mosty skompilovať do appky v telefóne a notebooku, Python mosty prepísať; odoslať neskôr, okná na čítanie a archív potrebujú niečo, čo beží stále | sedí najlepšie, ale sú to mesiace práce, ktorú by si pri grante písal ručne |

Federácia nie je samostatná možnosť. Dovolí, aby sa ľudia z rôznych Weft serverov videli v Matrixe, ale most
na Messenger a jeho prihlásenie sú vždy na serveri toho, kto most prevádzkuje. Matrix ju vie, na asuse je vypnutá
(`allow_federation = false` v `tuwunel.toml`).

## Ako to robia iní

- **Beeper** prevádzkoval mosty v cloude (Beeper Cloud, história šifrovaná tak, že ju firma neprečíta). Od júla
  2025 vie „On-Device Connections“: most beží v appke a správy idú zo zariadenia priamo do siete, „never sent to our
  servers“. V júli 2025 bol cloud predvolený a mal časom skončiť; dnešný návod Beeperu volí spôsob podľa siete. Zadarmo 5 sietí, Plus 9,99 $ mesačne. Vlastné mosty sa
  dajú pripojiť cez Beeper Bridge Manager.
- **Texts.com** bežal celý v zariadení, bez serverov. Automattic ho kúpil v roku 2023 a spojil s Beeperom; on-device
  model Beeperu z neho vychádza.
- **Element One** (od 2021, 5 $ mesačne) je hostovaný Matrix účet s mostmi na WhatsApp, Signal a Telegram. Messenger
  ani Instagram nemá. Stránka stavu ešte v novembri 2025 hlásila jeho údržbu.
- **etke.cc** inštaluje a spravuje Matrix server s mostmi (aj WhatsApp a mautrix-meta) na stroji zákazníka alebo
  svojom, od asi 5 $ mesačne plus balík mostov. Je to najbližšie k možnosti A s niekým, kto ju robí za teba.

Spoločné: kto mosty prevádzkuje za iných, je firma. Najväčší z nich sa práve presúva od servera k zariadeniu.

## Odporúčanie

**Weft je softvér, ktorý si človek spustí sám, nie služba.** Teda A, a B len pre tvoju domácnosť.

- Verejnú službu (C) nerob: prevádzkovateľ by si bol ty, za cudzie prihlásenia do Mety a cudzie správy, a pri prihlásení cez
  Google každoročný audit (heslo aplikácie ho nepotrebuje). NLnet môže platiť vývoj softvéru, prevádzku nie.
- Známym nehostuj (B mimo domácnosti): GDPR by bol tvoj, pri bane ich účtu by prišli za tebou a asus by sa stal službou, ktorú musíš
  stále držať. Rodine áno, ak vedia, že technicky vidíš ich správy.
- Bežný človek bez technika v okolí Weft nespustí ani s inštalátorom a pre neho je Beeper. Weft je pre ľudí, ktorí
  majú doma niekoho, kto rozbehne Home Assistant alebo Nextcloud. Ten istý človek ho rozbehne rodine. Tak to treba
  napísať aj v README.
- Mosty v zariadení (D) sú dobrý smer na neskôr, nie teraz. Najprv musí niekto iný Weft spustiť z repa.

Prvý krok je ten, ktorý už je v PR #4 v opravách pred zverejnením: inštalácia na čistý stroj (3 až 5 dní). Bez nej
Weft nespustí nikto iný a žiadna z možností neexistuje.

## Rozhodnutia pre teba

1. **Weft ako softvér na vlastný server, žiadna verejná služba?** Odporúčam áno. Odpovedá to na otázku z PR #4
   a README to povie ľuďom hneď na začiatku.
2. **Komu hostíš na asuse?** Odporúčam len domácnosti a známym povedať, že si Weft spustia sami. Ak to má byť niekto
   konkrétny mimo domácnosti, napíš kto, a pozriem, čo by to znamenalo.
3. **Inštalátor napísať agentmi teraz, alebo ho dať do grantu a písať ručne?** Odporúčam agentmi pred podaním:
   NLnet ho ráta ako už existujúci kód (treba ho priznať) a grant ostane úzky, most EduPage a formát stavu.
   Na otvorenej hodine NLnetu 25. 11. o 16:00 sa dá k otázke o kóde od AI pridať, či im vadí, že Weft stojí na
   mostoch proti podmienkam Mety.

## Zdroje

Otvorené 19. 11. 2026.

- [NLnet Restack](https://nlnet.nl/restack/), [FAQ Restacku](https://nlnet.nl/restack/faq/)
- [Beeper FAQ](https://www.beeper.com/faq), [Beeper pre vývojárov: mosty](https://developers.beeper.com/bridges),
  [TechCrunch o on-device Beeperi, 16. 7. 2025](https://techcrunch.com/2025/07/16/beepers-all-in-one-messaging-app-relaunches-with-an-on-device-model-and-premium-upgrades/)
- [TechCrunch o Texts.com pod Automatticom](https://techcrunch.com/2023/12/13/whats-next-for-texts-com-under-new-owner-automattic-as-apple-cracks-down-on-rival-beeper)
- [Element One, ohlásenie z 2021](https://element.io/blog/element-one-all-of-matrix-whatsapp-signal-and-telegram-in-one-place),
  [stav Element One](https://status.element.io/incidents/02w5vxnx3894)
- [etke.cc: mosty](https://etke.cc/help/bridges/)
- [Google: overenie citlivých a obmedzených rozsahov](https://support.google.com/cloud/answer/13463817?hl=en)
- [GDPR článok 2](https://gdpr-text.com/read/article-2/), [GDPR článok 33](https://eur-lex.europa.eu/eli/reg/2016/679/oj/eng)
- [Beeper: pridanie siete](https://help.beeper.com/en_US/desktop/how-do-i-add-a-chat-network)

Neoverené: či Meta blokuje účty za mosty (sú len hlásenia používateľov, žiadne vyjadrenie Mety ani projektu
mautrix), či viac účtov z jednej IP zvyšuje riziko (môj úsudok), presný zoznam sietí, ktoré Beeper vie na zariadení,
a dnešné ceny etke.cc. Výklad GDPR je z komentárov, nie z rozhodnutí súdu.
