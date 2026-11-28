# Weft Priamo: správy medzi dvoma Weftmi bez verejnej IP

Ako môžu dvaja ľudia, ktorí majú každý svoj Weft doma, písať priamo svojim serverom. Netreba na to verejnú IP,
doménu ani certifikát, a cudzí server ich nevidí. Napísal ho agent 27. 11. 2026 podľa labu z 25. a 26. 11.

Stav: krok 1 (úpravy Tuwunelu a firewall len pre kontakty) je postavený a overený v labe. Krok 2 beží od 28. 11. 2026
na asuse a delli, ktorý je prvý kontakt. Ďalšie kroky čakajú.

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
  `Requires=`, takže bez nej `ygg0` nevznikne. Inak by na Yggdrasile odpovedalo všetko, čo na stroji počúva na `::`,
  napríklad SSH.
- **Yggdrasil** je balík z Debianu. Volá len von na dva verejné peery: `ygg-ke.8px.sk` (Košice) a `37.205.14.171`
  (Praha, s kľúčom). Nemá listener ani multicast a o sebe nič nehlási (`NodeInfoPrivacy`).
- **Tuwunel** je `tuwunel-priamo` ako používateľská jednotka. Počúva len na adrese Yggdrasilu a na 127.0.0.1, port
  8448. Meno servera je `[adresa]`.

| Stroj | Priečinok | Jednotka |
|---|---|---|
| asus | `~/matrix-spike/priamo` | `matrix-spike-priamo` |
| dell | `~/priamo` | `weft-priamo` |

Kontakty sú v `priamo.json` v priečinku. Dell nemá Bun, preto sa jeho `priamo.nft` a `allowlist.toml` vyrábajú na
asuse (`bun priamo.ts render`) a kopírujú tam. Adresy uzlov sú len na strojoch, nie v gite. Účet `overenie` na oboch
serveroch slúži na kontroly. Jeho heslo je v `overenie.pw` v priečinku.

Kontrola naživo z 28. 11. 2026:

- Správa ide medzi asusom a dellom cez verejné peery za 0,5 s oboma smermi.
- Dell bol 2 minúty vypnutý. Správu, ktorú asus poslal počas výpadku, dostal 6,4 s po štarte.
- Cudzí uzol stál vo vlastnom sieťovom mennom priestore na asuse a pripojil sa cez pražský peer. Cestu k obom
  strojom našiel a na `ygg0` asusu od neho prišlo 18 paketov. Port 8448 ani SSH (22) sa mu neotvoril ani na asuse,
  ani na delli.

## Ďalšie kroky

| # | Krok | Kontrola |
|---|---|---|
| 3 | Weft: druhý účet na Priamo a sieť „Priamo“ v zlúčenom chate. Keď ju má aj druhá strana, Weft pošle cez ňu. | dva Wefty proti dvom falošným homeserverom: správa ide cez Priamo, bez neho cez bežnú cestu |
| 4 | Šifrovanie vo Wefte (`@matrix-org/matrix-sdk-crypto-wasm`). Pomôže aj ostatným chatom, nielen Priamo. | správa na disku servera nie je čitateľná (scenár 5 labu) |
| 5 | Nástenka kontaktom: z tej istej nástenky ([návrh](../2026-11-nastenka/README.md)) poslať súbor alebo text kontaktu cez Priamo | položka z nástenky príde do Weftu kontaktu |
| 6 | Návrh do špecifikácie Matrixu (MSC): mená v 200::/7 overené sieťou namiesto certifikátu | text návrhu a odkaz na lab |

## Spojenie s nástenkou

Nástenka posiela medzi vlastnými zariadeniami cez LocalSend. Jej krok 2 je súkromná miestnosť na asuse pre to, čo
LocalSend nedoručí. Vlastné zariadenia sa k asusu dostanú cez Tailscale, takže pre ne Priamo netreba. Priamo do
nástenky pridá posielanie **iným ľuďom**: rovnaké klávesy, rovnaké položky, len cieľ je kontakt a cesta ide cez jeho
server Priamo (krok 5). Veľký súbor tak ide z domu priamo k nemu, cez šifrovaný Yggdrasil.

## Riziká

- Yggdrasil nie je anonymný: peer vidí IP adresu. Na verejných peeroch ju vidí aj ich prevádzkovateľ.
- Na verejnom Yggdrasile môže každý uzol skúsiť adresu servera. Firewall z `priamo.json` je preto povinný, nie
  doplnok.
- Kým nebude šifrovanie (krok 4), server Priamo ukladá správy čitateľne, rovnako ako živý homeserver Weftu.
- Výnimka pre 200::/7 je bezpečná len s pravidlom, že 200::/7 neodíde iným rozhraním. Ak Yggdrasil spadne, jeho
  trasa zmizne a bez pravidla by išla premávka cez bežnú sieť.

## Rozhodnutia

1. Peer: verejné peery Yggdrasilu (Karchi, 28. 11. 2026). VPS sa pridá, keď Priamo používa viac ľudí.
2. Prvý kontakt je dell (Karchi, 28. 11. 2026). Druhý človek s Priamo príde, keď bude krok 3.

## Zdroje

- [Yggdrasil: ako funguje](https://yggdrasil-network.github.io/implementation.html), [FAQ](https://yggdrasil-network.github.io/faq.html)
- [Matrix Server-Server API: mená serverov a certifikáty](https://spec.matrix.org/latest/server-server-api/)
- [Tuwunel](https://github.com/matrix-construct/tuwunel)
- [matrix-sdk-crypto-wasm](https://github.com/matrix-org/matrix-rust-sdk-crypto-wasm)
