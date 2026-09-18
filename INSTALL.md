# Installatieplan — Marstek Venus (BETA) op je Homey Pro 2023

**BETA** · gemaakt door **JPD** · versie `0.1.0` (BETA 1)
Achtergrond, geteste hardware en risico's: zie [`BETA.md`](BETA.md).

> **Eindstand 18-09-2026:** beide batterijen zijn gekoppeld en werken — de Venus E
> (192.168.1.50) en de Venus A (192.168.1.51). De Venus A moest eerst via Bluetooth
> worden gereset en zijn Local API opnieuw aangezet worden (poort 30000); daarna
> antwoordde hij direct. Dit document beschrijft de hele route en alle metingen onderweg.

## Onderzoeksresultaten (netwerkmeting)

Gemeten vanaf de pc (192.168.1.10) en met de Homey op 192.168.1.20:

| Adres | MAC | Ping | TCP-poorten | UDP 30000 (Marstek-API) |
|---|---|---|---|---|
| 192.168.1.50 | *Venus E* | ja | geen open | **ja — antwoordt volledig** (VenusE 3.0, ver 150) |
| 192.168.1.51 (Venus A volgens Marstek-app + router) | geen ARP-entry | **nee** | geen | nee |
| 192.168.1.52 | 00-11-22-33-44-55 | ja (TTL 255) | geen | nee |
| 192.168.1.53 | aa-bb-cc-dd-ee-ff | ja (TTL 255) | geen | nee |

Belangrijkste conclusies:

- De **Venus E** spreekt de lokale API volledig uit; de app is daarop geverifieerd
  (`Marstek.GetDevice`, `ES.GetMode`, `ES.GetStatus`, `ES.SetMode`).
- **192.168.1.51 is op dit moment niet bereikbaar** (geen ARP, ping time-out). Omdat de
  Venus E via wifi (`MY_WIFI`) wél bereikbaar is vanaf de bekabelde kant, is
  broadcast/isolatie niet de oorzaak: het toestel is waarschijnlijk offline of zit op een
  ander wifi-netwerk.
- De Venus A reageert (nog) niet op UDP 30000, dus een koppeling kan nu niet worden
  getest. Zodra het apparaat online is en hetzelfde protocol spreekt, vindt de app hem
  automatisch — er is geen codewijziging nodig.

De lokale API van de Venus A is bevestigd door de officiële Marstek Device Open API
(hoofdstuk 4.2: Venus A/D ondersteunen de ES-component) én door een Home Assistant-brug
die de Venus A "lokaal via de UDP API" uitleest (github.com/IvanKablar/marstek-venus-bridge).
Er is dus geen protocolprobleem — alleen bereikbaarheid.

### De oplossing volgens het Homey-forum: de BLE Test Tool

Uit de thread van de bestaande Marstek-apps blijkt dat de **Local API standaard UIT
staat** en dat de schakelaar in de Marstek-app hem niet bij elk model daadwerkelijk
opent. Het aanzetten hoort via Bluetooth:

1. Open in **Chrome op een Windows-pc**: <https://rweijnen.github.io/marstek-venus-monitor/latest/>
   (Web Bluetooth; op Apple-apparaten en in sommige browsers werkt dit niet).
2. Verbind met de **Venus A** via Bluetooth.
3. Zet daar de **Local API** aan en stel de **UDP-poort** in (bijv. 30000 of 30001).
4. Lukt er niets meer? Op het tabblad **advanced** zit **"System Reset"**. Meerdere
   gebruikers (en de ontwikkelaar van de Marstek Venus Connector-app) moesten dit doen
   omdat *"de batterij soms gewoon stopt met antwoorden"*. Op eigen risico.
5. Test daarna: `node tools\marstek-cli.js --host 192.168.1.52 --port 30001 get-device`.

