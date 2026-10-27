'use strict';

const Homey = require('homey');
const {
  MarstekClient,
  parseStatus,
  parseWifi,
  rssiQuality,
  normalizeMode,
  DEFAULT_PORT,
  PASSIVE_CHARGE_SIGN,
} = require('../../lib/marstek');

const MAX_FAILURES = 3;

/**
 * Kortste poll-interval (s). Eén ronde kan met retries 15 tot 40 s duren; een
 * korter interval dan dit zou vooral extra verkeer opleveren, en daar stopt de
 * UDP-server van de batterij van met antwoorden. 0 blijft "uit".
 */
const MIN_POLL_INTERVAL = 30;

/**
 * De energietellers (ES.GetStatus) en de temperatuur (Bat.GetStatus) zitten in
 * andere componenten dan ES.GetMode, dus dat zijn twee extra UDP-verzoeken.
 * De UDP-server van deze batterijen houdt niet van veel verkeer, daarom wordt
 * dit maar één op de zoveel rondes opgehaald (bij 60 s pollen: elke 5 minuten).
 */
const ENERGY_EVERY = 5;

/**
 * De WiFi-status (Wifi.GetStatus: SSID, RSSI, IP-instellingen) is ook een extra
 * UDP-verzoek. Die gaat in een eigen ronde - ronde 2, 7, 12, ... - zodat er
 * nooit drie verzoeken achter elkaar naar de batterij gaan. Bij het standaard
 * poll-interval van 60 s dus elke 5 minuten.
 */
const WIFI_EVERY = 5;

/**
 * Default max age (ms) for the cached mode used by the `mode_is` condition
 * card. The regular poll (>= MIN_POLL_INTERVAL) keeps this cache
 * fresh, so a condition check normally doesn't need its own UDP round-trip -
 * that would double the traffic these batteries are sensitive to.
 */
const DEFAULT_MODE_MAX_AGE = 45 * 1000;

/** Store-sleutel van een lopende laadsessie, zodat die een herstart van de app overleeft. */
const SESSION_KEY = 'charge_session';

/**
 * Speling (s) op cd_time van Passive. De app beëindigt de sessie zelf op de
 * eindtijd en zet de batterij terug; de aftelklok van de batterij loopt iets
 * langer en is alleen het vangnet als Homey op dat moment niet kan schakelen.
 */
const CD_TIME_MARGIN = 120;

/**
 * Nazorg (ms) na een laadsessie. Gemeten op een Venus A (fw 148, 27-10-2026):
 * loopt cd_time af nadat de app al naar Auto is teruggezet, dan springt de
 * batterij een paar minuten naar Passive met 0 W. Zolang de nazorg loopt,
 * wordt zo'n Passive zonder sessie teruggezet naar de aan-modus.
 */
const AFTERCARE_MS = (CD_TIME_MARGIN + 600) * 1000;

