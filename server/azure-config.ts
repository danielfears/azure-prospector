export function configuredSubscriptionIds(): Set<string> | undefined {
  const configured = process.env.PROSPECTOR_SUBSCRIPTION_IDS
  if (!configured?.trim()) return undefined
  return new Set(
    configured
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  )
}
