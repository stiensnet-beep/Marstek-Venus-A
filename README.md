# Marstek Venus — Homey app (**BETA**)

**Gemaakt door JPD** · versie `0.3.0` (BETA 2) · Homey SDK 3 (lokaal)

> **BETA:** de app werkt en is getest op een **Venus E 3.0 (fw 150)** en een **Venus A
> (fw 148)**, maar is nog niet breed uitgerold en is geen officiele Marstek-integratie.
> Lees [`BETA.md`](BETA.md) voor de status, de geteste hardware, de risico's en de
> technische uitleg. Gebruik op eigen verantwoordelijkheid.

Een kleine, lokale Homey-app (SDK 3) waarmee je een **Marstek Venus A** (en Venus E)
thuisbatterij via de **lokale API** (UDP poort 30000) kunt in- en uitschakelen, zodat je
hem in Homey flows kunt gebruiken.

## Snel installeren

```bash
npm install -g homey                        # eenmalig: Homey CLI
homey login                                 # eenmalig: inloggen met je Athom-account
git clone https://github.com/stiensnet-beep/Marstek-Venus-A.git
cd Marstek-Venus-A
homey app install                           # of: homey app run (ontwikkelmodus)
```

Geen Git? Download de ZIP via de groene **Code**-knop → *Download ZIP*, pak hem uit en
voer `homey app install` uit in die map.

