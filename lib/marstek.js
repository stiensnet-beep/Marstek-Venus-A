'use strict';

/*
 * Local-protocol client for Marstek batteries (Venus E / Venus A).
 *
 * Protocol as verified on a Marstek Venus E 3.0 (firmware ver 150):
 *
 *   - Everything runs over UDP port 30000. The device does NOT listen on TCP.
 *   - One JSON object per request, one JSON object per response, matched by id.
 *
 * Discovery (broadcast):
 *   -> {"id":0,"method":"Marstek.GetDevice","params":{"ble_mac":"0"}}
 *   <- {"id":0,"src":"VenusE 3.0-aabbccddeeff",
 *       "result":{"device":"VenusE 3.0","ver":150,"ble_mac":"aabbccddeeff",
 *                 "wifi_mac":"ffeeddccbbaa","wifi_name":"MY_WIFI","ip":"192.168.01.50"}}
 *
 * Commands:
 *   -> {"id":1,"method":"ES.GetMode","params":{"id":0}}
 *   <- {"id":1,"src":"...","result":{"id":0,"mode":"Auto","ongrid_power":-135,
 *                                    "offgrid_power":0,"bat_soc":38,...}}
 *
 *   -> {"id":2,"method":"ES.SetMode","params":{"id":0,"config":{"mode":"Auto"}}}
 *   <- {"id":2,"src":"...","result":{"id":0,"set_result":false}}
 *
 *   -> {"id":3,"method":"ES.GetStatus","params":{"id":0}}
 *   <- {"id":3,"src":"...","result":{"id":0,"bat_soc":38,"bat_cap":5120,
 *                                    "pv_power":0,"ongrid_power":-166,...}}
 *
 * Note: `set_result` is not a reliable success indicator (setting the mode that
 * is already active returns false as well), so every change is verified by
 * reading the mode back afterwards.
 */

const dgram = require('dgram');
const os = require('os');

const DEFAULT_PORT = 30000;
const DEVICE_ID = 0;

/**
 * Operating modes from the official Marstek Device Open API (Rev 3.1, 3.6.2):
 * "Auto", "AI", "Manual", "Passive", "UPS".
 * There is no "Standby"/"off" mode: switching the battery off means selecting a
 * mode whose configuration is disabled (see buildModeConfig).
 * Venus A/C/D/E support the ES component and therefore all of these modes.
 */
const MODES = ['Auto', 'AI', 'UPS', 'Manual', 'Passive'];

const DISCOVERY_REQUEST = {
  id: 0,
  method: 'Marstek.GetDevice',
  params: { ble_mac: '0' },
};

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/** "192.168.01.50" -> "192.168.1.50" (the firmware uses leading zeroes). */
function normalizeIp(value) {
  if (value === null || value === undefined) return null;
  const match = String(value).trim().match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return null;
  const octets = match.slice(1).map(Number);
  if (octets.some((octet) => octet > 255)) return null;
  return octets.join('.');
}

/** Ignores placeholder values such as "0" or "00:00:00:00:00:00". */
function sanitizeIdentifier(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  if (/^[0:.\-]+$/.test(text)) return null;
  return text;
}

/**
 * Build the mode specific configuration block for ES.SetMode.
 * The Open API requires this block; without it the device answers
 * `set_result: false`.
 *
 * @see Marstek Device Open API Rev 3.1, chapter 3.6.2
 */
function buildModeConfig(mode, {
  enable = true,
  power = 800,
  weekSet = 127,
  timeNum = 0,
  startTime = '00:00',
  endTime = '23:59',
  cdTime = 300,
} = {}) {
  const flag = enable ? 1 : 0;

  switch (String(mode || '').toLowerCase()) {
    case 'ai':
      return { ai_cfg: { enable: flag } };

    case 'ups':
      return { ups_cfg: { enable: flag } };

    case 'manual':
      return {
        manual_cfg: {
          time_num: timeNum,
          start_time: startTime,
          end_time: endTime,
          week_set: weekSet,
          power: enable ? power : 0,
          enable: flag,
        },
      };

    case 'passive':
      return { passive_cfg: { power: enable ? power : 0, cd_time: cdTime } };

    case 'auto':
    default:
      return { auto_cfg: { enable: flag } };
  }
}

