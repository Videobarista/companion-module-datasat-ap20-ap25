// A minimal stand-in for the parts of @companion-module/base that this module uses.
// It records what the module reports instead of talking to Companion.
import net from 'node:net'
import { EventEmitter } from 'node:events'

export const InstanceStatus = {
	Ok: 'ok',
	Connecting: 'connecting',
	ConnectionFailure: 'connection_failure',
	BadConfig: 'bad_config',
	AuthenticationFailure: 'authentication_failure',
	Disconnected: 'disconnected',
	UnknownError: 'unknown_error',
}

export const Regex = { IP: '/^\\d+\\.\\d+\\.\\d+\\.\\d+$/' }

export const combineRgb = (r, g, b) => ((r & 0xff) << 16) | ((g & 0xff) << 8) | (b & 0xff)

export class InstanceBase {
	constructor() {
		this.label = 'ap2x'
		this.logs = []
		this.statuses = []
		this.vars = {}
		this.defs = { actions: {}, feedbacks: {}, presets: {} }
		this.checkedFeedbacks = []
	}

	log(level, message) {
		this.logs.push({ level, message })
	}

	updateStatus(status, message) {
		this.statuses.push({ status, message })
	}

	setVariableDefinitions(definitions) {
		this.variableDefinitions = definitions
	}

	setVariableValues(values) {
		Object.assign(this.vars, values)
	}

	setActionDefinitions(definitions) {
		this.defs.actions = definitions
	}

	setFeedbackDefinitions(definitions) {
		this.defs.feedbacks = definitions
	}

	setPresetDefinitions(definitions) {
		this.defs.presets = definitions
	}

	checkFeedbacks(...ids) {
		this.checkedFeedbacks.push(...ids)
	}
}

/** Connects to the port in globalThis.__AP20_TEST_PORT__ (the simulated unit) instead of 14500. */
export class TCPHelper extends EventEmitter {
	constructor(host, port) {
		super()
		this.isConnected = false
		this.socket = net.connect(globalThis.__AP20_TEST_PORT__ ?? port, host)
		this.socket.on('connect', () => {
			this.isConnected = true
			this.emit('connect')
		})
		this.socket.on('data', (data) => this.emit('data', data))
		this.socket.on('error', (err) => {
			this.isConnected = false
			this.emit('error', err)
		})
		this.socket.on('close', () => {
			this.isConnected = false
			this.emit('end')
		})
	}

	send(text) {
		return new Promise((resolve) => this.socket.write(text, () => resolve(true)))
	}

	destroy() {
		this.socket.destroy()
	}
}

export function runEntrypoint(instanceClass, upgradeScripts) {
	globalThis.__ModuleInstance__ = instanceClass
	globalThis.__ModuleUpgradeScripts__ = upgradeScripts
}
