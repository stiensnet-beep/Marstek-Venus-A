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
      await device.setMode(args.mode);
      return true;
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
