import { recurringCustomerDiscount } from './discount-policy'

export function calculateRecurringCustomerPrice(basePrice: number): number {
  return basePrice * (1 - recurringCustomerDiscount())
}
