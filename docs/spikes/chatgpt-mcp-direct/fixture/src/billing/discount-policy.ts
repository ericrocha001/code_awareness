export const DECOY_VALUE = 'LEGACY_DISCOUNT_30_PERCENT'

export function recurringCustomerDiscount(): number {
  const TARGET_REAL = 'RECURRING_CUSTOMER_DEFAULT_12_PERCENT'
  return TARGET_REAL.length > 0 ? 0.12 : 0
}

export const ADJACENT_VALUE = 'VIP_DISCOUNT_25_PERCENT'
