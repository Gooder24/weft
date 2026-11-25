# Nástenka: súbory a text medzi vlastnými zariadeniami

Návrh, ako vo Wefte poslať súbor, fotku alebo text z jedného svojho zariadenia na druhé jednoduchšie ako cez
LocalSend. Napísal ho agent 25. 11. 2026. Je to plánovací dokument, nič z neho ešte nie je postavené. AI v ňom
nemá žiadnu úlohu.

## Čo prekáža na LocalSende

- Pri každom poslaní treba nájsť cieľové zariadenie a znova vybrať súbory.
- Prenos nikde neostane. Kto ho nestihol prijať, nemá nič, a o hodinu sa už nedá dohľadať.
- Obe zariadenia musia byť zapnuté v tej istej sieti. Cez Tailscale sa zariadenia nenájdu, lebo LocalSend ich hľadá
  multicastom v miestnej sieti (UDP 224.0.0.167, port 53317).

## Krátko

- **Nástenka** je jedno miesto vo Wefte, kam čokoľvek hodíš a odkiaľ si to vezmeš na hocijakom svojom zariadení.
  Zariadenie sa nevyberá, všetky tvoje zariadenia vidia všetko. Položka ostane, kým ju nezmažeš.
- Pod kapotou je to súkromná Matrix miestnosť bez ďalších členov. Ide teda naším protokolom cez asus a funguje
  všade, kde ide Weft: doma aj mimo domu cez Tailscale, v mobile v prehliadači aj v desktopovej appke.
- Keď príde niečo z iného zariadenia a Weft je otvorený, ukáže sa v rohu malé okno ako pri overovacích kódoch. Enter
  uloží súbor alebo skopíruje text, takže vec jednoducho príde ako pri LocalSende.
- Priamy prenos medzi dvoma zariadeniami ako v LocalSende pomôže až pri veľkých súboroch mimo domu. Doma idú obe
  cesty po miestnej sieti, lebo asus je doma. Preto príde až neskôr a len keď bude cesta cez asus merateľne pomalá.
  Aj potom sa nič nevyberá: Weft skúsi priamu cestu a keď nejde, pošle to cez asus.

## Možnosti

| Možnosť | Vyberá sa zariadenie | Ostane | Mimo domu | Mobil v prehliadači | Čo treba postaviť |
|---|---|---|---|---|---|
| **Nástenka cez asus** | nie | áno | áno, cez Tailscale | áno | miestnosť, pohľad, rohové okno |
| Priamo, ako LocalSend (WebRTC medzi dvoma Weftami) | áno | nie | len keď sú obe v jednej sieti | len kým je stránka otvorená | dohoda cez Matrix, prenos po kúskoch, obnova po výpadku |
| **Nástenka a k nej priama cesta** | nie | áno | áno | áno | oboje; priama cesta je len zrýchlenie |
| Vlastný PairDrop na asuse | áno | nie | len s vlastným TURN serverom | áno | ďalšia služba a appka mimo Weftu (GPL-3.0) |
| Protokol LocalSend v desktopovej appke | áno | nie | nie, multicast cez Tailscale nejde | nie | prijímač v Electrone; mobil potrebuje appku LocalSend |

Odporúčanie: najprv nástenka cez asus, priama cesta neskôr ako zrýchlenie tej istej nástenky.

## Ako by fungovala nástenka

- **Kde je:** tlačidlo v spodnej lište vedľa Feedu, položka „Nástenka“ v Ctrl+K a vlastná skratka (vyberie sa pri
  stavbe z voľných). Nie je to chat. Nemá neprečítané a nečaká na okná na čítanie.
- **Pohľad:** mriežka dlaždíc ako vo Feede, najnovšie navrchu. Fotka má náhľad, súbor meno a veľkosť, text a odkaz
  sú karta. Pri každej je napísané, z ktorého zariadenia a kedy prišla.
- **Hodiť tam:**
  - potiahnutie alebo Ctrl+V na otvorenú nástenku;
  - tlačidlo „Pridať“ (výber súborov, v mobile aj fotoaparát);
  - v mobile „Zdieľať → Weft“ (nižšie);
  - zo serverov `weft board put SÚBOR` (aj `-` pre text zo vstupu).
- **Vziať si:** Enter alebo klik súbor stiahne (desktopová appka rovno do Stiahnutých), text a odkaz skopíruje.
  Fotky a videá otvorí prehliadač Weftu, Ctrl+← a Ctrl+→ listujú. Na serveroch `weft board take [ID]` stiahne do
  priečinka a vypíše cestu.
- **Príchod:** položka z iného zariadenia ukáže v otvorenom Weftu rohové okno ako overovacie kódy. Enter uloží alebo
  skopíruje, Esc zavrie a zavretie platí na všetkých zariadeniach. Zavretý Weft sa nedozvie nič; Web Push pre
  nástenku príde len keď ho budeš chcieť.
