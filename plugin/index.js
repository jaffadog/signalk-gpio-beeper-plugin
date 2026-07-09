module.exports = (app) => {
  const pkg = require("../package.json");
  const Gpio = require("onoff").Gpio;
  let buzzer = null;
  let notificationTimer;
  let unsubscribes = [];

  function beep(duration = 150) {
    app.debug("BEEP");
    if (!buzzer) return;
    buzzer.writeSync(1);
    setTimeout(() => buzzer.writeSync(0), duration);
  }

  const plugin = {
    id: pkg.name,
    name: pkg.signalk.description,

    start: (settings, restartPlugin) => {
      app.debug("Plugin started");
      app.debug(settings);

      if (Gpio.accessible) buzzer = new Gpio(17, "out");

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
      if (buzzer) {
        buzzer.writeSync(0);
        buzzer.unexport();
        buzzer = null;
      }
    },

    schema: () => {
      return {
        properties: {
          interval: {
            type: "number",
            title: "Interval in milliseconds between beeps",
            default: 1000,
          },
          duration: {
            type: "number",
            title: "Duration in milliseconds of the beep",
            default: 300,
          },
        },
      };
    },
  };

  return plugin;
};