module.exports = class VenusADevice extends Homey.Device {

  async onInit() {
    this.log('Marstek Venus A initialiseren');

    this._client = null;
    this._pollTimer = null;
    this._failures = 0;
    this._available = true;
    this._mode = this.getStoreValue('mode') || null;
    this._modeUpdatedAt = 0;
    this._pollCount = 0;
    this._syncing = false;
    this._session = this.getStoreValue(SESSION_KEY) || null;
    this._sessionTimer = null;
    this._restorePending = false;
    this._aftercareUntil = 0;

    this._modeChangedTrigger = this.homey.flow.getDeviceTriggerCard('mode_changed');

    this.registerCapabilityListener('onoff', async (value) => {
      this.log(`Schakelaar -> ${value ? 'AAN' : 'UIT'}`);
      await this.setPower(value);
      return true;
    });

    await this._ensureCapabilities();

    await this._migrateClass();

    this._startPolling();
    this._scheduleSessionEnd();
    this._sync().catch((err) => this._onFailure(err));
  }

  /**
   * Zorg dat het apparaat de klasse heeft die de driver voorschrijft.
   *
   * Homey legt de klasse van een apparaat vast op het moment van koppelen: een
   * update van de app verandert de klasse van een bestaand apparaat niet, en via
   * de API is `class` niet te wijzigen (`PUT /device/:id` negeert het veld).
   * Zonder deze migratie blijft een koppeling die met een oudere app-versie is
   * gemaakt op `socket` staan en komt de batterij nooit in het energieoverzicht,
   * want daar is klasse `battery` voor nodig.
   */
  async _migrateClass() {
    const target = 'battery';

    if (typeof this.getClass !== 'function' || typeof this.setClass !== 'function') {
      this.log('Klasse-API niet beschikbaar op deze Homey-versie; migratie overgeslagen');
      return;
    }

    try {
      const current = this.getClass();
      if (current === target) return;

      await this.setClass(target);
      this.log(`Klasse bijgewerkt van "${current}" naar "${target}" (nodig voor het energieoverzicht)`);
    } catch (err) {
      this.error('Klasse bijwerken mislukt:', (err && err.message) || err);
    }
  }

  async onSettings({ changedKeys }) {
    // De app schrijft ook zelf naar de instellingen (de WiFi-statusregels via
    // _applyWifiLabels). Zo'n schrijfactie mag geen extra poll uitlokken, dus
    // alleen reageren op de instellingen die de gebruiker zelf beheert.
    const eigenInstellingen = [
      'host',
      'port',
      'poll_interval',
      'mode_on',
      'mode_off',
      'manual_power',
      'manual_slot',
      'energy_exclude',
    ];
    if (!changedKeys.some((key) => eigenInstellingen.includes(key))) return;

    if (changedKeys.includes('host') || changedKeys.includes('port')) {
      this._client = null;
    }

    // De nieuwe waarden staan tijdens deze callback nog niet in
    // this.getSettings() (SDK3-gedrag), dus _startPolling()/_sync() zouden
    // hier de oude host/poort/interval te pakken krijgen. Met setTimeout(0)
    // draaien ze pas nadat Homey de nieuwe instellingen heeft opgeslagen.
    this.homey.setTimeout(() => {
      if (changedKeys.includes('poll_interval')
        || changedKeys.includes('host')
        || changedKeys.includes('port')) {
        this._startPolling();
      }
      this._sync().catch((err) => this._onFailure(err));
    }, 0);
  }

  async onDeleted() {
    this._stopPolling();
    this._clearSessionTimer();
    if (this._client) {
      this._client.close();
      this._client = null;
    }
  }

  /* ---------------------------------------------------------------- *
   * Public API (used by flow cards)
   * ---------------------------------------------------------------- */

  /**
   * Read the current mode, used by the `mode_is` condition card.
   *
   * The regular poll (_sync) already keeps `this._mode` fresh, so as long as
   * that cache isn't older than `maxAge` it is returned directly instead of
   * doing another UDP round-trip - that would double the network traffic on
   * a flow that checks the condition every minute.
   *
   * @param {object} [options]
   * @param {number} [options.maxAge] Max cache age in ms (default 45s).
   */
  async getCurrentMode({ maxAge = DEFAULT_MODE_MAX_AGE } = {}) {
    if (this._mode && Date.now() - this._modeUpdatedAt < maxAge) {
      return this._mode;
    }

    try {
      const mode = await this._getClient().getMode();
      if (mode) await this._applyMode(mode);
      return mode;
    } catch (err) {
      this.log('getCurrentMode gebruikt cache:', err.message);
      return this._mode;
    }
  }

  /**
   * Set an explicit operating mode.
   *
   * The Marstek Open API needs the sub-configuration belonging to the mode
   * (auto_cfg / ai_cfg / ups_cfg / manual_cfg / passive_cfg); `options.enable`
   * switches that sub-configuration on or off, which is how the battery is
   * effectively turned off.
   *
   * @param {string} mode Auto | AI | UPS | Manual | Passive
   * @param {object} options protocol options, e.g. { enable: false }
   */
  async setMode(mode, options = {}) {
    if (!mode) throw new Error('Geen modus opgegeven');

    // Elke andere schakeling (aan/uit, de modus-kaart) beëindigt een lopende
    // laadsessie en een nog openstaand terugzetten: wie de batterij daarna
    // bedient (bijvoorbeeld de Tesla-flow die hem uitzet), heeft voorrang.
    const { keepSession, ...protocolOptions } = options;
    if (!keepSession) {
      this._restorePending = false;
      this._aftercareUntil = 0;
      if (this._session) await this._clearSession(`modus ${mode} van buitenaf ingesteld`);
    }

    const settings = this._getSettings();
    const client = this._getClient();

    const { setResult } = await client.setMode(mode, {
      power: settings.manualPower,
      // Manual schrijft een tijdslot van het batterijschema; welk slot staat in
      // de instellingen, zodat een eigen schema uit de Marstek-app heel blijft.
      timeNum: settings.manualSlot,
      // De UDP-server van de batterij is wisselvallig: schrijfcommando's krijgen
      // iets meer geduld dan de periodieke uitlezing. De back-off is aan de
      // client-kant geplafonneerd (MAX_RETRY_DELAY), zodat dit plus de
      // terugleescontrole hieronder ruim binnen Homey's 30s flow-timeout blijft.
      attempts: 3,
      retryDelay: 1500,
      ...protocolOptions,
    });

    // `set_result` is not a reliable success indicator, so read the mode back.
    // Een korte pauze eerst voorkomt valse mismatches: de batterij past de
    // modus soms pas net na het antwoord op ES.SetMode toe.
    await new Promise((resolve) => this.homey.setTimeout(resolve, 750));
    const actualMode = await client.getMode();
    await this._applyMode(actualMode);
    this._onSuccess();

    if (actualMode && String(actualMode).toLowerCase() !== String(mode).toLowerCase()) {
      throw new Error(`Batterij staat in modus "${actualMode}" in plaats van "${mode}"`);
    }
    if (setResult === false) {
      this.log(`${mode} ingesteld; het toestel meldde daarbij set_result: false`);
    }

    return true;
  }

  /** Turn the battery on (modeOn) or off (modeOff) as configured in the settings. */
  async setPower(on) {
    const settings = this._getSettings();
    const mode = on ? settings.modeOn : settings.modeOff;

    if (!mode) throw new Error('Geen aan/uit modus geconfigureerd');

    if (String(settings.modeOn).toLowerCase() === String(settings.modeOff).toLowerCase()) {
      this.log(`Aan en uit gebruiken dezelfde modus (${mode}); het verschil zit in de enable-vlag`);
    }

    this.log(`Schakelen naar modus ${mode} (${on ? 'aan' : 'uit'})`);
    await this.setMode(mode, { enable: on });
    return true;
  }

  /**
   * Laden van het net: Passive met een vast vermogen tot `targetSoc` of tot
   * `minutes` om zijn. Daarna zet _checkChargeSession() de batterij terug in de
   * aan-modus. cd_time loopt CD_TIME_MARGIN langer als vangnet voor het geval
   * Homey op de eindtijd niet bij de batterij kan.
   *
   * @param {object} options
   * @param {number} options.power     laadvermogen in W (positief)
   * @param {number} options.targetSoc stoppen bij dit percentage
   * @param {number} options.minutes   maximale duur
   * @returns {Promise<boolean>} false als het doel al bereikt is
   */
  async startChargeSession({ power, targetSoc, minutes }) {
    const watt = Math.round(Math.abs(Number(power)));
    const target = Math.max(1, Math.min(100, Math.round(Number(targetSoc))));
    const duration = Math.max(1, Math.round(Number(minutes))) * 60;
    if (!Number.isFinite(watt) || watt <= 0) throw new Error('Geen laadvermogen opgegeven');
    if (!Number.isFinite(target) || !Number.isFinite(duration)) {
      throw new Error('Doel of duur ontbreekt');
    }

    const soc = this.getCapabilityValue('measure_battery');
    if (Number.isFinite(soc) && soc >= target) {
      this.log(`Laden van het net overgeslagen: ${soc}% is al >= doel ${target}%`);
      return false;
    }

    // Eerst de sessie vastleggen, dan pas schakelen: zo ziet de uitleesronde die
    // tijdens het schakelen loopt de sessie al en grijpt hij niet in.
    await this._setSession({ power: watt, targetSoc: target, endsAt: Date.now() + duration * 1000 });

    try {
      await this.setMode('Passive', {
        power: PASSIVE_CHARGE_SIGN * watt,
        cdTime: duration + CD_TIME_MARGIN,
        keepSession: true,
      });
    } catch (err) {
      await this._clearSession('schakelen naar Passive mislukt');
      throw err;
    }

    this.log(`Laden van het net: ${watt} W tot ${target}%, hooguit ${duration / 60} min`);
    return true;
  }

  /** Lopende laadsessie stoppen en de batterij terugzetten in de aan-modus. */
  async stopChargeSession() {
    const passive = String(this._mode || '').toLowerCase() === 'passive';
    if (!this._session && !passive) {
      this.log('Stop laden: er loopt geen laadsessie');
      return false;
    }
    await this._endChargeSession('gestopt via flow');
    return true;
  }

  isChargeSessionActive() {
    return Boolean(this._session);
  }

  /* ---------------------------------------------------------------- *
   * Internals
   * ---------------------------------------------------------------- */

  async _ensureCapabilities() {
    const capabilities = [
      'measure_battery',
      'measure_power',
      'meter_power.charged',
      'meter_power.discharged',
      'measure_temperature',
      'measure_signal_strength',
      'operation_mode',
    ];

    for (const capability of capabilities) {
      if (this.hasCapability(capability)) continue;
      try {
        await this.addCapability(capability);
      } catch (err) {
        this.error(`Kon capaciteit ${capability} niet toevoegen:`, err.message);
      }
    }
  }

  _getSettings() {
    const settings = this.getSettings();
    return {
      host: String(settings.host || '').trim(),
      port: Number(settings.port) || DEFAULT_PORT,
      pollInterval: Number(settings.poll_interval) || 0,
      modeOn: settings.mode_on || 'Auto',
      modeOff: settings.mode_off || 'Manual',
      manualPower: Number(settings.manual_power) || 0,
      manualSlot: Math.max(0, Math.min(9, Math.round(Number(settings.manual_slot) || 0))),
    };
  }

  _getClient() {
    const { host, port } = this._getSettings();
    if (!host) throw new Error('Geen IP-adres ingesteld (zie apparaatinstellingen)');

    if (!this._client || this._client.host !== host || this._client.port !== port) {
      this._client = new MarstekClient({ host, port, log: (message) => this.log(message) });
    }
    return this._client;
  }

  _startPolling() {
    this._stopPolling();

    const { pollInterval: ingesteld } = this._getSettings();
    if (!ingesteld || ingesteld <= 0) return;

    const pollInterval = Math.max(ingesteld, MIN_POLL_INTERVAL);
    if (pollInterval !== ingesteld) {
      this.log(`Poll-interval ${ingesteld} s is te kort; ${pollInterval} s gebruikt`);
    }

    this.log(`Polling elke ${pollInterval} seconden`);
    this._pollTimer = this.homey.setInterval(() => {
      this._sync().catch((err) => this._onFailure(err));
    }, pollInterval * 1000);
  }

  _stopPolling() {
    if (!this._pollTimer) return;
    this.homey.clearInterval(this._pollTimer);
    this._pollTimer = null;
  }

  /**
   * Eén uitleesronde, nooit twee tegelijk. Met retries kan een ronde langer
   * duren dan het poll-interval; zonder deze wacht stapelen de rondes zich op
   * en krijgt de batterij juist het verkeer waar hij niet tegen kan.
   */
  async _sync() {
    if (this._syncing) {
      this.log('Vorige uitleesronde loopt nog; deze ronde overgeslagen');
      return;
    }

    this._syncing = true;
    try {
      await this._syncOnce();
    } finally {
      this._syncing = false;
    }
  }

  async _syncOnce() {
    const { host } = this._getSettings();
    if (!host) {
      this._setUnavailable('Vul het IP-adres van de batterij in bij de apparaatinstellingen');
      return;
    }

    const client = this._getClient();

    // ES.GetMode geeft modus + SOC + vermogen in één antwoord; dat scheelt de
    // helft van het verkeer en dat is precies waar deze batterijen gevoelig voor zijn.
    const modeStatus = await client.getModeStatus();
    await this._applyMode(normalizeMode(modeStatus));

    let status = parseStatus(modeStatus);

    if (status.soc === null || status.power === null) {
      const extra = await client.getStatus().catch((err) => {
        this.log('Status ophalen mislukt:', err.message);
        return null;
      });
      if (extra) status = parseStatus(extra);
    }

    await this._applyStatus(status);
    await this._checkChargeSession(status);

    // Energie en temperatuur: één keer meteen, daarna af en toe (zie ENERGY_EVERY).
    this._pollCount += 1;
    if (this._pollCount === 1 || this._pollCount % ENERGY_EVERY === 0) {
      await this._syncEnergy(client);
    }

    // WiFi-status in een eigen ronde (zie WIFI_EVERY): zo gaan er nooit drie
    // verzoeken tegelijk naar de batterij.
    if (this._pollCount === 2 || this._pollCount % WIFI_EVERY === 2) {
      await this._syncWifi(client);
    }

    this._onSuccess();
  }

  /**
   * Na elke uitleesronde: is de laadsessie klaar? Klaar betekent doel bereikt
   * of tijd om; dan gaat de batterij terug in de aan-modus. Staat de batterij
   * niet meer in Passive, dan heeft iets anders (de Marstek-app, een schakeling
   * buiten Homey om) het overgenomen: de sessie stopt en er wordt niets
   * teruggezet. Mislukte het terugzetten eerder (de UDP-server van de batterij
   * is wisselvallig), dan wordt dat hier opnieuw geprobeerd.
   *
   * @param {object} status parseStatus(ES.GetMode)
   */
  async _checkChargeSession(status) {
    if (this._restorePending) {
      if (this._mode && String(this._mode).toLowerCase() !== 'passive') {
        this._restorePending = false;
        this.log(`Terugzetten niet meer nodig: batterij staat al in ${this._mode}`);
      } else {
        await this._restoreAfterSession();
      }
      return;
    }

    const session = this._session;
    const passive = String(this._mode || '').toLowerCase() === 'passive';
    if (!session) {
      if (passive && Date.now() < this._aftercareUntil) {
        this.log('Passive na afloop van cd_time; terug naar de aan-modus');
        this._restorePending = true;
        await this._restoreAfterSession();
      }
      return;
    }

    if (this._mode && !passive) {
      await this._clearSession(`batterij staat nu in ${this._mode}`);
      return;
    }

    const soc = status && Number.isFinite(status.soc) ? status.soc : null;
    if (soc !== null && soc >= session.targetSoc) {
      await this._endChargeSession(`doel ${session.targetSoc}% bereikt`);
    } else if (Date.now() >= session.endsAt) {
      await this._endChargeSession('maximale duur verstreken');
    }
  }

  async _endChargeSession(reason) {
    await this._clearSession(reason);
    this._aftercareUntil = Date.now() + AFTERCARE_MS;
    this._restorePending = true;
    await this._restoreAfterSession();
  }

  async _restoreAfterSession() {
    const { modeOn } = this._getSettings();
    try {
      await this.setMode(modeOn, { enable: true, keepSession: true });
      this._restorePending = false;
      this.log(`Na het laden teruggezet naar ${modeOn}`);
    } catch (err) {
      this.error(`Terugzetten naar ${modeOn} mislukt, volgende ronde opnieuw:`, err.message);
    }
  }

  async _setSession(session) {
    this._session = session;
    this._restorePending = false;
    await this.setStoreValue(SESSION_KEY, session).catch((err) => this.log(err.message));
    this._scheduleSessionEnd();
  }

  async _clearSession(reason) {
    if (!this._session) return;
    this._session = null;
    this._clearSessionTimer();
    await this.unsetStoreValue(SESSION_KEY).catch((err) => this.log(err.message));
    this.log(`Laadsessie beëindigd: ${reason}`);
  }

  /**
   * Een extra uitleesronde precies op de eindtijd, zodat het terugzetten niet
   * tot een poll-ronde later hoeft te wachten (en ook werkt als pollen uit staat).
   */
  _scheduleSessionEnd() {
    this._clearSessionTimer();
    if (!this._session) return;
    const wait = Math.max(1000, this._session.endsAt - Date.now() + 1000);
    this._sessionTimer = this.homey.setTimeout(() => {
      this._sessionTimer = null;
      this._sync().catch((err) => this._onFailure(err));
    }, wait);
  }

  _clearSessionTimer() {
    if (!this._sessionTimer) return;
    this.homey.clearTimeout(this._sessionTimer);
    this._sessionTimer = null;
  }

  /**
   * De energietellers en de temperatuur ophalen. Deze zitten in ES.GetStatus en
   * Bat.GetStatus; ES.GetMode (de gewone poll) bevat ze niet.
   *
   * @param {MarstekClient} client
   */
  async _syncEnergy(client) {
    const [status, batterij] = await Promise.all([
      client.getStatus().catch((err) => {
        this.log('ES.GetStatus mislukt:', err.message);
        return null;
      }),
      client.getBatteryStatus().catch((err) => {
        this.log('Bat.GetStatus mislukt:', err.message);
        return null;
      }),
    ]);

    await this._applyEnergy(parseStatus(status), parseStatus(batterij));
  }

  async _applyMode(mode) {
    if (!mode) return;

    const changed = this._mode !== mode;
    this._mode = mode;
    this._modeUpdatedAt = Date.now();

    if (changed) {
      await this.setStoreValue('mode', mode).catch((err) => this.log(err.message));
    }

    const onoff = this._modeToOnoff(mode);
    if (this.getCapabilityValue('onoff') !== onoff) {
      await this.setCapabilityValue('onoff', onoff);
    }

    // De modus ook als capaciteit, zodat hij op de apparaatpagina staat en
    // andere apps (zoals het energiedashboard) hem via de Homey-API kunnen lezen.
    if (this.hasCapability('operation_mode') && this.getCapabilityValue('operation_mode') !== mode) {
      await this.setCapabilityValue('operation_mode', mode)
        .catch((err) => this.log('Modus-capaciteit bijwerken mislukt:', err.message));
    }

    if (changed) {
      this.log(`Modus gewijzigd naar ${mode}`);
      this._modeChangedTrigger
        .trigger(this, { mode })
        .catch((err) => this.log('Trigger mode_changed mislukt:', err.message));
    }
  }

  async _applyStatus(status) {
    if (!status) return;

    if (status.soc !== null && status.soc !== undefined && Number.isFinite(status.soc)) {
      const soc = Math.max(0, Math.min(100, Math.round(status.soc)));
      if (this.getCapabilityValue('measure_battery') !== soc) {
        await this.setCapabilityValue('measure_battery', soc);
      }
    }

    if (status.power !== null && status.power !== undefined && Number.isFinite(status.power)) {
      if (this.getCapabilityValue('measure_power') !== status.power) {
        await this.setCapabilityValue('measure_power', status.power);
      }
    }
  }

  /**
   * De energietellers (kWh, cumulatief) en de batterijtemperatuur doorgeven aan
   * Homey. De tellers zijn wat het Energie-overzicht van Homey gebruikt voor een
   * thuisbatterij; zonder `energy.homeBattery` + deze twee capaciteiten komt het
   * apparaat daar niet in voor.
   *
   * @param {object} status  parseStatus(ES.GetStatus)
   * @param {object} batterij parseStatus(Bat.GetStatus)
   */
  async _applyEnergy(status, batterij) {
    const waarden = [
      ['meter_power.charged', status && status.chargedKwh, 100],
      ['meter_power.discharged', status && status.dischargedKwh, 100],
      ['measure_temperature', batterij && batterij.temperature, 10],
    ];

    for (const [capability, waarde, factor] of waarden) {
      if (!Number.isFinite(waarde) || !this.hasCapability(capability)) continue;

      const afgerond = Math.round(waarde * factor) / factor;
      if (this.getCapabilityValue(capability) !== afgerond) {
        await this.setCapabilityValue(capability, afgerond);
      }
    }
  }

  /**
   * WiFi-status ophalen: SSID, RSSI en de IP-instellingen van de batterij.
   *
   * De RSSI gaat als `measure_signal_strength` naar Homey. Homey toont dat als
   * "Signaalsterkte" (dB) op de apparaatpagina en legt het vast in Insights,
   * zodat je kunt terugzien wanneer het signaal wegzakte. De rest - SSID, IP,
   * gateway, subnetmasker en MAC - komt als leesbare regel in de
   * apparaatinstellingen.
   *
   * @param {MarstekClient} client
   */
  async _syncWifi(client) {
    const result = await client.getWifiStatus().catch((err) => {
      this.log('Wifi.GetStatus mislukt:', err.message);
      return null;
    });

    await this._applyWifi(parseWifi(result));
  }

  async _applyWifi(wifi) {
    if (!wifi) return;

    // Elke ronde loggen, ook als de waarde gelijk blijft: in het app-log is dan
    // te zien dat het uitlezen doorloopt terwijl het getal uren hetzelfde is.
    if (Number.isFinite(wifi.rssi)) {
      this.log(`WiFi: ${wifi.rssi} dBm (${rssiQuality(wifi.rssi) || 'onbekend'}) via ${wifi.ssid || '?'}`);
    }

    if (Number.isFinite(wifi.rssi) && this.hasCapability('measure_signal_strength')) {
      if (this.getCapabilityValue('measure_signal_strength') !== wifi.rssi) {
        await this.setCapabilityValue('measure_signal_strength', wifi.rssi);
      }
    }

    await this._applyWifiLabels(wifi);
  }

  /**
   * De WiFi-gegevens als tekstregels in de apparaatinstellingen zetten
   * (`type: "label"`). Alleen schrijven wat echt veranderd is: elke
   * setSettings() is een schrijfopdracht naar de Homey.
   *
   * @param {object} wifi parseWifi(Wifi.GetStatus)
   */
  async _applyWifiLabels(wifi) {
    const huidig = this.getSettings();
    const nieuwe = {};

    const zet = (sleutel, waarde) => {
      if (waarde === null || waarde === undefined || waarde === '') return;
      const tekst = String(waarde);
      if (huidig[sleutel] !== tekst) nieuwe[sleutel] = tekst;
    };

    const kwaliteit = rssiQuality(wifi.rssi);

    // Tijdstip van deze uitlezing. Homey legt een capaciteitswaarde alleen vast
    // als die verandert; met deze regel is te zien dat de app blijft lezen, ook
    // als de batterij urenlang dezelfde RSSI meldt.
    zet('wifi_bijgewerkt', this._formatteerTijd(new Date()));

    zet('wifi_ssid', wifi.ssid);
    zet('wifi_rssi', Number.isFinite(wifi.rssi)
      ? `${wifi.rssi} dBm${kwaliteit ? ` (${kwaliteit})` : ''}`
      : null);
    zet('wifi_ip', wifi.ip);
    zet('wifi_gateway', [wifi.gateway, wifi.mask].filter((deel) => deel).join(' / '));
    zet('wifi_mac', wifi.mac);

    if (!Object.keys(nieuwe).length) return;

    try {
      await this.setSettings(nieuwe);
    } catch (err) {
      this.log('WiFi-regels bijwerken mislukt:', err.message);
    }
  }

  /**
   * Tijd in de tijdzone van de Homey, bijvoorbeeld "16:50". Valt terug op UTC
   * als de runtime geen tijdzonegegevens heeft.
   *
   * @param {Date} datum
   * @returns {string}
   */
  _formatteerTijd(datum) {
    try {
      const tijdzone = this.homey.clock.getTimezone();
      return new Intl.DateTimeFormat('nl-NL', {
        hour: '2-digit',
        minute: '2-digit',
        timeZone: tijdzone,
      }).format(datum);
    } catch (err) {
      return `${datum.toISOString().slice(11, 16)} UTC`;
    }
  }

  _modeToOnoff(mode) {
    if (!mode) return false;
    const { modeOff } = this._getSettings();
    return String(mode).toLowerCase() !== String(modeOff).toLowerCase();
  }

  _onSuccess() {
    this._failures = 0;
    if (this._available) return;
    this._available = true;
    this.setAvailable().catch((err) => this.log(err.message));
  }

  _onFailure(err) {
    this._failures += 1;
    this.error('Synchronisatie met batterij mislukt:', err.message);

    if (this._failures >= MAX_FAILURES) {
      const { host, port } = this._getSettings();
      this._setUnavailable(`Geen verbinding met ${host || '?'}:${port} (${err.message})`);
    }
  }

  _setUnavailable(reason) {
    if (!this._available) return;
    this._available = false;
    this.setUnavailable(reason).catch((err) => this.log(err.message));
  }

};
