'use strict';

// One HomeKit Television tile for a Samsung The Frame. Tapping the tile turns the Frame truly
// on or off; its inputs are Art Mode plus the sources listed in the config (HDMI ports, etc.).
// The work is done by frame.py over the Frame's local network API.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const run = promisify(execFile);

const PLUGIN_NAME = 'homebridge-frame-tv';
const PLATFORM_NAME = 'FrameTV';

const INPUT_ART = 1; // sources from the config are numbered from 2
const DEFAULT_SOURCES = [{ name: 'HDMI 1', key: 'KEY_HDMI1' }];

const HELPER = path.join(__dirname, 'frame.py');
const PY_FILES = ['requirements.txt', 'constraints.txt'].map((f) => path.join(__dirname, f));
const COMMAND_TIMEOUT = 120_000; // ms; a wake right after an off can take ~30 s
const HOLD_AFTER_COMMAND = 15_000; // ms to trust the commanded state over a poll that may lag behind

const expandHome = (p) => (p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p);

module.exports = (api) => {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, FrameTVPlatform);
};

class FrameTVPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.api = api;
    this.config = config || {};
    if (!this.config.tvIp) {
      log.error('Not starting: tvIp is missing from the config');
      return;
    }
    const sources = this.config.sources?.length ? this.config.sources : DEFAULT_SOURCES;
    const bad = sources.filter((s) => !s.name || !/^KEY_[A-Z0-9_]+$/.test(s.key || ''));
    if (bad.length) {
      log.error(`Not starting: each source needs a name and a key like KEY_HDMI1 (check ${JSON.stringify(bad)})`);
      return;
    }
    this.sources = sources.map((s, i) => ({ ...s, id: i + 2 }));

    const storage = path.join(api.user.storagePath(), 'frame-tv');
    this.helperConfig = JSON.stringify({
      tvIp: this.config.tvIp,
      tvMac: this.config.tvMac,
      tvTokenFile: path.join(storage, 'tv-token.txt'),
      tvMacFile: path.join(storage, 'tv-mac.txt'),
    });
    this.venv = path.join(storage, 'venv');
    this.python = path.join(this.venv, 'bin', 'python');
    this.stateFile = path.join(storage, 'state.json');

    this.power = false;
    this.input = this.sources[0].id;
    this.lastSource = this.sources[0].id; // the Frame can't say which source it's on, so remember
    this.loadState();
    this.busyUntil = 0;
    this.running = false;
    this.next = null; // the latest command waiting to run

    api.on('didFinishLaunching', () => this.start());
  }

  async start() {
    try {
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
      await this.ensureVenv();
    } catch (e) {
      this.log.error(`Python environment setup failed: ${e.message}`);
      return;
    }
    if (!fs.existsSync(JSON.parse(this.helperConfig).tvTokenFile)) {
      this.log.warn('Not paired with the Frame yet. Run the pair-tv step from the README and press Allow on the TV.');
    }
    this.publish();
    await this.poll();
    setInterval(() => this.poll(), Math.max(this.config.pollInterval || 10, 5) * 1000);
  }

  // The venv lives in Homebridge's storage, so it survives plugin reinstalls. It's rebuilt
  // whenever the pinned requirements or the Python interpreter change.
  async ensureVenv() {
    const basePython = expandHome(this.config.pythonPath || 'python3');
    const { stdout: version } = await run(basePython, ['-c', 'import sys; print(sys.version)']);
    if (!/^3\.(1[0-9]|[2-9][0-9])\./.test(version)) {
      throw new Error(`${basePython} is Python ${version.trim()}; 3.10 or newer is needed (set pythonPath)`);
    }
    const hash = crypto.createHash('sha256').update(version);
    for (const f of PY_FILES) hash.update(fs.readFileSync(f));
    const digest = hash.digest('hex');
    const stamp = path.join(this.venv, '.frame-tv-stamp');
    if (fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8') === digest) return;

    this.log.info(`Building the Python environment in ${this.venv} (first run or dependencies changed)...`);
    fs.rmSync(this.venv, { recursive: true, force: true });
    await run(basePython, ['-m', 'venv', this.venv]);
    const pip = [this.python, '-m', 'pip', '--disable-pip-version-check', '--quiet'];
    await run(pip[0], [...pip.slice(1), 'install', '-r', PY_FILES[0], '-c', PY_FILES[1]], { timeout: 600_000 });
    fs.writeFileSync(stamp, digest);
    this.log.info('Python environment ready.');
  }

  publish() {
    const { Service, Characteristic, Categories } = this.api.hap;
    const name = this.config.name || 'Frame';
    const accessory = new this.api.platformAccessory(name, this.api.hap.uuid.generate(`${PLUGIN_NAME}:${this.config.tvIp}`), Categories.TELEVISION);

    accessory
      .getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Manufacturer, 'Samsung')
      .setCharacteristic(Characteristic.Model, 'The Frame')
      .setCharacteristic(Characteristic.SerialNumber, this.config.tvIp);

    const tv = accessory.addService(Service.Television, name);
    tv.setCharacteristic(Characteristic.ConfiguredName, name);
    tv.setCharacteristic(Characteristic.SleepDiscoveryMode, Characteristic.SleepDiscoveryMode.ALWAYS_DISCOVERABLE);
    tv.getCharacteristic(Characteristic.Active)
      .onGet(() => (this.power ? 1 : 0))
      .onSet((value) => this.setPower(value === 1));
    tv.getCharacteristic(Characteristic.ActiveIdentifier)
      .onGet(() => this.input)
      .onSet((value) => this.setInput(value));
    // Required by HomeKit's Television service. Remote keys aren't forwarded: opening the
    // Frame's remote channel takes seconds, too slow for a remote.
    tv.getCharacteristic(Characteristic.RemoteKey).onSet(() => {});

    const inputs = [
      { id: INPUT_ART, name: 'Art Mode', type: Characteristic.InputSourceType.OTHER },
      ...this.sources.map((s) => ({
        id: s.id,
        name: s.name,
        type: s.key.startsWith('KEY_HDMI') ? Characteristic.InputSourceType.HDMI : Characteristic.InputSourceType.OTHER,
      })),
    ];
    for (const { id, name: label, type } of inputs) {
      const input = accessory.addService(Service.InputSource, label, `input-${id}`);
      input
        .setCharacteristic(Characteristic.Identifier, id)
        .setCharacteristic(Characteristic.ConfiguredName, label)
        .setCharacteristic(Characteristic.IsConfigured, Characteristic.IsConfigured.CONFIGURED)
        .setCharacteristic(Characteristic.InputSourceType, type)
        .setCharacteristic(Characteristic.CurrentVisibilityState, Characteristic.CurrentVisibilityState.SHOWN);
      tv.addLinkedService(input);
    }

    this.tv = tv;
    // HomeKit shows a Television properly only as its own accessory, so it gets its own pairing.
    this.api.publishExternalAccessories(PLUGIN_NAME, [accessory]);
    this.log.info(`Published "${name}". Add it in the Home app with this bridge's setup code.`);
  }

  update(power, input) {
    const { Characteristic } = this.api.hap;
    if (power !== this.power) {
      this.power = power;
      this.tv.updateCharacteristic(Characteristic.Active, power ? 1 : 0);
    }
    if (input !== undefined && input !== this.input) {
      this.input = input;
      if (input !== INPUT_ART) this.lastSource = input;
      this.tv.updateCharacteristic(Characteristic.ActiveIdentifier, input);
      this.saveState();
    }
  }

  // The input is kept while the Frame is off, so turning it on returns to it. It's saved so a
  // Homebridge restart doesn't forget it.
  loadState() {
    try {
      const { input, lastSource } = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      const known = (id) => id === INPUT_ART || this.sources.some((s) => s.id === id);
      if (known(input)) this.input = input;
      if (known(lastSource) && lastSource !== INPUT_ART) this.lastSource = lastSource;
    } catch {
      // No saved state yet.
    }
  }

  saveState() {
    try {
      fs.writeFileSync(this.stateFile, JSON.stringify({ input: this.input, lastSource: this.lastSource }));
    } catch (e) {
      this.log.warn(`Could not save the last input: ${e.message}`);
    }
  }

  commandFor(id) {
    if (id === INPUT_ART) return ['art'];
    const source = this.sources.find((s) => s.id === id) || this.sources[0];
    return ['source', source.key];
  }

  // HomeKit wants a quick answer, so set handlers report the new state at once and do the work
  // in the background. Commands run one at a time; only the latest request waits its turn, so
  // taps made while one is running don't pile up behind it.
  setPower(on) {
    if (on === this.power) return;
    this.update(on);
    this.enqueue(on ? this.commandFor(this.input) : ['off']);
  }

  setInput(id) {
    this.update(true, id);
    this.enqueue(this.commandFor(id));
  }

  enqueue(command) {
    if (this.next) this.log.info(`Skipping "${this.next.join(' ')}", superseded by "${command.join(' ')}".`);
    this.next = command;
    this.busyUntil = Infinity;
    if (!this.running) this.drain();
  }

  async drain() {
    this.running = true;
    while (this.next) {
      const command = this.next;
      const label = command.join(' ');
      this.next = null;
      try {
        this.log.info(`Running "${label}"...`);
        const state = await this.helper(...command);
        // A newer request has already set the tile to what it asked for; don't undo that.
        if (!this.next) this.apply(state);
        this.log.info(`"${label}" done.`);
      } catch (e) {
        this.log.error(`"${label}" failed: ${e.message}`);
      }
    }
    this.running = false;
    this.busyUntil = Date.now() + HOLD_AFTER_COMMAND;
  }

  async helper(...args) {
    try {
      const { stdout } = await run(this.python, [HELPER, '--config', this.helperConfig, ...args], { timeout: COMMAND_TIMEOUT });
      return JSON.parse(stdout);
    } catch (e) {
      throw new Error((e.stderr || e.message).trim().split('\n').pop());
    }
  }

  // The Frame reports power and Art Mode, but not which source it's on. Out of Art Mode, the
  // tile shows the source last picked.
  apply(state) {
    const on = state.power === 'on';
    let input;
    if (state.art === true) input = INPUT_ART;
    else if (state.art === false && this.input === INPUT_ART) input = this.lastSource;
    this.update(on, on ? input : undefined);
  }

  // Power comes from the TV's REST API (cheap, every poll). Art Mode needs a websocket session,
  // so it's checked through the helper only while the TV is on, and not on every poll.
  async poll() {
    if (Date.now() < this.busyUntil) return;
    let on = false;
    try {
      const res = await fetch(`http://${this.config.tvIp}:8001/api/v2/`, { signal: AbortSignal.timeout(3000) });
      on = ((await res.json()).device?.PowerState ?? 'on') === 'on';
    } catch {
      // Unreachable means fully off: the Frame drops off the network in standby.
    }
    const artDue = on && (!this.power || Date.now() - (this.lastArtCheck || 0) > 30_000);
    if (!artDue) {
      if (Date.now() >= this.busyUntil) this.update(on);
      return;
    }
    this.lastArtCheck = Date.now();
    try {
      const state = await this.helper('status');
      if (Date.now() >= this.busyUntil) this.apply(state);
    } catch (e) {
      this.log.debug(`Status check failed: ${e.message}`);
      if (Date.now() >= this.busyUntil) this.update(on);
    }
  }
}
