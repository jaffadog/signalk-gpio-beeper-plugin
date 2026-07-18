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
    buzzerHandle.buzzer.on();
    setTimeout(() => buzzerHandle.buzzer.off(), duration);
  }

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
        if (buzzerHandle.impl === "sysfs") {
          app.setPluginStatus(
            "Using sysfs GPIO fallback (gpioset not found). Consider installing libgpiod-tools.",
          );
        }
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
        buzzerHandle.buzzer.on();
        testTimer = setTimeout(() => {
          buzzerHandle.buzzer.off();
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