Marstek kan de API ook op afstand openzetten; volgens het forum duurt dat soms een paar
werkdagen. Verder is de UDP-server van de batterij berucht instabiel: houd het
poll-interval op **minimaal 30 seconden** (de app doet dat standaard) en reken erop dat
sommige commando's pas na een herhaalpoging slagen. De app doet nu automatisch 3 pogingen
met oplopende wachttijd.

### Aanvullende meting op 192.168.1.52 (het adres waar de Marstek-app naartoe praat):

| Test | Resultaat |
|---|---|
| MAC (OUI) | **00:9B:08 = Quectel**, dezelfde reeks die de officiële API-documentatie gebruikt in het VenusD-voorbeeld (`VenusD-009b08a5ac28`) - dus de Venus D/A-familie |
| Ping | **antwoord** (3-4 ms) - het toestel is bereikbaar |
| UDP 30000 en 30001, 3 x 3 commando's, 30 s wachten per poort | **geen enkel antwoord** |
| UDP-poortenscan (269 poorten, 2 payloads) | geen antwoord |
| TCP-poortenscan (74 poorten) | geen open poort |
| 192.168.1.51 (volgens de Marstek-app) | geen ARP-entry, ping time-out |

Conclusie: het netwerkpad naar de Venus A is in orde (ping komt aan), maar op de
UDP-poorten luistert niets. De **Open API staat op dit toestel dus niet aan**, of de
poortwijziging is nog niet actief geworden in de wifi-module.

Vervolgstappen:

1. Marstek-app -> **Venus A** -> instellingen -> **Open API / Local API**: zet die aan en
   stel de poort in (`30000` of `30001`) - noteer welke poort je kiest.
2. **Herstart de Venus A** (uit/aan via de app of de knop). Een gewijzigde API-poort wordt
   pas actief nadat de module opnieuw is opgestart.
3. Test: `node tools\marstek-cli.js --host 192.168.1.52 get-device` (of `--port 30001`).
   Een antwoord ziet eruit als
   `{"id":1,"src":"VenusA-...","result":{"device":"VenusA","ver":...,"ble_mac":"..."}}`.
4. Antwoordt hij? Koppel hem in Homey via **"Marstek Venus A (handmatig IP instellen)"**
   met IP `192.168.1.52` en de gekozen poort. De Venus E (192.168.1.50) werkt nu al.

> **Status:** de app is al geïnstalleerd op een Homey Pro 2023
> (`com.stiensnet.marstek`, in dit voorbeeld op 192.168.1.20). De stappen hieronder
> zijn de volledige route voor als je het opnieuw wilt doen.

Stap voor stap, voor Windows 11. Elke stap heeft een **controlepunt**: pas als dat
klopt ga je verder. Total duurt het ongeveer 15–20 minuten.

- Wat je nodig hebt: je Windows-pc, je Homey Pro 2023 en je Athom-account.
- De app draait **lokaal op je Homey**; je pc is alleen nodig om hem te installeren.
- Je bestaande Marstek-app voor de **Venus E** blijft gewoon werken.

---

## Stap 1 — Node.js installeren

De Homey CLI (`homey`) is een Node.js-programma. Open **PowerShell** en voer uit:

```powershell
winget install OpenJS.NodeJS.LTS
```

Alternatief: download de LTS-versie van <https://nodejs.org> en installeer die.

**Sluit daarna PowerShell en open een nieuw venster** (zodat het PATH opnieuw geladen wordt).

**Controlepunt:**

```powershell
node -v
npm -v
```

Je moet twee versienummers zien (bijv. `v22.11.0` en `10.9.0`).

> Krijg je nog steeds "'node' is not recognized"? Sluit alle terminals, of herstart
> Windows. Node.js staat op deze pc nog niet geïnstalleerd — dat is de reden dat
> deze stap nodig is.

---

## Stap 2 — Homey CLI installeren

```powershell
npm install -g athom-cli
```

**Controlepunt:**

```powershell
homey --version
```

Je moet een versienummer zien (bijv. `3.x.x`).

---

## Stap 3 — Inloggen bij Homey

```powershell
homey login
```

- Er opent een browser; log in met je **Athom-account** (hetzelfde account als in de
  Homey-app).