function normalizeMode(result) {
  if (result === null || result === undefined) return null;
  if (typeof result === 'string') return result;
  if (typeof result !== 'object') return null;
  if (typeof result.mode === 'string') return result.mode;
  if (typeof result.mode_name === 'string') return result.mode_name;
  if (typeof result.current_mode === 'string') return result.current_mode;
  if (result.config && typeof result.config.mode === 'string') return result.config.mode;
  return null;
}

function firstNumber(source, keys) {
  if (!source || typeof source !== 'object') return null;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
      return Number(value);
    }
  }
  return null;
}

/**
 * Turn an ES.GetStatus / ES.GetMode response into { soc, power }.
 * @param {object} result
 */
function parseStatus(result) {
  const out = { soc: null, power: null, raw: result };
  if (!result || typeof result !== 'object') return out;

  const sources = [result, result.battery, result.bms, result.ems, result.es]
    .filter((entry) => entry && typeof entry === 'object');

  const socKeys = ['bat_soc', 'battery_soc', 'soc', 'batterySoc', 'bms_soc', 'battery_level', 'batteryLevel', 'capacity'];
  const powerKeys = ['bat_power', 'battery_power', 'batteryPower', 'pbat', 'p_bat', 'ongrid_power', 'total_power', 'power'];

  for (const source of sources) {
    if (out.soc === null) out.soc = firstNumber(source, socKeys);
    if (out.power === null) out.power = firstNumber(source, powerKeys);
  }

  if (out.soc !== null && out.soc > 100 && out.soc <= 1000) {
    out.soc = out.soc / 10; // some firmware reports permille
  }

  return out;
}

function extractDevice(message, fallbackHost) {
  if (!message || typeof message !== 'object') return null;

  let result = message.result || message;
  if (result && typeof result === 'object' && result.result) result = result.result;
  if (!result || typeof result !== 'object') return null;

  // `device` is the model name (string), but some firmware nests an object here
  const info = (result.device && typeof result.device === 'object') ? result.device : result;

  const model = (typeof result.device === 'string' ? result.device : null)
    || info.model
    || info.device_model
    || info.product_name
    || info.product
    || null;

  const mac = sanitizeIdentifier(
    info.ble_mac
    || info.mac
    || info.wifi_mac
    || (result.ble_mac && result.ble_mac !== '0' ? result.ble_mac : null),
  );

  const ip = normalizeIp(info.ip)
    || normalizeIp(info.ip_address)
    || normalizeIp(info.wifi_ip)
    || normalizeIp(info.device_ip);

  // Reject stray packets (e.g. our own echoed request) instead of inventing devices
  if (!ip && !mac && !model) return null;

  const host = ip || normalizeIp(fallbackHost);
  if (!host) return null;

  return {
    host,
    mac,
    port: Number(info.port) || DEFAULT_PORT,
    model: model ? String(model) : null,
    name: info.name || info.device_name || model ? String(info.name || info.device_name || model) : null,
    firmware: info.ver || null,
    info,
  };
}

function broadcastAddresses() {
  const addresses = new Set(['255.255.255.255']);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const address of list || []) {
      const isIPv4 = address.family === 'IPv4' || address.family === 4;
      if (!isIPv4 || address.internal || !address.netmask) continue;
      const ip = normalizeIp(address.address);
      const mask = normalizeIp(address.netmask);
      if (!ip || !mask) continue;
      const broadcast = ip.split('.').map((octet, index) => {
        return (Number(octet) & Number(mask.split('.')[index])) | (~Number(mask.split('.')[index]) & 255);
      }).join('.');
      addresses.add(broadcast);
    }
  }
  return [...addresses];
}

