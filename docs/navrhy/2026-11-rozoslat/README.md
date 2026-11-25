# Rozoslať: jedna správa viacerým, každému osobne (beta)

Návrh z 23.–25. 11. 2026 (návrh Claude Fable 5.2, ukážka Claude Opus 5.5). Karchi ukážku schválil
a chce ju vo Wefte ako betu. Klikateľná ukážka je [`ukazka.html`](ukazka.html) (`ukazka.html#3` otvorí krok 3).
Je to špecifikácia: kód preberá jej CSS, triedy, texty a klávesy, nenavrhuje sa nanovo.

## Čo to je

Organizátor (animátori, zbor, rodičia) napíše oznam raz. Každý ho dostane do svojho vlastného chatu
s vlastným oslovením a zvyškom rovnakým pre všetkých. Pred odoslaním vidí každú správu a potom ich
jedným potvrdením pošle postupne. Nakoniec vidí, komu správa odišla, kto odpísal a čo (áno / nie / možno).

Je to beta: v Nastaveniach → Správy je prepínač „Rozoslať viacerým (beta)“, predvolene vypnutý a rovnaký na
všetkých zariadeniach. Kým je vypnutý, Rozoslať sa nikde neukáže.

## Postup (podľa ukážky)

1. **Komu:** otvorí sa cez Ctrl+J → „Rozoslať…“ alebo z menu chatu. Má výber s označovaním (Medzerník
   označí, Enter pokračuje) a nad ním uložené zoznamy ľudí. Ponúka len chaty jeden na jedného; spojený chat
   je jeden človek. Človek bez vlastného chatu („nemáte spolu chat“) sa vynechá: správy cudzím ľuďom
   najviac hrozia banom. Dá sa uložiť ako zoznam.
2. **Správa:** jedna šablóna s `{oslovenie}` (a `{meno}`). Prílohy sa nahrajú raz a každý dostane ten istý
   `mxc://`.
3. **Náhľad (povinný):** každá správa celá, s menom a sieťou.
   - ↑/↓ prechod, E oslovenie, ←/→ sieť spojeného chatu, Delete vyhodí človeka.
   - Pri každej správe sa dá pridať osobná veta navyše.
   - Uhádnuté oslovenie („Ahoj “ + krstné meno) je označené „uhádnuté“. Opravené sa zapamätá natrvalo.
   - Dole je počet a čas poslednej správy. Ctrl+Enter „Rozoslať N“.
4. **Rozoslané:** súčty (odišlo, čaká, áno, nie, možno, bez odpovede) a riadok na človeka: čas, stav, jeho
   prvá odpoveď po správe a áno/nie/možno.
   - Áno/nie/možno sa uhádne z odpovede; A, N, M ho opravia.
   - Enter otvorí chat. „Zastaviť“ zruší neodoslané. „Pripomenúť tým, čo neodpísali“ začne nové rozoslanie
     len pre nich.

## Rozhodnutia (25. 11., Karchi môže zmeniť)

- **Najprv zoznamy ľudí.** Hostia pri udalosti v kalendári prídu až neskôr: kalendár dnes účastníkov nepozná.
- **Tempo:** jedna správa za 25–70 s, náhodne. Najviac 30 ľudí na jednu sieť za deň; nad tým náhľad odmietne.
- **Áno/nie/možno je už v bete,** ako v ukážke.
- **Siete:** Messenger, Instagram, WhatsApp, Discord. Mail, EduPage a Teams až neskôr.

## Architektúra

- **Účtové dáta `sk.karchi.broadcast`:**
  `{ beta, lists: [{ id, name, people }], items: [{ id, title, text, files, state, at, to: [{ key, room,
  greeting, extra?, rsvp? }] }] }`. Stav `draft` služba nevidí.
- **Oslovenia ľudí:** `sk.karchi.people.names`, s rovnakými kľúčmi ako `sk.karchi.people.look`
  (user, `merge:<id>`, room).
- **Odoslanie:** potvrdenie zapíše N položiek do `sk.karchi.sendlater` (ako „Poslať“ v Odložených) s id
  `bc-<rozoslanie>-<človek>-<seq>`, ktoré služba použije ako transakčné id. Správa tak odíde raz, aj po
  potvrdení na dvoch zariadeniach. Text a súbor jedného človeka sú jeden `batch`.
- **Služba send-later** dostane jedinú novú vec: položka s `gap` ide najviac jedna za `gap` na sieť. Dnes
  `send_due` po výpadku pošle všetko zmeškané v jednom kole.
- **Stav a odpovede** Weft číta z položiek send-later a z časovej osi chatov. Služba maže hotové po 7 dňoch,
  takže výsledok sa raz prepíše do rozoslania.
- **Neskôr `weft broadcast`:** agent rozoslanie len pripraví ako `draft` (`by: agent`). Odoslať ho vie iba
  Karchiho potvrdenie vo Wefte.

## Testy

Nikdy nie skutoční ľudia. Používa sa falošný homeserver (`overenie/stash/fakehs.py`) a jednorazový Tuwunel na
„raz a s rozostupmi“ (čas podaný zvonka, bez sleep). V UI sa zachytí každá ne-GET požiadavka. Overovateľ
porovná skutočné obrazovky so screenshotmi `ukazka.html#1` až `#4`.

## Neskôr

Hostia pri udalosti („Pozvať“), členovia skupiny, mail a EduPage ako záloha, naplánovanie na čas,
`weft broadcast`.
