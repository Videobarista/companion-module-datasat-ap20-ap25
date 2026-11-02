import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { boot, logged, noVariables, wait, waitFor } from './helpers/harness.mjs'

describe('a unit that is on', () => {
	it('loads the formats and macros once, without the command echo', async () => {
		const { unit, instance, stop } = await boot()
		try {
			await waitFor(() => instance.formats.length > 0, 3000, 'formats')
			assert.deepEqual(instance.formats, ['AES EBU 2ch', 'Hdmi 1', 'Hdmi 1 Neo6', 'Nonsync 2 pro', 'Spdif ', 'Toslink A'])
			assert.deepEqual(instance.macros, ['FORMAT_1', 'HDMI 1'])
			assert.equal(unit.received.filter((c) => c === 'FORMATNAMES').length, 1)
			assert.equal(instance.defs.actions.setFormat.options[0].type, 'dropdown')
			assert.ok(instance.defs.presets.format_0)
			assert.ok(instance.defs.presets.macro_1)
		} finally {
			await stop()
		}
	})

	it('fills the variables, including health', async () => {
		const { instance, stop } = await boot()
		try {
			await waitFor(() => instance.vars.board_h338 === 'N/A', 4000, 'health')
			assert.equal(instance.vars.fader, '7.0')
			assert.equal(instance.vars.format, 'Hdmi 1')
			assert.equal(instance.vars.power_state, 'On')
			assert.equal(instance.vars.temp1, '41')
			assert.equal(instance.vars.board_h331, 'OK')
			assert.equal(instance.vars.phantom, 'Off')
			assert.equal(instance.vars.power, 'OK')
			assert.equal(instance.vars.version, '105.09')
			assert.equal(instance.vars.serial, '02635')
		} finally {
			await stop()
		}
	})

	it('runs the actions', async () => {
		const { unit, instance, stop } = await boot()
		try {
			await waitFor(() => instance.vars.fader === '7.0', 3000, 'first poll')
			const actions = instance.defs.actions
			actions.setFader.callback({ options: { level: 5.5 } })
			actions.faderRelative.callback({ options: { delta: -0.1 } })
			await waitFor(() => instance.vars.fader === '5.4', 3000, 'fader 5.4')
			actions.mute.callback({ options: { mode: 'toggle' } })
			await waitFor(() => instance.vars.muted === 'Muted', 3000, 'mute')
			await actions.setFormat.callback({ options: { format: 'Spdif ' } }, noVariables)
			await waitFor(() => unit.received.includes('FORMAT Spdif '), 3000, 'format with its trailing space')
			await waitFor(() => instance.vars.format === 'Spdif', 3000, 'format variable')
			assert.equal(instance.defs.feedbacks.format.callback({ options: { format: 'Spdif ' } }), true)
			actions.screensaver.callback({ options: { mode: 'activate' } })
			actions.gpioPulse.callback({ options: { gpio: 3 } })
			await waitFor(() => unit.received.includes('SCR OFF') && unit.received.includes('PULSE 3'), 3000, 'scr + pulse')
		} finally {
			await stop()
		}
	})

	it('adds up quick presses of a relative fader button', async () => {
		const { unit, instance, stop } = await boot()
		try {
			await waitFor(() => instance.vars.fader === '7.0', 3000, 'first poll')
			for (let i = 0; i < 5; i++) instance.defs.actions.faderRelative.callback({ options: { delta: 0.1 } })
			await waitFor(() => instance.vars.fader === '7.5', 3000, 'fader 7.5 after five presses of +0.1')
			assert.equal(unit.fader, 75)
			await waitFor(() => instance.faderTarget === null, 3000, 'no fader commands pending')
		} finally {
			await stop()
		}
	})

	it('draws the level bar for the fader and the monitor', async () => {
		const { instance, stop } = await boot()
		try {
			await waitFor(() => instance.vars.monitor_level === 40, 3000, 'monitor level')
			const levelBar = instance.defs.feedbacks.levelBar
			const fader = levelBar.callback({ options: { source: 'fader', position: 'bottom', color: 0x2ec4b6 }, image: { width: 72, height: 72 } })
			assert.ok(fader.imageBuffer)
			assert.deepEqual(levelBar.callback({ options: { source: 'fader' } }), {}, 'nothing without an image size')
			assert.ok(instance.checkedFeedbacks.includes('levelBar'))
			assert.ok(instance.defs.presets.faderBar)
			assert.ok(instance.defs.presets.monitorBar)
			assert.ok(instance.defs.presets.faderUpFine)
		} finally {
			await stop()
		}
	})
})

