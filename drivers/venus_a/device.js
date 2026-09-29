'use strict';

const Homey = require('homey');
const {
  MarstekClient,
  parseStatus,
  parseWifi,
  rssiQuality,
  normalizeMode,
  DEFAULT_PORT,
} = require('../../lib/marstek');

const MAX_FAILURES = 3;

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
 * card. The regular poll (>= 60s, see driver.compose.json) keeps this cache
 * fresh, so a condition check normally doesn't need its own UDP round-trip -
 * that would double the traffic these batteries are sensitive to.
 */
const DEFAULT_MODE_MAX_AGE = 45 * 1000;

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

    this._modeChangedTrigger = this.homey.flow.getDeviceTriggerCard('mode_changed');

    this.registerCapabilityListener('onoff', async (value) => {
      this.log(`Schakelaar -> ${value ? 'AAN' : 'UIT'}`);
      await this.setPower(value);
      return true;
    });

    await this._ensureCapabilities();

    await this._migrateClass();

    this._startPolling();
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

    const settings = this._getSettings();
    const client = this._getClient();

    const { setResult } = await client.setMode(mode, {
      power: settings.manualPower,
      // De UDP-server van de batterij is wisselvallig: schrijfcommando's krijgen
      // iets meer geduld dan de periodieke uitlezing. De back-off is aan de
      // client-kant geplafonneerd (MAX_RETRY_DELAY), zodat dit plus de
      // terugleescontrole hieronder ruim binnen Homey's 30s flow-timeout blijft.
      attempts: 3,
      retryDelay: 1500,
      ...options,
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

    const { pollInterval } = this._getSettings();
    if (!pollInterval || pollInterval <= 0) return;

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

  async _sync() {
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
