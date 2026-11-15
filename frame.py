"""Power, Art Mode and source control for a Samsung The Frame, over its local network API.

- Off: hold the power key. A short press only toggles Art Mode; a long press turns the Frame
  fully off, and Anynet+ (HDMI-CEC) puts connected devices to standby with it.
- On: Wake-on-LAN. The Frame comes back in the mode it was turned off in: Art Mode, or the
  last source.
- Art Mode: the Frame's art websocket API.
- Sources: leave Art Mode, then press the source's key (e.g. KEY_HDMI1). Selecting an HDMI input
  wakes a CEC device on it.

Usage: frame.py --config JSON status | off | art | source KEY | pair-tv
Prints one JSON line with the resulting state. Errors go to stderr with exit code 1.
"""

import argparse
import json
import logging
import socket
import sys
import time
import urllib.request

import urllib3
from samsungtvws import SamsungTVWS

# The TV serves HTTPS with a self-signed certificate, so samsungtvws skips verification.
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

log = logging.getLogger("frame")

TV_CLIENT_NAME = "Homebridge Frame TV"  # what the Frame shows in its Allow prompt and device list
REST_TIMEOUT = 3  # seconds for the TV's power-state check
ART_TIMEOUT = 10  # seconds for an Art Mode websocket call
REMOTE_TIMEOUT = 30  # seconds to open the remote-control channel, which can be slow
PAIR_TIMEOUT = 100  # seconds to wait for someone to press Allow on the TV
POWER_HOLD = 4  # seconds to hold the power key; a short press only toggles Art Mode
OFF_TIMEOUT = 20  # seconds for the Frame to reach standby
WOL_TIMEOUT = 30  # seconds of Wake-on-LAN; it misses wakes for ~15 s after turning off
WOL_INTERVAL = 1  # seconds between wake packets
ART_SET_TIMEOUT = 30  # seconds to keep trying to switch Art Mode
ART_CONFIRM_DELAY = 3  # seconds between switching Art Mode and checking it held


class FrameError(Exception):
    pass


def wait_for(check, timeout: float, interval: float = 1) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if check():
            return True
        time.sleep(interval)
    return check()


# Power state and MAC, from the REST API


def tv_power(cfg) -> str:
    """'on' or 'off'. Art Mode counts as on; standby and unreachable count as off."""
    try:
        with urllib.request.urlopen(f"http://{cfg['tvIp']}:8001/api/v2/", timeout=REST_TIMEOUT) as r:
            device = json.load(r)["device"]
    except Exception:
        return "off"
    _remember_mac(cfg, device)
    return "on" if device.get("PowerState", "on") == "on" else "off"


def _remember_mac(cfg, device: dict) -> None:
    """Save the Frame's MAC while it can tell us, since waking it is when it can't."""
    mac = device.get("wifiMac")
    if not mac or mac == _saved_mac(cfg):
        return
    try:
        with open(cfg["tvMacFile"], "w") as f:
            f.write(mac)
    except OSError as e:
        log.warning("Could not save the Frame's MAC address: %s", e)


def _saved_mac(cfg) -> str | None:
    try:
        with open(cfg["tvMacFile"]) as f:
            return f.read().strip() or None
    except OSError:
        return None


# Websocket channels


def _remote(cfg, timeout: int = REMOTE_TIMEOUT) -> SamsungTVWS:
    return SamsungTVWS(host=cfg["tvIp"], port=8002, token_file=cfg["tvTokenFile"], timeout=timeout, name=TV_CLIENT_NAME)


def _send_key(cfg, key: str, hold: float = 0) -> None:
    tv = _remote(cfg)
    try:
        if hold:
            tv.hold_key(key, hold)
        else:
            tv.send_key(key)
    except Exception as e:
        raise FrameError(f"Could not send {key} to the Frame: {e}") from e
    finally:
        tv.close()


def art_mode(cfg) -> bool | None:
    """Whether Art Mode is showing, or None if the TV can't say."""
    try:
        return _remote(cfg, ART_TIMEOUT).art().get_artmode() == "on"
    except Exception as e:
        log.warning("Art Mode check failed: %s", e)
        return None


