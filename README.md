# Azure Prospector

**Find the gold hiding in your cloud bill.**

Azure Prospector is a free, self-hosted Azure cost-optimization dashboard. It combines native Azure recommendations, cost history, resource inventory, telemetry coverage, ownership, exceptions, remediation workflow, and verified savings in one view.

> [!IMPORTANT]
> Azure Prospector is an independent community project. It is not an official Microsoft product and is not affiliated with or endorsed by Microsoft.

## Why it exists

Azure already exposes valuable optimization signals through Azure Advisor, Cost Management, Azure Resource Graph, Azure Monitor, reservations, savings plans, and service-specific telemetry. Those signals are useful but distributed across different scopes, interfaces, schemas, and permission models.

Azure Prospector does not attempt to replace those systems. It provides a persistent layer that:

- inventories every subscription visible to the configured identity;
- normalizes recommendations from multiple Azure sources;
- adds deterministic checks for common waste patterns;
- ranks findings by estimated value, confidence, effort, and risk;
- associates findings with owners using configurable resource tags;
- records exceptions without losing auditability;
- tracks remediation work separately from detection;
- compares post-change costs with stored baselines to report realized savings;
- clearly identifies missing telemetry instead of overstating certainty.

## Current MVP

- Responsive React dashboard with light and dark themes
- Persistent SQLite data store
- Safe demo workspace populated with representative findings
- Read-only live Azure collector using `@azure/identity`
- Visible-subscription discovery
- Azure Advisor cost recommendation ingestion
- Azure Resource Graph orphan-resource checks
- VM schedule-gap signals with deliberately lower confidence
- Cost Management history grouped by resource
- Configurable owner-tag discovery
- Confidence-scored recommendations and evidence
- Exception and remediation workflow
- Potential and realized-savings reporting
- Native Node HTTP API and one-process Vite development server

## Quick start

Requirements:

- Node.js 22.13 or later
- npm

```powershell
git clone https://github.com/danielfears/azure-prospector.git
Set-Location azure-prospector
npm install
npm run dev
```

Open `http://localhost:4310`. The default demo mode does not need Azure credentials and writes its local database to `data\azure-prospector.db`.

Docker is also supported:

```powershell
docker compose up --build
```

Compose binds to `127.0.0.1` by default because Azure cost and resource
metadata is sensitive. Put Azure Prospector behind an authenticated reverse
proxy before exposing it to another machine or network.

## Connect to Azure

The lowest-friction local option is Azure CLI authentication:

```powershell
az login --tenant <tenant-id>
Copy-Item .env.example .env
```

Set these values in `.env`:

```dotenv
PROSPECTOR_AUTH_MODE=azure-cli
AZURE_TENANT_ID=<tenant-id>
```

Then run:

```powershell
npm run dev
```

For hosted deployments, use managed identity or workload identity instead of a client secret.

### Recommended read roles

Assign only at the scopes Azure Prospector should inspect:

- **Reader** for resource inventory and Azure Advisor data
- **Cost Management Reader** for cost history
- **Monitoring Reader** for available platform metrics
- Appropriate billing or reservation read roles if commitment utilization is required

Authentication alone does not grant access. The identity sees only subscriptions, resources, costs, and benefits allowed by its Azure RBAC and billing roles.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `4310` | HTTP listening port |
| `PROSPECTOR_DB_PATH` | `data\azure-prospector.db` | SQLite database path |
| `PROSPECTOR_AUTH_MODE` | `default` | `default`, `azure-cli`, `managed-identity`, or `interactive` |
| `AZURE_TENANT_ID` | unset | Limits authentication to a tenant |
| `AZURE_CLIENT_ID` | unset | User-assigned managed identity or interactive app client ID |
| `PROSPECTOR_SUBSCRIPTION_IDS` | unset | Optional comma-separated subscription allow-list |
| `PROSPECTOR_OWNER_TAGS` | `owner,serviceOwner,applicationOwner,technicalOwner` | Ordered ownership tag keys |

See [`.env.example`](.env.example) for the complete template.

## What confidence means

Confidence is evidence quality, not a promise that a change is safe.

- **High:** direct Azure recommendation or deterministic relationship plus recent cost evidence
- **Medium:** strong utilization or configuration evidence with a known blind spot
- **Low:** useful investigation lead where workload intent or external automation is unknown

For example, an unattached managed disk with continuing cost is usually high-confidence. A VM without a visible auto-shutdown schedule is lower-confidence because an external scheduler may exist. Old blobs are not automatically considered deletable because retention, legal, backup, and workload intent cannot be inferred safely.

## Architecture

```text
Azure identity
    |
    +-- ARM subscription discovery
    +-- Azure Resource Graph inventory and checks
    +-- Azure Advisor recommendations
    +-- Cost Management history
    +-- Azure Monitor coverage
                |
         normalization layer
                |
        SQLite recommendation store
                |
       native Node HTTP API
                |
          React dashboard
```

The scanner is read-only. Remediation records represent workflow state; Azure changes require a separate, explicitly configured automation integration.

More detail is available in [`docs/architecture.md`](docs/architecture.md).

## Development

```powershell
npm run dev
npm test
npm run lint
npm run build
```

Run all checks:

```powershell
npm run check
```

## API

| Method | Endpoint | Purpose |
|---|---|---|
| `GET` | `/api/health` | Process, mode, and database health |
| `GET` | `/api/overview` | Estate KPIs, trends, coverage, and scan history |
| `GET` | `/api/recommendations` | Filterable recommendation inventory |
| `GET` | `/api/recommendations/:id` | Recommendation detail and evidence |
| `POST` | `/api/scans` | Run a demo or live read-only scan |
| `POST` | `/api/recommendations/:id/exceptions` | Add a documented exception |
| `DELETE` | `/api/recommendations/:id/exceptions` | Clear an exception |
| `POST` | `/api/recommendations/:id/actions` | Create a remediation action |
| `GET` | `/api/actions` | List remediation workflow items |
| `PATCH` | `/api/actions/:id` | Update remediation status |

## Known limitations

- Resource-level cost allocation depends on the dimensions returned for the billing agreement and resource type.
- Reservation and savings-plan data can require billing-scope permissions beyond subscription RBAC.
- Guest memory requires previously enabled VM telemetry.
- Blob-level stale-data analysis requires inventory or last-access data and should always respect retention requirements.
- A missing Azure-native VM schedule does not prove that no external scheduler exists.
- Estimated savings from separate findings can overlap; values must be deduplicated before being treated as a forecast.

## Contributing

Issues and pull requests are welcome. Start with [`CONTRIBUTING.md`](CONTRIBUTING.md), and never include tenant identifiers, exported billing data, credentials, or customer resource names in examples or test fixtures.

## License

[MIT](LICENSE)
