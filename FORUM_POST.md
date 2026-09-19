# Kant-en-klare forumtekst

Kopieer het blok hieronder naar het Homey-forum (of een ander forum). De repository-link
staat er al in: <https://github.com/stiensnet-beep/Marstek-Venus-A>

---

## Titel

`[APP][BETA] Marstek Venus A + Venus E — lokale UDP API (geen cloud, geen Modbus)`

## Bericht

```
Hoi allemaal,

Ik heb een Homey-app gemaakt voor de **Marstek Venus** thuisbatterijen die volledig
**lokaal** werkt: geen cloud, geen MQTT, geen extra Modbus-hardware. De app gebruikt de
officiele **Marstek Device Open API** (UDP, JSON-RPC) en is getest op een **Venus E 3.0**
(firmware 150) en een **Venus A** (firmware 148).

**Wat kan de app**
- Aan/uit schakelen van de batterij vanuit Homey-flows
- Modus kiezen: Auto, AI, UPS, Manual, Passive
- Uitlezen van batterijniveau (SOC) en vermogen
- Trigger "batterijmodus is gewijzigd" en conditie "batterijmodus is ..."
- Werkt voor zowel de Venus A als de Venus E (zelfde protocol)

**Wat je vooraf moet regelen**
De **Local API moet aan** staan op de batterij. Dat gaat niet via de schakelaar in de
Marstek-app, maar via de **Marstek BLE Test Tool**:
https://rweijnen.github.io/marstek-venus-monitor/latest/ (Chrome op Windows of Android).
Daar zet je de Local API aan en stel je de UDP-poort in (standaard 30000). Loopt een
batterij vast? Op het tabblad *advanced* zit **System Reset** — dat lost het bijna altijd op.

**Installeren**

    npm install -g homey
    homey login
    git clone https://github.com/stiensnet-beep/Marstek-Venus-A.git
    cd Marstek-Venus-A
    homey app install

Geen Git? Download de ZIP via de groene **Code**-knop → *Download ZIP*, pak hem uit en
voer `homey app install` uit in die map.

Daarna in de Homey-app: **+ → Marstek Venus (BETA) → Marstek Venus A** en kies de
batterij met het juiste IP-adres. Zet in de instellingen het poll-interval op **60
seconden** of hoger.

**BETA — dus lees dit even**
De app werkt, maar is nog niet breed getest en is geen officiele Marstek-integratie.
De lokale API van deze batterijen antwoordt af en toe niet; daarom doet de app meerdere
pogingen en herstelt hij zichzelf. Gebruik op eigen risico. Alle details, de geteste
hardware, de risico's en een uitgebreide handleiding staan in `BETA.md` in de repo.

**Bronnen**
- Officiele Marstek Device Open API Rev 3.1: https://static-eu.marstekenergy.com/ems/resource/agreement/MarstekDeviceOpenApi.pdf
- Repo: https://github.com/stiensnet-beep/Marstek-Venus-A
- Bugs of ideeen? Zet ze in een issue in de repo.

Ik hoor graag of het bij jullie ook werkt — vooral op een Venus C, D of E mini, die heb
ik zelf niet kunnen testen.
```

---

## Korte Engelse versie

```
BETA Homey app for Marstek Venus A / Venus E home batteries — fully local, no cloud, no
MQTT, no Modbus hardware. Uses the official Marstek Device Open API (UDP JSON-RPC).
Tested on a Venus E 3.0 (fw 150) and a Venus A (fw 148).

- On/off switching from Homey flows, mode selection (Auto, AI, UPS, Manual, Passive),
  battery level and power readout, mode-changed trigger and mode condition.
- The battery's Local API must be enabled first — that is done over Bluetooth with the
  Marstek BLE Test Tool (https://rweijnen.github.io/marstek-venus-monitor/latest/), not
  with the switch in the Marstek app.
- Install: npm install -g homey && homey login && git clone <repo> && cd <repo> &&
  homey app install
- BETA: use at your own risk, see BETA.md in the repository.

Repo: https://github.com/stiensnet-beep/Marstek-Venus-A
```

---

## Tips voor je forumonderwerp

- Zet in de titel **[APP][BETA]** — dat is op het Homey-forum de gebruikelijke notatie.
- Voeg eventueel later een schermafbeelding toe van het apparaat in de Homey-app en van
  een voorbeeldflow; dat maakt het onderwerp een stuk aantrekkelijker.
- Verwijs naar het bestand `BETA.md` voor de details, dan blijft je openingsbericht kort.
- Zet in de repo een **issue-template** aan (Settings → Features) zodat vragen en
  bugmeldingen niet in het forum verdwijnen.
