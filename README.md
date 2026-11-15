# homebridge-frame-tv

A Homebridge plugin that gives a Samsung **The Frame** one TV tile in Apple Home:

- **Tap the tile** on the Home app's home page: the Frame turns **fully** on or off, not just in
  and out of Art Mode.
- **Open the tile**: pick the input, **Art Mode** or any source you list (HDMI 1, HDMI 2, ...).
- **Turning it on** returns to whatever it was showing last: art, or the last source.

Everything is local: the Frame's own network API, no SmartThings, no cloud. It works with the
Frame's internet access blocked.

## Why

General Samsung plugins typically give a Frame several accessories (a TV, a power switch, an Art
Mode switch), and without SmartThings their "off" can just drop the Frame into Art Mode: a short
press of the power key only toggles Art Mode. This plugin uses a long press for a true off and
treats Art Mode as an input, so one tile does it all.

## How it works

| Action | What the plugin does |
|---|---|
| Off | Holds the power key for 4 s, same as a long press on the remote. The Frame goes fully off, and Anynet+ (HDMI-CEC) puts connected devices to standby. |
| On, to Art Mode | Wake-on-LAN. If the Frame was turned off in Art Mode, it comes back in Art Mode. Otherwise the plugin switches Art Mode on. |
| On, to a source | Wake-on-LAN, leaves Art Mode if needed, then presses the source's key (`KEY_HDMI1`, ...). Selecting the input wakes a CEC device on it, such as an Apple TV. |
| Switch input | Same as above, without the wake. |

State comes from the Frame's REST API (`http://<frame>:8001/api/v2/`, polled every 10 s): its
`PowerState` is `on` (Art Mode counts as on), or `standby`/unreachable (off). Art Mode is checked
through the websocket API every 30 s while the Frame is on. The Frame doesn't report which source
it's on, so outside Art Mode the tile shows the source last picked from it.

What to expect:

- Commands take a few seconds: off ~6 s, switching input ~8 s, on ~10–15 s. The tile updates at
  once and the Frame catches up.
- Turning on to a source whose device was asleep can show "No signal" for about a second, until
  the device wakes.
- For ~15 s after turning off, the Frame ignores wake packets; the plugin keeps sending them, so
  an immediate on just takes longer (~30 s).
- Rapid taps don't queue up: only the latest request runs after the current one.
- The tile's remote (Control Center) isn't wired up. Opening the Frame's remote channel takes
  seconds, too slow for a remote. Use your source's own remote.

Tested on a 2019 Frame (QN55LS03R) with an Apple TV 4K on HDMI 1. Other Frame years use the same
API and should work, but haven't been tested; reports welcome.

## Requirements

- Homebridge 1.8+ or 2.x, Node.js 20+.
- Python 3.10+ on the Homebridge host. The plugin builds its own virtualenv; you don't install
  any Python packages yourself.
- The Frame on your LAN at a fixed IP (DHCP reservation).
- On the Frame:
  - **Power On with Mobile** on (Settings → General → Network → Expert Settings), so it accepts
    Wake-on-LAN.
  - **Anynet+ (HDMI-CEC)** on (Settings → General → External Device Manager).
- HDMI-CEC on each source device (next section).
- Homebridge and the Frame on the same subnet: Wake-on-LAN is a broadcast.

### Source devices: turn on HDMI-CEC

The plugin only talks to the Frame. Your source devices follow along over HDMI-CEC: the Frame
wakes a device when its input is selected, and puts it to standby when the Frame turns off. That
only works if CEC is on **at both ends**: Anynet+ on the Frame, and CEC on the device.

Without it on the device:

- Picking that source turns the Frame on to a **"No signal"** screen, and it stays there until you
  wake the device with its own remote.
- Turning the Frame off leaves the device running.

Where the setting lives:

| Device | Setting |
|---|---|
| Apple TV | Settings → Remotes and Devices → **Control TVs and Receivers: On** (tested) |
| Others | Usually off by default and named after the brand's CEC feature, e.g. "HDMI Device Link" (PlayStation), "HDMI-CEC" (Xbox, Google TV), "Match TV Power State" (Nintendo Switch). Look in the device's display or HDMI settings. |

A quick check: with the Frame on, pick the device's HDMI input with the Samsung remote. If the
device wakes and its picture appears, CEC is working and the plugin will work with it.

## Install

The plugin isn't on npm yet. Install it from GitHub on the Homebridge host:

```sh
npm install -g github:jaybuff/homebridge-frame-tv
```

(or clone it and `npm install -g /path/to/homebridge-frame-tv`, which links your checkout).

## Configure

Add the platform to `config.json`, or use the plugin's settings page in the Homebridge UI.
Running it as a child bridge is recommended.

