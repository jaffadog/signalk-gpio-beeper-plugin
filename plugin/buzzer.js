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
 * Holds the line at the requested value until explicitly turned off via
 * `off()`, using whichever argument syntax matches the installed gpioset
 * version (see getGpiosetVersion above) - "on" spawns a background
 * process, "off" kills it.
 *
 * Each spawned process also carries a generous self-release backstop
 * (BACKSTOP_MS, far longer than any real beep) baked into the gpioset
 * invocation itself. Sending SIGTERM (via off()) still releases the line
 * immediately as normal - the backstop only matters if the plugin process
 * crashes or otherwise never calls off(), in which case gpioset releases
 * the line on its own after the backstop elapses instead of leaving the
 * buzzer stuck on indefinitely.
 */
const BACKSTOP_MS = 10000;

class GpiosetBuzzer {
  constructor({ chip = "gpiochip0", pin = 17 } = {}) {
    this.chip = chip;
    this.pin = pin;
    this.child = null;
    this.version = getGpiosetVersion();
    if (this.version === null) {
      throw new Error("gpioset not found");
    }
  }

  _buildArgs(value) {
    // v1: chip is positional; -m time -s/-u holds the line for a fixed
    // duration, but (like every mode) still releases immediately if the
    // process receives SIGTERM/SIGINT before that duration elapses - so
    // it doubles as both the hold mechanism and the crash backstop.
    // v2: chip moved to a -c/--chip flag; -t <ms>,0 sets the value, holds
    // for <ms>, then exits - same dual-purpose behavior on early SIGTERM.
    if (this.version === 1) {
      return [
        "-m",
        "time",
        "-u",
        String(BACKSTOP_MS * 1000),
        this.chip,
        `${this.pin}=${value}`,
      ];
    }
    return ["-c", this.chip, "-t", `${BACKSTOP_MS},0`, `${this.pin}=${value}`];
  }

  on() {
    if (this.child) return; // already on
    this.child = spawn("gpioset", this._buildArgs(1), { stdio: "ignore" });
    this.child.on("error", () => {
      this.child = null;
    });
    this.child.on("exit", () => {
      this.child = null;
    });
  }

  off() {
    if (!this.child) return;
    this.child.kill("SIGTERM");
    this.child = null;
  }

  cleanup() {
    this.off();
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

  on() {
    this._ensureExported();
    fs.writeFileSync(`${GPIO_ROOT}/gpio${this.sysfsPin}/value`, "1");
  }

  off() {
    if (!this.exported) return;
    fs.writeFileSync(`${GPIO_ROOT}/gpio${this.sysfsPin}/value`, "0");
  }

  cleanup() {
    if (!this.exported) return;
    try {
      this.off();
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
