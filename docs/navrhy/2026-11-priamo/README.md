# Weft Priamo: správy medzi dvoma Weftmi bez verejnej IP

Ako môžu dvaja ľudia, ktorí majú každý svoj Weft doma, písať priamo svojim serverom. Netreba na to verejnú IP,
doménu ani certifikát, a cudzí server ich nevidí. Napísal ho agent 27. 11. 2026 podľa labu z 25. a 26. 11.

Stav (28. 11. 2026): kroky 1 až 5 sú postavené. Priamo beží na asuse a delli, ktorý je prvý kontakt, a vo Wefte je
to sieť „Priamo“ so šifrovanými chatmi, do ktorej posiela aj nástenka. Text pre krok 6 (návrh do špecifikácie Matrixu)
je v [msc.md](msc.md); do Matrixu ešte neodišiel.

## Krátko

- Každý má vlastný malý homeserver „Priamo“ vedľa Weftu. Jeho meno je jeho adresa v sieti Yggdrasil, napríklad
  `[201:db8::1]:8448`. Yggdrasil dá každému počítaču stálu adresu odvodenú z jeho kľúča, aj za NAT. Domáci server
  sa len sám pripojí von na spoločný uzol (peer), nič neotvára do internetu.
- Je to obyčajný Matrix, takže Priamo je pre Weft len ďalšia sieť v zlúčenom chate. Keď ho druhá strana nemá,
  píše sa cez bežnú cestu.
- Server vidia len kontakty. Firewall na rozhraní Yggdrasilu pustí len servery kontaktov a Tuwunel prijme len ich
  mená. Obe pravidlá sa robia z toho istého zoznamu.

## Čo ukázal lab

Lab porovnal Matrix (M1), Matrix cez Yggdrasil (M2), XMPP (X1, X2) a SimpleX (S) v sieťových menných priestoroch na
asuse.

| Situácia | Bežný Matrix | Matrix cez Yggdrasil | XMPP | SimpleX |
|---|---|---|---|---|
| Oba domy za NAT | nedoručí | doručí | nedoručí (cez Yggdrasil doručí) | doručí |
| Výpadok servera 30 min | nedoručí ani 15 min po návrate | nedoručí ani 15 min po návrate | správu vráti ako chybu | doručí do sekundy |
| Zlá sieť, p50 | 661 ms | 708 ms | 623 ms | 1510 ms |
| Kto mu napíše | celý Matrix | len servery na Yggdrasile | celé XMPP | len SimpleX |

Z toho vyplynuli dve veci, ktoré Matrix cez Yggdrasil sám nevie, a krok 1 ich pridáva:

1. **Certifikát.** Matrix chce aj pre server s IP menom platný certifikát. Pre adresu v Yggdrasile sa nedá dostať,
   takže lab musel overovanie vypnúť pre všetky servery.
2. **Návrat po výpadku.** Tuwunel prestane čakať, keď od druhého servera niečo príde (`notify_peer_alive`). Server,
   ktorý sa vráti, sa však sám neozve, a tak druhá strana čaká ďalej.

## Krok 1: čo je postavené

- **`server/priamo/tuwunel-priamo.patch`** na Tuwunel 1.9.4 (build: `server/priamo/build-tuwunel-priamo`, binárka
  `~/build/tuwunel-priamo` na asuse). Pridáva dve voľby, obe predvolene vypnuté:
  - `yggdrasil_trust_overlay`: server s menom v 200::/7 smie ukázať akýkoľvek certifikát, aj vlastnoručne
    podpísaný. Adresu odvodzuje Yggdrasil z kľúča uzla a šifruje k nej celú cestu, takže kto na nej odpovie, je ten
    uzol. Podpis TLS spojenia sa overuje ďalej. Certifikát každej inej adresy sa overuje ako doteraz. Výnimka platí
    len pre federáciu (médiá, náhľady odkazov a pushery overujú všetko) a federácia potom nejde cez proxy, lebo
    za proxy by cesta k adrese už nebola Yggdrasil.
  - `startup_hello`: päť sekúnd po štarte pošle server prázdnu transakciu každému serveru, s ktorým zdieľa
    miestnosť. Ten tým zistí, že je späť, a hneď pošle, čo preň drží.
