# Architecture

Azure Prospector is an Advisor-first recommendation and evidence dashboard. It
separates collection, claims, opportunity accounting, workflow, persistence,
and presentation so that an Azure-authored estimate is never confused with a
Prospector calculation or a measured result.

## Design principles

- Azure Advisor cost recommendations are the root recommendation layer.
- Every finding states what kind of claim it makes and what evidence is missing.
- Native currency is preserved; unknown amounts and currencies stay null.
- Usage is optimised before rates, and overlapping alternatives are not summed.
- Missing telemetry lowers readiness rather than being interpreted as zero.
- Detection remains read-only and separate from remediation.
- Outcomes contain measured results only.

## Components

```text
Subscription-bound Azure credentials
    |
    +-- ARM subscription discovery
    +-- Advisor recommendations and configurations via Resource Graph
    +-- Resource Graph inventory and deterministic relationship checks
    +-- completed-month Cost Management queries
    +-- selective VM platform metrics and Activity Log
                |
      claim, currency, scope, and overlap normalisation
                |
       SQLite active state + saved assessment snapshots
                |
              Node API
                |
     React portfolio/subscription/resource/finding UI
```

### Authentication and assessment scope

Local authentication is delegated to Azure Identity. `auto` mode first tries a
valid `AzureCliCredential` session and then offers
`InteractiveBrowserCredential`, including the library's PKCE and loopback
handling. Prospector does not implement OAuth or persist refresh tokens.
Hosted deployments use managed identity, workload identity, or an explicitly
selected default credential; no client secret is required.

The subscription catalogue can include several tenants. A live assessment binds
a credential to each selected subscription and its tenant, scans subscriptions
independently, and merges only compatible units and native currencies. An
expired cached Azure CLI session disables that subscription and gives a
targeted reauthentication instruction rather than reusing another tenant's
token. Partial subscription failures remain visible as warnings and assessment
coverage.

### Provider layer

Providers return a common snapshot:

- visible subscriptions and resource counts;
- normalised findings and their claim metadata;
- resource and subscription cost points;
- telemetry and source coverage;
- warnings for inaccessible, partial, or unavailable sources;
- source-family completeness by subscription.

The demo provider supplies deterministic public fixtures. The live provider
uses read-only management APIs. Stable fingerprints update a finding across
scans. An existing finding is resolved as absent only when its source family
completed successfully for that subscription; a failed or partial source cannot
silently close findings.

## Azure collection

### Advisor and Resource Graph