- **Mená zariadení:** dnes sa každý Weft prihlasuje ako „Weft“. Každé zariadenie dostane meno (desktopová appka
  názov stroja, inak „Android“, „iPhone“ či „Linux“, zmeniteľné v Nastaveniach) a položka ho nesie v
  `sk.karchi.device`.
- **Mazanie:** Delete zmaže položku na všetkých zariadeniach. Zmazanie správy v Matrixe súbor z disku asusu
  neodstráni, takže ho Weft zmaže aj z úložiska Tuwunelu (ktorým príkazom, treba overiť pri stavbe).
- **Limit:** 100 MiB na súbor (`max_request_size` v Tuwuneli). Väčší súbor Weft odmietne jasnou vetou. Zdvihnúť
  limit alebo posielať po kúskoch je samostatné rozhodnutie.
- **Bez spojenia:** položka z mobilu mimo Tailscale čaká v odosielaní ako správa a odíde, keď sa spojenie vráti.

## Z mobilu

- **Android:** manifest so `share_target` a obsluha v `app/sw.js`. Weft sa objaví v „Zdieľať“ a položka ide rovno na
  nástenku. Weft dnes manifest nemá.
- **iPhone:** webové appky sa do „Zdieľať“ nedostanú. Ide to skratkou v appke Skratky, ktorá sa v „Zdieľať“ ukáže a
  pošle súbor na asus. Na to treba malú adresu na asuse, ktorá vie len pridať na nástenku, s vlastným tokenom.
  Token Weftu do skratky nedávame.
- Bez zdieľania ide vždy: otvoriť Weft, nástenka, „Pridať“.

## Priama cesta (neskôr)

- Dva otvorené Wefty sa dohodnú cez Matrix (správy medzi zariadeniami, to-device) a súbor pošlú cez WebRTC data
  channel priamo.
- Bez cudzích STUN a TURN serverov. Priama cesta tak ide hlavne v jednej miestnej sieti, napríklad mobil a notebook
  v škole; koľko presne, závisí od toho, aké adresy prehliadač prezradí, a treba to overiť pri stavbe. Inak Weft
  použije asus.
- Položka na nástenke vznikne vždy a kópia na asus sa dohrá na pozadí, takže ostane aj pre ostatné zariadenia.
- Oplatí sa len pri veľkých súboroch mimo domu, keď ide každý súbor dvakrát cez domáce pripojenie (nahor na asus a
  z neho nadol). Najprv to zmerať.

## Poradie stavby

| # | Krok | Kontrola |
|---|---|---|
| 1 | Miestnosť nástenky (Weft ju založí pri prvom použití, id v account data `sk.karchi.board`), pohľad s mriežkou, pridanie, stiahnutie, mazanie, mená zariadení | na falošnom homeserveri: položka z jedného okna je v druhom; po Delete zmizne v oboch; nič nejde do iných miestností |
| 2 | Rohové okno pri príchode; desktopová appka ukladá rovno do Stiahnutých | dve okná: okno sa ukáže len v tom druhom a Enter súbor uloží |
| 3 | `weft board` na serveroch | `put` na jednom stroji, `take` na druhom, rovnaký kontrolný súčet |
| 4 | Z mobilu: Android cez `share_target` alebo iPhone cez skratku | na emulátore Androidu je zdieľaná fotka na nástenke |
| 5 | Priama cesta, len ak meranie ukáže, že cez asus je to pomalé | dve okná v jednej sieti: súbor nešiel cez asus a položka je aj tak na nástenke |

## Riziká

- Súbory ležia na asuse ako všetko ostatné vo Wefte. Nástenka je súkromná miestnosť, ale bez šifrovania
  end-to-end, rovnako ako ostatné miestnosti Weftu na tomto serveri.
- Miesto na disku asusu: veľa videí ho zaberie. Nastavenia ukážu, koľko nástenka zaberá.
- Mimo domu ide každý súbor dvakrát cez domáce pripojenie. To rieši až priama cesta v kroku 5.

## Rozhodnutia pre Karchiho

1. Android alebo iPhone? Podľa toho bude krok 4 `share_target`, alebo skratka s adresou na asuse.
2. Ostane na nástenke všetko, kým to nezmažeš, alebo sa majú staré položky mazať samy (napríklad po 30 dňoch)?
   Odporúčanie: ostane, kým nezmažeš, a Nastavenia ukážu, koľko miesta zaberá.

## Zdroje

- [Protokol LocalSend](https://github.com/localsend/protocol)
- [PairDrop: vlastný server](https://github.com/schlagmichdoch/PairDrop/blob/master/docs/host-your-own.md),
  [FAQ](https://github.com/schlagmichdoch/pairdrop/blob/master/docs/faq.md)
