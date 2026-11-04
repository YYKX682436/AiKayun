<script setup lang="ts">
import type { ApiSuccess } from '@aikayun/contracts'

definePageMeta({ layout: 'admin', middleware: 'admin-auth' })
useSeoMeta({ title: '运维中心' })

type Risk = { kind: string; count: number; oldest: string | null }
type Worker = { worker: string; status: string; lastScanAt: string | null; lastSuccessAt: string | null; lastFailureAt: string | null; lastFailureCode: string | null; unavailableCode: string | null; backlog: number; oldest: string | null }
type DiagnosticData = { checkedAt: string; checks: { key: string; status: string; reason: string; impact: string }[] }
type RiskData = { checkedAt: string; rows: Risk[] }
type WorkerData = { checkedAt: string; workers: Worker[] }
type FileData = { checkedAt: string; files: { kind: string; status: string; startedAt: string | null; completedAt: string | null; counts: Record<string, number> }[] }
const { data: risk, error: riskError, refresh: refreshRisk, status: riskStatus } = await useFetch<ApiSuccess<RiskData>>('/api/v1/admin/operations/risk')
const { data: workers, error: workerError, refresh: refreshWorkers, status: workerStatus } = await useFetch<ApiSuccess<WorkerData>>('/api/v1/admin/operations/workers')
const { data: diagnostic, error: diagnosticError, refresh: refreshDiagnostic } = await useFetch<ApiSuccess<DiagnosticData>>('/api/v1/admin/operations/diagnostics')
const { data: files, error: filesError, refresh: refreshFiles } = await useFetch<ApiSuccess<FileData>>('/api/v1/admin/operations/files')
const { data: license, error: licenseError, refresh: refreshLicense } = await useFetch<ApiSuccess<{ status: string; allowedUntil: string | null; retryable: boolean }>>('/api/v1/admin/license-status')
const { data: ready, error: readyError, refresh: refreshReady } = await useFetch<ApiSuccess<{ status: string }>>('/api/v1/health/ready')
const clientMounted = ref(false)
const busy = computed(() => riskStatus.value === 'pending' || workerStatus.value === 'pending')
const riskDefinitions: Record<string, { label: string; explanation: string; advice: string; to: string; financial?: boolean }> = {
  payment_requesting: { label: '支付请求长时间未决', explanation: '支付请求超过 10 分钟仍在请求中，时间从请求开始计算。', advice: '通过原业务页面进行认证查单，核对结果；不要重复发起支付。', to: '/admin/orders', financial: true },
  payment_unknown: { label: '支付结果未确认', explanation: '支付请求超过 10 分钟仍未确认；持续未决从请求开始计算，首次进入结果未知的准确时间无法确定。', advice: '通过原业务页面进行认证查单，核对结果；不要重复发起支付。', to: '/admin/orders', financial: true },
  reconciliation: { label: '开放支付对账', explanation: '支付证据存在需要核对的差异。', advice: '进入订单或钱包页面，使用已有认证查单和对账流程。', to: '/admin/orders', financial: true },
  orphan_hold: { label: '异常未释放的订单冻结', explanation: '支付已终结但关联钱包冻结仍未结算或释放。', advice: '核对订单与钱包账本，使用既有处理流程，勿强制解冻。', to: '/admin/wallets', financial: true },
  refund_unknown: { label: '退款结果未确认', explanation: '人工退款从开始时起持续未决超过 10 分钟；首次进入结果未知的准确时间可能无法确定。', advice: '核对原渠道结果并在订单中登记，勿重复退款。', to: '/admin/orders', financial: true },
  refund_manual: { label: '退款等待处理', explanation: '已审核退款处理超过 24 小时。', advice: '检查订单退款分配与原渠道处理进度。', to: '/admin/orders' },
  withdrawal_unknown: { label: '提现打款未确认', explanation: '打款从开始时起持续未决超过 10 分钟；首次进入结果未知的准确时间可能无法确定。', advice: '核对实际打款结果，再使用现有结果确认流程；勿再次打款。', to: '/admin/withdrawals', financial: true },
  withdrawal_uncertain: { label: '提现结果不确定', explanation: '提现处于结果不确定状态。', advice: '核对实际打款与审计记录，再使用现有结果确认流程。', to: '/admin/withdrawals', financial: true },
  delivery_failed: { label: '交付异常', explanation: '处理中的订单存在失败或未知的交付。', advice: '检查订单详情及失败原因，遵循既有恢复流程。', to: '/admin/orders' },
  delivery_backlog: { label: '交付长期积压', explanation: '自动交付订单项超过 24 小时仍未完成。', advice: '检查订单、支付和退款状态及 Worker 运行情况。', to: '/admin/orders' },
  supplier_uncertain: { label: '上游交付待核对', explanation: '上游操作结果未知或需要人工核对。', advice: '检查订单与供应商结果，勿直接重复提交外部请求。', to: '/admin/orders' },
  license_retry: { label: '授权续签异常', explanation: '本地续签存在重试记录。', advice: '检查授权状态及中心连接；历史业务仍需单独检查。', to: '/admin/license' },
}
const fileNames: Record<string, string> = { media: '商品媒体', private: '数字商品私有文件', draft: '购买草稿附件', order: '成交订单附件' }
const countNames: Record<string, string> = { metadataVariants: '媒体记录', verifiedVariants: '已验证', missingFiles: '缺失文件', invalidFiles: '损坏文件', unreferencedFiles: '无引用文件', staleStagingFiles: '过期暂存文件', referencedObjects: '引用对象', verifiedObjects: '已验证对象', missingObjects: '缺失对象', corruptObjects: '损坏对象', unknownObjects: '未知对象', staleUploadRows: '过期上传记录', orphanFiles: '孤儿文件', deletingAttachments: '删除中附件', oldOrphanFiles: '过期孤儿文件', prepared: '待完成', deleting: '删除中', missingRetained: '缺失历史附件', hashVerified: '哈希已验证', hashFailed: '哈希失败', hashLimitReached: '达到检查上限' }
const diagnosticNames: Record<string, string> = { media_directory: '商品媒体目录', private_directory: '私有文件目录', identity: '安装身份', trust_store: 'Trust Store', pending_key: '授权恢复密钥', payment_keys: '支付历史密钥', delivery_keys: '交付历史密钥', historical_obligations: '历史义务处理能力' }
const workerNames: Record<string, string> = { unpaid_expiry: '未付款订单过期', local_delivery: '本地数字商品交付', supplier_delivery: '上游交付与恢复', license_renewal: '授权自动续签' }
function isTime(value: unknown): value is string { return typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value)) }
function optionalTime(value: unknown) { return value === null || isTime(value) }
function count(value: unknown) { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 }
const validRisk = computed(() => !riskError.value && isTime(risk.value?.data?.checkedAt) && Array.isArray(risk.value.data.rows) && risk.value.data.rows.length <= 20 && risk.value.data.rows.every(r => Object.hasOwn(riskDefinitions, r.kind) && count(r.count) && optionalTime(r.oldest)))
const validWorkers = computed(() => !workerError.value && isTime(workers.value?.data?.checkedAt) && Array.isArray(workers.value.data.workers) && workers.value.data.workers.length === 4 && new Set(workers.value.data.workers.map(w => w.worker)).size === 4 && workers.value.data.workers.every(w => Object.hasOwn(workerNames, w.worker) && ['running', 'failed', 'unknown'].includes(w.status) && optionalTime(w.lastScanAt) && optionalTime(w.lastSuccessAt) && optionalTime(w.lastFailureAt) && (w.lastFailureCode === null || w.lastFailureCode === 'SCAN_FAILED') && (w.unavailableCode === null || w.unavailableCode === 'RELEASE_NOT_CONFIGURED') && count(w.backlog) && optionalTime(w.oldest)))
const validFiles = computed(() => !filesError.value && isTime(files.value?.data?.checkedAt) && Array.isArray(files.value.data.files) && files.value.data.files.length === 4 && new Set(files.value.data.files.map(f => f.kind)).size === 4 && files.value.data.files.every(f => Object.hasOwn(fileNames, f.kind) && ['ok', 'attention', 'unknown'].includes(f.status) && optionalTime(f.startedAt) && optionalTime(f.completedAt) && f.counts && typeof f.counts === 'object' && Object.entries(f.counts).length <= 30 && Object.entries(f.counts).every(([k, v]) => Object.hasOwn(countNames, k) && count(v))))
const validDiagnostic = computed(() => !diagnosticError.value && isTime(diagnostic.value?.data?.checkedAt) && Array.isArray(diagnostic.value.data.checks) && diagnostic.value.data.checks.length === 8 && new Set(diagnostic.value.data.checks.map(c => c.key)).size === 8 && diagnostic.value.data.checks.every(c => Object.hasOwn(diagnosticNames, c.key) && ['ok', 'problem', 'unknown'].includes(c.status) && ['DIRECTORY_ACCESSIBLE', 'DIRECTORY_UNAVAILABLE', 'PRESENT_NOT_VERIFIED', 'FILE_UNAVAILABLE', 'HISTORICAL_KEY_MISSING', 'KEY_IDS_PRESENT_NOT_DECRYPTED', 'KEY_RING_NOT_CONFIGURED', 'DEPENDENCY_UNAVAILABLE', 'NOT_FULLY_VERIFIED'].includes(c.reason) && ['STORAGE', 'NEW_BUSINESS', 'LICENSE_RECOVERY', 'HISTORICAL_OBLIGATIONS'].includes(c.impact)))
function date(value: string | null | undefined) { return value ? new Date(value).toLocaleString('zh-CN') : '未知' }
function duration(value: string | null) {
  if (!value) return '未知'
  const checkedAt = risk.value?.data?.checkedAt
  if (!isTime(checkedAt)) return '未知'
  const minutes = Math.max(0, Math.floor((new Date(checkedAt).getTime() - new Date(value).getTime()) / 60_000))
  return minutes < 60 ? `${minutes} 分钟` : `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`
}
function timeLabel(item: Risk) {
  return ['payment_requesting', 'payment_unknown', 'refund_unknown', 'withdrawal_unknown'].includes(item.kind) ? '最早未决起点' : '最早相关记录'
}
function durationLabel(item: Risk) {
  return ['payment_requesting', 'payment_unknown', 'refund_unknown', 'withdrawal_unknown'].includes(item.kind) ? '持续未决' : '距该记录'
}
function severity(item: Risk) {
  const definition = riskDefinitions[item.kind]
  const checkedAt = risk.value?.data?.checkedAt
  if (definition?.financial && item.oldest && isTime(checkedAt)
    && new Date(checkedAt).getTime() - new Date(item.oldest).getTime() >= 30 * 60_000) return '严重'
  return '需要处理'
}
const licenseLabel = computed(() => {
  switch (license.value?.data.status) {
    case 'active': return '有效'
    case 'offline_valid': return '离线有效'
    case 'unactivated': return '未激活，新经营受限'
    case 'expired': case 'offline_expired': return '已过期，新经营受限'
    case 'revoked': return '已撤销，新经营受限'
    case 'superseded': return '已被替代，新经营受限'
    default: return '未知 / 需要检查'
  }
})
async function refreshAll() { await Promise.all([refreshRisk(), refreshWorkers(), refreshLicense(), refreshReady(), refreshFiles(), refreshDiagnostic()]) }
let timer: ReturnType<typeof setInterval> | undefined
onMounted(() => { clientMounted.value = true; timer = setInterval(() => { if (document.visibilityState === 'visible') void refreshAll() }, 60_000) })
onUnmounted(() => { if (timer) clearInterval(timer) })
function exportDiagnostic() {
  // Fixed fields and bounded collections only: never export arbitrary response properties.
  const riskRows = validRisk.value ? risk.value!.data.rows.map(({ kind, count, oldest }) => ({ kind, count, oldest })) : null
  const workerRows = validWorkers.value ? workers.value!.data.workers.map(({ worker, status, lastScanAt, lastSuccessAt, lastFailureAt, lastFailureCode, unavailableCode, backlog, oldest }) => ({ worker, status, lastScanAt, lastSuccessAt, lastFailureAt, lastFailureCode, unavailableCode, backlog, oldest })) : null
  const fileRows = validFiles.value ? files.value!.data.files.map(({ kind, status, startedAt, completedAt, counts }) => ({ kind, status, startedAt, completedAt, counts: Object.fromEntries(Object.entries(counts).filter(([key]) => Object.hasOwn(countNames, key))) })) : null
  const checks = validDiagnostic.value ? diagnostic.value!.data.checks.map(({ key, status, reason, impact }) => ({ key, status, reason, impact })) : null
  const licenseData = license.value?.data
  const payload = JSON.stringify({ exportedAt: new Date().toISOString(), risk: riskRows, workers: workerRows, files: fileRows, checks,
    license: !licenseError.value && ['active', 'offline_valid', 'unactivated', 'expired', 'offline_expired', 'revoked', 'superseded', 'clock_suspect', 'identity_mismatch', 'pending', 'unavailable'].includes(licenseData?.status ?? '') && optionalTime(licenseData?.allowedUntil) && typeof licenseData?.retryable === 'boolean'
      ? { status: licenseData.status, allowedUntil: licenseData.allowedUntil, retryable: licenseData.retryable } : null,
    readiness: !readyError.value && ready.value?.data?.status === 'ok' ? 'ok' : 'unknown' }, null, 2)
  if (new TextEncoder().encode(payload).byteLength > 32 * 1024) return
  const url = URL.createObjectURL(new Blob([payload], { type: 'application/json' }))
  const link = document.createElement('a')
  link.href = url
  link.download = 'aikayun-operations-diagnostic.json'
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
</script>

<template>
  <UDashboardPanel id="admin-operations">
    <template #header>
      <UDashboardNavbar
        title="运维中心"
        :toggle="{ size: 'md', class: 'min-h-11 min-w-11' }"
      >
        <template #right>
          <ThemeModeSelect />
        </template>
      </UDashboardNavbar>
    </template>
    <template #body>
      <main
        id="admin-main"
        :data-operations-mounted="clientMounted ? 'true' : undefined"
        tabindex="-1"
        class="mx-auto w-full max-w-6xl p-4 focus:outline-none sm:p-6 lg:p-8"
      >
        <div class="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p class="text-sm font-medium text-primary">
              管理后台
            </p><h1 class="mt-1 text-3xl font-semibold tracking-tight text-highlighted">
              运维中心
            </h1><p class="mt-2 max-w-2xl text-sm leading-6 text-muted">
              查看运行状态和需要人工核对的历史业务。页面每分钟刷新一次，数据只读。
            </p>
          </div>
          <div class="flex flex-wrap gap-2">
            <UButton
              color="neutral"
              variant="outline"
              icon="i-lucide-refresh-cw"
              class="min-h-11"
              :loading="busy"
              @click="refreshAll"
            >
              刷新
            </UButton><UButton
              color="neutral"
              variant="outline"
              icon="i-lucide-download"
              class="min-h-11"
              @click="exportDiagnostic"
            >
              导出脱敏诊断
            </UButton>
          </div>
        </div>
        <section
          class="mt-8"
          aria-labelledby="service-heading"
        >
          <h2
            id="service-heading"
            class="text-xl font-semibold"
          >
            服务与授权
          </h2>
          <div class="mt-4 grid gap-4 md:grid-cols-3">
            <UCard>
              <p class="text-sm text-muted">
                服务与数据库就绪
              </p><p class="mt-2 font-semibold">
                {{ readyError || ready?.data?.status !== 'ok' ? '未知 / 需要检查' : '就绪' }}
              </p><p class="mt-2 text-sm text-muted">
                就绪检查不访问支付服务或授权中心。
              </p>
            </UCard>
            <UCard>
              <p class="text-sm text-muted">
                经营授权
              </p><p class="mt-2 font-semibold">
                {{ licenseError ? '未知 / 需要检查' : licenseLabel }}
              </p><p class="mt-2 text-sm text-muted">
                有效截止：{{ date(license?.data.allowedUntil) }}
              </p><UButton
                to="/admin/license"
                variant="link"
                class="mt-2 px-0"
              >
                管理授权
              </UButton>
            </UCard>
            <UCard>
              <p class="text-sm text-muted">
                历史义务处理
              </p><p class="mt-2 font-semibold">
                {{ !validDiagnostic ? '未知 / 需要检查' : diagnostic?.data.checks.find(c => c.key === 'historical_obligations')?.status === 'problem' ? '存在问题' : '需要独立检查' }}
              </p><p class="mt-2 text-sm text-muted">
                授权状态不会直接阻止已有业务；密钥、身份或文件异常仍可能影响历史义务。
              </p>
            </UCard>
          </div>
        </section>
        <section
          class="mt-10"
          aria-labelledby="diagnostic-heading"
        >
          <h2
            id="diagnostic-heading"
            class="text-xl font-semibold"
          >
            关键文件与密钥
          </h2><p class="mt-2 text-sm text-muted">
            此处不读取或展示秘密文件内容；异常需要结合恢复流程人工检查。
          </p><UAlert
            v-if="!validDiagnostic"
            class="mt-4"
            color="warning"
            title="诊断未知"
            description="读取失败或检查超时，请检查服务并刷新。"
          /><div
            v-else
            class="mt-4 grid gap-4 md:grid-cols-2"
          >
            <UCard
              v-for="check in diagnostic?.data.checks"
              :key="check.key"
            >
              <div class="flex items-center justify-between gap-3">
                <h3 class="font-semibold">
                  {{ diagnosticNames[check.key] ?? '未知诊断项' }}
                </h3><UBadge
                  :color="check.status === 'ok' ? 'success' : 'warning'"
                  variant="soft"
                >
                  {{ check.status === 'ok' ? '已检查' : check.status === 'problem' ? '需要处理' : '未知 / 需要检查' }}
                </UBadge>
              </div><p
                v-if="check.status !== 'ok'"
                class="mt-2 text-sm text-muted"
              >
                检查代码：{{ check.reason }}。请检查对应配置和受保护备份，不要替换历史文件或密钥。
              </p>
            </UCard>
          </div>
        </section>
        <section
          class="mt-10"
          aria-labelledby="risk-heading"
        >
          <div class="flex flex-wrap items-baseline justify-between gap-2">
            <h2
              id="risk-heading"
              class="text-xl font-semibold"
            >
              业务风险
            </h2><p class="text-sm text-muted">
              检查时间：{{ date(risk?.data.checkedAt) }}
            </p>
          </div>
          <UAlert
            v-if="!validRisk"
            class="mt-4"
            color="warning"
            title="风险数据未知"
            description="读取失败或检查超时，请检查数据库并刷新。"
          />
          <UAlert
            v-else-if="!risk?.data.rows.length"
            class="mt-4"
            color="success"
            title="当前未发现已定义的业务风险"
            description="这不代表所有历史问题均已排除。"
          />
          <div
            v-else
            class="mt-4 grid gap-4 md:grid-cols-2"
          >
            <UCard
              v-for="item in risk?.data.rows"
              :key="item.kind"
            >
              <div class="flex items-start justify-between gap-3">
                <h3 class="font-semibold">
                  {{ riskDefinitions[item.kind]?.label ?? '未知风险类型' }}
                </h3><UBadge
                  :color="severity(item) === '严重' ? 'error' : 'warning'"
                  variant="soft"
                >
                  {{ severity(item) }}
                </UBadge>
              </div><p class="mt-2 text-sm text-muted">
                {{ riskDefinitions[item.kind]?.explanation ?? '需要检查诊断数据。' }}
              </p><p class="mt-2 text-sm">
                {{ item.count }} 项 · {{ timeLabel(item) }} {{ date(item.oldest) }} · {{ durationLabel(item) }} {{ duration(item.oldest) }}
              </p><p class="mt-2 text-sm leading-6 text-muted">
                {{ riskDefinitions[item.kind]?.advice }}
              </p><p class="mt-2 text-sm text-muted">
                人工响应目标：资金未知 10 分钟内开始核对，超过 30 分钟升级；其他异常尽快检查。响应目标不代表问题已解决。
              </p><UButton
                :to="riskDefinitions[item.kind]?.to ?? '/admin'"
                variant="link"
                class="mt-2 px-0"
              >
                前往业务页面
              </UButton>
            </UCard>
          </div>
        </section>
        <section
          class="mt-10"
          aria-labelledby="worker-heading"
        >
          <div class="flex flex-wrap items-baseline justify-between gap-2">
            <h2
              id="worker-heading"
              class="text-xl font-semibold"
            >
              后台任务
            </h2><p class="text-sm text-muted">
              检查时间：{{ date(workers?.data.checkedAt) }}
            </p>
          </div>
          <UAlert
            v-if="!validWorkers"
            class="mt-4"
            color="warning"
            title="Worker 状态未知"
            description="监测数据不可用或检查超时，请检查数据库并刷新。"
          />
          <div
            v-else
            class="mt-4 grid gap-4 md:grid-cols-2"
          >
            <UCard
              v-for="worker in workers?.data.workers"
              :key="worker.worker"
            >
              <div class="flex items-start justify-between gap-3">
                <h3 class="font-semibold">
                  {{ workerNames[worker.worker] ?? worker.worker }}
                </h3><UBadge
                  :color="worker.status === 'running' ? 'success' : 'warning'"
                  variant="soft"
                >
                  {{ worker.status === 'running' ? '扫描正常' : worker.status === 'failed' ? '最近扫描失败' : '未知 / 需要检查' }}
                </UBadge>
              </div><p class="mt-2 text-sm text-muted">
                最近扫描：{{ date(worker.lastScanAt) }} · 最近成功：{{ date(worker.lastSuccessAt) }}
              </p><p class="mt-2 text-sm">
                待处理 {{ worker.backlog }} 项 · 最早 {{ date(worker.oldest) }}
              </p><p
                v-if="worker.unavailableCode"
                class="mt-2 text-sm text-muted"
              >
                发行授权配置尚不可用，请检查发行配置。
              </p><p
                v-if="worker.lastFailureAt"
                class="mt-2 text-sm text-muted"
              >
                最近失败：{{ date(worker.lastFailureAt) }} {{ worker.lastFailureCode ?? '' }}
              </p>
            </UCard>
          </div>
        </section>
        <section
          class="mt-10"
          aria-labelledby="files-heading"
        >
          <h2
            id="files-heading"
            class="text-xl font-semibold"
          >
            文件一致性
          </h2><p class="mt-2 text-sm text-muted">
            独立检查只代表执行节点挂载的文件；超过 7 天或未完成的结果视为未知。缺失或损坏的历史文件需要人工恢复。
          </p><UAlert
            v-if="!validFiles"
            class="mt-4"
            color="warning"
            title="文件检查状态未知"
            description="读取失败或检查超时，请检查数据库并刷新。"
          /><div
            v-else
            class="mt-4 grid gap-4 md:grid-cols-2"
          >
            <UCard
              v-for="file in files?.data.files"
              :key="file.kind"
            >
              <div class="flex items-start justify-between gap-3">
                <h3 class="font-semibold">
                  {{ fileNames[file.kind] ?? file.kind }}
                </h3><UBadge
                  :color="file.status === 'ok' ? 'success' : 'warning'"
                  variant="soft"
                >
                  {{ file.status === 'ok' ? '检查通过' : file.status === 'attention' ? '需要处理' : '未知 / 需要检查' }}
                </UBadge>
              </div><p class="mt-2 text-sm text-muted">
                完成时间：{{ date(file.completedAt) }}
              </p><p
                v-if="Object.keys(file.counts).length"
                class="mt-2 text-sm leading-6"
              >
                {{ Object.entries(file.counts).map(([key, count]) => `${countNames[key] ?? key} ${count}`).join(' · ') }}
              </p>
            </UCard>
          </div>
        </section>
      </main>
    </template>
  </UDashboardPanel>
</template>
