'use strict';

const Homey = require('homey');
const { discoverDevices, DEFAULT_PORT } = require('../../lib/marstek');

/**
 * In de Marstek-app is de UDP-API-poort per toestel instelbaar (default 30000).
 * Veel gebruikers zetten hun tweede batterij op 30001, dus daar wordt ook op
 * gezocht.
 */
const DISCOVERY_PORTS = [DEFAULT_PORT, DEFAULT_PORT + 1];

module.exports = class VenusADriver extends Homey.Driver {

  async onInit() {
    this.log('Marstek Venus A driver is gestart');
  }

  /**
   * Koppelwizard. De eigen view `pair/start.html` toont de gevonden apparaten en
   * maakt het gekozen apparaat zelf aan; deze handler levert de lijst.
   */
  async onPair(session) {
    this.log('Koppelen gestart');

    session.setHandler('list_devices', async () => this.onPairListDevices());
  }

  /**
   * Called by the pairing wizard (`list_devices` view).
   *
   * A UDP broadcast + unicast sweep on port 30000 and 30001 is used to find
   * Marstek devices on the LAN. Note: a Venus E listens on the same port, so
   * both batteries will show up here. Every entry is therefore labelled with
   * model, IP address and MAC so the Venus A can be picked deliberately - this
   * app only ever sends UDP requests to the IP address of the device you
   * select.
   *
   * A manual entry is always appended so pairing also works on networks where
   * broadcast traffic is blocked (the IP is then set in the device settings).
   */
  async onPairListDevices() {
    const devices = [];
    const seen = new Set();

    try {
      const results = await Promise.all(
        DISCOVERY_PORTS.map((port) => discoverDevices({ timeout: 4000, port })),
      );
      const found = results.flat();

      if (found.length > 1) {
        this.log(`${found.length} Marstek-apparaten gevonden op UDP ${DISCOVERY_PORTS.join('/')}. `
          + 'Kies het apparaat dat bij de Venus A hoort (controleer het IP-adres en de poort).');
      }

      for (const device of found) {
        const id = device.mac || device.host;
        if (seen.has(id)) continue;
        seen.add(id);

        const label = [];
        label.push(device.model || device.name || 'Marstek Venus');
        label.push(`IP ${device.host}`);
        if (device.mac) label.push(device.mac);

        devices.push({
          name: label.join(' · '),
          data: { id: `venus_a:${id}` },
          settings: {
            host: device.host,
            port: device.port || DEFAULT_PORT,
          },
        });
      }
    } catch (err) {
      this.error('Discovery mislukt:', err.message);
    }

    devices.push({
      name: 'Marstek Venus A (handmatig IP instellen)',
      data: { id: 'venus_a:manual' },
      settings: { host: '', port: DEFAULT_PORT },
    });

    return devices;
  }

};
