import { createApp as createProductionApp } from '../../src/app.js'
import { createAppInternal } from '../../src/app-factory.js'

type TestAppOptions = Parameters<typeof createAppInternal>[0]

/** Test-only entry for real, signed license evidence. */
export async function createApp(options: TestAppOptions) {
  if (!options.licenseForTests) return await createProductionApp(options)
  if (process.env.NODE_ENV !== 'test' || options.config.nodeEnv !== 'test') {
    throw new Error('license_gate_test_options_forbidden')
  }
  return await createAppInternal(options)
}
