// Older signed upgrade launchers override the Compose command with `verify`.
// Dispatch that invocation to the existing read-only identity verifier.
process.argv.splice(1, process.argv.length - 1, '/app/dist/production-install-init.js', 'verify')
await import('./dist/production-install-init.js')