- **`server/priamo/priamo.ts`** (Bun): z `priamo.json` so zoznamom kontaktov vyrobí dva súbory:
  - `priamo.nft`: na rozhraní Yggdrasilu prejdú na port servera len kontakty, ostatné sa zahodí. Adresy 200::/7
    nesmú odísť iným rozhraním. Bez toho by ich mohol podstrčiť ktokoľvek v miestnej sieti a výnimka
    `yggdrasil_trust_overlay` by mu verila.
  - `allowlist.toml`: Tuwunelova `allowed_remote_server_names_experimental` pre tých istých kontaktov. Prázdny
    zoznam nepustí nikoho. Meno servera kontaktu musí byť adresa tak, ako ju píše Yggdrasil (malými písmenami,
    skrátená); iný zápis tej istej adresy sa odmietne. Odobratý kontakt odmietne Tuwunel hneď po načítaní
    zoznamu, firewall mu zastaví až nové spojenia.

  Testy: `bun test server/priamo`.
- **Lab:** `overenie/prenos-lab/run.sh priamo` spustí upravený Tuwunel (M3) za NAT so zapnutým overovaním
  certifikátov a s firewallom. Skúsi aj cudzí server na tom istom Yggdrasile, cudzí server bez firewallu a server s
  obyčajným menom a vlastnoručne podpísaným certifikátom. Potom zmeria výpadky 2, 10 a 30 minút
  (`run.sh priamo quick` len 2 minúty).

Výsledok behu z 27. 11. 2026:

| Kontrola | M3 (Priamo) | Bežný Matrix cez Yggdrasil (M2) |
|---|---|---|
| Oba domy za NAT, prvá správa | doručí za 6–10 ms; vlastnoručne podpísaný certifikát adresy v Yggdrasile prijme výnimka, inde sa overuje | doručí, ale overovanie má vypnuté pre všetky servery |
| Výpadok 2 / 10 / 30 min | doručí 5,9 / 5,6 / 5,6 s po návrate | 644 s / 796 s / ani za 15 min |
| Cudzí server na Yggdrasile | zahodí firewall | nemá ho čím odmietnuť (neskúšané) |
| Cudzí server, firewall vypnutý | odmietne Tuwunel (403, nie je v zozname) | nemá ho čím odmietnuť (neskúšané) |
| Obyčajné meno s vlastnoručne podpísaným certifikátom | odmietne (curl s `-k` sa k nemu dostane, bez `-k` hlási chybu 60) | overovanie má vypnuté (neskúšané) |

Päť sekúnd z času po návrate je čakanie `startup_hello` pred prvou transakciou.

Tuwunel porovnáva zoznam povolených mien s hostom mena servera, teda bez portu. Kontakt je preto celá adresa, nie
adresa a port.

## Krok 2: Priamo na asuse a delli

`server/priamo/setup.sh <priečinok> <jednotka>` postaví Priamo na stroji. Potrebuje sudo bez hesla. Spúšťa sa znova
po každej zmene kontaktov.

- **Firewall** je systémová jednotka `weft-priamo-firewall` (`/etc/weft-priamo/priamo.nft`). Yggdrasil ju má v
  `Requires=`, takže bez nej `ygg0` nevznikne. Inak by na Yggdrasile odpovedalo všetko, čo na stroji počúva na `::`
  (na asuse napríklad LLMNR na porte 5355).
- **Yggdrasil** je balík z Debianu. Volá len von na dva verejné peery: `ygg-ke.8px.sk` (Košice) a `37.205.14.171`
  (Praha, s kľúčom). Nemá listener ani multicast a o sebe nič nehlási (`NodeInfoPrivacy`).
- **Tuwunel** je `tuwunel-priamo` ako používateľská jednotka. Počúva len na adrese Yggdrasilu a na 127.0.0.1, port
  8448, cez HTTPS aj obyčajné HTTP (`dual_protocol`), aby sa naň mohol prihlásiť most Weftu na 127.0.0.1. Cez
  Yggdrasil sa k nemu dostanú len kontakty a cestu šifruje Yggdrasil; federácia ide von vždy cez HTTPS. Meno
  servera je `[adresa]`.

