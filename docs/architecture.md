# Architecture

Azure Prospector separates collection, recommendation normalization, workflow, and presentation so each part can evolve without coupling the product to one Azure service or billing agreement.

## Components

### Provider layer

Providers return a common snapshot:

- visible subscriptions;
- normalized recommendations;
- resource and subscription cost points;
- telemetry coverage;
- warnings describing inaccessible or unavailable sources.

The demo provider supplies deterministic public fixtures. The live provider uses Azure Identity and read-only management APIs.

### Azure collection

The initial live collector uses:

- Azure Resource Manager for subscription discovery;
- Azure Resource Graph for estate-wide inventory, Advisor resources, ownership tags, and deterministic orphan checks;
- Cost Management Query for amortized resource-level cost history;
- Azure Advisor data exposed through Resource Graph.

The interactive Query API collector uses an adaptive evidence window of up to
six completed months. It budgets tenant-wide query processing units (QPUs),
paces subscription requests, honours bounded retry guidance, and retains every
billing currency separately. It never performs implicit currency conversion.

Live scans are organised as named assessments. The authenticated subscription
catalogue can be searched across Azure CLI tenants, and the chosen subscriptions
are grouped by tenant for collection. Results are merged only where units and
currencies are compatible; the active assessment scope prevents findings from
other projects leaking into the current view.

Later collectors can add reservation and savings-plan detail, Azure Monitor metrics, Blob Inventory, Storage Discovery exports, AKS allocation, SQL-specific telemetry, and custom policy results without changing the UI contract.

For large production estates, scheduled Cost Management exports are the
preferred ingestion path because historical cost data can be cached and
incrementally refreshed instead of queried repeatedly.

### Normalization

Every finding is converted into a common recommendation model with:

- stable fingerprint and source identity;
- resource and subscription scope;
- category and lifecycle status;
- current monthly cost and estimated monthly savings;
- confidence, effort, and change risk;
- evidence with source and observation time;
- owner plus ownership provenance;
- exception and remediation relationships.

Stable fingerprints allow repeated scans to update a finding rather than create duplicates.

### Persistence

SQLite is the default store because it keeps installation friction low and supports a useful single-instance deployment. The data-access layer is intentionally isolated so a future PostgreSQL adapter can support horizontally scaled deployments.

### HTTP service

The Node service exposes JSON APIs and serves the React application. During development it runs Vite in middleware mode; production serves the compiled static assets.

### Security boundaries

The collector identity is read-only. Detection and remediation are separate domains. A workflow item can be approved in Prospector without granting the web process permission to change Azure.

Local authentication is delegated to the Azure Identity library. Prospector
tries `AzureCliCredential` first, then uses `InteractiveBrowserCredential` with
its supported PKCE and loopback flow when the user explicitly connects. Azure
Identity owns the protocol and token maintenance; Prospector never handles
credentials or refresh tokens directly. Hosted deployments use a deterministic
managed or workload identity credential instead.

## Confidence model

Confidence reflects the strength and completeness of evidence:

- relationship checks such as an unattached disk start high;
- current cost evidence raises confidence in financial impact;
- missing guest or object-level telemetry caps confidence;
- ambiguous configuration findings such as missing schedules remain lower;
- exception history and ownership do not alter the technical evidence score.

## Realized savings

Potential savings and realized savings are deliberately separate:

1. A recommendation records a conservative expected monthly value.
2. A remediation action establishes the change and measurement date.
3. A stored pre-change period becomes the baseline.
4. Comparable post-change cost is measured after a stabilization window.
5. The difference is recorded with a measurement-coverage score.

Overlapping recommendations must be deduplicated before aggregation. A reservation purchase and a VM right-size affecting the same spend cannot both claim the full original cost.
