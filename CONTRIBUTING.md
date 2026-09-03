# Contributing to Azure Prospector

Azure Prospector is intended to remain a generic, self-hosted Azure optimization tool. Contributions should work across tenants and must not encode assumptions about a particular company, management-group structure, naming convention, billing agreement, or internal process.

## Development setup

```powershell
npm install
npm run dev
```

Before opening a pull request:

```powershell
npm run check
```

## Contribution principles

- Keep the default scanner read-only.
- Prefer public, documented Azure APIs.
- Explain the evidence and blind spots behind every recommendation.
- Never describe estimated savings as guaranteed.
- Make tenant-specific rules configurable.
- Use least-privilege roles and avoid client secrets where managed identity or workload identity is available.
- Add tests for recommendation logic, persistence changes, and API behavior.
- Keep UI colors on the existing `--cp-*` theme variables.

## Safe fixtures

Do not commit:

- tenant, subscription, billing-account, or enrollment identifiers;
- real resource names, tags, email addresses, or cost exports;
- access tokens, client secrets, certificates, or private keys;
- screenshots containing customer data.

Use generated UUIDs, reserved example domains, and clearly fictional resource names in fixtures.

## Recommendation rules

A rule should include:

1. A stable fingerprint.
2. The Azure source and evidence used.
3. A confidence score and reason for any confidence cap.
4. A conservative monthly savings estimate.
5. Known false-positive cases.
6. A read-only test fixture.

## Pull requests

Keep changes focused, explain user-visible behavior, and call out any new Azure permissions or telemetry requirements.
