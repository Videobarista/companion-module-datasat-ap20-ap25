import { LIMITS, hasControlChars, toBoundedInt } from './parsers.js'

/**
 * A dropdown filled with the names the unit reported, or a plain text field when the unit
 * cannot list them. The dropdown also accepts a typed name, e.g. one that was added after loading.
 */
export function nameOption(names, id, label, fallbackDefault, useVariables = true) {
	if (names.length > 0) {
		return {
			type: 'dropdown',
			id,
			label,
			default: names[0],
			choices: names.map((name) => ({ id: name, label: name })),
			allowCustom: true,
		}
	}
	return {
		type: 'textinput',
		id,
		label: `${label} (must match exactly, spaces allowed)`,
		default: fallbackDefault,
		useVariables,
	}
}

/**
 * A format or macro name that is about to be sent. Names come from the user or from variables, so a
 * name with control characters (a line break would start a second command) or an over-long name is
 * refused instead of sent. Spaces are kept: names can end in a space.
 */
function nameArgument(self, value, kind) {
	const name = String(value ?? '')
	if (name.trim().length === 0) {
		self.log('warn', `No ${kind} name given`)
		return null
	}
	if (hasControlChars(name) || name.length > LIMITS.nameLength) {
		self.log(
			'warn',
			`Not sent: the ${kind} name contains control characters or is longer than ${LIMITS.nameLength} characters`,
		)
		return null
	}
	return name
}

/** '1' or '0' from a mode dropdown, or the opposite of the current state for anything else (toggle). */
function onOffOrToggle(mode, current) {
	if (mode === '1') return 1
	if (mode === '0') return 0
	return current ? 0 : 1
}

export function getActions(self) {
	return {
		setFader: {
			name: 'Set Master Fader Level',
			options: [
				{
					type: 'number',
					id: 'level',
					label: 'Level (0.0 - 10.0)',
					default: 7.0,
					min: 0,
					max: 10,
					step: 0.1,
					range: true,
				},
			],
			callback: (action) => {
				const tenths = toBoundedInt(Number(action.options.level) * 10, 0, 100)
				if (tenths === null) {
					self.log('warn', 'Set Master Fader Level: the level is not a number')
					return
				}
				self.sendFader(tenths)
			},
		},

		faderRelative: {
			name: 'Adjust Master Fader (relative)',
			options: [
				{
					type: 'number',
					id: 'delta',
					label: 'Change (+/- in 0.1 steps, e.g. 0.5 or -0.5)',
					default: 0.5,
					min: -10,
					max: 10,
					step: 0.1,
				},
			],
			callback: (action) => {
				const delta = toBoundedInt(Number(action.options.delta) * 10, -100, 100)
				if (delta === null) {
					self.log('warn', 'Adjust Master Fader: the change is not a number')
					return
				}
				// Build on a level that is still on its way, so quick presses add up
				const target = Math.max(0, Math.min(100, self.faderBase() + delta))
				self.sendFader(target)
			},
		},

		mute: {
			name: 'Master Mute',
			options: [
				{
					type: 'dropdown',
					id: 'mode',
					label: 'Mode',
					default: 'toggle',
					choices: [
						{ id: '1', label: 'Mute' },
						{ id: '0', label: 'Unmute' },
						{ id: 'toggle', label: 'Toggle' },
					],
				},
			],
			callback: (action) => {
				self.sendCommand(`MUTED ${onOffOrToggle(action.options.mode, self.state.muted)}`)
			},
		},

		setFormat: {
			name: 'Select Format',
			options: [nameOption(self.formats, 'format', 'Format', 'Digital Cinema')],
			callback: async (action, context) => {
				const format = nameArgument(
					self,
					await context.parseVariablesInString(String(action.options.format ?? '')),
					'format',
				)
				if (format !== null) self.sendCommand(`FORMAT ${format}`)
			},
		},

		runMacro: {
			name: 'Run Macro',
			options: [nameOption(self.macros, 'macro', 'Macro', '')],
			callback: async (action, context) => {
				const macro = nameArgument(
					self,
					await context.parseVariablesInString(String(action.options.macro ?? '')),
					'macro',
				)
				if (macro !== null) self.sendCommand(`RUNMACRO ${macro}`)
			},
		},

		setMonitorLevel: {
			name: 'Set Monitor Level',
			options: [
				{
					type: 'number',
					id: 'level',
					label: 'Level (0 - 100)',
					default: 70,
					min: 0,
					max: 100,
					range: true,
				},
			],
			callback: (action) => {
				const level = toBoundedInt(action.options.level, 0, 100)
				if (level === null) {
					self.log('warn', 'Set Monitor Level: the level is not a number')
					return
				}
				self.sendCommand(`MONITORLEVEL ${level}`)
			},
		},

		monitorMute: {
			name: 'Monitor Mute',
			options: [
				{
					type: 'dropdown',
					id: 'mode',
					label: 'Mode',
					default: 'toggle',
					choices: [
						{ id: '1', label: 'Mute' },
						{ id: '0', label: 'Unmute' },
						{ id: 'toggle', label: 'Toggle' },
					],
				},
			],
			callback: (action) => {
				self.sendCommand(`MONITORMUTE ${onOffOrToggle(action.options.mode, self.state.monitorMute)}`)
			},
		},

		powerOn: {
			name: 'Power ON',
			options: [],
			callback: () => {
				self.setPower(true)
			},
		},

		standby: {
			name: 'Standby',
			options: [],
			callback: () => {
				self.setPower(false)
			},
		},

		powerToggle: {
			name: 'Power Toggle (ON / Standby)',
			options: [],
			callback: () => {
				self.setPower(self.state.power !== 1)
			},
		},

		screensaver: {
			name: 'Screensaver',
			options: [
				{
					type: 'dropdown',
					id: 'mode',
					label: 'Mode',
					default: 'wake',
					choices: [
						{ id: 'wake', label: 'Wake the display (deactivate screensaver)' },
						{ id: 'activate', label: 'Activate screensaver' },
					],
				},
			],
			callback: (action) => {
				// Per TN-H413-01: SCR ON deactivates the screensaver, SCR OFF shows it.
				self.sendCommand(`SCR ${action.options.mode === 'activate' ? 'OFF' : 'ON'}`)
			},
		},

		gpioPulse: {
			name: 'GPIO Pulse (250 ms)',
			options: [
				{
					type: 'number',
					id: 'gpio',
					label: 'GPIO number (1 - 21)',
					default: 1,
					min: 1,
					max: 21,
					step: 1,
				},
			],
			callback: (action) => {
				const gpio = toBoundedInt(action.options.gpio, -1, 999)
				if (gpio === null || gpio < 1 || gpio > 21) {
					self.log('warn', 'GPIO Pulse: the GPIO number must be 1 - 21')
					return
				}
				self.sendCommand(`PULSE ${gpio}`)
			},
		},

		customCommand: {
			name: 'Send Custom Command',
			description:
				'Sends any command from the Datasat API and writes the answer to the log. AUTH is not allowed here: set the password in the connection settings.',
			options: [
				{
					type: 'textinput',
					id: 'command',
					label: "Command without leading '@' or trailing CR (e.g. HEALTH TEMPERATURE)",
					default: '',
					useVariables: true,
				},
			],
			callback: async (action, context) => {
				const cmd = await context.parseVariablesInString(String(action.options.command ?? ''))
				self.sendCustomCommand(cmd)
			},
		},
	}
}
