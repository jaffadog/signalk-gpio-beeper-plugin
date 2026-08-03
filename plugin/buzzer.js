const fs = require("fs");
const path = require("path");
const { spawn, execFileSync } = require("child_process");

const GPIO_ROOT = "/sys/class/gpio";

// Labels seen for the main BCM pinctrl chip across Pi OS releases.
// rp1 (Pi 5) is intentionally excluded - sysfs GPIO does not work there.
const BCM_CHIP_LABEL_PATTERNS = [/^pinctrl-bcm2835$/, /^pinctrl-bcm2711$/];

/**
 * Returns the gpioset major version (1 or 2), or null if gpioset isn't
 * installed. The CLI changed significantly between versions:
 *
 * - v1 (Bullseye/Bookworm-era libgpiod-tools): default behavior is
 *   "set values and exit immediately" - you must pass `-m signal` (or
 *   `-m wait`/`-m time`) to keep the line held after the values are set.
 * - v2 (Trixie-era libgpiod, e.g. v2.2.x): the `-m`/`--mode` flag is gone.
 *   The new default is the opposite of v1's: gpioset now holds the line
 *   until killed (SIGINT/SIGTERM) unless told otherwise, so no extra
 *   flag is needed to get "hold until killed" behavior.
 *
 * Because of this, the same buzzer semantics require different argument
 * lists depending on which major version is installed.
 *
 * OS Version to gpioset version:
 * Buster (10)	  EOL, archived	  v1.2
 * Bullseye (11)	oldoldstable	  1.6.2-1
 * Bookworm (12)	oldstable	      1.6.3-1
 * Trixie (13)	  current stable	2.2.1-2
 * Forky (test)	  testing	        2.2.3-1
 */
function getGpiosetVersion() {
  let output;
  try {
    output = execFileSync("gpioset", ["--version"], {
      encoding: "utf8",
    });
  } catch {
    return null;
  }
  const match = output.match(/v(\d+)\./);
  return match ? parseInt(match[1], 10) : null;
}

function isGpiosetAvailable() {
  return getGpiosetVersion() !== null;
}

/**
 * Primary implementation: shells out to `gpioset` (libgpiod-tools), which
 * ships by default on Raspberry Pi OS Bookworm and later (including Pi 5,
 * where the sysfs GPIO interface has been removed entirely). No native
 * addon compilation is involved, so it's compatible with App Store
 * installs that run `npm install --ignore-scripts`.
 *
 * v2's `-t <ms>,0` sets the line, holds for <ms>, then explicitly toggles
 * it back to 0 before exiting - the line is never released while still
 * driven high. Combined with `-z`/`--daemonize`, the process detaches
 * into its own session, outside the calling process's (SignalK/Node's)
 * process group - so it's immune to SIGINT sent to that group (e.g. a
 * Ctrl+C in the terminal SignalK is running in), and completes its own
 * toggle-to-zero regardless of what happens to the parent process
 * afterward. This was confirmed by testing: killing an un-daemonized
 * `gpioset -t` process mid-toggle left the line floating high; letting
 * the same sequence run to completion (undisturbed) released it cleanly.
 *
 * v1 has no built-in toggle-back-to-zero step - `-m time` just holds the
 * value and exits, and whether that leaves the line in a defined low
 * state on exit is unverified (untestable without v1-era hardware; the
 * Buster device this was developed against has since been reimaged to
 * Trixie). v1's `-b`/`--background` flag is used for the same signal-
 * isolation benefit, but a physical pull-down resistor is recommended as
 * defense-in-depth for anyone actually running the v1 fallback.
 *
 * Sample/test commands for 0.1 sec beep:
 * gpioset v1: gpioset -b -m time -u 100000 gpiochip0 17=1
 * gpioset v2: gpioset -z -c gpiochip0 -t 100,0 17=1
 */
class GpiosetBuzzer {
  constructor({ chip = "gpiochip0", pin = 17 } = {}) {
    this.chip = chip;
    this.pin = pin;
    this.version = getGpiosetVersion();
    if (this.version === null) {
      throw new Error("gpioset not found");
    }
  }

