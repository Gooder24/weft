# Nástenka: súbory a text medzi vlastnými zariadeniami

Ako vo Wefte poslať súbor, fotku alebo text z jedného svojho zariadenia na druhé jednoduchšie ako v appke LocalSend.
Napísal ho agent 25. 11. 2026. AI v ňom nemá žiadnu úlohu.

Stav: krok 1 (LocalSend v desktopovej appke) je postavený. Krok 2, vlastný protokol cez asus, príde neskôr a pridá sa
do tej istej nástenky.

## Čo prekáža na LocalSende

- Pri každom poslaní treba nájsť cieľové zariadenie a znova vybrať súbory.
- Prenos nikde neostane. Kto ho nestihol prijať, nemá nič, a o hodinu sa už nedá dohľadať.
- Obe zariadenia musia byť zapnuté v tej istej sieti. Cez Tailscale sa zariadenia samy nenájdu, lebo LocalSend ich
  hľadá multicastom v miestnej sieti (UDP 224.0.0.167, port 53317).

## Krok 1: LocalSend v desktopovej appke (postavené)

- **Kde je:** Ctrl+B, tlačidlo „Nástenka“ v spodnej lište vedľa Feedu, Ctrl+J „nástenka“. Len v desktopovej appke:
  prehliadač nevie prijímať spojenia ani multicast. V prehliadači nástenka nie je vôbec.
- **Kto prijíma a posiela:** shell (`desktop/localsend.js`, zapojený v `desktop/main.js`) je plnohodnotné zariadenie
  LocalSend (protokol v2 cez HTTPS ako appka). Mobil alebo iný počítač potrebuje appku LocalSend, nič iné.
- **Certifikát:** LocalSend 1.19 pustí cez HTTPS len klienta, ktorý ukáže vlastný certifikát, a zariadenie pozná
  podľa SHA-256 jeho certifikátu. Nástenka si raz vyrobí svoj (RSA 2048 ako LocalSend) a drží ho vo svojom stave
  (`board.json` v profile appky, len pre vlastníka). Zariadenie, ktoré poznala podľa certifikátu, musí ukázať ten
  istý; keď na jeho adrese odpovie iný, nepošle sa mu nič, ani mená súborov. Na inú adresu alebo na HTTP bez
  šifrovania ho presunie len tvrdenie, ktoré ten certifikát dokáže; keď sa niekto iný ohlási s jeho odtlačkom,
  nástenka sa opýta novej adresy cez HTTPS a dovtedy nemení nič.
- **Zariadenie sa nevyberá:** nástenka si pamätá zariadenia, ktoré našla, a tie z Tailscale sú od začiatku
  predvolené. Čo pošleš, ide do všetkých predvolených naraz. Klik na zariadenie ho pridá alebo uberie; nepredvolené
  a nedostupné sa neukazujú.
- **Hľadanie:** pri štarte, pri otvorení nástenky, tlačidlom Hľadať a každé 2 minúty sa opýta každého zariadenia
  Tailscale, ktoré je online, či na porte 53317 beží LocalSend (najprv HTTPS ako appka LocalSend, potom HTTP).
  Multicast cez Tailscale nejde, preto takto.
- **Počúva len na adrese Tailscale** tohto počítača a čo príde odtiaľ, prijme bez pýtania. Prepínač „Aj v miestnej
  sieti“ pridá všetky rozhrania a multicast ako appka LocalSend (doma, v škole bez Tailscale). Súbory aj text od
  zariadenia mimo Tailscale potom čakajú v rohovom okne na Prijať (Enter) alebo Odmietnuť (Esc), 60 sekúnd. Enter
  platí až sekundu po tom, čo sa okno ukáže, aby ho neprijal Enter mienený pre inbox.
- **Port:** 53317 je port LocalSendu. Keď ho má appka LocalSend na tom istom počítači, nástenka vezme ďalší voľný
  (do 53320) a povie to; v LocalSende v mobile treba vtedy tento počítač pridať ručne (adresa a port).
- **Poslať:** text a Enter, súbory potiahnuť na nástenku, Ctrl+V (snímka obrazovky, skopírované súbory) alebo
  „Pridať súbory“. Súbor ide z disku po svojej ceste; stránka nemôže podstrčiť inú cestu, lebo cestu berie preload zo
  samotného súboru (`webUtils.getPathForFile`). Vložený obrázok bez cesty sa uloží do `board-out` v profile appky a
  zmaže sa so svojou položkou.
- **Prijať:** súbory idú do Stiahnutých/Weft (podpriečinky zostanú, meno nikdy nevyjde von z priečinka ani cez odkaz
  na iný priečinok, rovnaké meno dostane „ (1)“, kontrolný súčet sa overí, ak ho odosielateľ pošle). Súbor sa píše pod
  vlastným dočasným menom a premenuje sa, až keď je celý, takže neprepíše nič, čo tam už je. Text príde ako text.