> **Voorwaarde:** de **Local API** van de batterij moet aan staan. Dat gebeurt via
> Bluetooth met de Marstek BLE Test Tool
> (<https://rweijnen.github.io/marstek-venus-monitor/latest/>), niet met de schakelaar in
> de Marstek-app. Zie [`BETA.md` §4](BETA.md).

Volledige stap-voor-stap handleiding: [`BETA.md` §5](BETA.md).

Naast aan/uit worden ook de **batterijmodus**, het **laadniveau (SOC)**, het
**batterijvermogen**, de **batterijtemperatuur** en de **kWh-tellers** (geladen en
ontladen) uitgelezen (optioneel, instelbaar poll-interval).

De Venus E kun je met de bestaande Marstek-app blijven bedienen; deze app voegt
daar niets aan toe en kan naast die app bestaan.

---

## 1. Wat kun je ermee in Homey?

**Apparaten**
- Marstek Venus A (driver `venus_a`), klasse **battery** (thuisbatterij), met de capaciteiten
  `onoff`, `measure_battery`, `measure_power`, `meter_power.charged`,
  `meter_power.discharged`, `measure_temperature` en `measure_signal_strength`
  (het WiFi-signaal van de batterij, sinds 0.3.0).

**Flows — acties (ingebouwd via de `onoff`-capaciteit)**
- *Zet aan* (schakelt naar de in de instellingen gekozen "aan"-modus, standaard `Auto` met `auto_cfg.enable = 1`)
- *Zet uit* (schakelt naar de "uit"-modus, standaard `Manual` met de sub-configuratie **uit**)
- *Schakel om*

**Flows — acties (eigen kaart)**
- *Batterijmodus instellen*: kies een apparaat en een modus
  (`Auto`, `AI`, `UPS`, `Manual`, `Passive` — de officiële Marstek-modi), en optioneel
  een vermogen in W voor `Manual` en `Passive` (leeg = **Vermogen in Manual-modus** uit de
  instellingen).

  > Let op: `Manual` schrijft één tijdslot van het batterijschema: 00:00-23:59, elke
  > dag, met het gekozen vermogen. Welk slot dat is, stel je in bij **Schemaslot voor
  > Manual** (standaard 0). Kies een slot dat je in de Marstek-app niet gebruikt, anders
  > wordt dat deel van je schema overschreven. Dat geldt ook voor aan/uit als die
  > `Manual` gebruikt.

**Flows — conditie**
- *Batterijmodus is ...*: vergelijkt de actuele modus met de gekozen modus.
- Daarnaast kun je de standaard Homey-conditiekaarten voor `onoff` gebruiken.

**Flows — trigger**
- *Batterijmodus is gewijzigd* met token `mode` (de nieuwe modus).

### Energieoverzicht (Energy-tab)

Homey zet een thuisbatterij alleen in het energieoverzicht als de driver dat expliciet
zegt: `"energy": { "homeBattery": true }` in `driver.compose.json`, plus de tellers
`meter_power.charged` en `meter_power.discharged` (kWh). Tot **0.1.1** deed deze app dat
niet, waardoor de batterij nergens in het energieoverzicht stond - ook niet met
"Uitsluiten van energie" op **NEE**. Sinds **0.2.0** wel:

| Waarde | Homey-capaciteit | Waar het vandaan komt |
|---|---|---|
| Batterijniveau (%) | `measure_battery` | `ES.GetMode` / `Bat.GetStatus` (`bat_soc`) |
| Batterijvermogen (W, positief = laden, negatief = ontladen) | `measure_power` | `ES.GetMode` (`ongrid_power`, met omgedraaid teken - zie hieronder) |
| Modus (`Auto`, `AI`, `UPS`, `Manual`, `Passive`) | `operation_mode` (eigen capaciteit, alleen lezen) | `ES.GetMode` (`mode`) |
| Geladen energie (kWh, cumulatief) | `meter_power.charged` | `ES.GetStatus` (`total_grid_input_energy`) |
| Ontladen energie (kWh, cumulatief) | `meter_power.discharged` | `ES.GetStatus` (`total_grid_output_energy`) |
| Batterijtemperatuur (°C) | `measure_temperature` | `Bat.GetStatus` (`bat_temp`) |

De twee energietellers worden niet bij elke poll opgehaald: dat kost twee extra
UDP-verzoeken en deze batterijen houden niet van veel verkeer. Ze komen één keer bij het
starten en daarna elke vijfde ronde - bij het standaardinterval van 60 s dus elke 5
minuten. De temperatuur lift mee op dezelfde ronde.

> **Teken van het vermogen:** `ongrid_power` is het vermogen aan de netkant van de batterij en
> is **positief bij ontladen** (op 18-09-2026 gemeten: bij +934 W liep de opgeslagen energie in
> 15 minuten 109 Wh terug). Homey verwacht bij een thuisbatterij juist positief = laden. Sinds
> **0.3.3** draait de app het teken om; tot en met 0.3.2 stond de richting in Homey Energy
> verkeerd om.

> Let op: `ES.GetMode` bevat ook `input_energy` / `output_energy` (in 0,1 Wh), maar dat
> zijn de **CT-waarden van het huis** (import/export van de meterkast), niet de lading van
> de batterij. Die worden daarom bewust niet als batterijteller gebruikt.

### WiFi-status van de batterij

Sinds **0.3.0** is de WiFi-status van de accu zelf zichtbaar - handig, want deze batterijen
hebben een bescheiden WiFi-radio en de Marstek-app laat daar weinig van zien.

| Waarde | Waar te zien | Waar het vandaan komt |
|---|---|---|
| Signaalsterkte (dB) | Capaciteit **WiFi-signaal** op de apparaatpagina en in **Insights** | `Wifi.GetStatus` (`rssi`, dBm) |
| Netwerk (SSID) | Apparaatinstellingen → **WiFi van de batterij** | `ssid` |
| Signaalsterkte als tekst | idem, bijv. `-87 dBm (zeer zwak)` | `rssi` + kwaliteitsklasse |
| IP-adres, gateway/subnetmasker, MAC | idem | `sta_ip`, `sta_gate` / `sta_mask`, `wifi_mac` |
| Laatst uitgelezen | idem | tijdstip van de laatste geslaagde `Wifi.GetStatus` |

De RSSI is een echte dBm-waarde: rond **-30** is uitstekend, **-67** is de gebruikelijke
grens voor vloeiend streamen, onder **-80** wordt het wankel en rond **-90** houdt het op.
Homey toont de waarde in **dB**, want dat is de eenheid van de standaardcapaciteit
`measure_signal_strength`.

> **Waarom het getal urenlang hetzelfde kan blijven:** Homey legt een capaciteitswaarde
> alleen vast als die écht verandert, en de batterij meldt zijn RSSI traag (in de praktijk
> schuift die met stapjes van 1 dB per uur). Het is dus normaal dat *WiFi-signaal* lang op
> bijvoorbeeld `-86` blijft staan; dat betekent niet dat de app niet leest. Dat je het
> uitlezen kunt volgen, zie je aan de regel **Laatst uitgelezen** in de instellingen (die
> verspringt bij elke WiFi-ronde) en aan de logregel *WiFi: -86 dBm (zeer zwak) via
> MY_WIFI*.

Omdat het die standaardcapaciteit is, maakt Homey automatisch de flow-trigger
*De signaalsterkte is veranderd* aan (met de nieuwe waarde als token). Daarmee kun je
bijvoorbeeld een melding laten sturen zodra het signaal onder de -80 zakt.

> WiFi kost ook een extra UDP-verzoek, dus het gaat in een **eigen ronde** (ronde 2, 7, 12,
> ...): er gaan nooit drie verzoeken tegelijk naar de batterij. Bij het standaardinterval
> van 60 s dus elke 5 minuten. De regels in de instellingen worden alleen bijgewerkt als er
> echt iets veranderd is.

### Al gekoppeld? Meestal gaat het vanzelf

Homey legt de **klasse van een apparaat vast op het moment van koppelen** en een
app-update verandert die niet. Een apparaat dat met 0.1.x als `socket` is gekoppeld zou dus
buiten het energieoverzicht blijven. Daarom zet de app sinds **0.2.1** de klasse bij het
starten zelf recht met `device.setClass('battery')`; je hoeft daar niets voor te doen. In
het Homey-log staat dan *Klasse bijgewerkt van "socket" naar "battery"*.

Blijft de batterij onverwacht toch buiten **Energie → Thuisbatterij**, verwijder het
apparaat dan eenmalig en voeg het opnieuw toe: **Apparaten → tandwiel → Verwijderen** en
daarna **+ → Marstek Venus → Marstek Venus A** met het IP-adres van je Venus A.

> Via de API is `class` niet te wijzigen: `homey api devices update-device` negeert het veld
> (gecontroleerd op firmware 13.5.1) en een herstart van de app helpt niet. Vandaar de
> migratie in de app zelf, en anders opnieuw koppelen.

---

## 2. Vereisten

- Homey Pro met firmware **12.2 of nieuwer** (getest op 13.5.1), app draait **lokaal** op
  Homey. Sinds 0.2.0 is Homey 12 het minimum (de klasse `battery` voor het
  energieoverzicht bestaat niet in oudere firmware) en sinds 0.3.0 is dat **12.2**, omdat
  de capaciteit `measure_signal_strength` (WiFi-signaal) pas vanaf die versie bestaat.
- Node.js 18+ en de Homey CLI op je computer om de app te installeren/bouwen
  (op deze computer: Node.js **v24** met Homey CLI **4.5.0**). Ontbreekt Node.js?
  Installeer het met `winget install OpenJS.NodeJS.LTS` of via <https://nodejs.org>,
  daarna `npm install -g homey`.
- De Venus A moet bereikbaar zijn op je LAN (zelfde netwerk als je Homey).
- De lokale API moet op de batterij aanwezig zijn (recente firmware).
- Python 3 is hier wél aanwezig; de hulpscripts voor iconen/controle werken daarmee.

---

## 3. Installeren

### 3.1 Homey CLI

Een volledige stap-voor-stap handleiding voor andere gebruikers (inclusief Node.js
installeren, inloggen, koppelen en bijwerken) staat in
[**BETA.md §5 — Installeren bij jou thuis**](BETA.md#5-installeren-bij-jou-thuis-stap-voor-stap).

```powershell
npm install -g homey       # de huidige Homey CLI
homey login                # inloggen met je Athom-account
homey select               # alleen nodig als je meerdere Homey's hebt
```

### 3.2 Iconen genereren (eenmalig)

De Homey app-store vereist PNG-iconen (app én driver). Ze zijn in deze map al
gegenereerd, maar je kunt ze altijd opnieuw maken:

```powershell
cd homey-marstek-venus
python tools\generate_images.py      # werkt met Python 3 (aanbevolen hier)
npm run images                        # alternatief met Node.js
```

Controleren of alle bestanden en verwijzingen kloppen (zonder Node/Homey CLI):

```powershell
python tools\check_app.py
```

### 3.3 App naar Homey sturen

Tijdens het ontwikkelen (blijft draaien en herlaadt bij wijzigingen):

```powershell
homey app run
```

Blijvend installeren op je Homey:

```powershell
homey app install
```

> Bij `homey app run` wordt de app in ontwikkelaarsmodus gestart. Sluit je de
> terminal, dan stopt de app. Gebruik `homey app install` voor permanent gebruik.

---

## 4. Apparaat toevoegen

Zie ook het uitgebreide stap-voor-stap plan in [`INSTALL.md`](INSTALL.md).

1. Homey → **Apparaten** → **+** → **Marstek Venus** → **Marstek Venus A**.
2. De app doet een **UDP-broadcast** (`Marstek.GetDevice` op poort 30000) en toont
   ieder gevonden Marstek-apparaat als `model · IP … · MAC`.
   **Let op:** je Venus E zit op dezelfde poort en staat hier dus ook tussen — kies
   bewust de regel met het IP-adres van je Venus A.
3. Staat je batterij er niet bij (bijvoorbeeld omdat je router broadcast blokkeert)?
   Kies dan **"Marstek Venus A (handmatig IP instellen)"** en vul daarna het IP-adres
   in via de apparaatinstellingen.
4. Klaar: het apparaat verschijnt met een aan/uit-schakelaar.

### Venus E en Venus A op dezelfde UDP-poort (30000)

Dat is geen probleem, omdat:

- de discovery alleen **luistert** naar antwoorden; er wordt niets naar je Venus E
  gestuurd en de broadcast-responsen worden per IP/MAC in een aparte lijst gezet;
- de app vanaf dat moment **alleen UDP-berichten stuurt naar het IP-adres van het
  apparaat dat jij hebt toegevoegd**;
- de broadcast vanaf een **willekeurige bronpoort** vertrekt, dus niet botst met de
  bestaande Marstek-app of met de UDP-poort 30000 van je Homey zelf.

Handig om de twee uit elkaar te houden:

```powershell
node tools\marstek-cli.js discover
```

Je krijgt per apparaat `host`, `port`, `mac`, `model` en `name` te zien. Vergelijk die
IP's met je router (of met de netwerkinfo in de Marstek-app) en koppel alleen de Venus A.

---

## 5. Instellingen (per apparaat)

| Instelling | Standaard | Betekenis |
|---|---|---|
| **IP-adres** | *leeg* | Lokaal IP van de batterij, bijv. `192.168.1.50` |
| **UDP-poort** | `30000` | Poort van de lokale API (UDP) |
| **Poll-interval** | `60` | Seconden tussen uitlezen van modus/status. `0` = niet pollen; minder dan 30 wordt 30. Een nieuwe ronde start pas als de vorige klaar is |
| **Modus bij INSCHAKELEN** | `Auto` | Modus die bij "aan" wordt gezet (sub-config aan) |
| **Modus bij UITSCHAKELEN** | `Manual` | Modus die bij "uit" wordt gezet (sub-config uit = batterij doet niets) |
| **Vermogen in Manual-modus** | `800` | Watt voor `Manual` en `Passive`, bij aan/uit en bij de flowkaart zonder eigen vermogen |
| **Schemaslot voor Manual** | `0` | Tijdslot (0-9) van het batterijschema dat `Manual` schrijft; kies er een dat je in de Marstek-app niet gebruikt |
| **WiFi van de batterij** | *automatisch* | Alleen-lezen: SSID, signaalsterkte, IP, gateway/subnetmasker en MAC, gevuld uit `Wifi.GetStatus` |

Het "aan/uit"-vinkje in Homey wordt afgeleid uit de modus: **uit = de modus die bij
uitschakelen is ingesteld**, elke andere modus betekent **aan**. Kies je voor aan én
uit dezelfde modus (bijv. beide `Manual`), dan werkt schakelen nog steeds: bij "uit"
wordt de sub-configuratie uitgeschakeld (`enable = 0`).

> Er is geen aparte "Standby"-modus in de Marstek-API. "Uit" betekent: een modus
> zetten waarvan de sub-configuratie uit staat. `Manual` zonder actief schema laat de
> batterij niets doen; `UPS` met `ups_cfg.enable = 0` zet alleen de back-upfunctie uit.

---

## 6. Voorbeeldflows

**Batterij uit tijdens dure uren**

- *ALS* — Het is 17:00
- *DAN* — Zet Marstek Venus A **uit**

**Batterij aan zodra de panelen terugleveren**

- *ALS* — Zonnepanelen leveren meer dan 1500 W
- *EN* — Marstek Venus A is **uit**
- *DAN* — Zet Marstek Venus A **aan**

**Melding bij een moduswijziging**

- *ALS* — Batterijmodus is gewijzigd (token `mode`)
- *DAN* — Stuur een notificatie: "Batterij staat nu in [[mode]]"

**Handmatig ontladen met vast vermogen**

- *DAN* — Batterijmodus instellen → modus `Manual`, vermogen leeg (ingesteld wattage) of bijv. `500`

---

## 7. Protocol (geverifieerd op een Venus E 3.0, firmware ver 150)

Bron: **Marstek Device Open API Rev 3.1** (officieel, Marstek):
<https://static-eu.marstekenergy.com/ems/resource/agreement/MarstekDeviceOpenApi.pdf>

Volgens hoofdstuk 4 ondersteunt de **Venus A** (samen met de D) de componenten Marstek,
WiFi, Bluetooth, Battery, **PV**, **ES**, EM en SYS — dus exact dezelfde
`ES.*`-commando's als de Venus E. De API is per toestel aan te zetten in de Marstek-app,
met een **instelbare UDP-poort** (default 30000). Zet de Venus E en Venus A dus gerust op
verschillende poorten (bijvoorbeeld 30000 en 30001) en vul die poort per apparaat in.

Modi en hun sub-configuratie (`ES.SetMode`):

| Modus | Sub-configuratie | Betekenis |
|---|---|---|
| `Auto` | `auto_cfg.enable` | Eigen verbruik (standaard "aan") |
| `AI` | `ai_cfg.enable` | AI-sturing |
| `UPS` | `ups_cfg.enable` | Noodstroom / back-up |
| `Manual` | `manual_cfg`: `time_num`, `start_time`, `end_time`, `week_set`, `power`, `enable` | Tijdschema of vast vermogen |
| `Passive` | `passive_cfg`: `power`, `cd_time` | Externe sturing |

Elke modus vereist de bijbehorende sub-configuratie: zonder die sub-configuratie
antwoordt het toestel met `set_result: false`. Geverifieerd op de Venus E — met
`auto_cfg.enable = 1` komt er `set_result: true`.

**Belangrijk:** de Marstek Venus praat volledig over **UDP** (standaard poort 30000).
Er is geen TCP-listener op die poort (getest: TCP-verbinding geeft geen antwoord).
Elke request is één JSON-object, elk antwoord ook; ze worden op `id` gematcht.

| Doel | Transport | Payload |
|---|---|---|
| Discovery | UDP 30000 (broadcast + unicast-sweep) | `{"id":0,"method":"Marstek.GetDevice","params":{"ble_mac":"0"}}` |
| Modus lezen | UDP 30000 | `{"id":n,"method":"ES.GetMode","params":{"id":0}}` |
| Modus zetten | UDP 30000 | `{"id":n,"method":"ES.SetMode","params":{"id":0,"config":{"mode":"Auto"}}}` |
| Status lezen | UDP 30000 | `{"id":n,"method":"ES.GetStatus","params":{"id":0}}` |

Voorbeeldantwoorden:

```json
{"id":0,"src":"VenusE 3.0-aabbccddeeff",
 "result":{"device":"VenusE 3.0","ver":150,"ble_mac":"aabbccddeeff",
           "wifi_mac":"ffeeddccbbaa","wifi_name":"MY_WIFI","ip":"192.168.01.50"}}

{"id":1,"src":"VenusE 3.0-aabbccddeeff",
 "result":{"id":0,"mode":"Auto","ongrid_power":-135,"offgrid_power":0,"bat_soc":38}}

{"id":2,"src":"VenusE 3.0-aabbccddeeff","result":{"id":0,"set_result":false}}
```

Let op twee eigenaardigheden van de firmware, die de app allebei opvangt:

- `result.device` is de **modelnaam als tekst** (geen object) en `ip` kan
  voorloopnullen bevatten (`192.168.01.50`); de app normaliseert dat.
- `set_result` is **geen betrouwbare succesaanduiding**: dezelfde modus nogmaals
  zetten geeft óók `false`. Daarom leest de app na elke wijziging de modus terug
  en vergelijkt die; klopt het niet, dan faalt de flowkaart met een duidelijke melding.

Bij `Manual` wordt extra configuratie meegestuurd:

```json
{"id":n,"method":"ES.SetMode","params":{"id":0,"config":{
  "mode":"Manual",
  "manual_cfg":{"time_num":0,"start_time":"00:00","end_time":"23:59","power":800,"enable":1}
}}}
```

`time_num` is het schemaslot uit de instelling **Schemaslot voor Manual** (standaard 0) en
`power` het vermogen van de flowkaart of uit de instellingen.

### Wat de API nog meer geeft

Alles hieronder komt uit de officiële *Marstek Device Open API Rev 3.1*. De kolom
"Venus A nu" is wat de batterij op **29-09-2026** teruggaf (fw 148; IP-adres en WiFi-naam hieronder vervangen door voorbeelden),
opgevraagd met `node tools/marstek-cli.js`; de laatste kolom zegt of de app het gebruikt.

| Commando | Gegeven | Venus A nu | In de app? |
|---|---|---|---|
| `Marstek.GetDevice` | model, firmware, BLE-MAC, WiFi-MAC, WiFi-naam, IP | `Venus A`, fw 148, `192.168.1.51` | deels (koppelen) |
| `ES.GetMode` | `mode`, `bat_soc`, `ongrid_power`, `offgrid_power` | `Auto`, 15 %, −133 W | ja (elke poll) |
| `ES.GetMode` | `ct_state` + `a_power`/`b_power`/`c_power`/`total_power` (CT per fase) | CT aangesloten, −810 / 86 / 839 W | nee |
| `ES.GetMode` | `input_energy` / `output_energy` (0,1 Wh, **huis**meter) | 210,8 / 307,5 kWh | nee (bewust) |
| `ES.GetStatus` | `bat_cap`, `pv_power`, `offgrid_power` | 4160 Wh, 0 W | nee |
| `ES.GetStatus` | `total_grid_input_energy` / `total_grid_output_energy` (Wh) | **605,9 / 485,5 kWh** | **ja** (energietellers) |
| `ES.GetStatus` | `total_pv_energy` (0,01 kWh), `total_load_energy` (Wh) | 0 / 0 | nee |
| `Bat.GetStatus` | `soc`, `charg_flag`, `dischrg_flag`, `bat_temp` | 15 %, laden + ontladen toegestaan, **22 °C** | temperatuur ja |
| `Bat.GetStatus` | `bat_capacity` (nog beschikbaar), `rated_capacity` | 653 van 4160 Wh | nee |
| `EM.GetStatus` | `ct_state`, fasevermogens, `input_energy`/`output_energy` | ±10 W totaal | nee |
| `Wifi.GetStatus` | `ssid`, `rssi`, `sta_ip`, `sta_gate`, `sta_mask`, `sta_dns` | `MY_WIFI`, **−84 dBm** | nee |
| `BLE.GetStatus` | Bluetooth-status + BLE-MAC | `disconnect` | nee |
| `PV.GetStatus` | 4× MPPT (`pv1..pv4_power/_voltage/_current/_state`) | **geen antwoord** op deze unit | nee |
| `DOD.SET` | ontlaaddiepte instellen (30–88 %) | standaard 88 | nee |
| `Set.Ver` | vermogensversie (800/1200/1500/2200/2500 W) | 2500 | nee |
| `Led.Ctrl`, `Ble.Adv`, `Reset.Factory` | paneel-LED, Bluetooth-uitzending, fabrieksreset | — | nee |

Interessant om nog toe te voegen (in volgorde van nut):

1. **WiFi-signaalsterkte** (`rssi`): nu **−84 dBm**, dat is zwak. Dat verklaart
   waarschijnlijk de wisselvalligheid van de UDP-server ("geen antwoord").
2. **Nog beschikbaar vermogen in Wh** (`bat_capacity`): "653 van 4160 Wh" is
   concreter dan alleen een percentage.
3. **`target_power`** (Homey ≥ v12.13): met de **Passive**-modus kan Homey zelf het
   laad-/ontlaadvermogen sturen, zodat de batterij meedoet in Homey's energiebeheer.
4. **PV-ingangen** (alleen Venus A/D): per MPPT stroom, spanning en status - op deze
   unit antwoordt `PV.GetStatus` niet, dus eerst uitzoeken of er panelen op zitten.
5. **DOD en de vermogenslimiet** als instelling of flowkaart (`DOD.SET`, `Set.Ver`).

Alle wire-formats staan op één plek: [`lib/marstek.js`](lib/marstek.js).
Wijkt jouw firmware af (andere veldnamen of een andere modusnaam voor "uit"),
pas dan alleen dat bestand of de apparaatinstellingen aan. De status-parser
(`parseStatus`) accepteert meerdere bekende veldnamen voor SOC en vermogen
(`battery_soc`, `soc`, `bat_soc`, `battery_power`, `bat_power`, `pbat`, ...) en kijkt
ook één niveau diep (`battery`/`bms`/`ems`-objecten).

**Belangrijk:** de client houdt één UDP-socket per apparaat open (op een willekeurige
bronpoort) en matcht antwoorden op het request-`id`. Bij het koppelen wordt zowel een
broadcast als een unicast-sweep over de eigen /24 gestuurd, zodat discovery ook werkt
op netwerken die broadcastverkeer tussen clients tegenhouden.

---

## 8. Testen zonder Homey

Met de meegeleverde CLI kun je de verbinding direct testen:

```powershell
node tools/marstek-cli.js discover
node tools/marstek-cli.js --host 192.168.1.50 get-device
node tools/marstek-cli.js --host 192.168.1.50 get-mode
node tools/marstek-cli.js --host 192.168.1.50 get-status
node tools/marstek-cli.js --host 192.168.1.50 battery-status
node tools/marstek-cli.js --host 192.168.1.50 wifi-status
node tools/marstek-cli.js --host 192.168.1.50 set-mode Auto
node tools/marstek-cli.js --host 192.168.1.50 set-mode Manual uit
node tools/marstek-cli.js --host 192.168.1.50 off --off-mode Manual
node tools/marstek-cli.js --host 192.168.1.50 raw "{\"id\":9,\"method\":\"ES.GetStatus\",\"params\":{\"id\":0}}"
```

Zoek je een andere modusnaam voor "uit"? Test dan eerst met `set-mode <naam>` wat de
batterij accepteert en zet die naam daarna in de apparaatinstellingen.

---

## 9. Problemen oplossen

| Symptoom | Oplossing |
|---|---|
| Apparaat wordt **niet gevonden** bij koppelen | Gebruik de handmatige optie en vul het IP-adres in de instellingen in. Controleer of Homey en de batterij in hetzelfde VLAN zitten. |
| Apparaat is **onbeschikbaar** met "Geen verbinding" | Controleer IP/poort; test met `node tools/marstek-cli.js --host <ip> get-mode`. |
| Schakelen gebeurt **niets** | Controleer of de modusnamen bestaan op jouw firmware (test met de CLI) en of aan/uit-modi verschillend zijn. |
| Verkeerde **SOC / vermogen** | Andere firmware gebruikt andere veldnamen; breid `parseStatus` in [`lib/marstek.js`](lib/marstek.js) uit of bekijk de ruwe respons met `get-status`. |
| "No app found" / build-fout over images | Voer `python tools\generate_images.py` (of `npm run images`) uit; de PNG's ontbreken dan. |
| Onzeker of de app-structuur compleet is | Voer `python tools\check_app.py` uit voor een statische controle. |

Logboek bekijken tijdens ontwikkelen:

```powershell
homey app run --remote    # of: homey app logs
```

---

## 10. Bestandsstructuur

```
homey-marstek-venus/
├─ .homeycompose/
│  ├─ app.json                       # app-manifest (id, naam, iconen)
│  └─ flow/
│     ├─ actions/set_mode.json       # actiekaart "Batterijmodus instellen"
│     └─ conditions/mode_is.json     # conditiekaart "Batterijmodus is ..."
├─ app.js                            # registratie van de flow-kaarten
├─ drivers/venus_a/
│  ├─ driver.compose.json            # driver, capaciteiten, pairing, instellingen
│  ├─ driver.flow.compose.json       # device-trigger "Batterijmodus is gewijzigd"
│  ├─ driver.js                      # pairing + UDP-discovery
│  ├─ device.js                      # UDP-aansturing, polling, onoff-afhandeling
│  └─ assets/icon.svg                # driver-icoon
├─ BETA.md                            # BETA-status, werking, risico's en achtergrond
├─ FORUM_POST.md                      # kant-en-klare forumtekst
├─ LICENSE                            # MIT-licentie (JPD)
├─ INSTALL.md                         # stap-voor-stap installatieplan
├─ lib/marstek.js                    # protocol: discovery, UDP-client, statusparser
├─ tools/generate_images.py          # genereert de vereiste PNG-iconen (Python)
├─ tools/generate-images.js          # idem, maar met Node.js
├─ tools/check_app.py                # statische controle van de app-structuur
├─ tools/marstek-cli.js              # CLI om de batterij los te testen (Node)
└─ package.json
```

> Beide generators (`tools/generate_images.py` en `tools/generate-images.js`)
> tekenen hetzelfde icoon; gebruik degene die op jouw computer beschikbaar is.

---

## 11. Scope

Deze app is bewust klein gehouden: aan/uit schakelen plus moduskeuze, met uitlezen
van SOC en vermogen. Geavanceerde functionaliteit (tijdschema's, dynamische
tariefsturing, vermogenssturing op basis van P1-data) hoort eerder in een Homey flow
dan in deze app — daar kun je deze kaarten prima voor gebruiken.