/**
 * Find Marstek devices on the LAN.
 *
 * Both a broadcast and a unicast sweep of the local /24 are used, because some
 * routers filter broadcast traffic between clients.
 *
 * @returns {Promise<Array<{host:string, mac:(string|null), model:(string|null)}>>}
 */
function discoverDevices({ timeout = 4000, port = DEFAULT_PORT, sweep = true } = {}) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const found = new Map();
    const payload = Buffer.from(JSON.stringify(DISCOVERY_REQUEST), 'utf8');
    let finished = false;
    let timer = null;

    const finish = () => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      try { socket.close(); } catch (err) { /* ignore */ }
      resolve([...found.values()]);
    };

    timer = setTimeout(finish, timeout);

    socket.on('error', finish);
    socket.on('message', (message, rinfo) => {
      let parsed;
      try {
        parsed = JSON.parse(message.toString('utf8'));
      } catch (err) {
        return;
      }
      if (parsed.method) return; // our own echoed request

      const device = extractDevice(parsed, rinfo && rinfo.address);
      if (device) found.set(device.mac || device.host, device);
    });

    socket.bind({ port: 0, exclusive: false }, () => {
      try { socket.setBroadcast(true); } catch (err) { /* ignore */ }

      for (const address of broadcastAddresses()) {
        socket.send(payload, 0, payload.length, port, address, () => { /* ignore */ });
      }

      if (sweep) {
        const ranges = new Set();
        for (const list of Object.values(os.networkInterfaces())) {
          for (const address of list || []) {
            const isIPv4 = address.family === 'IPv4' || address.family === 4;
            if (!isIPv4 || address.internal) continue;
            const ip = normalizeIp(address.address);
            if (ip) ranges.add(`${ip.split('.').slice(0, 3).join('.')}.`);
          }
        }
        for (const prefix of ranges) {
          for (let i = 1; i <= 254; i++) {
            socket.send(payload, 0, payload.length, port, `${prefix}${i}`, () => { /* ignore */ });
          }
        }
      }
    });
  });
}

/* ------------------------------------------------------------------ *
 * UDP client
 * ------------------------------------------------------------------ */

class MarstekClient {

  constructor({ host, port = DEFAULT_PORT, timeout = 3000, log } = {}) {
    this.host = host;
    this.port = Number(port) || DEFAULT_PORT;
    this.timeout = Number(timeout) || 3000;
    this._log = typeof log === 'function' ? log : () => {};
    this._seq = Math.floor(Math.random() * 20000);
    this._socket = null;
    this._waiters = new Map();
  }

  _nextId() {
    this._seq += 1;
    if (this._seq > 60000) this._seq = 1;
    return this._seq;
  }

  async _ensureSocket() {
    if (this._socket) return this._socket;

    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    socket.on('message', (message) => this._handleMessage(message));
    socket.on('error', (err) => this._log(`UDP-fout: ${err.message}`));

    await new Promise((resolve, reject) => {
      const onError = (err) => { socket.removeListener('listening', onListening); reject(err); };
      const onListening = () => { socket.removeListener('error', onError); resolve(); };
      socket.once('error', onError);
      socket.once('listening', onListening);
      socket.bind(0);
    });

    this._socket = socket;
    return socket;
  }

  _handleMessage(message) {
    let parsed;
    try {
      parsed = JSON.parse(message.toString('utf8'));
    } catch (err) {
      return;
    }
    if (!parsed || parsed.id === undefined || parsed.method) return;

    const waiter = this._waiters.get(parsed.id);
    if (!waiter) return;

    this._waiters.delete(parsed.id);
    clearTimeout(waiter.timer);
    waiter.resolve(parsed);
  }

