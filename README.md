# Azure Prospector

**Find the gold hiding in your cloud bill.**

Azure Prospector is a free, self-hosted Azure cost-optimisation dashboard. It turns Azure Advisor recommendations into an evidence-led decision workspace, alongside cost history, resource inventory, selective telemetry, ownership, exceptions, remediation workflow, and measured outcomes.

> [!IMPORTANT]
> Azure Prospector is an independent community project. It is not an official Microsoft product and is not affiliated with or endorsed by Microsoft.

## Why it exists

Azure already exposes valuable optimisation signals through Azure Advisor, Cost Management, Azure Resource Graph, Azure Monitor, reservations, savings plans, and service-specific telemetry. Those signals are useful but distributed across different scopes, interfaces, schemas, and permission models.

Azure Prospector does not attempt to replace those systems. It provides a persistent layer that:

- inventories every subscription visible to the configured identity;
- uses Azure Advisor cost recommendations as the root recommendation layer;
- distinguishes observed facts, Azure-authored estimates, calculated scenarios, investigation leads, and measured results;
- adds deterministic Resource Graph checks without presenting them as Azure estimates;
- preserves source lifecycle, recommendation type, status, freshness, lookback, and provenance;
- ranks findings by decision readiness, native-currency value, evidence quality, effort, and risk;
- associates findings with owners using configurable resource tags;
- records exceptions without losing auditability;
- tracks remediation work separately from detection;
- keeps potential value separate from measured realised savings;
- clearly identifies missing telemetry instead of overstating certainty.

## Current MVP

- Responsive React dashboard with light and dark themes
- Portfolio → subscription → resource → finding navigation with a persistent trust strip
- Azure estimate, action-ready, and needs-validation decision hierarchy
- Usage optimisation and Rate optimisation activity groupings
- Azure Advisor cost recommendations queried through Azure Resource Graph
- Deterministic Resource Graph orphan checks and precise DevTest Lab schedule checks
- Selective 30-day Azure Monitor VM platform telemetry and Activity Log corroboration
- Native-currency Cost Management history grouped by resource and pricing model
- Explicit claim provenance, formulas, assumptions, exclusions, evidence windows, and gaps
- Named, searchable, multi-tenant and multi-subscription assessments
- Saved assessment collection with open, rescan, and confirmed delete actions
- Schema-versioned JSON and RFC 4180 findings CSV exports
- Configurable owner-tag discovery, exceptions, and read-only remediation workflow
- Measured-only Outcomes view; estimates and scenarios are never labelled as realised
- Persistent SQLite data store with migration of legacy and saved workspaces
- Safe demo workspace, native Node HTTP API, and one-process Vite development server

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
- Appropriate billing or reservation read roles if commitment utilisation is required

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
| `AZURE_VM_TELEMETRY_MAX_CANDIDATES` | `50` | Maximum evidence-relevant VMs selected per subscription collector by default |
| `AZURE_VM_TELEMETRY_BATCH_SIZE` | `20` | VMs per regional CPU, network, and disk metrics request |
| `AZURE_VM_TELEMETRY_CONCURRENCY` | `3` | Concurrent metric batches and per-VM availability or Activity Log requests |
| `AZURE_VM_TELEMETRY_MAX_ATTEMPTS` | `2` | Bounded attempts for each telemetry request |
| `AZURE_VM_TELEMETRY_TIMEOUT_MS` | `20000` | Per-attempt telemetry timeout |
| `AZURE_VM_TELEMETRY_RETRY_DELAY_MS` | `500` | Initial exponential retry delay |

See [`.env.example`](.env.example) for the base template.

## Cost evidence and throttling