Advisor cost recommendations are queried from the `advisorresources` table and
joined to Resource Graph inventory. See [Advisor data in Azure Resource
Graph](https://learn.microsoft.com/azure/advisor/advisor-azure-resource-graph).
The collector also reads Advisor configurations so subscription/resource-group
exclusions and the inactive-VM low-CPU threshold are honoured.

Only source recommendations with an explicit native lifecycle status of
`New`, `Active`, or `InProgress` are ingested for live monetisation. Tracked
recommendations and scopes excluded through Advisor configuration are omitted.
For each ingested finding, Prospector preserves:

- native recommendation ID and Advisor resource ID;
- recommendation type ID, native status, `lastUpdated`, impact, and risk;
- Advisor lookback, commitment term, quantity, SKU, region, and scalar extended
  properties where supplied;
- API name/version, collection time, source family, rule version, and
  activity-classification method.

Known recommendation type IDs drive activity classification first; a recorded
text fallback handles other Advisor types. Advisor metadata is not rewritten to
look like independent validation.

Resource Graph also supplies deterministic unattached-disk, public-IP, and NIC
relationships, VM inventory, and DevTest Lab schedules. These become observed
facts, calculated scenarios, or investigation leads according to the evidence;
they are not labelled as Advisor estimates.

### Cost Management and throttling

The interactive collector queries `AmortizedCost`/`PreTaxCost` for completed
calendar months, grouped by resource ID and pricing model. It uses up to six
months for small scopes and shortens the window against a conservative
tenant-wide 480-QPU budget. Requests are paced for Query API request and QPU
limits, pagination is delayed, Azure retry headers are honoured, and retries
and maximum delays are bounded.

The representative subscription and resource basis is the median completed
month in each native billing currency. Cost may be null when access, allocation,
currency, or a comparable resource match is unavailable. A numeric value with
no source currency is not monetised. A mismatch between Advisor and Cost
Management currencies retains both pieces of evidence but prevents comparison.
Currencies are never converted or aggregated across FX boundaries.

Azure cost data can be delayed or corrected; see [Understand Cost Management
data](https://learn.microsoft.com/azure/cost-management-billing/costs/understand-cost-mgt-data).
For large estates, scheduled Cost Management exports remain the preferred
future ingestion path. The Query API is the low-friction assessment path.

## Claim and readiness model

Every finding carries exactly one `claim.level`:

| Claim class | Meaning |
|---|---|
| `observed_fact` | A collected configuration or relationship with no implied saving |
| `azure_estimate` | A monetary forecast authored by Azure Advisor |
| `calculated_scenario` | A deterministic Prospector formula over stated evidence |
| `investigation_lead` | A signal that still lacks evidence needed for a decision |
| `measured_result` | A comparable completed-period result after a change |

The claim also records decision status, validation state, rule version,
provenance, evidence window, formula inputs, assumptions, exclusions, missing
evidence, and overlap identity. Monetary fields are separate and nullable:

- `azureEstimatedMonthlySavings` is Azure-authored;
- `calculatedMonthlySavings` is a Prospector counterfactual;
- `measuredMonthlySavings` is a verified result;
- `estimatedMonthlySavings` is the compatibility/display value for the
  finding's current claim class.

`Azure estimate`, `Action-ready`, and `Needs validation` are therefore different
concepts. An Azure estimate normally still needs workload, operational, and
commercial validation. Action-ready requires an explicit `decision_ready`
state with suitable dated and comparable evidence; it is not inferred merely
from a large value or confidence score. Confidence describes evidence quality,
not the probability of achieving a saving or the safety of a change.

The local recommendation workflow has `open`, `accepted`, `in_progress`,
`resolved`, and `dismissed` states. Only unexcepted `open`, `accepted`, and
`in_progress` findings enter active opportunity calculations. An active
exception removes a finding from totals without deleting its evidence or audit
history.

## Canonical opportunity accounting

Each claim has an affected scope key, spend-pool key, sequence stage/order,
alternative group where relevant, and mutually exclusive activities. Totals
admit only positive, native-currency `azure_estimate` or
`calculated_scenario` claims and select the highest-value alternative for each
scope.

The sequence follows Microsoft's [Advisor total-savings
guidance](https://learn.microsoft.com/azure/advisor/advisor-how-to-calculate-total-cost-savings):

1. Apply usage optimisation, such as right-sizing or shutdown scheduling.
2. Refresh demand, then evaluate reservations.
3. Evaluate Savings Plans against the remaining eligible usage.

If a subscription/currency has a supported usage-optimisation scenario, current
reservation and Savings Plan forecasts are withheld because they describe the
pre-optimisation demand. Otherwise, reservation and Savings Plan families are
treated as alternatives: the stronger family is selected for the current
portfolio scenario, never added blindly to the other. All Advisor terms,
lookbacks, and alternatives remain in finding details and exports.

The dashboard presents the activities as:

- **Usage optimisation:** right-sizing, shutdown scheduling, orphan cleanup,
  storage, database, network, and other waste reduction.
- **Rate optimisation:** reservations, Savings Plans, and licensing/Azure
  Hybrid Benefit.

Opportunity trend lines apply the conservative, confidence-weighted,
scope-deduplicated scenario to observed completed-period cost. They are
counterfactual potential, not forecasts or realised savings.

## Selective VM telemetry

Telemetry is collected only for VMs already implicated in right-sizing or
shutdown-scheduling findings. Schedule candidates are prioritised, resources
are deduplicated, and the default supported selection is at most 50 candidates
per subscription collector. Requests are grouped by subscription and Azure
region. CPU, network, and disk metrics use regional batches of 20;
`VmAvailabilityMetric` uses the resource-scoped Metrics API because Azure's
regional multi-resource endpoint does not return it. Concurrency is limited to
three across both paths.

Each telemetry operation has two attempts by default, exponential delay from
500 ms, and a 20-second per-attempt timeout. Configuration is bounded to three
attempts, 120 seconds, batch size 50, and concurrency eight. Failures remain as
per-resource retrieval errors; successful metric families are not discarded
because another family failed.

The evidence window is the completed 30 days ending at the preceding UTC
midnight: 720 expected `PT1H` buckets. Prospector requests:

- `VmAvailabilityMetric` with average, minimum, maximum, and `Context`;
- Percentage CPU;
- network ingress and egress totals;
- disk read and write byte totals;
- Activity Log start, restart, power-off, and deallocate operations.

Metrics unsupported for a VM remain explicit gaps. Activity Log events
corroborate control-plane changes but are not a complete power-state history.
Platform metrics do not require Azure Monitor Agent or a Log Analytics
workspace. Guest memory is not collected and remains an optional gap requiring
guest telemetry. Refer to the [VM monitoring data
reference](https://learn.microsoft.com/azure/virtual-machines/monitor-vm-reference),
[Azure Monitor metric
retention](https://learn.microsoft.com/azure/azure-monitor/metrics/data-platform-metrics#retention-of-metrics),
and [Activity Log](https://learn.microsoft.com/azure/azure-monitor/platform/activity-log).

### Schedule semantics

A DevTest Lab schedule suppresses the schedule-gap finding only when it has a
target VM resource ID, is not disabled/failed/deleted/cancelled, represents a
shutdown task, and includes recurrence and time zone. Incomplete or disabled
matching schedules are retained as inspected evidence rather than treated as
active coverage.

This check cannot see schedules implemented through Azure Automation, Logic
Apps, Functions, guest operating-system jobs, or external orchestrators. Their
absence is missing evidence, not proof that no schedule exists.

`VmAvailabilityMetric` numeric buckets approximate observed available/billable
hours. A null or missing bucket is unknown, not deallocated; Azure can stop
emitting the metric immediately after a control-plane stop. A schedule finding
becomes an eight-hours-per-weekday calculated scenario only when:

- at least 95% of the 720 hourly buckets are populated;
- availability is at least 98% across known buckets;
- observed available hours exceed eight hours for each weekday and zero hours
  at weekends in the completed window;
- a native-currency median completed-month cost exists for the VM's
  `PricingModel=OnDemand` or `Spot` rows.

The formula is:

```text
eligible variable VM compute cost
× (observed available hours − target weekday hours)
÷ observed available hours
```

It excludes managed disks, public IPs, backup, monitoring, other fixed resource
costs, reservations, Savings Plans, Azure Hybrid Benefit, other commitments,
start/stop overhead, unknown availability buckets, and guest-memory behaviour.
Required operating hours, time zone, recovery overhead, and seasonal
representativeness still require operator validation.

## Presentation and navigation

Overview is the portfolio route. Subscription comparison shows native-currency
cost, share within that currency, canonically sequenced Azure opportunity,
readiness, and owner coverage. Users then navigate:

```text
saved assessments → portfolio → subscription → resource → finding
```

Routes are addressable through assessment, subscription, resource, and finding
query parameters. Breadcrumbs preserve context. The trust strip remains above
the active view and shows assessment scope, scanned subscriptions/resources,
source window, scan/view freshness, native-currency/no-FX treatment, warnings,
and leading coverage gaps.

Finding details expose claim type, readiness, validation state, cost basis,
source evidence, freshness, formula, assumptions, exclusions, missing evidence,
provenance, and overlap treatment before an exception or remediation action can
be recorded. The web process remains read-only against Azure.

The **Outcomes** route reads measured fields only. Azure estimates, calculated
scenarios, remediation status, opportunity trends, and stored cost periods do
not create realised savings. Until comparable post-change evidence is persisted
as a measured result, the UI reports **Not measured**. Current collectors do
not yet create measured-result claims.

## Persistence and compatibility

SQLite keeps local installation friction low. Active normalised tables support
dashboard queries; each named assessment also stores a transactional snapshot
of its selected subscription scope, findings, coverage, exceptions, actions,
and scan metadata. Opening an assessment snapshots the current workspace before
restoring the target. Rescanning updates that named workspace; confirmed delete
removes only its snapshot and associated scan history.

Startup migrations update both active tables and saved assessment snapshots:

- a legacy single workspace becomes an imported named assessment;
- savings activities, explicit claims, financial-availability flags, and VM
  telemetry fields are backfilled;
- legacy monetary zero sentinels become null unless source evidence proves the
  amount and currency are available;
- historic schedule amounts are downgraded to investigation leads unless the
  stored claim is backed by an Azure Monitor evidence window and VM telemetry.

The API retains deprecated aliases for older clients:
`actualCost` → `observedAmortizedCost`, `optimizedCost` →
`opportunityScenarioCost`, `realizedSavings` → nullable `measuredSavings`, and
`verifiedMeasurementCount` → `measuredResultCount`. Compatibility aliases must
not be interpreted as proof of measurement; the legacy numeric realised-saving
fields remain zero when no measured result exists. The legacy numeric
`measurementCoverage` remains `0`; nullable `measuredResultCoverage` is the
canonical field for unknown coverage.

## Exports

Exports are scoped to the explicitly opened assessment. JSON uses
`azure-prospector/assessment-report@2` and contains the overview, complete
findings, remediation actions, and scans. CSV uses RFC 4180 quoting and exports
separate Azure/calculated/measured amounts plus claim level, decision and
validation states, provenance, evidence window, formula, missing evidence,
overlap identity, and VM telemetry.

Both formats preserve nullable values and native currencies without FX
conversion. Spreadsheet formula cells are neutralised, credential-shaped keys
and text are redacted, and tag keys are kept while arbitrary tag values are
redacted.

## Security boundary

The collector identity requires only the read roles for the selected scope:
Reader, Cost Management Reader, Monitoring Reader, and any separately required
billing/benefit reader roles. Authentication does not widen Azure RBAC.
Prospector can record an approved workflow item but cannot change Azure unless a
separate automation integration is deliberately configured and approved.

The design follows the [Well-Architected Cost Optimisation
checklist](https://learn.microsoft.com/azure/well-architected/cost-optimization/checklist):
cost decisions remain grounded in workload value, evidence, ownership, and
operational risk rather than headline savings alone.
