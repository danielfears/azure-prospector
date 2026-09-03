import { afterEach, describe, expect, it } from 'vitest'
import { configuredSubscriptionIds } from './azure-config.js'

const originalSubscriptionIds = process.env.PROSPECTOR_SUBSCRIPTION_IDS

afterEach(() => {
  if (originalSubscriptionIds === undefined) {
    delete process.env.PROSPECTOR_SUBSCRIPTION_IDS
  } else {
    process.env.PROSPECTOR_SUBSCRIPTION_IDS = originalSubscriptionIds
  }
})

describe('configuredSubscriptionIds', () => {
  it('normalizes the picker and collector allow-list', () => {
    process.env.PROSPECTOR_SUBSCRIPTION_IDS =
      ' SUB-ONE,sub-two, SUB-ONE '

    expect(configuredSubscriptionIds()).toEqual(
      new Set(['sub-one', 'sub-two']),
    )
  })
})
