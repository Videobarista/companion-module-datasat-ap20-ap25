import { startSimulatedUnit } from './simulated-ap20.mjs'

// main.js registers its instance class through runEntrypoint (see the stand-in)
await import('../../main.js')

export const DEFAULT_CONFIG = {
	host: '127.0.0.1',
	pollInterval: 500,
	healthInterval: 10,
	powerOnMacro: '',
	standbyMacro: '',
}

/** Start a simulated unit and a module instance connected to it. */
export async function boot(unitOptions = {}, config = {}, secrets = {}) {
	const simulated = await startSimulatedUnit(unitOptions)
	globalThis.__AP20_TEST_PORT__ = simulated.port
	const instance = new globalThis.__ModuleInstance__({})
	await instance.init({ ...DEFAULT_CONFIG, ...config }, true, secrets)
	return {
		unit: simulated.unit,
		simulated,
		instance,
		async stop() {
			await instance.destroy()
			await simulated.close()
		},
	}
}

export const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Wait until check() is true, or fail after timeoutMs. */
export async function waitFor(check, timeoutMs = 5000, what = 'condition') {
	const end = Date.now() + timeoutMs
	while (Date.now() < end) {
		if (check()) return
		await wait(25)
	}
	throw new Error(`Timed out waiting for ${what}`)
}

/** The parseVariablesInString context that Companion passes to action callbacks. */
export const noVariables = { parseVariablesInString: async (text) => text }

export function logged(instance, level, fragment) {
	return instance.logs.some((entry) => entry.level === level && entry.message.includes(fragment))
}
