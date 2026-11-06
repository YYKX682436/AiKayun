// Internal signed-image component only. Host launch remains hard-disabled.
import { parseHelperCommand, runInternalHelper } from './helper-command.js'
import { closeHostOperationChannel, reportHostEvent, reportHostResult } from './host-operations.js'

const controller = new AbortController()
const interrupt = () => controller.abort()
process.on('SIGINT', interrupt)
process.on('SIGTERM', interrupt)
// A broken output pipe is cancellation: never proceed with an unreported set.
process.stdout.on('error', interrupt)
const hostBroker = process.env.NODE_ENV === 'production' && process.env.AIKAYUN_BACKUP_HOST_BROKER === 'stdio-v1'
const safeDiagnosticCode = /^(?:BACKUP|RESTIC|REPOSITORY|STAGING|DEPLOYMENT|INSTALLER|LICENSE|TRUST|DATABASE|PAYMENT|DELIVERY|SET|FENCE|ARCHIVE|DUMP|RESTORE)_[A-Z0-9_]{1,80}$/u
const writeLine = async (value: unknown) => {
  if (hostBroker) {
    if (value && typeof value === 'object' && 'operation' in value && 'backupSetId' in value && 'status' in value &&
        (value as { status?: unknown }).status === 'started') {
      const item = value as { operation: string; backupSetId: string; status: string }
      await reportHostEvent(item.operation, item.backupSetId, item.status)
    } else await reportHostResult(value)
    return
  }
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(`${JSON.stringify(value)}\n`, error => error ? reject(error) : resolve())
  })
}
try {
  const command = parseHelperCommand(process.argv.slice(2))
  const result = await runInternalHelper(command, controller.signal, writeLine)
  if (controller.signal.aborted) throw new Error('interrupted')
  await writeLine(result)
} catch (error) {
  // Never print the exception, stack, arguments, provider output or secrets.
  const candidates = error && typeof error === 'object'
    ? [
      'operationCode' in error && typeof error.operationCode === 'string' ? error.operationCode : '',
      'message' in error && typeof error.message === 'string' ? error.message : '',
      'code' in error && typeof error.code === 'string' ? error.code : '',
    ]
    : []
  const diagnosticCode = candidates.find(candidate => safeDiagnosticCode.test(candidate)) ?? 'BACKUP_OPERATION_FAILED'
  process.stderr.write(`${controller.signal.aborted ? 'BACKUP_OPERATION_INTERRUPTED' : diagnosticCode}\n`)
  process.exitCode = controller.signal.aborted ? 130 : 1
} finally {
  closeHostOperationChannel()
  process.off('SIGINT', interrupt)
  process.off('SIGTERM', interrupt)
}
