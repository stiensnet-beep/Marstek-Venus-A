# Marstek Venus voor Homey — **BETA**

**Gemaakt door JPD** · versie `0.1.0` (BETA 1) · Homey SDK 3 (lokaal)

> Homey staat geen pre-release versienummers toe (`0.1.0-beta.1` werd door de validator
> geweigerd). In het app-manifest staat daarom `0.1.0`; de BETA-status blijkt uit de
> app-naam "Marstek Venus (BETA)" en uit dit document.

> **Deze app is BETA.** Hij werkt en is op echte hardware getest, maar hij is nog niet
> breed uitgerold. Gebruik hem op eigen verantwoordelijkheid: je stuurt een echte
> thuisbatterij aan. Zie ook de sectie *Risico's* onderaan.

---

## 1. Wat "BETA" hier precies betekent

| Wel | Nog niet |
|---|---|
| Getest en werkend op een **Venus E 3.0** (fw 150) en een **Venus A** (fw 148) | Getest op de Venus C, D, E mini en Jupiter — de API-documentatie noemt ze, maar we hebben ze niet in handen gehad |
| Uitlezen van modus, SOC, vermogen + aan/uit schakelen vanuit Homey-flows | Energietotalen (kWh), PV-ingangen en DOD-instellingen |
| Werkt naast de bestaande Venus E-app | Garantie op werking na een firmware-update van Marstek |
| Fouten worden duidelijk gemeld en de app herstelt zichzelf | Ondersteuning van Marstek zelf (het is geen officiële integratie) |

## 2. Wat er getest is (bewijs, geen belofte)

| Test | Resultaat |
|---|---|
| `Marstek.GetDevice` op een Venus E 3.0 | `{"device":"VenusE 3.0","ver":150,"ble_mac":"aabbccddeeff","ip":"192.168.01.50"}` |
| `Marstek.GetDevice` op een Venus A | `{"device":"Venus A","ver":148,"ble_mac":"112233445566","ip":"192.168.1.51"}` |
| `ES.GetMode` | `{"mode":"Auto","bat_soc":38,"ongrid_power":-135}` |
| `ES.SetMode` zonder sub-configuratie | `set_result: false` (wordt dus **niet** toegepast) |
| `ES.SetMode` met sub-configuratie (`auto_cfg.enable = 1`) | **`set_result: true`** — dit is de reden dat de app altijd de volledige config meestuurt |
| `Bat.GetStatus` (Venus E) | SOC 41 %, 29 °C, 2124 van 5120 Wh |
| `Wifi.GetStatus` (Venus E) | SSID `MY_WIFI`, RSSI −36 dBm |
| TCP op poort 30000 | **geen antwoord** — de Venus praat alleen UDP |
| Koppelen + aan/uit in Homey | Beide batterijen gekoppeld, schakelen werkt |

## 3. Hoe het werkt

### 3.1 Protocol
Alles gaat over **UDP met JSON-RPC** op de poort die per toestel in de Marstek-app is in
te stellen (standaard 30000):

```
-> {"id":1,"method":"Marstek.GetDevice","params":{"ble_mac":"0"}}
-> {"id":2,"method":"ES.GetMode",  "params":{"id":0}}
-> {"id":3,"method":"ES.SetMode",  "params":{"id":0,"config":{"mode":"Auto","auto_cfg":{"enable":1}}}}
-> {"id":4,"method":"ES.GetStatus","params":{"id":0}}
-> {"id":5,"method":"Bat.GetStatus","params":{"id":0}}
-> {"id":6,"method":"Wifi.GetStatus","params":{"id":0}}
```

- Antwoorden worden op **`id`** gematcht; een eigen bronpoort houdt het simpel.
- Discovery stuurt zowel een **broadcast** als een **unicast-sweep over de eigen /24**, op
  poort 30000 **én** 30001 — zo vinden we ook een tweede batterij met een andere poort.
- Twee firmware-eigenaardigheden worden opgevangen: `result.device` is de **modelnaam als
  tekst** (geen object) en het IP kan voorloopnullen bevatten (`192.168.01.50`).

### 3.2 Modi en "aan/uit"
De officiële Marstek-API kent **`Auto`, `AI`, `Manual`, `Passive`, `UPS`** — er is géén
`Standby`. Bij elke modus hoort een sub-configuratie:

| Modus | Sub-configuratie |
|---|---|
| `Auto` | `auto_cfg.enable` |
| `AI` | `ai_cfg.enable` |
| `UPS` | `ups_cfg.enable` |
| `Manual` | `manual_cfg` (`time_num`, `start_time`, `end_time`, `week_set`, `power`, `enable`) |
| `Passive` | `passive_cfg` (`power`, `cd_time`) |