Prospector keeps cost evidence native to Azure: every subscription,
recommendation, chart, and roll-up retains its source billing currency. Amounts
and currencies are nullable rather than represented by misleading zeroes.
Amounts in different currencies are displayed separately and are never
converted or added together. If Advisor and Cost Management currencies conflict,
both source values remain as evidence but the cost baseline is not treated as
comparable.

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
source; the Query API is the low-friction local fallback. See Microsoft's
[Cost Management data caveats](https://learn.microsoft.com/azure/cost-management-billing/costs/understand-cost-mgt-data)
before using recent or estimated charges for financial decisions.

## Recommendation trust model

Every finding carries one explicit claim class:

- **Observed fact:** a collected configuration or relationship, without an implied monetary result.
- **Azure estimate:** a savings estimate authored by Azure Advisor.
- **Calculated scenario:** a reproducible Prospector formula applied to stated evidence and assumptions.
- **Investigation lead:** a useful signal that lacks evidence needed for a decision.
- **Measured result:** a comparable, completed-period result after a change.

The UI deliberately separates **Azure estimated opportunity**, **Action-ready**,
and **Needs validation**. An Azure-authored estimate is not automatically
action-ready: operational intent, comparable cost evidence, ownership, and
commercial constraints can still require validation. Confidence is evidence
quality, not the probability of achieving a saving or a declaration that a
change is safe.

For each ingested Advisor recommendation, Prospector retains the source
recommendation and resource IDs, recommendation type ID, native status,
`lastUpdated`, impact/risk, lookback, scalar extended properties, collection
time, API/version, and the activity-classification method. Only the explicit
Advisor lifecycle states `New`, `Active`, and `InProgress` enter live
monetisation. Locally, only unexcepted `open`, `accepted`, and `in_progress`
findings contribute to active opportunity totals; `resolved` and `dismissed`
findings do not.

Stable fingerprints update repeated observations. A finding is resolved as
absent only when collection for its source family and subscription completed,
so a permissions or API failure does not silently close it.

## Opportunity accounting

The dashboard groups actions into **Usage optimisation** (right-sizing,
scheduling, orphan cleanup, storage, database, network, and other waste
reduction) and **Rate optimisation** (reservations, Savings Plans, and licensing
or Azure Hybrid Benefit).

Totals follow Microsoft's [Advisor savings sequence](https://learn.microsoft.com/azure/advisor/advisor-how-to-calculate-total-cost-savings):
optimise usage first, evaluate reservations next, and Savings Plans last.
Prospector selects the highest-value scenario within each affected scope. If a
subscription/currency has a supported right-size or schedule scenario, current
commitment forecasts are withheld until usage is changed and Advisor refreshes.
Otherwise, reservation and Savings Plan families are treated as alternatives
and are never blindly added together. Every source term and lookback alternative
remains inspectable and exportable.

Azure estimates, calculated scheduling scenarios, and measured results have
separate nullable amount fields. Finding details and exports carry formula
inputs, rule versions, assumptions, exclusions, evidence windows, missing
evidence, and overlap/spend-pool identity.

## Selective VM telemetry and schedules

Prospector enriches only VMs already relevant to right-sizing or shutdown
findings. It selects at most 50 candidates by default, prioritises schedule
candidates, groups requests by subscription and region, batches CPU, network,
and disk metrics for up to 20 VMs, and queries availability through the
resource-scoped Metrics API. At most three operations run concurrently.
Telemetry calls use bounded retries and timeouts; partial results and
per-resource errors are preserved.

The collector requests the completed previous 30 days as 720 hourly buckets:
`VmAvailabilityMetric`, Percentage CPU, network totals, and disk byte totals
where Azure supports them. It also queries start, restart, power-off, and
deallocate Activity Log events as corroborating control-plane evidence. These
are platform sources: Azure Monitor Agent and a Log Analytics workspace are not
a baseline requirement. Guest memory remains an optional evidence gap.

A DevTest Lab schedule counts as coverage only when it targets the VM, is
enabled, represents a shutdown task, and has both recurrence and time zone.
The absence of that precise schedule does not rule out Automation, Logic Apps,
Functions, guest-OS jobs, or external schedulers. A null availability bucket is
unknown, not proof that the VM was deallocated.

The eight-hours-per-weekday value is emitted only when the completed window has
at least 95% hourly coverage, at least 98% availability across known buckets,
observed available hours above the scenario target, and a native-currency
variable compute-cost baseline. The formula is:

```text
OnDemand/Spot VM compute cost
× (observed available hours − eight hours per weekday)
÷ observed available hours
```

The scenario excludes disks, public IPs, backups, monitoring, commitments,
licensing effects, and start/stop overhead. It is calculated potential, not an
Azure estimate, forecast, or measured result.

## Navigating and saving assessments

Overview is the portfolio entry point. Subscription comparison opens a
subscription view; subscription and findings tables open resource scopes; each
resource links to its evidence-rich finding detail. The trust strip keeps
assessment scope, scanned resources, source window, freshness, native currency
treatment, warnings, and leading coverage gaps visible.

The **Outcomes** view reports only `measured_result` evidence. Completing a
workflow action, drawing an opportunity trend, or storing cost history does not
manufacture realised savings. Until a comparable post-change measurement
exists, Outcomes says **Not measured**. The current collectors do not yet
create measured-result claims.

Named assessments preserve their selected scope, scans, findings, actions, and
coverage in SQLite. Legacy single-workspace databases and saved workspace
snapshots are migrated in place. Legacy zero sentinels become nullable financial
values conservatively, and unsupported historic schedule amounts are downgraded
to investigation leads unless telemetry-backed. Deprecated response aliases
(`actualCost`, `optimizedCost`, `realizedSavings`, and
`verifiedMeasurementCount`) remain for compatibility. The numeric
`measurementCoverage` alias remains `0` when coverage is unavailable; new
clients should use nullable `measuredResultCoverage` and the explicit observed,
opportunity, and measured fields.

## Architecture

```text
Azure identity
    |
    +-- ARM subscription discovery
    +-- Azure Advisor recommendations via Resource Graph
    +-- Azure Resource Graph inventory and deterministic checks
    +-- Cost Management history
    +-- selective Azure Monitor metrics and Activity Log
                |
      claim and overlap normalisation
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
- Platform metrics have finite retention; the selected completed 30-day window must still be available.
- Guest memory is not collected and requires separately enabled guest telemetry.
- Blob-level stale-data analysis requires inventory or last-access data and should always respect retention requirements.
- DevTest Lab schedule detection cannot see Automation, Logic Apps, Functions, guest-OS, or external schedules.
- Activity Log is control-plane corroboration, not a complete historical power-state ledger.
- Cost and recommendation data can be delayed, corrected, or unavailable because of Azure processing and permissions.
- Calculated scheduling values cover variable VM compute only and are illustrative counterfactual scenarios.

## Microsoft Learn references

- [Advisor data in Azure Resource Graph](https://learn.microsoft.com/azure/advisor/advisor-azure-resource-graph)
- [Calculate total Advisor cost savings](https://learn.microsoft.com/azure/advisor/advisor-how-to-calculate-total-cost-savings)
- [Azure VM monitoring data and `VmAvailabilityMetric`](https://learn.microsoft.com/azure/virtual-machines/monitor-vm-reference)
- [Azure Monitor metric retention](https://learn.microsoft.com/azure/azure-monitor/metrics/data-platform-metrics#retention-of-metrics)
- [Activity Log in Azure Monitor](https://learn.microsoft.com/azure/azure-monitor/platform/activity-log)
- [Understand Cost Management data](https://learn.microsoft.com/azure/cost-management-billing/costs/understand-cost-mgt-data)
- [Well-Architected Cost Optimisation checklist](https://learn.microsoft.com/azure/well-architected/cost-optimization/checklist)

## Contributing

Issues and pull requests are welcome. Start with [`CONTRIBUTING.md`](CONTRIBUTING.md), and never include tenant identifiers, exported billing data, credentials, or customer resource names in examples or test fixtures.

## License

[MIT](LICENSE)