- Kies je Homey Pro uit de lijst.

**Controlepunt:** er verschijnt een melding als *"Logged in as …"*.

Zie je meerdere Homey's of is de verkeerde geselecteerd?

```powershell
homey select
```

---

## Stap 4 — Naar de app-map gaan

```powershell
cd C:\pad\naar\homey-marstek-venus
```

**Controlepunt:**

```powershell
dir
```

Je ziet o.a. `app.js`, `package.json`, `drivers`, `lib`, `assets` en dit bestand.

---

## Stap 5 — (optioneel) de app controleren

Zonder Node/Homey CLI kun je met Python controleren of alle bestanden kloppen:

```powershell
python tools\check_app.py
```

Verwacht: `Alles in orde.`

Ook de iconen kun je altijd opnieuw genereren (ze zitten er al in):

```powershell
python tools\generate_images.py
```

---

## Stap 6 — De app naar je Homey sturen (ontwikkelmodus)

```powershell
homey app run
```

Wat er gebeurt:

1. De app wordt gecontroleerd en naar je Homey Pro geüpload.
2. De app start op de Homey en **deze terminal toont het logboek**.

**Laat dit venster openstaan** zolang je de app in ontwikkelmodus wilt gebruiken.
Stoppen = `Ctrl+C`.

**Controlepunt:** in de log zie je iets als `Marstek Venus app is gestart`.

> Fouten over ontbrekende afbeeldingen? Voer eerst `python tools\generate_images.py` uit.

---

## Stap 7 — De Venus A als apparaat toevoegen

