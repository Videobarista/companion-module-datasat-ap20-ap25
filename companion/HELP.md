# Datasat AP20 / AP25

This module controls the Datasat AP20 and AP25 cinema audio processors over Ethernet (TCP port 14500), based on the Datasat Remote Command API (TN-H413 rev D) plus a few commands that real units accept but the API document does not list (`@POWER`, `@FORMATNAMES`, `@MACRONAMES`, `@SCR`, `@PULSE`).

## Configuration

- **IP Address**: The IP of the AP20/AP25. Find it on the device under the Network screen.
- **NetCmd password**: Only needed if a password is set under _System > Access Control_ on the device. Leave empty otherwise. The module sends `@AUTH` automatically on connect. The password is kept in Companion's secrets store. Use the NetCmd password: the Setup password works too, but gives the module more rights than it needs, and the module warns about it in the log.
- **Status poll interval**: How often the module reads fader, mute, format, monitor and power state to keep variables and feedbacks in sync with changes made on the device itself. Minimum 500 ms. Set to 0 to disable.
- **Temperature / voltage poll interval**: How often (in seconds) the board temperatures and supply voltages are read. Minimum 10 seconds. Set to 0 to disable.
- **Fallback Power ON / Standby macro**: Only used when the unit does not support `@POWER`. Leave empty on units that do.

## What the module detects

On connect the module asks the unit which of the extra commands it understands. A unit answers `BadCommand` to anything it does not know. Only that answer counts as "not supported": if the unit does not answer in time (for example while it is starting up) the module asks again later.

- `@POWER` available: Power ON / Standby / Toggle switch the unit directly and the power state is shown.
- `@FORMATNAMES` / `@MACRONAMES` available: the Select Format and Run Macro actions become dropdowns filled with the names on the unit, and a preset button is created for every format and macro.
- Not available: the actions fall back to a text field (the name must match the name on the unit exactly) and the Power actions use the fallback macros.

While the unit is in standby only its power state is polled. The format and macro lists are read as soon as the unit is operating.

## Actions

- Set Master Fader Level (0.0 - 10.0)
- Adjust Master Fader relative (e.g. +0.1 / -0.1 or +0.5 / -0.5)
- Master Mute (mute / unmute / toggle)
- Select Format
- Run Macro
- Set Monitor Level (0 - 100)
- Monitor Mute (mute / unmute / toggle)
- Power ON, Standby, Power Toggle (the unit needs about 15 seconds to become operational after Power ON)
- Screensaver (wake the display or activate the screensaver)
- GPIO Pulse (250 ms pulse on GPIO 1 - 21)
- Send Custom Command (any command from the API doc, with or without the leading `@`). The answer of the unit is written to the Companion log. `AUTH` is not allowed here: set the password in the connection settings.

## Feedbacks

- Master output muted
- Monitor muted
- Current format matches a given name
- Fader level comparison (=, >, <)
- Unit power state (on, starting, standby)
- Supply voltage fault (any board, a specific board, or the CPU supply)
- Microphone phantom power on
- **Level bar**: draws a bar on the button for the master fader (with a white tick at reference level 7.0) or the monitor level. Choose top or bottom and the colour. The bar shows the setting, not the audio signal: the unit has no metering command.

## Presets

Besides buttons for mute, fader steps (0.1 and 0.5), reference level 7.0, power, display and health, there are two display buttons with a level bar: **Fader level with bar** and **Monitor level with bar**. A preset button is also created for every format and macro on the unit.

## Variables

`fader`, `fader_raw`, `muted`, `format`, `monitor_level`, `monitor_mute`, `power_state`, `temp1`, `temp2`, `temp3`, `power`, `power_faults`, `board_h331`, `board_h332`, `board_h335`, `board_h336`, `board_h338`, `phantom`, `cpu_power`, `version`, `serial`

- `temp1`, `temp2`, `temp3` are the H331, H332 and H335 board temperatures in °C.
- `power` is the overall supply voltage status (OK / FAULT) and `power_faults` lists the boards with a fault.
- `board_*` show OK, FAULT or N/A (board not fitted).
- `fader_raw` (0 - 100) and `monitor_level` (0 - 100) can also drive a gauge you design yourself in the Companion button editor.

## Limits

To protect the unit and Companion, the module refuses commands with line breaks or other control characters (for example from a variable), uses at most 100 format or macro names of at most 64 characters, and lets at most 20 button presses wait for the unit. Anything dropped is reported in the log.

## Notes

- Format and macro names are case sensitive and may contain spaces.
- The AP20/AP25 applies changes immediately on receiving a command.
- The unit has no `@VOLUME` command (it answers `BadCommand`); use the master fader, which works in tenths.
- Debug logging in Companion shows every command and answer. The password, MAC address and serial number are hidden.
- The control protocol is not encrypted. Keep the unit on a separate, firewalled network: see SECURITY.md in the repository.