def set_art_mode(cfg, on: bool) -> None:
    """Switch Art Mode and confirm it stuck; right after waking, the Frame can ignore it."""
    deadline = time.monotonic() + ART_SET_TIMEOUT
    last = None
    while time.monotonic() < deadline:
        try:
            _remote(cfg, ART_TIMEOUT).art().set_artmode(on)
        except Exception as e:
            last = e
        time.sleep(ART_CONFIRM_DELAY)
        if art_mode(cfg) is on:
            return
    raise FrameError(f"Could not turn Art Mode {'on' if on else 'off'}" + (f": {last}" if last else ""))


# Commands


def wake(cfg) -> None:
    if tv_power(cfg) == "on":
        return
    mac = cfg.get("tvMac") or _saved_mac(cfg)
    if not mac:
        raise FrameError("The Frame's MAC address isn't known yet. Set tvMac, or turn the Frame on once by hand.")
    packet = b"\xff" * 6 + bytes.fromhex(mac.replace(":", "").replace("-", "")) * 16
    deadline = time.monotonic() + WOL_TIMEOUT
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        while time.monotonic() < deadline:
            for address in ("255.255.255.255", cfg["tvIp"]):
                try:
                    sock.sendto(packet, (address, 9))
                except OSError as e:
                    log.warning("Wake packet to %s failed: %s", address, e)
            if wait_for(lambda: tv_power(cfg) == "on", WOL_INTERVAL, 0.5):
                return
    raise FrameError("The Frame didn't wake. Is Wake-on-LAN (Power On with Mobile) enabled on it?")


def off(cfg) -> None:
    for attempt in range(2):
        if tv_power(cfg) == "off":
            return
        _send_key(cfg, "KEY_POWER", POWER_HOLD)
        if wait_for(lambda: tv_power(cfg) == "off", OFF_TIMEOUT):
            return
        log.warning("Frame still on after holding its power key (attempt %d)", attempt + 1)
    raise FrameError("The Frame didn't turn off.")


def art(cfg) -> None:
    wake(cfg)
    if art_mode(cfg) is not True:
        set_art_mode(cfg, True)


def source(cfg, key: str) -> None:
    wake(cfg)
    # Source keys are ignored in Art Mode. Leaving it returns to the last source and wakes it.
    if art_mode(cfg) is not False:
        set_art_mode(cfg, False)
    _send_key(cfg, key)


def pair_tv(cfg) -> None:
    """Open the remote channel once so the Frame shows its Allow prompt; samsungtvws saves the
    token it issues to tvTokenFile."""
    tv = _remote(cfg, PAIR_TIMEOUT)
    try:
        tv.open()
    except Exception as e:
        raise FrameError(f"Could not pair with the Frame (press Allow on the TV): {e}") from e
    finally:
        tv.close()


def status(cfg) -> dict:
    power = tv_power(cfg)
    return {"power": power, "art": art_mode(cfg) if power == "on" else None}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True, help="JSON object with tvIp, tvTokenFile, tvMacFile, optional tvMac")
    parser.add_argument("command", choices=["status", "off", "art", "source", "pair-tv"])
    parser.add_argument("key", nargs="?", help="for source: the key that selects it, e.g. KEY_HDMI1")
    args = parser.parse_args()
    if args.command == "source" and not args.key:
        parser.error("source needs a key, e.g. KEY_HDMI1")
    logging.basicConfig(level=logging.INFO, stream=sys.stderr, format="%(levelname)s %(message)s")
    cfg = json.loads(args.config)
    try:
        if args.command == "off":
            off(cfg)
        elif args.command == "art":
            art(cfg)
        elif args.command == "source":
            source(cfg, args.key)
        elif args.command == "pair-tv":
            pair_tv(cfg)
    except FrameError as e:
        print(e, file=sys.stderr)
        return 1
    print(json.dumps(status(cfg)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
