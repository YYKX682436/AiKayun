import { createAppInternal } from './app-factory.js'

/** Production entry point: test license injection is available only to test fixtures. */
export async function createApp(options: Omit<Parameters<typeof createAppInternal>[0], 'licenseForTests'>) {
  const { db, config, logger, productIdentityFactory, paymentProviderBaseUrlForTests } = options
  return await createAppInternal({ db, config,
    ...(logger === undefined ? {} : { logger }),
    ...(productIdentityFactory === undefined ? {} : { productIdentityFactory }),
    ...(paymentProviderBaseUrlForTests === undefined ? {} : { paymentProviderBaseUrlForTests }),
  })
}
