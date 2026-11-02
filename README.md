# companion-module-datasat-ap20-ap25

[![Companion Module Checks](https://github.com/Videobarista/companion-module-datasat-ap20-ap25/actions/workflows/companion-module-checks.yaml/badge.svg?branch=main)](https://github.com/Videobarista/companion-module-datasat-ap20-ap25/actions/workflows/companion-module-checks.yaml)
[![Tests](https://github.com/Videobarista/companion-module-datasat-ap20-ap25/actions/workflows/tests.yml/badge.svg?branch=main)](https://github.com/Videobarista/companion-module-datasat-ap20-ap25/actions/workflows/tests.yml)
[![CodeQL](https://github.com/Videobarista/companion-module-datasat-ap20-ap25/actions/workflows/codeql.yml/badge.svg?branch=main)](https://github.com/Videobarista/companion-module-datasat-ap20-ap25/actions/workflows/codeql.yml)
[![Release](https://img.shields.io/github/v/release/Videobarista/companion-module-datasat-ap20-ap25)](https://github.com/Videobarista/companion-module-datasat-ap20-ap25/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A [Bitfocus Companion](https://bitfocus.io/companion) module to control the **Datasat AP20 and AP25** cinema audio processors over Ethernet (TCP port 14500).

Implements the Datasat Remote Command API (document TN-H413 rev D) and the extra commands that real units accept, such as `@POWER`.

## Features

- Master fader control (absolute + relative, in 0.1 and 0.5 steps), master mute
- Level bars on buttons for the master fader (with a tick at reference level 7.0) and the monitor level
- Format selection with feedback, as a dropdown filled with the formats on the unit
- Macro execution, as a dropdown filled with the macros on the unit
- Power ON / Standby / Toggle with the real power state and a start-up indication
- Monitor level and monitor mute
- Screensaver control and GPIO pulse output
- Board temperatures, per-board supply voltage status, phantom power and CPU supply monitoring
- Password authentication (NetCmd / Setup), with the password kept in Companion's secrets store
- Status polling so buttons stay in sync with changes made on the device
- Presets for common buttons, plus one button per format and macro of your unit
- Detects what your particular unit supports and falls back gracefully
- Custom command action that shows the answer of the unit in the log

## Requirements

Bitfocus Companion with module import (Companion 4.x or 5.x). Tested on Companion 5.1.

## Installation

1. Download `pkg.tgz` from the [latest release](https://github.com/Videobarista/companion-module-datasat-ap20-ap25/releases/latest).
2. In Companion, open **Modules** and choose **Import module package**. Select `pkg.tgz`.
3. Add a new connection and search for "Datasat", or pick the new version for an existing connection.

## Device setup

- Connect the AP20/AP25 Ethernet port to your network and note the IP address (Network screen on the device).
- If a password is set under _System > Access Control_, enter the **NetCmd** password in the connection settings.
  The Setup password works too, but gives the module more rights than it needs.

## Security

The Datasat control protocol is plain TCP without encryption: the password and every command can be read
by anyone who can see the network traffic, and anyone who can reach TCP port 14500 can control the unit
directly. The module adds its own safeguards (see [SECURITY.md](SECURITY.md)), but the real protection is
the network around the unit and around Companion. SECURITY.md lists the recommended firewall rules and
Companion settings.

## Development

```
yarn install    # install dependencies
yarn check      # validate companion/manifest.json and the module definitions
yarn test       # run the tests against a simulated AP20
yarn format     # apply prettier formatting
yarn package    # build pkg.tgz for distribution
```

The tests need no AP20: they run the module against a simulated unit that answers like the real one.
Every push runs the shared Bitfocus module checks (the same validation used by the official Companion
module library), the tests and a CodeQL analysis. Each run of the module checks also uploads a built
`pkg.tgz`.

## Documentation

See [companion/HELP.md](companion/HELP.md) for the in-app help text with all actions, feedbacks, variables and presets.

## License

MIT, see [LICENSE](LICENSE).

## Disclaimer

This module is not affiliated with Datasat Digital Entertainment. Datasat, AP20 and AP25 are trademarks of their respective owners.
