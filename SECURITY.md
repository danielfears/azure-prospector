# Security policy

## Reporting a vulnerability

Please use GitHub private vulnerability reporting for the repository. Do not include credentials, tenant data, billing exports, or other sensitive material in a public issue.

## Security model

- Azure collection is read-only by default.
- Credentials are supplied by Azure Identity providers and are never written to the Prospector database.
- The project does not require a stored client secret for local Azure CLI or hosted managed-identity use.
- Local SQLite data may contain resource metadata and cost information; protect the host and database as sensitive operational data.
- Remediation workflow records do not grant permission to modify Azure resources.
- Any future write-capable integration must use separate credentials, explicit approval, scoped permissions, and auditable execution.
- The application does not yet include multi-user authentication. Its default
  host and Compose configuration bind locally; remote deployments must use an
  authenticated reverse proxy and transport encryption.

## Supported versions

Until the first stable release, security fixes are applied to the latest `main` branch.