- **Príchod:** keď je nástenka zavretá, ukáže sa rohové okno ako pri overovacích kódoch: Enter otvorí súbor alebo
  skopíruje text, Esc ho zavrie. Keď Weft nie je v popredí, príde aj systémová notifikácia.
- **Ostane:** nástenka drží posledných 200 položiek (odoslané aj prijaté), kým ich nezmažeš. Delete maže len z
  nástenky; súbor v Stiahnutých ostane. Čo nedošlo (zariadenie nedostupné, zaneprázdnené, odmietlo), Enter pošle znova
  tým, ktorým nedošlo.
- **Kontroly:** `node tests/localsend/run.cjs` (dve nástenky proti sebe a falošný mobil s certifikátmi ako LocalSend
  1.19), `tests/localsend/cli.sh` (oficiálne LocalSend CLI 1.19 oboma smermi, v izolovanej sieti; `NODE=<electron>`
  na TLS Electronu), self-test shellu `SPRAVY_SELFTEST=board` (`desktop/selftest-board.js`, skutočný preload a
  súbory), UI s falošným shellom `overenie/nastenka/run.sh`.

## Krok 2: náš protokol cez asus (neskôr)

LocalSend nestačí, keď druhé zariadenie nie je zapnuté, nemá appku LocalSend, alebo nie je v tej istej sieti ani
na Tailscale. Vtedy pôjde položka cez asus:

- Súkromná Matrix miestnosť bez ďalších členov (id v account data `sk.karchi.board`). Funguje všade, kde ide Weft:
  doma aj mimo domu cez Tailscale, v mobile v prehliadači aj v desktopovej appke.
- Tá istá nástenka a tie isté klávesy. Zariadenie sa ani vtedy nevyberá: Weft skúsi LocalSend a čo nedôjde, pošle cez
  asus, kde si to vezme ktorékoľvek zariadenie. Položka ostane, kým ju nezmažeš.
- Každý Weft dostane meno zariadenia (desktopová appka názov stroja, inak „Android“, „iPhone“ či „Linux“), položka ho
  nesie v `sk.karchi.device`.
- Delete zmaže položku na všetkých zariadeniach. Zmazanie správy v Matrixe súbor z disku asusu neodstráni, takže ho
  Weft zmaže aj z úložiska Tuwunelu (ktorým príkazom, treba overiť pri stavbe).
- Limit 100 MiB na súbor (`max_request_size` v Tuwuneli). Väčší súbor Weft odmietne jasnou vetou.
- Z mobilu: Android cez `share_target` v manifeste a `app/sw.js`; iPhone skratkou v appke Skratky, ktorá pošle súbor na
  malú adresu na asuse s vlastným tokenom (token Weftu do skratky nedávame).
- `weft board put SÚBOR` a `weft board take [ID]` na serveroch.

## Poradie stavby

| # | Krok | Kontrola |
|---|---|---|
| 1 | LocalSend v desktopovej appke: hľadanie cez Tailscale, predvolené zariadenia, posielanie, príjem do Stiahnutých/Weft, rohové okno, „Aj v miestnej sieti“ (hotové) | `tests/localsend/run.cjs`, `tests/localsend/cli.sh`, `SPRAVY_SELFTEST=board`, `overenie/nastenka/run.sh` |
| 2 | Miestnosť nástenky na asuse, mená zariadení, záloha cez asus pre to, čo LocalSend nedoručí | na falošnom homeserveri: položka z jedného okna je v druhom; po Delete zmizne v oboch |
| 3 | `weft board` na serveroch | `put` na jednom stroji, `take` na druhom, rovnaký kontrolný súčet |
| 4 | Z mobilu: Android cez `share_target` alebo iPhone cez skratku | na emulátore Androidu je zdieľaná fotka na nástenke |

## Riziká

- „Aj v miestnej sieti“ počúva na všetkých rozhraniach a v cudzej sieti (škola) nástenku vidia všetky zariadenia s
  LocalSendom. Súbory aj text od nich čakajú na Prijať. Preto je to prepínač a nie predvolené.
- Starší LocalSend so šifrovaním vypnutým (HTTP) nástenka nájde a pošle mu, ale tie súbory idú v miestnej sieti
  nešifrovane (cez Tailscale ich šifruje Tailscale).
- Mobil bez zapnutého Tailscale nástenka cez Tailscale nenájde; vtedy pomôže len „Aj v miestnej sieti“ alebo krok 2.

## Rozhodnutia pre Karchiho

1. Má byť „Aj v miestnej sieti“ zapnuté hneď? Odporúčanie: nie, a v mobile mať zapnutý Tailscale.
2. Ostane na nástenke všetko, kým to nezmažeš, alebo sa majú staré položky mazať samy? Dnes drží posledných 200.

## Zdroje

- [Protokol LocalSend](https://github.com/localsend/protocol)
- [PairDrop: vlastný server](https://github.com/schlagmichdoch/PairDrop/blob/master/docs/host-your-own.md),
  [FAQ](https://github.com/schlagmichdoch/pairdrop/blob/master/docs/faq.md)
