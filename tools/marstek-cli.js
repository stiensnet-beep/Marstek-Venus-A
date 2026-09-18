'use strict';

/*
 * Small command line tool to talk to a Marstek Venus battery, without Homey.
 * Useful to verify that the local API works on your network/firmware.
 *
 * Usage:
 *   node tools/marstek-cli.js discover
 * The Marstek local API runs over UDP port 30000 (there is no TCP listener).
 *
 *   node tools/marstek-cli.js --host 192.168.1.50 get-device
 *   node tools/marstek-cli.js --host 192.168.1.50 get-mode
 *   node tools/marstek-cli.js --host 192.168.1.50 get-status
 *   node tools/marstek-cli.js --host 192.168.1.50 set-mode Auto
 *   node tools/marstek-cli.js --host 192.168.1.50 on
 *   node tools/marstek-cli.js --host 192.168.1.50 off
 *   node tools/marstek-cli.js --host 192.168.1.50 raw '{"id":9,"method":"ES.GetMode","params":{"id":0}}'
 *
 * Options:
 *   --host <ip>       IP address of the battery
 *   --port <port>     UDP port (default 30000)
 *   --timeout <ms>    Response timeout (default 5000)
 *   --off-mode <mode> Mode used by the "off" command (default Manual, disabled)
 */

const {
  MarstekClient,
  discoverDevices,
  parseStatus,
  normalizeMode,
  DEFAULT_PORT,
} = require('../lib/marstek');

const HELP = `
Marstek Venus CLI

  node tools/marstek-cli.js discover [--timeout 4000]
  node tools/marstek-cli.js --host <ip> [--port 30000] <command> [argument]

Commands:
  discover      Broadcast a discovery request on UDP port 30000
  get-device    Marstek.GetDevice
  get-mode      ES.GetMode
  get-status    ES.GetStatus (raw + parsed)
  battery-status Bat.GetStatus (SOC, charge/discharge flag, temperatuur)
  wifi-status   Wifi.GetStatus (SSID, RSSI, IP-configuratie)
  set-mode <m> [aan|uit]  ES.SetMode with the given mode (Auto, AI, UPS, Manual, Passive)
  on            ES.SetMode Auto with auto_cfg.enable = 1
  off           ES.SetMode to --off-mode (default Manual) with the sub-config disabled
  raw <json>    Send a raw JSON payload

Options:
  --host <ip>       IP address of the battery
  --port <port>     UDP port (default ${DEFAULT_PORT})
  --timeout <ms>    Response timeout in milliseconds (default 5000)
  --off-mode <mode> Mode used by the "off" command (default Manual)
`;

function parseArgs(argv) {
  const options = {
    host: '',
    port: DEFAULT_PORT,
    timeout: 5000,
    offMode: 'Manual',
  };
  const rest = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--host' || arg === '-h') options.host = argv[++i] || '';
    else if (arg === '--port' || arg === '-p') options.port = Number(argv[++i]);
    else if (arg === '--timeout') options.timeout = Number(argv[++i]);
    else if (arg === '--off-mode') options.offMode = argv[++i] || 'Standby';
    else if (arg === '--help') rest.unshift('help');
    else rest.push(arg);
  }

  return { options, rest };
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

async function main() {
  const { options, rest } = parseArgs(process.argv.slice(2));
  const command = (rest.shift() || 'help').toLowerCase();

  if (command === 'discover') {
    console.log('Zoeken naar Marstek apparaten op het netwerk (UDP 30000)...');
    const devices = await discoverDevices({ timeout: options.timeout || 4000 });
    if (!devices.length) {
      console.log('Geen apparaten gevonden. Controleer of de batterij op hetzelfde netwerk zit.');
      return;
    }
    printJson(devices.map((device) => ({
      host: device.host,
      port: device.port,
      mac: device.mac,
      model: device.model,
      name: device.name,
    })));
    if (devices.length > 1) {
      console.log(`\nLet op: ${devices.length} Marstek-apparaten gevonden (een Venus E zit op dezelfde poort).`);
      console.log('Koppel in Homey alleen het apparaat met het IP-adres van je Venus A.');
    }
    return;
  }

  if (command === 'help') {
    console.log(HELP);
    return;
  }

  if (!options.host) {
    console.error('Geef een IP-adres op met --host <ip>\n');
    console.log(HELP);
    process.exitCode = 1;
    return;
  }

  const client = new MarstekClient({
    host: options.host,
    port: options.port || DEFAULT_PORT,
    timeout: options.timeout || 5000,
    log: (message) => console.log(`[udp] ${message}`),
  });

  try {
    await runCommand(command, rest, client, options);
  } finally {
    // De UDP-socket houdt het Node-proces anders open
    client.close();
  }
}

/**
 * Voert één commando uit met een bestaande client.
 * De aanroeper (main) sluit de client daarna af.
 */
async function runCommand(command, rest, client, options) {
  switch (command) {
    case 'get-device': {
      printJson(await client.getDeviceInfo());
      return;
    }
    case 'get-mode': {
      const message = await client.request('ES.GetMode', { id: 0 });
      printJson(message);
      console.log(`Modus: ${normalizeMode(message.result)}`);
      return;
    }
    case 'get-status': {
      const status = await client.getStatus();
      printJson(status);
      console.log('Geïnterpreteerd:');
      printJson(parseStatus(status));
      return;
    }
    case 'battery-status': {
      printJson(await client.getBatteryStatus());
      return;
    }
    case 'wifi-status': {
      printJson(await client.getWifiStatus());
      return;
    }
    case 'set-mode': {
      const mode = rest[0];
      if (!mode) throw new Error('Geef een modus op, bijvoorbeeld: set-mode Auto');
      const enable = String(rest[1] || 'aan').toLowerCase() !== 'uit';
      printJson(await client.setMode(mode, { enable }));
      return;
    }
    case 'on': {
      printJson(await client.setMode('Auto', { enable: true }));
      return;
    }
    case 'off': {
      printJson(await client.setMode(options.offMode, { enable: false }));
      return;
    }
    case 'raw': {
      const payload = rest.join(' ');
      if (!payload) throw new Error('Geef een JSON payload op');
      printJson(await client.sendRaw(JSON.parse(payload), options.timeout));
      return;
    }
    default:
      console.error(`Onbekend commando: ${command}\n`);
      console.log(HELP);
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`Fout: ${err.message}`);
  process.exitCode = 1;
});