In de **Homey-app op je telefoon (of <https://my.homey.app>)**:

1. **Meer** → **Apparaten** → **+** (rechtsboven).
2. Kies **Marstek Venus**.
3. Kies **Marstek Venus A** → **Installeren**.
4. De wizard zoekt nu via een UDP-broadcast op poort 30000. Je ziet een lijst:

   | Regel in de lijst | Betekenis |
   |---|---|
   | `Venus … · IP 192.168.x.y · AA:BB:…` | een gevonden Marstek-apparaat (model + IP + MAC) |
   | `Marstek Venus A (handmatig IP instellen)` | altijd aanwezig; voor als broadcast geblokkeerd is |

5. **Let op:** je **Venus E** zit op dezelfde poort en verschijnt hier dus ook.
   Kies de regel met het **IP-adres van je Venus A** (venus E weglaten).
   Weet je niet welk IP wat is? Kijk in je router of in de Marstek-app bij
   *Apparaatinstellingen/Netwerk* van elk apparaat.
6. Bevestig. Het apparaat heet nu bv. *Marstek Venus A*.

> Twijfel je? Voer eerst `node tools\marstek-cli.js discover` uit: je krijgt een
> JSON-lijst met per apparaat `host`, `mac` en `model`. Hetzelfde rijtje als in de wizard.

---

## Stap 8 — IP-adres en aan/uit-koppeling instellen

1. Homey-app → **Apparaten** → **Marstek Venus A** → **tandwiel** (instellingen).
2. Vul/controleer:
   - **IP-adres**: bv. `192.168.1.50` (vast IP aanraden: DHCP-reservering in je router).
   - **UDP-poort**: `30000`.
   - **Poll-interval**: `30` seconden (of `0` als je alleen wilt schakelen).
   - **Modus bij INSCHAKELEN**: `Auto` (sub-configuratie aan → eigen verbruik).
   - **Modus bij UITSCHAKELEN**: `Manual` (sub-configuratie uit → batterij doet niets).
   - Staat de Venus A op een andere API-poort (zoals 30001)? Vul die dan hier in.
3. Opslaan.

**Controlepunt:** het apparaat is **beschikbaar** (geen rode driehoek) en de
aan/uit-schakelaar reageert. Test los van Homey met:

```powershell
node tools\marstek-cli.js --host 192.168.1.50 get-mode
node tools\marstek-cli.js --host 192.168.1.50 battery-status
node tools\marstek-cli.js --host 192.168.1.50 set-mode Auto
node tools\marstek-cli.js --host 192.168.1.50 off --off-mode Manual
```

De geldige modi zijn `Auto`, `AI`, `UPS`, `Manual` en `Passive` (officiële Marstek-API;
`Standby` bestaat niet). Bij `set-mode` kun je er `aan` of `uit` achter zetten om de
sub-configuratie aan of uit te zetten.

---

## Stap 9 — Flows maken

In de Homey-app → **Flows** → **+ Nieuwe flow**:

1. **ALS** — kies bv. *Datum & tijd → Het is 17:00*
2. **DAN** — kies **Marstek Venus A** → *Zet uit* (of *Batterijmodus instellen* → `Manual`)
3. Sla op en test met de play-knop.

Beschikbare kaarten:

- **Acties:** *Zet aan*, *Zet uit*, *Schakel om*, *Batterijmodus instellen …*
- **Conditie:** *Batterijmodus is …*
- **Trigger:** *Batterijmodus is gewijzigd* (token `mode`)

---

## Stap 10 — Permanent installeren

Wil je de app laten draaien zonder dat de terminal open hoeft te blijven:

1. Stop de ontwikkelmodus: `Ctrl+C` in het `homey app run`-venster.
2. Installeer definitief:

```powershell
homey app install
```

De app staat nu op je Homey en blijft draaien (ook na een herstart van Homey).
Het gekoppelde apparaat en je flows blijven bestaan.

---

## Stap 11 — Later iets aanpassen

- Wijzig je een bestand in de map, dan kun je opnieuw `homey app run` (of
  `homey app install`) uitvoeren; Homey werkt de app bij.
- Na een aanpassing aan de driver is het soms nodig het apparaat te verwijderen en
  opnieuw toe te voegen (Homey herlaadt drivers niet altijd warm).

---

## Problemen oplossen

| Melding / symptoom | Wat te doen |
|---|---|
| `'node' is not recognized` | Stap 1 opnieuw; terminal sluiten en heropenen; eventueel Windows herstarten. |
| `'homey' is not recognized` | Terminal heropenen. Controleer met `npm config get prefix` en of die map in je PATH staat. |
| `homey login` opent geen browser | Kopieer de URL uit de terminal naar je browser, of probeer `homey select` daarna. |
| App niet te zien bij **+ Apparaat** | Draait `homey app run` nog? Zonder actieve installatie is de app er niet. |
| Wizard toont alleen de handmatige regel | Broadcast wordt geblokkeerd (VLAN/AP-isolatie). Kies de handmatige regel en vul het IP in bij de instellingen. |
| Twee Marstek-regels, welke is de Venus A? | Vergelijk het IP-adres met je router/Marstek-app; of gebruik `node tools\marstek-cli.js discover` (met `--host` test je daarna per apparaat). |
| Apparaat "onbeschikbaar" | Verkeerd IP/poort, of de batterij is offline. Test met `node tools\marstek-cli.js --host <ip> get-mode`. |
| Schakelen lijkt niets te doen | Aan- en uitmodus zijn gelijk, of de modusnaam bestaat niet op jouw firmware. Test met `set-mode <naam>` via de CLI. |
| Build-fout over images | `python tools\generate_images.py` uitvoeren. |

---

## Wat deze app níet doet met je Venus E

- De UDP-broadcast alleen **lezen** om apparaten te vinden; je Venus E antwoordt dus mee
  in de koppellijst, maar er wordt niets naar gestuurd.
- Zodra je kiest, stuurt de app UDP-berichten **alleen naar het IP-adres van het
  apparaat dat je hebt toegevoegd**. Je Venus E wordt niet aangeraakt en blijft via de
  bestaande Marstek-app werken.
- Twijfelgeval: heb je per ongeluk de Venus E gekoppeld? Dan regelt die hetzelfde
  protocol - verwijder het apparaat in Homey en voeg de Venus A toe met het juiste IP.