  beep(durationMs) {
    const args =
      this.version === 1
        ? [
            "-b",
            "-m",
            "time",
            "-u",
            String(durationMs * 1000),
            this.chip,
            `${this.pin}=1`,
          ]
        : ["-z", "-c", this.chip, "-t", `${durationMs},0`, `${this.pin}=1`];

    // detached: true + unref() so Node never waits on or tracks this
    // process - it's expected to outlive this function call and clean
    // up after itself via its own internal timer.
    const child = spawn("gpioset", args, {
      stdio: "ignore",
      detached: true,
    });
    child.unref();
  }

  cleanup() {
    // Nothing to release - beep() never retains an open line or a
    // tracked child process between calls.
  }
}

/**
 * Fallback implementation: raw sysfs writes. Used when `gpioset` isn't
 * installed (e.g. older Raspberry Pi OS releases such as Buster, which
 * predate libgpiod-tools being a default package). No native addon
 * compilation involved either - just plain `fs` calls.
 *
 * Note: does not work on Pi 5 / CM5, where sysfs GPIO has been removed.
 * Also note: on newer kernels (Trixie, 6.12+) the BCM pinctrl chip's base
 * offset may not be 0, so the BCM pin number and the sysfs gpio number can
 * differ - this class resolves the real offset by reading gpiochip labels
 * rather than assuming they're the same.
 */
class SysfsBuzzer {
  constructor({ pin = 17 } = {}) {
    this.bcmPin = pin;
    this.sysfsPin = null;
    this.exported = false;
  }

  _findBcmChipBase() {
    if (!fs.existsSync(GPIO_ROOT)) {
      throw new Error(
        `${GPIO_ROOT} does not exist - sysfs GPIO is unavailable on this kernel (expected on Pi 5 / CM5).`,
      );
    }
    const entries = fs
      .readdirSync(GPIO_ROOT)
      .filter((f) => f.startsWith("gpiochip"));
    for (const entry of entries) {
      const labelPath = path.join(GPIO_ROOT, entry, "label");
      const basePath = path.join(GPIO_ROOT, entry, "base");
      if (!fs.existsSync(labelPath) || !fs.existsSync(basePath)) continue;
      const label = fs.readFileSync(labelPath, "utf8").trim();
      if (BCM_CHIP_LABEL_PATTERNS.some((re) => re.test(label))) {
        return parseInt(fs.readFileSync(basePath, "utf8").trim(), 10);
      }
    }
    throw new Error(
      "Could not identify the main BCM pinctrl gpiochip under /sys/class/gpio.",
    );
  }

  _ensureExported() {
    if (this.exported) return;
    const base = this._findBcmChipBase();
    this.sysfsPin = base + this.bcmPin;
    const pinPath = `${GPIO_ROOT}/gpio${this.sysfsPin}`;
    if (!fs.existsSync(pinPath)) {
      fs.writeFileSync(`${GPIO_ROOT}/export`, String(this.sysfsPin));
      const start = Date.now();
      while (
        !fs.existsSync(`${pinPath}/direction`) &&
        Date.now() - start < 1000
      ) {
        // brief busy-wait for sysfs entries to appear
      }
    }
    fs.writeFileSync(`${pinPath}/direction`, "out");
    this.exported = true;
  }

  beep(durationMs) {
    this._ensureExported();
    fs.writeFileSync(`${GPIO_ROOT}/gpio${this.sysfsPin}/value`, "1");
    setTimeout(() => {
      try {
        fs.writeFileSync(`${GPIO_ROOT}/gpio${this.sysfsPin}/value`, "0");
      } catch {
        // best-effort - pin may already be unexported (e.g. plugin stopped)
      }
    }, durationMs);
  }

  cleanup() {
    if (!this.exported) return;
    try {
      fs.writeFileSync(`${GPIO_ROOT}/gpio${this.sysfsPin}/value`, "0");
      fs.writeFileSync(`${GPIO_ROOT}/unexport`, String(this.sysfsPin));
    } catch {
      // best-effort cleanup
    }
    this.exported = false;
  }
}

/**
 * Picks the best available buzzer implementation. Prefers `gpioset`
 * (present by default on Bookworm+, required on Pi 5), falls back to
 * sysfs (works on older releases like Buster/Bullseye, but not Pi 5).
 * Neither path requires native addon compilation.
 */
function createBuzzer(options = {}) {
  if (isGpiosetAvailable()) {
    return { impl: "gpioset", buzzer: new GpiosetBuzzer(options) };
  }
  return { impl: "sysfs", buzzer: new SysfsBuzzer(options) };
}

module.exports = { createBuzzer, GpiosetBuzzer, SysfsBuzzer };
