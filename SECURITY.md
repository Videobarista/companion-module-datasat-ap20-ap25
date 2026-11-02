# Security Policy

## Supported versions

Only the most recent release of this module receives fixes.

| Version | Supported |
| ------- | --------- |
| 2.2.x   | Yes       |
| < 2.2   | No        |

## Reporting a vulnerability

Please do **not** open a public issue for security problems.

Use GitHub's private vulnerability reporting instead:
**Security → Report a vulnerability** on
<https://github.com/Videobarista/companion-module-datasat-ap20-ap25/security>.

Include the module version, the Companion version, and the steps needed to
reproduce the problem. You can expect an initial response within 14 days.

## Scope

Reports about how this module stores, logs or leaks credentials, what it sends
to the unit, or how it handles answers from the unit are in scope.

The Datasat control protocol itself is out of scope: it is plain TCP on port
14500 without encryption, and the NetCmd/Setup passwords are sent in the clear
by design of the device. Reports about that belong with Datasat.

## What the module does to protect you

- The password is kept in Companion's secrets store, not in the connection
  configuration that Companion sends to its web interface. It is never written
  to the log, and the Send Custom Command action refuses `AUTH`.
- Everything sent to the unit is one command per line: values from buttons or
  variables that contain line breaks or other control characters are refused,
  and commands and names have a maximum length.
- Numbers are rounded and kept within the range the unit accepts.
- Answers from the unit are treated as untrusted: the receive buffer, the
  number and length of format and macro names, and values written to
  variables all have upper bounds.
- At most 20 button presses wait for the unit; more are dropped with a warning.
  Polling cannot be set faster than every 500 ms (health every 10 s).
- The MAC address and serial number are hidden in the log, so logs can be
  shared in an issue.
- A warning is logged when the module is logged in with the Setup password.
  Use the NetCmd password: it is all the module needs.
- The module opens no network ports. It only makes one outgoing TCP connection
  to the unit.

## What only the network can do

Anyone who can reach TCP port 14500 on the unit can control it without this
module, and anyone who can reach Companion can press its buttons. Recommended:

**The AP20/AP25**

- Put it in a dedicated AV or cinema network (VLAN), not in a general-purpose
  or IoT network.
- Firewall: allow TCP 14500 to the unit only from the Companion host (and from
  other control systems that need it). Block everything else to the unit.
- Block traffic from the unit to the internet and to other networks. It has no
  reason to start connections itself.

**The Companion host**

- Make the Companion web interface (port 8000 by default) reachable only from
  the devices that are used to manage it, and set an admin password in
  Companion.
- Switch off the Companion services you do not use (for example Ember+, OSC,
  the TCP/UDP remote control and the HTTP remote control), under
  _Settings > Protocols_.
- Leave the REST API of Companion 5.1 off unless you need it. When you do, give
  each API key only the permissions it needs.
