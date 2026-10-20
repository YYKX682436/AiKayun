export type PaymentMethod = 'alipay' | 'wechat'
export type ProviderResultStatus = 'paid' | 'pending' | 'failed' | 'unknown'

export type PaymentAction =
  | { type: 'qr_code'; value: string }
  | { type: 'redirect'; url: string }

export interface PaymentProviderCredentials {
  merchantId: string
  merchantKey: string
}

export interface PaymentCreateRequest {
  merchantOrderNo: string
  orderId: string
  amount: string
  currency: 'CNY'
  paymentMethod: PaymentMethod
  productName: string
  clientIp: string
  notifyUrl: string
}

export interface PaymentCreateReady {
  kind: 'ready'
  providerOrderId: string
  action: PaymentAction
}

export interface PaymentCreateRejected {
  kind: 'rejected'
  code: string
}

export interface PaymentCreateUnknown {
  kind: 'unknown'
  code: string
}

export type PaymentCreateResult = PaymentCreateReady | PaymentCreateRejected | PaymentCreateUnknown

export interface VerifiedCallback {
  merchantOrderNo: string | null
  merchantId: string | null
  providerOrderId: string | null
  paymentMethod: PaymentMethod | null
  amount: string | null
  status: ProviderResultStatus
  currency: 'CNY'
  payload: Record<string, string>
  eventSha256: string
  providerTimeText: string | null
}

export interface PaymentQueryResult {
  status: ProviderResultStatus
  merchantOrderNo: string | null
  merchantId: string | null
  providerOrderId: string | null
  paymentMethod: PaymentMethod | null
  amount: string | null
  currency: 'CNY'
  paidAtText: string | null
  payload: Record<string, unknown>
  eventSha256: string
}

export interface PaymentProviderAdapter {
  readonly id: 'zpay_epay_v1'
  readonly displayName: string
  readonly paymentMethods: readonly PaymentMethod[]
  readonly supportsStatusQuery: true
  create(credentials: PaymentProviderCredentials, request: PaymentCreateRequest): Promise<PaymentCreateResult>
  verifyCallback(
    credentials: PaymentProviderCredentials,
    parameters: Record<string, string>,
    eventSha256: string,
  ): VerifiedCallback | null
  query(credentials: PaymentProviderCredentials, merchantOrderNo: string): Promise<PaymentQueryResult>
  testConfiguration(credentials: PaymentProviderCredentials): Promise<boolean>
}
