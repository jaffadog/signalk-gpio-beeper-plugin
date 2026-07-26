const { createBuzzer } = require("./buzzer");

module.exports = (app) => {
  const pkg = require("../package.json");
  let buzzerHandle = null; // { impl, buzzer }
  let notificationTimer;
  let unsubscribes = [];
  let testTimer = null;

  function beep(duration = 150) {
    app.debug("BEEP");
    if (!buzzerHandle) return;
    buzzerHandle.buzzer.beep(duration);
  }

  // Safety net: release the GPIO line directly on SIGINT/SIGTERM, in case
  // SignalK's own shutdown sequence doesn't reliably call plugin.stop()
  // (e.g. when run via `npm start`, which has known issues forwarding
  // Ctrl+C's SIGINT cleanly to the underlying node process). Mainly
  // matters for the sysfs fallback, which holds an exported pin open
  // between calls - the gpioset path no longer retains anything to
  // release (see buzzer.js), since each beep is a self-contained,
  // self-terminating process.
  function forceBuzzerOff() {
    if (buzzerHandle) {
      app.debug("Forcing buzzer off on process signal");
      buzzerHandle.buzzer.cleanup();
    }
  }
  process.once("SIGINT", forceBuzzerOff);
  process.once("SIGTERM", forceBuzzerOff);

  const plugin = {
    id: pkg.name,
    name: pkg.signalk.displayName,

    start: (settings, _restartPlugin) => {
      app.debug("Plugin started");
      app.debug(settings);

      try {
        buzzerHandle = createBuzzer({
          chip: settings.gpioChip || "gpiochip0",
          pin: settings.gpioPin ?? 17,
        });
        app.debug(`Using buzzer implementation: ${buzzerHandle.impl}`);
        app.setPluginStatus(
          buzzerHandle.impl === "sysfs"
            ? "⚠️ Using sysfs GPIO fallback (gpioset not found). Consider installing libgpiod-tools."
            : "✅ Using gpioset.",
        );
      } catch (err) {
        buzzerHandle = null;
        app.error(`Failed to initialize GPIO buzzer: ${err.message}`);
        app.setPluginError(`GPIO unavailable: ${err.message}`);
      }

      const shadowState = new Map(); // path -> state
      const severity = { emergency: 3, alarm: 2, warn: 1 };

      app.subscriptionmanager.subscribe(
        {
          context: "*",
          subscribe: [
            {
              path: "notifications.*",
              period: 1000,
            },
          ],
        },
        unsubscribes,
        (err) => app.error(err),
        (delta) => {
          delta.updates.forEach((update) => {
            update.values.forEach(({ path, value }) => {
              app.debug(`${path} ${JSON.stringify(value, null, 2)}`);
              const state = value && value.state;
              if (
                !state ||
                state === "normal" ||
                !value.method?.includes("sound") ||
                value.status?.silenced === true
              ) {
                shadowState.delete(path);
              } else {
                shadowState.set(path, state);
                app.setPluginStatus(
                  `Last: ${state} ${path} ${value.message || ""}`,
                );
              }
            });
          });
        },
      );

      notificationTimer = setInterval(() => {
        if (testTimer) return; // don't beep for alarms while a manual test is running
        app.debug(shadowState);
        let worst = null;
        for (const state of shadowState.values()) {
          if (severity[state] === undefined) continue;
          if (worst === null || severity[state] > severity[worst])
            worst = state;
        }
        app.debug({ worst });
        if (worst === "alarm" || worst === "emergency")
          beep(settings.duration || 300);
        else if (worst === "warn") beep(settings.duration / 3 || 100);
      }, settings.interval || 3000);
    },

    stop: () => {
      app.debug("Plugin stopped");
      if (unsubscribes) {
        unsubscribes.forEach((f) => f());
        unsubscribes = [];
      }
      if (notificationTimer) {
        clearInterval(notificationTimer);
        notificationTimer = null;
      }
      if (testTimer) {
        clearTimeout(testTimer);
        testTimer = null;
      }
      if (buzzerHandle) {
        buzzerHandle.buzzer.cleanup();
        buzzerHandle = null;
      }
    },

    registerWithRouter: (router) => {
      // Manual test endpoint - lets a user confirm wiring/permissions work
      // without needing to trigger a real alarm condition.
      // GET /plugins/signalk-gpio-beeper-plugin/test?seconds=5
      router.get("/test", (req, res) => {
        if (!buzzerHandle) {
          res.status(503).send("Buzzer not initialized - check plugin log.");
          return;
        }
        if (testTimer) {
          res.status(409).send("Test beep already in progress.");
          return;
        }

        const seconds = Math.min(
          Math.max(parseFloat(req.query.seconds) || 5, 0.5),
          30,
        );

        app.debug(`Manual test beep for ${seconds}s`);
        // beep() itself handles turning back off after `seconds * 1000`ms
        // (each implementation manages its own timing/self-termination -
        // see buzzer.js). testTimer here only tracks the coordination
        // window: preventing overlapping test triggers and suppressing
        // alarm beeps for the duration of the test.
        buzzerHandle.buzzer.beep(seconds * 1000);
        testTimer = setTimeout(() => {
          testTimer = null;
        }, seconds * 1000);

        res
          .status(200)
          .send(`Beeping for ${seconds} seconds (impl: ${buzzerHandle.impl})`);
      });
    },

    schema: () => {
      return {
        properties: {
          interval: {
            type: "number",
            title: "Interval in milliseconds between beeps",
            description: "(default 1000)",
            default: 1000,
          },
          duration: {
            type: "number",
            title: "Duration in milliseconds of the beep",
            description: "(default 300)",
            default: 300,
          },
          gpioPin: {
            type: "number",
            title: "BCM GPIO pin number the buzzer is connected to",
            description: "(default 17)",
            default: 17,
          },
          gpioChip: {
            type: "string",
            title: "gpiochip device name (only used when gpioset is available)",
            description: "(default gpiochip0)",
            default: "gpiochip0",
          },
        },
      };
    },
  };

  return plugin;
};
