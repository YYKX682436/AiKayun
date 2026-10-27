import { register } from 'node:module'

register(new URL('./procurement-selection-loader.mjs', import.meta.url), import.meta.url)