  async _send(payload, timeout) {
    if (!this.host) throw new Error('Geen IP-adres ingesteld');

    const socket = await this._ensureSocket();

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._waiters.delete(payload.id);
        reject(new Error(`Geen antwoord van ${this.host}:${this.port} binnen ${timeout} ms`));
      }, timeout);

      this._waiters.set(payload.id, { resolve, timer });

      const buffer = Buffer.from(JSON.stringify(payload), 'utf8');
      socket.send(buffer, 0, buffer.length, this.port, this.host, (err) => {
        if (!err) return;
        clearTimeout(timer);
        this._waiters.delete(payload.id);
        reject(err);
      });
    });
  }

  /**
   * Send a JSON-RPC style request and resolve with the full response object.
   *
   * The UDP server on Marstek batteries is known to be flaky: sometimes a
   * request gets no answer at all while the next one works. Community apps
   * therefore retry with a back-off, which is what happens here as well.
   */
  async request(method, params = {}, { timeout, attempts = 3, retryDelay = 1500 } = {}) {
    let lastError = null;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await this._send({ id: this._nextId(), method, params }, timeout || this.timeout);
      } catch (err) {
        lastError = err;
        this._log(`${method} poging ${attempt}/${attempts} mislukt: ${err.message}`);
        if (attempt < attempts) {
          await new Promise((resolve) => setTimeout(resolve, retryDelay * attempt));
        }
      }
    }

    throw lastError;
  }

  /** Send a fully custom payload (used by the CLI tool). */
  sendRaw(payload, timeout) {
    return this._send(payload, timeout || this.timeout);
  }

  async getDeviceInfo() {
    const message = await this.sendRaw({ ...DISCOVERY_REQUEST, id: this._nextId() });
    return message.result || null;
  }

  /** @returns {Promise<string|null>} current mode, e.g. "Auto" */
  async getMode() {
    const message = await this.request('ES.GetMode', { id: DEVICE_ID });
    return normalizeMode(message.result);
  }

  /**
   * Raw ES.GetMode response: contains the mode *and* the battery status
   * (bat_soc, ongrid_power). One request instead of two keeps the traffic low,
   * which matters because the UDP server of these batteries stops answering
   * when it is polled too often.
   * @returns {Promise<object|null>}
   */
  async getModeStatus() {
    const message = await this.request('ES.GetMode', { id: DEVICE_ID });
    return message.result || null;
  }

  /** @returns {Promise<object|null>} raw ES.GetStatus result */
  async getStatus() {
    const message = await this.request('ES.GetStatus', { id: DEVICE_ID });
    return message.result || null;
  }

  /**
   * Set the operating mode, including the matching sub-configuration.
   *
   * @param {string} mode Auto | AI | UPS | Manual | Passive
   * @param {object} options { enable, power, weekSet, timeNum, startTime, endTime, cdTime }
   * @returns {Promise<{setResult:(boolean|null), result:(object|null)}>}
   */
  async setMode(mode, options = {}) {
    const { timeout, attempts, retryDelay, ...configOptions } = options;
    const config = Object.assign({ mode }, buildModeConfig(mode, configOptions));
    const message = await this.request(
      'ES.SetMode',
      { id: DEVICE_ID, config },
      { timeout, attempts, retryDelay },
    );
    const result = message.result || null;
    return {
      result,
      setResult: result && typeof result.set_result === 'boolean' ? result.set_result : null,
    };
  }

  /** Battery component: SOC, charge/discharge permission, temperature, capacity. */
  async getBatteryStatus() {
    const message = await this.request('Bat.GetStatus', { id: DEVICE_ID });
    return message.result || null;
  }

  /** WiFi component: SSID, RSSI, IP configuration. */
  async getWifiStatus() {
    const message = await this.request('Wifi.GetStatus', { id: DEVICE_ID });
    return message.result || null;
  }

  close() {
    for (const waiter of this._waiters.values()) {
      clearTimeout(waiter.timer);
    }
    this._waiters.clear();

    if (!this._socket) return;
    try { this._socket.close(); } catch (err) { /* ignore */ }
    this._socket = null;
  }

}

module.exports = {
  MarstekClient,
  discoverDevices,
  parseStatus,
  normalizeMode,
  normalizeIp,
  buildModeConfig,
  MODES,
  DEFAULT_PORT,
  DEVICE_ID,
};
