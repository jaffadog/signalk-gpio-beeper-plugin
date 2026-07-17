# Signal K GPIO Beeper Plugin

A [Signal K](https://signalk.org/) plugin that activates a piezo beeper attached to the Raspberry Pi GPIO header when a Signal K notification alarm condition exists (e.g. anchor dragging, etc).

The plugin checks notifications on the configured interval (default 1 sec), and if any "**emergency**", "**alarm**", or "**warn**" notifications exist, it will beep the beeper for the configured duration.

The plugin will ignore notications that do not have:

    method: ["sound"]

and it will ignore notifications that have:

    status: {
        silenced: true
    }

The plugin assumes you are using an "active" beeper (no PWM required) attached to GPIO 17.

## Configuration

### Interval

Number of milliseconds between checking notifications and issuing a beep if warranted (default is 1000 milliseconds).

### Duration

Beep duration in milliseconds (default is 300 milliseconds).
