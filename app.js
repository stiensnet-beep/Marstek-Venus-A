'use strict';

const Homey = require('homey');

module.exports = class MarstekVenusApp extends Homey.App {

  async onInit() {
    this.log('Marstek Venus app is gestart');
    this._registerFlowCards();
  }

  _registerFlowCards() {
    // App-level action card: set a specific mode on a paired battery
    try {
      this.homey.flow.getActionCard('set_mode').registerRunListener(async (args) => {
        const device = args.device;
        if (!device || typeof device.setMode !== 'function') {
          throw new Error('Marstek Venus A apparaat niet gevonden');
        }
        await device.setMode(args.mode);
        return true;
      });
    } catch (err) {
      this.error('Kon actiekaart set_mode niet registreren:', err.message);
    }

    // App-level condition card: is the battery currently in a specific mode?
    try {
      this.homey.flow.getConditionCard('mode_is').registerRunListener(async (args) => {
        const device = args.device;
        if (!device || typeof device.getCurrentMode !== 'function') return false;
        const current = await device.getCurrentMode();
        return String(current || '').toLowerCase() === String(args.mode || '').toLowerCase();
      });
    } catch (err) {
      this.error('Kon conditiekaart mode_is niet registreren:', err.message);
    }
  }

};
