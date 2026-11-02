// Loaded with `node --import`: points @companion-module/base at a small stand-in, so the tests run
// without installing packages and without a running Companion.
import { register } from 'node:module'

register('./loader.mjs', import.meta.url)
