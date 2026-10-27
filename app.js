'use strict';

const Homey = require('homey');

module.exports = class MarstekVenusApp extends Homey.App {

  async onInit() {
    this.log('Marstek Venus app is gestart');
    this._registerFlowCards();
  }

  _registerFlowCards() {
    // App-level action card: set a specific mode on a paired battery
    //
    // getActionCard() only throws if the card id doesn't exist in app.json,
    // which is a packaging bug that should surface loudly at startup rather
    // than being swallowed into a log line while the app runs half-broken.
    this.homey.flow.getActionCard('set_mode').registerRunListener(async (args) => {
      const device = args.device;
      if (!device || typeof device.setMode !== 'function') {
        throw new Error('Marstek Venus A apparaat niet gevonden');
      }
      // Optioneel vermogen (Manual/Passive); leeg = het vermogen uit de
      // apparaatinstellingen.
      const power = Number(args.power);
      const options = (args.power !== undefined && args.power !== null && args.power !== ''
        && Number.isFinite(power)) ? { power } : {};
      await device.setMode(args.mode, options);
      return true;
    });

    // Laden van het net: Passive met een vast vermogen, tot een doel-SOC of een
    // maximale duur; de batterij zet zichzelf daarna terug (zie device.js).
    this.homey.flow.getActionCard('charge_from_grid').registerRunListener(async (args) => {
      const device = args.device;
      if (!device || typeof device.startChargeSession !== 'function') {
        throw new Error('Marstek Venus A apparaat niet gevonden');
      }
      await device.startChargeSession({
        power: Number(args.power),
        targetSoc: Number(args.soc),
        minutes: Number(args.minutes),
      });
      return true;
    });

    this.homey.flow.getActionCard('stop_charge').registerRunListener(async (args) => {
      const device = args.device;
      if (!device || typeof device.stopChargeSession !== 'function') {
        throw new Error('Marstek Venus A apparaat niet gevonden');
      }
      await device.stopChargeSession();
      return true;
    });

    this.homey.flow.getConditionCard('charge_active').registerRunListener(async (args) => {
      const device = args.device;
      return Boolean(device && typeof device.isChargeSessionActive === 'function'
        && device.isChargeSessionActive());
    });

    // App-level condition card: is the battery currently in a specific mode?
    this.homey.flow.getConditionCard('mode_is').registerRunListener(async (args) => {
      const device = args.device;
      if (!device || typeof device.getCurrentMode !== 'function') return false;
      const current = await device.getCurrentMode();
      return String(current || '').toLowerCase() === String(args.mode || '').toLowerCase();
    });
  }

};