```json
{
  "platform": "FrameTV",
  "name": "Living Room Frame",
  "tvIp": "192.168.1.50",
  "sources": [
    { "name": "Apple TV", "key": "KEY_HDMI1" },
    { "name": "PlayStation", "key": "KEY_HDMI2" }
  ],
  "pythonPath": "python3"
}
```

| Option | Default | |
|---|---|---|
| `name` | `Frame` | Tile name. |
| `tvIp` | required | The Frame's IP address. |
| `sources` | `[{"name": "HDMI 1", "key": "KEY_HDMI1"}]` | Inputs besides Art Mode. `key` is the Samsung remote key that selects it: `KEY_HDMI1`–`KEY_HDMI4`, or `KEY_TV` for the tuner. |
| `tvMac` | learned | The Frame's MAC, for Wake-on-LAN. The plugin learns it from the Frame while it's on, so you normally leave this out. The Frame reports its Wi-Fi MAC; if it's wired, set the wired MAC here. |
| `pythonPath` | `python3` | A Python 3.10+ interpreter, used to build the plugin's virtualenv. Set it if `python3` on Homebridge's `PATH` is older (macOS's `/usr/bin/python3` is 3.9). |
| `pollInterval` | `10` | Seconds between power checks (min 5). |

Restart Homebridge. The first start builds the virtualenv in
`<homebridge storage>/frame-tv/venv` (takes a few seconds).

## Pair with the Frame

The plugin needs a token from the Frame. Turn the Frame on, then run this on the Homebridge host
and press **Allow** on the TV when **Homebridge Frame TV** asks to connect:

```sh
~/.homebridge/frame-tv/venv/bin/python "$(npm root -g)/homebridge-frame-tv/frame.py" \
  --config '{"tvIp": "192.168.1.50", "tvTokenFile": "'"$HOME"'/.homebridge/frame-tv/tv-token.txt"}' \
  pair-tv
```

Adjust `~/.homebridge` if your Homebridge storage path differs. The token is saved to
`frame-tv/tv-token.txt` there. If the prompt doesn't appear in Art Mode, switch the Frame to a
source and try again.

## Add the tile to Home

HomeKit only shows a TV properly as its own accessory, so the tile isn't part of the bridge. In
the Home app: **+** → **Add Accessory** → **More options…**, pick the Frame tile, and enter the
setup code of the bridge it runs on (the child bridge's, or your main bridge's). The Homebridge log
prints it on startup.

## Troubleshooting

Run the helper by hand to see what the Frame does (same `--config` as pairing, plus
`"tvMacFile"` if you want the MAC learned):

```sh
PY=~/.homebridge/frame-tv/venv/bin/python
FRAME="$(npm root -g)/homebridge-frame-tv/frame.py"
CFG='{"tvIp": "192.168.1.50", "tvTokenFile": "'"$HOME"'/.homebridge/frame-tv/tv-token.txt", "tvMacFile": "'"$HOME"'/.homebridge/frame-tv/tv-mac.txt"}'
$PY "$FRAME" --config "$CFG" status            # {"power": "on", "art": true}
$PY "$FRAME" --config "$CFG" off
$PY "$FRAME" --config "$CFG" art
$PY "$FRAME" --config "$CFG" source KEY_HDMI1
```

- **"didn't wake"**: check Power On with Mobile, that Homebridge is on the Frame's subnet, and the
  MAC (`frame-tv/tv-mac.txt`, or `tvMac`). The MAC is learned only after the Frame has been seen on
  once.
- **Source shows "No signal" and stays there**: the device on that input isn't answering CEC. Turn
  on CEC on the device and Anynet+ on the Frame.
- **Commands time out or fail with a websocket error**: re-pair (the Frame may have dropped the
  token, e.g. after a reset), and check Settings → General → External Device Manager → Device
  Connection Manager on the Frame for a denied "Homebridge Frame TV".
- **The tile shows stale inputs** after changing `sources`: remove the tile from Home and add it
  again.

## Development

`index.js` is the Homebridge side: one Television accessory, polling, and a command queue. It runs
`frame.py`, which does the talking to the Frame through
[samsungtvws](https://github.com/xchwarze/samsung-tv-ws-api), and prints the resulting state as
JSON.

Python dependencies: `requirements.txt` pins the direct ones; `constraints.txt` locks everything
(a `pip freeze` of a working venv). The plugin rebuilds its venv whenever either file or the
interpreter changes. After changing `requirements.txt`, build a fresh venv, install, and regenerate
`constraints.txt` from `pip freeze`.

## License

Public domain ([The Unlicense](LICENSE)), provided as is, without warranty or liability. The
[samsungtvws](https://github.com/xchwarze/samsung-tv-ws-api) dependency is installed from PyPI under
its own MIT license.
