const STAND_IN = new URL('./companion-base-stand-in.mjs', import.meta.url).href

export async function resolve(specifier, context, nextResolve) {
	if (specifier === '@companion-module/base') return { url: STAND_IN, shortCircuit: true }
	return nextResolve(specifier, context)
}