describe('power', () => {
	it('goes to standby, polls only POWER, and shows Starting for 15 s after power on', async () => {
		const { unit, instance, stop } = await boot()
		try {
			await waitFor(() => instance.vars.power_state === 'On', 3000, 'on')
			instance.defs.actions.standby.callback()
			await waitFor(() => instance.vars.power_state === 'Standby', 3000, 'standby')
			const before = unit.received.length
			await wait(1200)
			assert.ok(unit.received.slice(before).every((c) => c === 'POWER'), 'only POWER is polled in standby')

			instance.defs.actions.powerOn.callback()
			await waitFor(() => instance.vars.power_state === 'Starting', 1000, 'starting')
			await waitFor(() => instance.vars.power_state === 'On', 17000, 'on after warm-up')
		} finally {
			await stop()
		}
	})

	it('loads the lists when a unit that was in standby is switched on', async () => {
		const { unit, instance, stop } = await boot({ power: 0 })
		try {
			await waitFor(() => instance.vars.power_state === 'Standby', 3000, 'standby')
			assert.equal(instance.formats.length, 0)
			unit.power = 1
			await waitFor(() => instance.formats.length === 6, 3000, 'lists after power on')
		} finally {
			await stop()
		}
	})

	it('does not write @POWER off when the unit is silent right after connecting', async () => {
		const { unit, instance, stop } = await boot({ silentForMs: 3000 })
		try {
			await wait(3500)
			assert.notEqual(instance.caps.power, false)
			await waitFor(() => instance.caps.power === true, 3000, '@POWER detected by polling')
			await waitFor(() => instance.formats.length === 6, 13000, 'lists loaded by the retry')
			instance.defs.actions.standby.callback()
			await waitFor(() => unit.received.includes('POWER 0'), 3000, 'POWER 0 sent')
		} finally {
			await stop()
		}
	})

	it('falls back to text fields and macros on a unit without the extra commands', async () => {
		const { unit, instance, stop } = await boot(
			{ supportsPower: false, supportsNames: false, macros: ['PowerOn', 'Standby'] },
			{ powerOnMacro: 'PowerOn', standbyMacro: 'Standby' },
		)
		try {
			await waitFor(() => instance.caps.power === false, 3000, 'power not supported')
			await waitFor(() => instance.namesLoaded, 3000, 'lists answered')
			assert.equal(instance.defs.actions.setFormat.options[0].type, 'textinput')
			instance.defs.actions.powerOn.callback()
			await waitFor(() => unit.received.includes('RUNMACRO PowerOn'), 3000, 'fallback macro')
		} finally {
			await stop()
		}
	})
})

describe('answers that arrive late', () => {
	it('never mixes up the format and macro lists', async () => {
		const { instance, stop } = await boot({ delays: { FORMATNAMES: 1800, MACRONAMES: 1000 } })
		try {
			await waitFor(() => instance.macros.length > 0, 4000, 'macros')
			assert.deepEqual(instance.macros, ['FORMAT_1', 'HDMI 1'])
			assert.ok(!instance.formats.some((name) => name.startsWith('FORMATNAMES')))
		} finally {
			await stop()
		}
	})
})

describe('connection', () => {
	it('cleans up when the unit goes away', async () => {
		const { simulated, instance, stop } = await boot()
		try {
			await waitFor(() => instance.vars.fader === '7.0', 3000, 'first poll')
			await simulated.close()
			await waitFor(() => instance.pollActive === false, 3000, 'polling stopped')
			assert.equal(instance.inflight, null)
			assert.equal(instance.userQueue.length + instance.pollQueue.length, 0)
			assert.ok(!logged(instance, 'error', ''), 'no errors')
		} finally {
			await stop()
		}
	})
})