| Stroj | Priečinok | Jednotka |
|---|---|---|
| asus | `~/matrix-spike/priamo` | `matrix-spike-priamo` |
| dell | `~/priamo` | `weft-priamo` |

Kontakty sú v `priamo.json` v priečinku. Dell nemá Bun, preto sa jeho `priamo.nft` a `allowlist.toml` vyrábajú na
asuse (`bun priamo.ts render`) a kopírujú tam. Adresy uzlov sú len na strojoch, nie v gite. Účet `overenie` na oboch
serveroch slúži na kontroly. Jeho heslo je v `overenie.pw` v priečinku.

Kontrola naživo z 28. 11. 2026:

- Správa ide medzi asusom a dellom cez verejné peery za 0,5 s oboma smermi.
- Priamo na delli bolo 2 minúty vypnuté. Správu, ktorú asus poslal počas výpadku, dostalo 6,4 s po štarte.
- Cudzí uzol stál vo vlastnom sieťovom mennom priestore na asuse a pripojil sa cez pražský peer. Cestu k obom
  strojom našiel a na `ygg0` asusu od neho prišlo 18 paketov. Port 8448 ani SSH (22) sa mu neotvoril ani na asuse,
  ani na delli.

Po štarte stroja sa najprv načíta firewall a až potom sa začne štartovať Yggdrasil. Overené 28. 11. na delli
zastavením oboch jednotiek a štartom samotného Yggdrasilu (skutočný reštart stroja ešte nebol).

## Krok 3: Priamo vo Wefte

