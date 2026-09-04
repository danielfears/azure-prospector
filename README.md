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
- CLI-first authentication with optional browser fallback
- Named, searchable multi-subscription cost assessments
- Saved assessment collection with open, rescan, and confirmed delete actions
- Complete JSON report and findings CSV exports
- Clickable savings activities with resource-focused drill-down
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
npm run app
```

`npm run app` starts Prospector and opens `http://localhost:4310`. It opens on a
live-first connection screen; sample data is loaded only through the explicit
**Explore demo** action. Previous assessment data remains stored locally but is
shown only after opening it from **Saved assessments**. Local data is written
to `data\azure-prospector.db`.

Docker is also supported:

```powershell
docker compose up --build
```

Compose binds to `127.0.0.1` by default because Azure cost and resource
metadata is sensitive. Put Azure Prospector behind an authenticated reverse
proxy before exposing it to another machine or network.

## Connect to Azure

The lowest-friction local option is an existing Azure CLI session. Prospector
checks it automatically on startup:

```powershell
az login --use-device-code --allow-no-subscriptions
npm run app
```

Choose **Choose subscriptions**, name the assessment, search for the project or
subscription name, and tick the subscriptions to include. Selections can span
tenants available to the current Azure CLI account; Prospector scans each
tenant scope with the appropriate credential and combines the results.

Azure CLI can retain cached subscription names after a tenant refresh token has
expired. Prospector therefore validates each cached subscription using the
account Azure CLI binds to that subscription, rather than assuming the current
default account. Stale sessions remain visible for diagnosis, but affected
subscriptions are disabled and accompanied by an `az login` command. After
refreshing the relevant account, choose **Recheck sessions** without leaving
the picker.

Each successful live scan is saved as a named workspace. Home lists the
collection so assessments can be reopened, rescanned with their saved scope, or
deleted after confirmation. An opened assessment can be exported as a complete,
schema-versioned JSON report or an RFC 4180 findings CSV. Exported amounts retain
their native currencies, resource tag values are redacted, and sensitive
credential-shaped fields are removed.

Browser sign-in uses Azure Identity's supported
`InteractiveBrowserCredential`, including its PKCE and loopback handling.
Local use does not require Prospector to implement OAuth or store refresh
tokens. When no project client ID is configured, Azure Identity uses its
development application; a project-owned public client ID remains recommended
for a branded production distribution. No client secret is used.

For hosted deployments, use managed identity or workload identity instead of a
client secret.

### Authentication order

The default `auto` mode is deliberately local-user friendly:

1. Use a valid Azure CLI session without prompting.
2. Fall back to explicit Azure Identity browser sign-in when needed.
3. Show an actionable connection message when neither method is ready.

Set `PROSPECTOR_AUTH_MODE` explicitly for unattended deployments that must use
only managed identity or `DefaultAzureCredential`.

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
| `PROSPECTOR_AUTH_MODE` | `auto` | `auto`, `azure-cli`, `browser`, `managed-identity`, or `default-credential` |
| `AZURE_TENANT_ID` | unset | Optionally limits authentication and collection to one tenant |
| `AZURE_CLIENT_ID` | unset | User-assigned managed identity client ID |
| `PROSPECTOR_BROWSER_CLIENT_ID` | unset | Optional public client ID for a branded production broker flow |
| `PROSPECTOR_REDIRECT_URI` | unset | Optional redirect registered for a custom public client |
| `PROSPECTOR_SUBSCRIPTION_IDS` | unset | Optional comma-separated subscription allow-list |
| `PROSPECTOR_OWNER_TAGS` | `owner,serviceOwner,applicationOwner,technicalOwner` | Ordered ownership tag keys |
| `AZURE_COST_HISTORY_MONTHS` | `6` | Maximum completed months requested from Cost Management |
| `AZURE_COST_QPU_BUDGET_PER_SCAN` | `480` | Conservative tenant-wide Query API budget used to adapt the history window |
| `AZURE_COST_REQUEST_INTERVAL_MS` | adaptive | Optional minimum delay between subscription cost queries |
| `AZURE_COST_PAGE_INTERVAL_MS` | `15500` | Delay between paginated requests for the same subscription scope |
| `AZURE_HTTP_RETRY_ATTEMPTS` | `3` | Bounded retries for transient Azure responses |
| `AZURE_MAX_RETRY_DELAY_MS` | `120000` | Maximum server-directed delay accepted within an interactive scan |

See [`.env.example`](.env.example) for the complete template.

## Cost evidence and throttling

Prospector keeps cost evidence native to Azure: every subscription,
recommendation, chart, and roll-up retains its source billing currency. Amounts
in different currencies are displayed separately and are never converted or
added together.

Cost Management Query API usage is planned against its tenant-wide query
processing unit (QPU) limits. Prospector requests only completed calendar
months, up to six months for small scopes. It automatically shortens the history
window for large estates to remain within a conservative 480-QPU scan budget,
and paces requests against both QPU and request-count limits. It honours the
Cost Management QPU, tenant, client-type, entity, and standard retry headers.
For example:

- two subscriptions use six completed months, consuming about 12 QPUs;
- 122 subscriptions use three completed months, consuming about 366 QPUs;
- very large estates receive partial cost coverage rather than an unsafe burst.

Interactive scans are intentionally assessment-scoped: a project team can
select its small set of subscriptions without forcing an estate-wide billing
query. Portfolio-wide reporting should use scheduled exports and background
ingestion rather than the interactive scan path.

Azure refreshes cost data periodically, so repeatedly querying unchanged
history adds load without improving the evidence. For production-scale
ingestion, scheduled Cost Management exports remain the preferred future data
source; the Query API is the low-friction local fallback.

## What confidence means

Confidence is evidence quality, not a promise that a change is safe.

- **High:** direct Azure recommendation or deterministic relationship plus recent cost evidence
- **Medium:** strong utilization or configuration evidence with a known blind spot
- **Low:** useful investigation lead where workload intent or external automation is unknown

For example, an unattached managed disk with continuing cost is usually high-confidence. A VM without a visible auto-shutdown schedule is lower-confidence because an external scheduler may exist. Old blobs are not automatically considered deletable because retention, legal, backup, and workload intent cannot be inferred safely.

Finding details explain the score in context. A quantified Advisor
recommendation without a matching resource-level cost baseline is medium
confidence: the source recommendation is authoritative, but its amount has not
been independently corroborated by Prospector. Alternative reservation and
savings-plan terms remain inspectable, while report totals and activity cards
use each affected resource scope only once.

## Savings activities

The Overview groups findings by the action needed: Reserved Instances, Savings
Plans, right-sizing, shutdown scheduling, orphan cleanup, storage optimisation,
licensing and Azure Hybrid Benefit, database optimisation, network
optimisation, and other findings. Selecting an activity opens the Findings view
with that filter applied.

Reservation and savings-plan activities show the highest-value Advisor scenario
per affected resource scope; all source term and lookback scenarios remain in
exports. Shutdown scheduling means no DevTest Lab auto-shutdown schedule was
detected. It does not rule out Azure Automation or external schedulers, and it
does not prove that a VM runs continuously—historical Azure Monitor evidence is
required before Prospector can make that claim.

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
npm run app
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
| `GET` | `/api/assessments` | List saved live assessment workspaces |
| `POST` | `/api/assessments/:id` | Open a saved assessment workspace |
| `DELETE` | `/api/assessments/:id` | Delete a saved assessment and its run history |
| `GET` | `/api/assessments/:id/export` | Export active assessment JSON or findings CSV |
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
