module.exports = (app) => {
  const Gpio = require("onoff").Gpio;
  let buzzer = null;
  let notificationTimer;

  function walkNotifications(node, pathPrefix, map) {
    if (!node || typeof node !== "object") return;

    if (
      node.value &&
      typeof node.value.state === "string" &&
      node.value.method?.includes("sound") &&
      node.value.status?.silenced !== true
    ) {
      map.set(pathPrefix, node.value.state);
    }

    for (const key of Object.keys(node)) {
      if (["meta", "timestamp", "$source", "value"].includes(key)) continue;
      walkNotifications(node[key], `${pathPrefix}.${key}`, map);
    }
  }

  function beep(duration = 150) {
    if (!buzzer) return;
    buzzer.writeSync(1);
    setTimeout(() => buzzer.writeSync(0), duration);
  }

  const plugin = {
    id: "gpio-beeper-plugin",
    name: "GPIO Beeper",

    start: (settings, restartPlugin) => {
      app.debug("Plugin started");
      app.debug(settings);

      if (Gpio.accessible) buzzer = new Gpio(17, "out");

      const severity = { emergency: 3, alarm: 2, warn: 1 };

      notificationTimer = setInterval(() => {
        const tree = app.getSelfPath("notifications");
        const active = new Map();
        if (tree) walkNotifications(tree, "notifications", active);

        let worst = null;

        for (const state of active.values()) {
          if (severity[state] === undefined) continue; // skip 'normal' and any unrecognized state
          if (worst === null || severity[state] > severity[worst])
            worst = state;
        }

        if (worst === "alarm" || worst === "emergency") {
          app.debug("BEEP", worst);
          beep(settings.duration || 300);
        } else if (worst === "warn") {
          app.debug("BEEP", worst);
          beep(settings.duration / 3 || 100);
        }
      }, settings.interval || 1000);
    },

    stop: () => {
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