Daarom werkt "uit" in deze app als volgt:

- **Aan** → `Auto` met `auto_cfg.enable = 1` (eigen verbruik).
- **Uit** → standaard `Manual` met `enable = 0` en `power = 0`: er is geen actief schema,
  dus de batterij doet niets. In de instellingen kun je ook `UPS`, `Passive`, `Auto` of
  `AI` kiezen; de app zet dan de bijbehorende sub-configuratie uit.

De app **leest na elke schakeling de modus terug**. Klopt die niet met wat gevraagd is, dan
faalt de flowkaart met een duidelijke melding in plaats van stil te doen alsof het gelukt is.

### 3.3 Omgaan met de wisselvallige UDP-server
De lokale API van deze batterijen antwoordt niet altijd — dat is een bekend euvel
(*"the main problem with the Marstek batteries is that their local API is just very
unstable"*). Daarom:

| Maatregel | Waarde |
|---|---|
| Herhaalpogingen bij uitlezen | 3× met oplopende wachttijd |
| Herhaalpogingen bij schakelen | 5× met 2 s oplopende wachttijd |
| Requests per poll | 1 (`ES.GetMode` bevat modus, SOC én vermogen) |
| Poll-interval | standaard 60 s (minimum aanbevolen: 30 s) |
| Bij aanhoudende stilte | apparaat wordt *onbeschikbaar*, maar blijft pollen → herstelt zichzelf |

## 4. Waarom deze keuzes

- **Officiële bron boven giswerk.** De implementatie volgt de *Marstek Device Open API
  Rev 3.1* (<https://static-eu.marstekenergy.com/ems/resource/agreement/MarstekDeviceOpenApi.pdf>).
  Hoofdstuk 4.2 bevestigt dat de **Venus A/D de ES-component ondersteunen**, dus dezelfde
  commando's als de Venus E.
- **Waarom geen TCP.** De opdracht was "via TCP", maar meten op de echte batterij laat zien
  dat er geen TCP-listener is: alleen UDP. TCP gebruiken zou dus nooit werken.
- **Waarom de Local API soms "aan" lijkt maar niets doet.** De schakelaar in de Marstek-app
  opent de API niet bij elk model. Dat gebeurt via Bluetooth met de
  [Marstek BLE Test Tool](https://rweijnen.github.io/marstek-venus-monitor/latest/)
  (Chrome op Windows of Android). Op het tabblad *advanced* zit ook **System Reset**, de
  bewezen manier om een batterij die niet meer antwoordt weer wakker te maken.
- **Waarom een eigen koppelwizard.** Het ingebouwde tweede koppelscherm van Homey liep vast
  ("Volgende" deed niets). De app heeft daarom een eigen scherm
  ([`drivers/venus_a/pair/start.html`](drivers/venus_a/pair/start.html)) dat de gevonden
  batterijen toont (model + IP + MAC) en het apparaat zelf aanmaakt.

## 5. Installeren bij jou thuis (stap voor stap)

Deze app is **lokaal** en staat (nog) niet in de Homey App Store. Je installeert hem
daarom één keer vanaf een computer naar je Homey. Daarna heb je de computer niet meer
nodig.

### 5.1 Wat je nodig hebt

| Nodig | Toelichting |
|---|---|
| Homey Pro (2016 of nieuwer) met firmware 10+ | Een Homey Bridge of Homey Cloud kan geen lokale apps draaien |
| Een Windows-, macOS- of Linux-computer | Alleen voor de installatie en updates |
| Node.js 18 of nieuwer | Gratis: <https://nodejs.org> (kies de LTS-versie) |
| Een Athom-account | Hetzelfde account als in de Homey-app |
| De batterij op hetzelfde netwerk als de Homey | En de **Local API aan** (zie §4) |

### 5.2 Stap 1 — Node.js installeren

- **Windows:** `winget install OpenJS.NodeJS.LTS` (of de installer van nodejs.org).
  Daarna een **nieuw** PowerShell-venster openen.
- **macOS:** `brew install node` (of de installer van nodejs.org).
- **Linux:** via je pakketbeheer of `nvm`.

Controle: `node -v` en `npm -v` geven allebei een versienummer.

### 5.3 Stap 2 — Homey CLI installeren

```bash
npm install -g homey
homey --version
```

> Krijg je `'homey' is not recognized`? Sluit de terminal en open een nieuwe.

### 5.4 Stap 3 — Inloggen op je Homey

```bash
homey login
```

Er opent een browser; log in met je Athom-account. Daarna:

```bash
homey list      # laat je Homey('s) zien
homey select    # kies je Homey als er meerdere zijn
```

### 5.5 Stap 4 — De app ophalen

Kopieer de map `homey-marstek-venus` naar je computer (via Git of een uitgepakte ZIP) en
ga er naartoe:

```bash
cd pad/naar/homey-marstek-venus
dir          # Windows: je ziet app.js, drivers, lib, ...
ls           # macOS/Linux
```

### 5.6 Stap 5 — (Optioneel) controleren en iconen maken

```bash
python tools/check_app.py         # controleert alle bestanden en verwijzingen
python tools/generate_images.py   # maakt de app-iconen (staan er al)
npm run images                    # hetzelfde, maar met Node.js
```

### 5.7 Stap 6 — Installeren op je Homey

```bash
homey app install
```

Je ziet achtereenvolgens *Pre-processing*, *Validating*, *Packing* en
*Installing Homey App* → **successfully installed**. Wil je de app tijdelijk draaien met
live logboek (ontwikkelmodus), gebruik dan `homey app run`; dat stopt als je het venster
sluit.

### 5.8 Stap 7 — De batterij koppelen

In de Homey-app:
1. **Meer → Apparaten → + (rechtsboven)**
2. Kies **Marstek Venus** (BETA)
3. Kies **Marstek Venus A** → **Installeren**
4. De eigen wizard toont de gevonden batterijen als grote knoppen met model, IP en MAC.
   Tik de juiste aan (bijvoorbeeld **Venus A · IP 192.168.1.51**) en druk **Volgende**.
   Zie je niets? Sluit de Homey-app volledig af en open hem opnieuw (cache), of kies de
   regel **"handmatig IP instellen"** en vul het IP daarna in bij de instellingen.

### 5.9 Stap 8 — Instellingen controleren

Tik het apparaat aan → **tandwiel**:

| Instelling | Aanbevolen |
|---|---|
| IP-adres | het adres uit de Marstek-app of je router |
| UDP-poort | 30000 (of wat je in de Marstek-app hebt ingesteld) |
| Poll-interval | **60** (niet lager dan 30) |
| Modus bij INSCHAKELEN | `Auto` |
| Modus bij UITSCHAKELEN | `Manual` |
| Vermogen in Manual-modus | 800 W (alleen als je `Manual` gebruikt) |

### 5.10 Stap 9 — Flows maken

**Flows → + Nieuwe flow** → *ALS* iets (tijd, zonnepanelen, prijs) → *DAN* **Marstek
Venus** → *Zet aan* / *Zet uit* / *Batterijmodus instellen*.

### 5.11 Bijwerken of verwijderen

- **Bijwerken:** nieuwe bestanden overnemen en opnieuw `homey app install`.
- **Verwijderen:** Homey-app → **Meer → Apps → Marstek Venus → Verwijderen**
  (apparaten en flows die eraan hangen verdwijnen dan ook).

### 5.12 Als de CLI klaagt

| Melding | Oplossing |
|---|---|
| `'node' is not recognized` | Node.js installeren of een nieuw terminalvenster openen |
| `'homey' is not recognized` | `npm install -g homey` opnieuw, daarna nieuwe terminal |
| `Could not find a valid Homey App ... app.json` | Eerst `python tools/build_app_json.py` uitvoeren (maakt `app.json` uit `.homeycompose`) |
| `Filepath does not exist: assets/icon.svg` | `python tools/generate_images.py` uitvoeren |
| `Invalid version ... pre-release` | Versienummer zonder `-beta` gebruiken (Homey staat dat niet toe) |
| Login lukt niet | `homey login` opnieuw, of `homey select` om de juiste Homey te kiezen |

### 5.13 Delen met anderen (of een nieuwe versie uitbrengen)

Maak een deelbaar ZIP-pakket van de app-map:

```bash
python tools/make_package.py      # -> dist/marstek-venus-homey-<versie>.zip
```

De ontvanger pakt de ZIP uit en voert **in die map** uit:

```bash
homey app install
```

**GitHub is hiervoor niet nodig.** GitHub is alleen een plek om bestanden te bewaren en
te delen; Git (het programma) is alleen handig als je vaker wijzigingen wilt
vastleggen en pushen. Wil je de code tóch op GitHub hebben, dan kan dat ook zonder Git
te installeren: maak een repository aan en sleep de bestanden in de browser naar de
pagina. Voor het publiceren in de **Homey App Store** is later wél een eigen app-id,
een e-mailadres in het manifest en een review door Athom nodig.

#### Op GitHub zetten (handig voor een forumlink)

1. Maak op <https://github.com/new> een **publieke, lege** repository aan (naam
   bijvoorbeed `Marstek-Venus-A`). Laat README, .gitignore en licentie uitgeschakeld —
   die zitten al in deze map.
2. Kopieer de URL die GitHub daarna toont en voer uit:

```powershell
.\publish.ps1 https://github.com/stiensnet-beep/Marstek-Venus-A.git
```

Deze app staat inmiddels op <https://github.com/stiensnet-beep/Marstek-Venus-A>; de
remote in deze map wijst daar al naartoe, dus `git push` is genoeg om een wijziging te
publiceren.

Bij de eerste keer opent GitHub een browservenster om in te loggen (Git Credential
Manager). Daarna kun je hetzelfde script bij elke wijziging opnieuw gebruiken om je
repository bij te werken. Blokkeert het uitvoeringsbeleid het script, gebruik dan:

```powershell
powershell -ExecutionPolicy Bypass -File .\publish.ps1 <url>
```

De forumtekst die bij deze repository hoort staat kant-en-klaar in
[`FORUM_POST.md`](FORUM_POST.md).

Uitgebreide uitleg over de ontwikkeling, netwerkdiagnose en alle metingen:
[`INSTALL.md`](INSTALL.md).

## 6. Bekende beperkingen

- **Instelling per toestel in de Marstek-app**: de Local API moet aan staan en de poort moet
  kloppen. Zonder dat antwoordt de batterij nergens op (de app zal dan *onbeschikbaar* zijn).
- **Eén batterij-index**: de app gebruikt `params.id = 0`. Meerdere batterijen in één
  systeem (multi-instance) zijn nog niet ondersteund.
- **Geen energiemeters**: kWh-totalen, PV-status en DOD zijn (nog) niet als Homey-capaciteit
  ontsloten; ze zijn wel op te vragen via de CLI.
- **"Uit" is geen fysieke uitschakeling**: de batterij blijft aan, maar doet niets.
- **Firmware-afhankelijk**: Marstek kan velden of modi wijzigen; de protocol-laag staat
  daarom in één bestand ([`lib/marstek.js`](lib/marstek.js)).

## 7. Risico's en verantwoordelijkheid

- Je bedient een echte batterij met een echte energievoorziening. Test nieuwe flows eerst
  met een simpele aan/uit-actie en houd de Marstek-app in de gaten.
- Gebruik op eigen risico. De maker is niet aansprakelijk voor schade, dataverlies of
  gevolgschade. Zie [`LICENSE`](LICENSE).
- Deze app is **niet** verbonden aan, goedgekeurd door of uitgebracht door Marstek.
- De meegeleverde PDF is auteursrechtelijk materiaal van Marstek en dient alleen als naslag.

## 8. Problemen oplossen

| Symptoom | Oplossing |
|---|---|
| Apparaat *onbeschikbaar* | Bekende wisselvalligheid. Wacht een poll af, of doe een **System Reset** via de BLE Test Tool |
| Geen enkel antwoord, ook niet met ping | Local API staat uit of de poort klopt niet → via Bluetooth (opnieuw) aanzetten |
| Koppelen vindt niets | Handmatige regel gebruiken en IP + poort in de instellingen invullen |
| Schakelen lijkt niets te doen | Controleer met `node tools\marstek-cli.js --host <ip> get-mode` of de modus echt wijzigt |
| Alles traag | Poll-interval op 60 s of hoger zetten |

Diagnose vanaf de pc:

```powershell
node tools\marstek-cli.js discover
node tools\marstek-cli.js --host 192.168.1.51 get-device
node tools\marstek-cli.js --host 192.168.1.51 get-mode
node tools\marstek-cli.js --host 192.168.1.51 battery-status
node tools\marstek-cli.js --host 192.168.1.51 wifi-status
```

## 9. Ideeën voor volgende versies

- Energietotalen en PV-status (Venus A/D hebben PV-ingangen) als Homey-capaciteiten
- Meerdere batterijen achter één IP (multi-instance via `params.id`)
- Alarmen (batterij leeg, geen verbinding, temperatuur)
- Volledige Nederlandse vertaling van alle flowkaarten
- Publicatie in de Homey App Store (vraagt een eigen app-id en een review)

## 10. Versiehistorie

| Versie | Datum | Wijziging |
|---|---|---|
| `0.1.0` (BETA 1) | 18-09-2026 | Eerste BETA: UDP-protocol volgens de officiële API, aan/uit + modi, eigen koppelwizard, robuustheid tegen de wisselvallige UDP-server. Getest op Venus E 3.0 (fw 150) en Venus A (fw 148). |
