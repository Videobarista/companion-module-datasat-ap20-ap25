import { combineRgb } from '@companion-module/base'
import { BOARDS } from './parsers.js'
import { nameOption } from './actions.js'
import { drawLevelBar } from './graphics.js'

// Default bar colours
export const FADER_BAR_COLOR = combineRgb(46, 196, 182)
export const MONITOR_BAR_COLOR = combineRgb(70, 140, 230)

// Reference level 7.0 on the master fader, shown as a white tick on the fader bar
const FADER_REFERENCE = 70

export function getFeedbacks(self) {
	return {
		muted: {
			type: 'boolean',
			name: 'Master output is muted',
			defaultStyle: {
				bgcolor: combineRgb(200, 0, 0),
				color: combineRgb(255, 255, 255),
			},
			options: [],
			callback: () => self.state.muted === 1,
		},

		monitorMute: {
			type: 'boolean',
			name: 'Monitor is muted',
			defaultStyle: {
				bgcolor: combineRgb(200, 0, 0),
				color: combineRgb(255, 255, 255),
			},
			options: [],
			callback: () => self.state.monitorMute === 1,
		},

		format: {
			type: 'boolean',
			name: 'Current format is',
			defaultStyle: {
				bgcolor: combineRgb(0, 120, 0),
				color: combineRgb(255, 255, 255),
			},
			options: [nameOption(self.formats, 'format', 'Format', 'Digital Cinema', false)],
			callback: (feedback) => self.state.format.trim() === String(feedback.options.format).trim(),
		},

		powerState: {
			type: 'boolean',
			name: 'Unit power state is',
			defaultStyle: {
				bgcolor: combineRgb(0, 120, 0),
				color: combineRgb(255, 255, 255),
			},
			options: [
				{
					type: 'dropdown',
					id: 'state',
					label: 'State',
					default: 'on',
					choices: [
						{ id: 'on', label: 'On (operating)' },
						{ id: 'starting', label: 'Starting (about 15 s after Power ON)' },
						{ id: 'standby', label: 'Standby' },
					],
				},
			],
			callback: (feedback) => {
				const warming = self.isWarmingUp()
				switch (feedback.options.state) {
					case 'starting':
						return warming
					case 'standby':
						return !warming && self.state.power === 0
					default:
						return !warming && self.state.power === 1
				}
			},
		},

		powerFault: {
			type: 'boolean',
			name: 'Supply voltage fault',
			defaultStyle: {
				bgcolor: combineRgb(255, 102, 0),
				color: combineRgb(0, 0, 0),
			},
			options: [
				{
					type: 'dropdown',
					id: 'board',
					label: 'Board',
					default: 'any',
					choices: [
						{ id: 'any', label: 'Any board' },
						...BOARDS.map((board) => ({ id: board, label: board })),
						{ id: 'cpu', label: 'CPU supply (H336)' },
					],
				},
			],
			callback: (feedback) => {
				const board = feedback.options.board ?? 'any'
				if (board === 'any') return self.state.powerOk === false
				if (board === 'cpu') return self.state.cpuOk === false
				const entry = self.state.boards[board]
				return Boolean(entry && entry.present === true && entry.ok === false)
			},
		},

		phantomOn: {
			type: 'boolean',
			name: 'Microphone phantom power is on',
			defaultStyle: {
				bgcolor: combineRgb(200, 120, 0),
				color: combineRgb(0, 0, 0),
			},
			options: [],
			callback: () => self.state.phantomOn === true,
		},

		faderLevel: {
			type: 'boolean',
			name: 'Fader level comparison',
			defaultStyle: {
				bgcolor: combineRgb(0, 120, 0),
				color: combineRgb(255, 255, 255),
			},
			options: [
				{
					type: 'dropdown',
					id: 'comparison',
					label: 'Comparison',
					default: 'eq',
					choices: [
						{ id: 'eq', label: '=' },
						{ id: 'gt', label: '>' },
						{ id: 'lt', label: '<' },
					],
				},
				{
					type: 'number',
					id: 'level',
					label: 'Level (0.0 - 10.0)',
					default: 7.0,
					min: 0,
					max: 10,
					step: 0.1,
				},
			],
			callback: (feedback) => {
				const target = Math.round(Number(feedback.options.level) * 10)
				if (!Number.isFinite(target)) return false
				switch (feedback.options.comparison) {
					case 'gt':
						return self.state.fader > target
					case 'lt':
						return self.state.fader < target
					default:
						return self.state.fader === target
				}
			},
		},

		levelBar: {
			type: 'advanced',
			name: 'Level bar (master fader or monitor level)',
			description:
				'Draws a bar on the button that follows the master fader (0.0 - 10.0, with a tick at 7.0) or the monitor level (0 - 100). This shows the setting, not the audio signal: the unit has no metering command.',
			options: [
				{
					type: 'dropdown',
					id: 'source',
					label: 'Show',
					default: 'fader',
					choices: [
						{ id: 'fader', label: 'Master fader' },
						{ id: 'monitor', label: 'Monitor level' },
					],
				},
				{
					type: 'dropdown',
					id: 'position',
					label: 'Position on the button',
					default: 'bottom',
					choices: [
						{ id: 'bottom', label: 'Bottom' },
						{ id: 'top', label: 'Top' },
					],
				},
				{
					type: 'colorpicker',
					id: 'color',
					label: 'Bar colour',
					default: FADER_BAR_COLOR,
				},
			],
			callback: (feedback) => {
				if (!feedback.image) return {}
				const monitor = feedback.options.source === 'monitor'
				return drawLevelBar({
					width: feedback.image.width,
					height: feedback.image.height,
					fraction: (monitor ? self.state.monitorLevel : self.state.fader) / 100,
					marker: monitor ? null : FADER_REFERENCE / 100,
					color: Number(feedback.options.color),
					position: feedback.options.position === 'top' ? 'top' : 'bottom',
				})
			},
		},
	}
}