- **Účet:** Weft sa na server Priamo prihlási tým istým mostom ako na matrix.org
  ([matrix-matrix](https://github.com/Gooder24/matrix-matrix)), ako druhý účet. Most má v configu
  `accept_invites_on: ["http://127.0.0.1:8448"]`: na tomto serveri prijme každú pozvánku, lebo tam sa dostanú len
  kontakty. Na iných serveroch pozvánky neprijíma ako doteraz. Účet na asuse je `karchi`, heslo je v
  `~/matrix-spike/priamo/karchi.pw`.
- **Sieť:** chat toho účtu má v `m.bridge` prihlásenie (`fi.mau.receiver`) s menom servera v 200::/7, a Weft ho preto
  ukazuje ako sieť „Priamo“ (`isPriamo` v `app/app.js`), nie Matrix.
- **Zlúčený chat:** Priamo sa zlučuje s ostatnými sieťami toho človeka (odteraz aj Matrix). Zlúčený chat píše cez
  Priamo, kým Karchi nevyberie inú sieť a kým je účet Priamo pripojený. Inak píše ako doteraz, cez sieť, z ktorej
  človek písal naposledy.
- **Nový chat:** Ctrl+N s adresou `@meno:[adresa]` otvorí chat cez účet Priamo, iná adresa ide cez ten druhý.
- **Kontrola:** `tests/priamo/ui.cjs` (tri dočasné Tuwunely: Weft, „matrix.org“ a Priamo s menom `[201:db8::1]`).
  Pozvánka na Priamo sa prijme, na druhom serveri nie, chaty sa zlúčia podľa mena a správa ide cez Priamo, hoci
  človek písal naposledy z Matrixu. Keď server Priamo spadne, ide cez Matrix.

Most predtým hlásil „pripojené“ aj vtedy, keď druhý server nebežal, lebo mautrix skúšal sync znova potichu. Od
28. 11. to hlási ako výpadok.

## Krok 4: šifrovanie

Chaty cez Priamo šifruje zariadenie mosta (Olm/Megolm cez goolm), takže servery Priamo na oboch stranách majú len
zašifrované správy. Pôvodný plán bol šifrovanie priamo vo Wefte (`matrix-sdk-crypto-wasm`). Nahradil ho most, lebo
správy všetkých ostatných sietí aj tak prichádzajú cez mosty na Karchiho vlastný homeserver nezašifrované, a pre
Priamo stačí, že ho nečíta server.

Kontrola naživo z 28. 11. 2026 (`overenie/priamo7/check.ts`): `overenie` na delli so šifrujúcou appkou založil
šifrovaný chat s Karchiho účtom Priamo. Most prijal pozvánku za 1,2 s a správa bola vo Wefte 2,6 s od štartu, v
chate siete Priamo. Odpoveď z Weftu prišla do dellu za 0,9 s a appka ju rozšifrovala. Na serveri Priamo asusu aj
dellu boli z chatu len udalosti `m.room.encrypted` (dve, žiadna čitateľná), a text nebol v databáze ani jedného z
nich, zatiaľ čo v databáze hlavného homeservera asusu bol.

## Krok 5: nástenka kontaktom

Na nástenke ([návrh](../2026-11-nastenka/README.md)) pribudol riadok „Kontaktom:“ s ľuďmi, s ktorými má Karchi chat
Priamo. Nikto z nich nie je predvolený: klik ho pridá, ďalší klik uberie. Text a súbory idú do jeho chatu Priamo
ako Karchiho správy, takže prídu do Weftu kontaktu cez Yggdrasil a šifrované. Na nástenke ostanú (v úložisku okna,
posledných 200) so stavom „odišlo cez Priamo“ alebo „neodišlo“. Kontrola: `tests/priamo/ui.cjs` s falošným shellom.

## Krok 6: návrh do špecifikácie Matrixu

[msc.md](msc.md): server s menom v sieti, ktorá overuje adresu kľúčom (Yggdrasil 200::/7), smie vynechať kontrolu
certifikátu, nie však delegovanie ani cestu mimo tejto siete. Podáva sa ako pull request do
`matrix-org/matrix-spec-proposals`, čo je verejný príspevok do cudzieho projektu.

## Spojenie s nástenkou

Nástenka posiela medzi vlastnými zariadeniami cez LocalSend. Jej krok 2 je súkromná miestnosť na asuse pre to, čo
LocalSend nedoručí. Vlastné zariadenia sa k asusu dostanú cez Tailscale, takže pre ne Priamo netreba. Priamo do
nástenky pridá posielanie **iným ľuďom**: rovnaké klávesy, rovnaké položky, len cieľ je kontakt a cesta ide cez jeho
server Priamo (krok 5). Veľký súbor tak ide z domu priamo k nemu, cez šifrovaný Yggdrasil.

## Riziká

- Yggdrasil nie je anonymný: peer vidí IP adresu. Na verejných peeroch ju vidí aj ich prevádzkovateľ.
- Na verejnom Yggdrasile môže každý uzol skúsiť adresu servera. Firewall z `priamo.json` je preto povinný, nie
  doplnok.
- Šifruje most, takže Karchiho vlastný homeserver má správy z Priamo čitateľne, rovnako ako správy všetkých
  ostatných sietí. Šifrované sú na serveroch Priamo a na ceste medzi nimi.
- Výnimka pre 200::/7 je bezpečná len s pravidlom, že 200::/7 neodíde iným rozhraním. Ak Yggdrasil spadne, jeho
  trasa zmizne a bez pravidla by išla premávka cez bežnú sieť.

## Rozhodnutia

1. Peer: verejné peery Yggdrasilu (Karchi, 28. 11. 2026). VPS sa pridá, keď Priamo používa viac ľudí.
2. Prvý kontakt je dell (Karchi, 28. 11. 2026). Druhý človek s Priamo príde, keď ho Karchi pozve.
3. Šifrovanie robí most namiesto Weftu (agent, 28. 11. 2026, keď Karchi povedal „všetko implementuj“).

## Zdroje

- [Yggdrasil: ako funguje](https://yggdrasil-network.github.io/implementation.html), [FAQ](https://yggdrasil-network.github.io/faq.html)
- [Matrix Server-Server API: mená serverov a certifikáty](https://spec.matrix.org/latest/server-server-api/)
- [Tuwunel](https://github.com/matrix-construct/tuwunel)
- [matrix-sdk-crypto-wasm](https://github.com/matrix-org/matrix-rust-sdk-crypto-wasm)
