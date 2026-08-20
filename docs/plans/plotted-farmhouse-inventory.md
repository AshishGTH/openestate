# Plotted / farmhouse inventory support — plan for review

**Status:** revision 3, approved for Phase A. Phase B remains gated on
reviewer sign-off after Phase A's stop-and-verify.

Changes in revision 3 (all approved in review):
- **§7 arithmetic corrected.** 1,147 × 43,560 = 49,963,320 paise
  (₹4,99,633.20), loss ₹366.80/acre, ₹73,360 on a 200-acre township —
  not the numbers in revision 2. The `perAcreVsPerSqftBounded` test is
  deleted; a hardcoded gap constant is a maintenance liability and it
  was already wrong once. Only the exact-value assertion remains.
- **Area stored as entered too**, not just rate. `Unit.landAreaEntered`
  + `Unit.landAreaEnteredUnit` are the source of truth for pricing;
  `Unit.landAreaSqft` becomes a derived projection for reports and
  filters, with the invariant enforced at write. Pricing pipeline is
  now flat multiplication (`ratePaise × landAreaEntered`) for the
  common case where rate and area share a unit — exact for **every**
  AreaUnit including SQM. §7. `landAreaDisplayUnit` from revision 2 is
  dropped (the entered unit IS the natural display).

Changes carried over from revision 2 (unchanged):
- Rate stored AS ENTERED in paise per `Unit.rateUnit`. §7.
- Server-side recomputation of every submitted `baseAmountPaise` in a
  new pre-verifier UPSTREAM of the frozen `BookingService`. §7.4, §8, §10.
- `Unit.shape` denormalised from `Project.shape`, exact CHECK. §5.2.
- Five area units (SQFT, SQYD, SQM, ACRE, GUNTA); bigha deferred. §6.
- LAND_BASED XLSX import in Phase C. §14.

This is a substantial architectural change. It touches the shape of the
inventory hierarchy that every reporting query, availability view, portal
screen, and the booking wizard traverses. Producing it as a plan first,
per the brief, so the direction can be argued in text before any of that
churn starts.

Two blockers before design that the reviewer already flagged, and one I'm
adding: land-record terminology and area units vary meaningfully by state,
and the client's actual inventory sheet is the difference between two
useful units and six speculative ones. Those decisions are called out
explicitly in "What the client needs to answer" below and are the
approval gate for Phase B (API) — schema can land without them, because
the honest answer is stored data, not code branches.

---

## 1. Assumptions

Written down so a reviewer who disagrees with one can raise it before we
build on it.

- **Only the inventory hierarchy shape varies.** Financial semantics,
  applicant/inquiry model, brokers/commissions, receipts, GST/TDS,
  refunds/cancellations/transfers do not vary by inventory shape. A land
  parcel and an apartment are the same thing to the ledger — a Unit with
  a booking, cost lines and a receipt schedule. This is the assumption
  that lets the Phase 4 frozen core stay frozen; if it turns out to be
  wrong for some client, that discovery becomes its own planning cycle.
- **Companies mix shapes across projects, never within a project.** A
  single project is one shape end-to-end. This lets shape live on
  `Project` and not on `Unit`, which is a much smaller surface.
- **The client will pilot with one shape first.** LAND_BASED. So the
  minimum viable delivery is: (a) LAND_BASED works end-to-end, (b) every
  existing apartment project keeps working byte-identically, (c) mixing
  the two in one company works. Multi-shape UI polish (e.g. a shape
  switcher on the project list) is a follow-up, not a shipping blocker.
- **Existing rows are all HIGH_RISE and stay that way.** No production
  data needs an inventory-shape change. If one does later, the answer is
  "cancel the project and re-create it" — see §12 (Risks and rollback).
- **Ledger byte-identity is a testable property, not a claim.** §11 (Test
  plan) makes this a property-based check that runs in CI, not a design
  assertion that will drift once shipped.

## 2. What the client needs to answer before Phase B

Written first, not last. Land-record terminology and area units are
regional; the honest answer is "we don't know without the client's own
inventory sheet". These become stored configuration, not code decisions,
so **Phase A (schema + migration) does not block on them** — but Phase B
(API validation and forms) does.

- **Which area units do they actually use?** The brief lists six
  (acre, gunta, bigha, sq. yd., sq. m., sq. ft.). Bigha is regional —
  UP-bigha differs from Punjabi-bigha differs from Bengali-bigha, and
  getting the conversion factor wrong silently corrupts every plot area
  by 20–40%. I would rather ship two units the client actually uses (with
  a per-project custom factor if they use bigha) than six I guessed at,
  three of which display wrong for their region.
- **Which land-record identifiers do they file against?** Khasra, khatauni
  and mutation status are northern/UP terminology. Survey number and
  hissa number are southern/Maharashtra terminology. Karnataka has its
  own RTC (Record of Rights, Tenancy and Crops) shape. Sample from a
  real inventory sheet is worth more than a generic list.
- **Does the client price the plot and any built structure as one number
  or two?** The brief says farmhouses are "often" priced separately —
  this may not be true for the specific client, and it changes whether we
  need a second BASE-shaped cost line at booking time. Both work; one is
  the default.
- **Land-use classification vocabulary.** "Agricultural", "NA
  (non-agricultural)", "converted", "residential-converted",
  "Section 143 order", etc. The set is regulatory and state-specific.
  Model as a per-company master, not an enum.
- **Do they use Sector/Block/Cluster grouping at all?** The brief
  suggests it as optional; if the client's inventory is a flat list of
  plots (common for farmland), we should not force them through an
  unused grouping level. `InventoryGroup` (§4) is nullable for exactly
  this reason.

Everything above is stored data or per-company configuration in this
plan. Nothing here forces a schema change once the client answers.

## 3. Conflicts with the brief, argued rather than resolved silently

### 3.1 `projectType` enum vs. the existing `ProjectType` master

The brief proposes `Project.projectType` as an enum. `Project` already
has `projectTypeId → ProjectType` (a per-company admin-configurable
master, seeded with values like "Residential", "Commercial",
"Township"). Two things named "projectType" with different jobs will
confuse every future reader.

**Recommendation:** distinct name for the new field. `Project.shape:
InventoryShape` (see §3.2 for the enum). Leave `ProjectType` master
untouched — it is the human-readable category (label, sortable, admin
can add "Farmland township" as a display type), and the code contract
lives elsewhere.

Argument:
- The master is per-company data an admin may rename, deactivate, or
  invent new values for. The shape is a code contract we branch on
  (must have `floor.tower` or not; must have `landAreaSqft` or not).
  Coupling them means every new master row needs a shape too, and adding
  a `shape` column to a per-company master leaks a global code invariant
  into per-company data — the wrong shape of coupling.
- A schema enum with a small closed set is comprehensively enumerable in
  tests. A master value is not.
- Symmetry: `Booking.status` is an enum, not a master. `Inquiry.status`
  is an enum, not a master. `Unit.status` is an enum, not a master. The
  pattern here is consistent: structural, code-branched state is an enum;
  categorical labels are masters. Shape is structural.

**Rejected alternatives:**
- Rename the existing `ProjectType` master to `ProjectCategory` and reuse
  `projectType` for the enum: churn on shipped data for no gain; every
  existing reference in `admin/masters` and reports would have to move.
- Add a `shape` column to `ProjectType` master: makes shape per-company
  data (wrong scope) and means "add a new project type" requires picking
  a shape from a hidden enum anyway.

### 3.2 Six enum values collapse to two shapes

The brief proposes six values (APARTMENT, COMMERCIAL_TOWER, PLOTTED,
COMMERCIAL_PLOT, FARMHOUSE, VILLA) grouped into three shapes: apartment,
plotted, farmhouse. On inspection, these collapse further to **two**
shapes, and the case for keeping the third is weak.

Structural questions the code will branch on:
- **Is there a Tower/Floor path above the Unit?** Yes → HIGH_RISE.
  No → LAND_BASED.
- **Is there an "optional Sector/Block/Cluster" group?** Only meaningful
  for LAND_BASED (a HIGH_RISE's grouping is Tower, which is not optional).
- **Is there a covered/built area on the Unit?** Both shapes may have it
  (an apartment always does; a farmhouse does; a bare plot does not) —
  this is per-unit data, not per-shape.
- **Is there a land area on the Unit?** LAND_BASED yes; HIGH_RISE no
  (a super-built-up figure is not the same as a land area).

That is one real branch (tower/floor present?), so one real bit of shape.
Everything else is either per-unit data or per-project configuration.

**Recommended enum, minimal:**

```
enum InventoryShape {
  HIGH_RISE     // absorbs the brief's APARTMENT + COMMERCIAL_TOWER
  LAND_BASED    // absorbs the brief's PLOTTED + COMMERCIAL_PLOT + FARMHOUSE + VILLA
}
```

Categorical distinctions (apartment vs. commercial tower; plotted vs.
farmhouse vs. villa) live in the existing `ProjectType` master — that is
what it is FOR. A farmhouse project has `shape=LAND_BASED, projectTypeId
= <"Farmhouse">`, an empty-plot layout has `shape=LAND_BASED,
projectTypeId = <"Plotted township">`, and the code branches on shape
while the UI labels and filters lean on the master.

**Honest limits of this recommendation:**
- If the client's actual inventory reveals a case the code needs to
  branch on that neither shape covers, the enum grows. That is safe —
  adding an enum value is additive.
- I am NOT confident enough to argue for one shape (LAND_BASED as a
  superset of HIGH_RISE by making tower/floor always optional). HIGH_RISE
  requiring tower/floor is a real invariant apartment operations depend
  on ("which floor is this unit on" is a first-class query); flattening
  it would rewrite reports for no gain.

**Rejected alternative:** three shapes (adding LAND_WITH_STRUCTURE for
farmhouses/villas). The distinction it captures is "the unit has both a
land area and a built area", which is per-unit data — bare plots and
farmhouses within the same LAND_BASED project would want to live side by
side, which a three-shape split makes clumsy.

## 4. Design overview

- `Project` gains `shape: InventoryShape @default(HIGH_RISE)`. Existing
  rows default cleanly.
- `Unit` gains `projectId: String @db.Uuid` (scalar FK, per this
  codebase's Phase 4 policy on scalar-FKs-without-Prisma-relations for
  non-primary graph edges). Always populated. For HIGH_RISE units this
  duplicates the reachable-via-floor.tower.projectId path; for LAND_BASED
  units it is the only path. Consistency is enforced on write, not
  trusted.
- `Unit.floorId` becomes nullable. Non-null on HIGH_RISE, null on
  LAND_BASED. A check constraint (see §5) enforces this.
- New `InventoryGroup` table (nullable Unit → InventoryGroup): the
  Sector/Block/Cluster grouping for LAND_BASED. Not called Tower, not
  overloaded onto Tower — different semantics, different reporting,
  different UI. HIGH_RISE units never carry one.
- New land-record fields on Unit — first-class only where code will
  filter, report or validate; everything else via the existing
  `Unit.customFields` (v0.2.3) path. See §5.
- No changes to `Booking`, `BookingCostLine`, or any ledger model. One
  line inside `BookingService.createBooking` changes: instead of walking
  `unit.floor.tower.project.areaLocation`, walk `unit.project.areaLocation`
  via the new scalar. That is the entire ledger-adjacent surface of the
  change. §10 lists what does NOT change.

## 5. Schema delta (exact Prisma)

Broken into clearly-labelled additions on existing models plus one new
model. RLS implications called out per table.

### 5.1 `Project` — add shape and default area unit

```prisma
enum InventoryShape {
  HIGH_RISE
  LAND_BASED
}

enum AreaUnit {
  SQFT
  SQYD
  SQM
  ACRE
  GUNTA
}

model Project {
  ...
  shape                InventoryShape @default(HIGH_RISE)
  /// Default entered-unit picker in the LAND_BASED unit-create form.
  /// Null (or ignored) for HIGH_RISE. Per-unit source of truth is
  /// `Unit.landAreaEnteredUnit`, which the wizard defaults from this.
  landAreaDefaultUnit  AreaUnit?      @map("land_area_default_unit")
  ...
  inventoryGroups InventoryGroup[]
  units           Unit[]
}
```

`bighaSqftOverride` from revision 1 is dropped — bigha only comes back if
the client's region needs it, and it comes back as a new enum value with
per-project factor at that point (a genuinely additive change).

RLS: no change. `projects` is already tenant-scoped and shape does not
change the isolation predicate.

### 5.2 `Unit` — direct project FK, denormalised shape, nullable floor, entered+derived area, rate unit

```prisma
model Unit {
  ...
  projectId        String        @map("project_id") @db.Uuid           // NEW, always set
  /// Denormalised from Project.shape. Safe because Project.shape is
  /// immutable after creation (§13.3), so the copy CANNOT drift — the
  /// invariant is enforced by never writing this column except at unit
  /// create, from the parent Project's shape. In exchange we get a
  /// row-level CHECK constraint that is EXACT (not the coarse guardrail
  /// revision 1 proposed) and every report that filters by shape can do
  /// so without joining to projects. Given the 35-site coupling risk
  /// documented in §13.1, the cost of the extra column is well spent.
  shape            InventoryShape @map("shape")                          // NEW
  floorId          String?       @map("floor_id") @db.Uuid              // was NOT NULL
  inventoryGroupId String?       @map("inventory_group_id") @db.Uuid    // NEW

  // Land-based inventory. §7.1 for the two-column rationale — pricing
  // uses landAreaEntered directly (no divide-through-sqft rounding);
  // landAreaSqft is the derived, comparable form for reports/filters.
  //
  // Source of truth: what the client typed and picked in the wizard.
  landAreaEntered      Decimal?  @map("land_area_entered") @db.Decimal(20, 6)
  landAreaEnteredUnit  AreaUnit? @map("land_area_entered_unit")
  // Derived at write time from (entered, enteredUnit) via
  // convertToSqft(). Invariant enforced in the unit create/update
  // service:  landAreaSqft == convertToSqft(landAreaEntered, landAreaEnteredUnit).
  // Reports, availability filters and "total plotted area" rollups
  // pivot on this — never on the entered pair, which mixes units.
  landAreaSqft         Decimal?  @map("land_area_sqft") @db.Decimal(20, 6)

  // Land-record identifier — kept as free-form text on purpose. State
  // vocabulary varies (khasra, survey number, RTC, hissa) and we do not
  // want to bake one in. The column is called `landRecordRef` for that
  // reason; per-project the LABEL is configurable ("Khasra number",
  // "Survey number", ...).
  landRecordRef   String?   @map("land_record_ref") @db.VarChar(100)

  // Facing/dimensions — first-class because reports and filters will use
  // them. Anything more esoteric (mutation status, land-use class,
  // registration book/volume/page) goes via customFields until a real
  // report needs to pivot on it.
  facing          String?   @db.VarChar(20)            // 'N','S','E','W','NE',...
  lengthFeet      Decimal?  @map("length_feet") @db.Decimal(10, 2)
  breadthFeet     Decimal?  @map("breadth_feet") @db.Decimal(10, 2)

  // baseRatePaise stays a BigInt. What changes: it is now paise per the
  // Unit's rateUnit, not always paise/sqft. HIGH_RISE units get rateUnit=SQFT
  // (matches pre-existing semantics, so backfill is a no-op interpretation
  // change). LAND_BASED units carry the unit the client actually entered
  // — most commonly ACRE for farmland — and the rate is stored EXACTLY,
  // not divided through sqft (which was lossy: ₹5,00,000/acre normalised
  // to 1,147 paise/sqft loses ₹366.80 per acre). See §7 for the arithmetic.
  rateUnit        AreaUnit  @default(SQFT) @map("rate_unit")            // NEW
  ...
  project         Project         @relation(fields: [projectId], references: [id])
  floor           Floor?          @relation(fields: [floorId], references: [id])
  inventoryGroup  InventoryGroup? @relation(fields: [inventoryGroupId], references: [id])

  @@index([projectId, status])            // NEW — reports pivot on this once
                                          // floor.tower traversal is optional
  @@index([inventoryGroupId, status])     // NEW — grouped availability views
  @@map("units")
}

// UnitRateRevision gets the same rateUnit column for the same reason —
// a rate revision must record the unit it was entered in, or converting
// history to compare rates would re-introduce the very rounding this
// change exists to eliminate.
model UnitRateRevision {
  ...
  rateUnit AreaUnit @default(SQFT) @map("rate_unit")   // NEW
  ...
}
```

**Check constraint (SQL, in the migration; Prisma does not model it):**
```sql
ALTER TABLE units ADD CONSTRAINT units_shape_hierarchy_chk
  CHECK (
    (shape = 'HIGH_RISE'  AND floor_id IS NOT NULL AND inventory_group_id IS NULL)
    OR
    (shape = 'LAND_BASED' AND floor_id IS NULL)
    -- inventory_group_id may be NULL or set for LAND_BASED; either is valid.
  );
```

Exact match, not the weak guardrail from revision 1. Possible only
because `shape` now lives on the row and `Project.shape` is immutable
(§13.3) so the copy on Unit cannot drift. Application still validates
the same rules on create/update, but the DB is now the authoritative
enforcer — a bug that tried to insert a HIGH_RISE unit with no floor
would be refused at the row level, before hitting any application code.

**Backfill of `Unit.shape` and `Unit.rateUnit`:** every existing unit is
HIGH_RISE (§1 assumption), and every existing HIGH_RISE rate is
implicitly paise/sqft. Migration writes `shape = 'HIGH_RISE'` and
`rateUnit = 'SQFT'` for every existing row before flipping either column
to NOT NULL. No semantic change to existing data.

RLS: `units` is already tenant-scoped by company_id. The new `projectId`
and `shape` columns do not change the isolation predicate; both are
shortcuts through the same tenant boundary. No RLS change.

### 5.3 New `InventoryGroup` model

```prisma
/// Sector / Block / Cluster grouping for LAND_BASED projects. HIGH_RISE
/// projects never carry these — their grouping level is Tower.
model InventoryGroup {
  id        String   @id @default(uuid()) @db.Uuid
  companyId String   @map("company_id") @db.Uuid
  projectId String   @map("project_id") @db.Uuid
  name      String   @db.VarChar(255)                  // "Sector 3", "Block B", "Cluster North"
  code      String   @db.VarChar(50)                   // stable short id for lookups/import
  kind      String?  @db.VarChar(20)                   // 'SECTOR' | 'BLOCK' | 'CLUSTER' — cosmetic label hint
  isActive  Boolean  @default(true) @map("is_active")
  createdAt DateTime @default(now()) @map("created_at")
  updatedAt DateTime @updatedAt @map("updated_at")

  company Company @relation(fields: [companyId], references: [id])
  project Project @relation(fields: [projectId], references: [id])
  units   Unit[]

  @@unique([projectId, code])
  @@index([companyId, projectId])
  @@map("inventory_groups")
}
```

RLS: **must be added to the `TENANT_SCOPED_MODELS` list**
(`packages/db/src/tenant.extension.ts`) AND to the migration's RLS
enable-and-policy loop — the Phase 3 pattern used for every new
tenant-scoped table. If the RLS ENABLE step is missed the app still
works, but a raw connection can read across companies — the exact bug
class Phase 3's tests were written to prevent.

### 5.4 `ProjectType` master — unchanged

Deliberately not touched. The category-vs-shape argument in §3.1 depends
on it staying a per-company label master. If a future release wants
"recommended default shape when this ProjectType is picked", that is a
hint field, not a code contract, and is a much smaller change than
coupling them now.

### 5.5 Backfill

All three new required Unit columns need populating from existing rows
before their NOT NULL flip. Single migration, ordered so each ALTER
follows a settled state:

```sql
-- 1. Direct project FK (fills from floor.tower.project).
UPDATE units u
SET project_id = t.project_id
FROM floors f
JOIN towers t ON t.id = f.tower_id
WHERE u.floor_id = f.id AND u.project_id IS NULL;

-- 2. Shape denormalisation. Every existing project is HIGH_RISE
--    (§1 assumption; verified in Phase A stop-and-verify).
UPDATE units SET shape = 'HIGH_RISE' WHERE shape IS NULL;

-- 3. Existing rate semantics were paise/sqft.
UPDATE units SET rate_unit = 'SQFT' WHERE rate_unit IS NULL;
UPDATE unit_rate_revisions SET rate_unit = 'SQFT' WHERE rate_unit IS NULL;

-- 4. Flip to NOT NULL.
ALTER TABLE units ALTER COLUMN project_id SET NOT NULL;
ALTER TABLE units ALTER COLUMN shape SET NOT NULL;
ALTER TABLE units ALTER COLUMN rate_unit SET NOT NULL;
ALTER TABLE unit_rate_revisions ALTER COLUMN rate_unit SET NOT NULL;

-- 5. Only NOW add the CHECK constraint — after every existing row has
--    a shape and every HIGH_RISE row has its floor. Ordering matters:
--    adding the CHECK before the shape backfill would reject every row.
ALTER TABLE units ADD CONSTRAINT units_shape_hierarchy_chk CHECK (...);
```

Runs against a live DB. Same lock-timeout discipline as the recent
`refresh_tokens` migration — the `MIGRATION_LOCK_TIMEOUT` mechanism the
recent decisions log entry documents covers this automatically now,
and `units` is much less hot than `refresh_tokens` so contention risk
is lower.

## 6. Area handling — canonical unit, decimal not BigInt

Money is BigInt paise because money has exact discrete operations
(allocation, splitting into installments) and rounding errors compound
across ledger rows. Area is measured — every input already has
irreducible imprecision (a "1 acre" plot is not exactly 43,560 sq ft on
the ground) — and no ledger operation ever sums or splits areas across
rows. The Money analogy applies to the **unit-aware type** part
(a value must never travel without its display unit) but not to
BigInt-as-storage (over-engineering for a continuous measurement).

**Recommended storage:**

- **Source-of-truth pair:** `landAreaEntered: Decimal(20, 6)` +
  `landAreaEnteredUnit: AreaUnit`. What the client typed and picked.
  Pricing math reads only these — never the derived sqft column below
  — so per-sqm-entered plots avoid the irrational sqft factor
  entirely.
- **Derived column for reports:** `landAreaSqft: Decimal(20, 6)`. Sqft
  chosen because it is India's default real-estate unit and four of
  the five supported units convert exactly by an integer factor:
  1 acre = 43,560 sqft, 1 gunta = 1,089 sqft, 1 sq yd = 9 sqft. The
  one inexact conversion is sqft ↔ sq metre (10.7639…). The invariant
  `landAreaSqft === convertToSqft(landAreaEntered, landAreaEnteredUnit)`
  is enforced at write; pricing NEVER reads this column, so sqm's
  rounding here does not corrupt the ledger. §7.1.
- Per-project default unit lives on `Project.landAreaDefaultUnit`;
  admins pick from the enum below at project creation, and it seeds
  the unit-create form's `landAreaEnteredUnit` picker.
- **A shared `AreaUnit` module** in `packages/shared` (not Money — Money
  is Money) with:
  - `AreaUnit` enum: `SQFT | SQYD | SQM | ACRE | GUNTA`. Five values,
    exhaustive at ship. Bigha deliberately not included — see below.
  - `sqftPerUnit`: constant map. SQFT=1, SQYD=9, GUNTA=1089, ACRE=43560,
    SQM=10.7639104167 (documented at 10 decimal places, chosen because
    the last digit is beyond the precision Decimal(20,6) can represent
    anyway).
  - `convertToSqft(value: Decimal, unit: AreaUnit): Decimal` — exact
    Decimal multiplication for the four integer-factor units; SQM uses
    the documented constant.
  - `formatArea(sqft: Decimal, unit: AreaUnit): string` — display-side
    rounding to 2 decimal places (the norm in Indian real-estate
    collateral).
  - Property-based tests: `formatArea(convertToSqft(v, u), u)`
    round-trips exactly (to the 2-dp display) for every unit including
    SQM (the round-trip cancels the irrational factor because the same
    constant is used in both directions).

**Bigha deliberately not shipped.** Regional bigha values (UP-bigha =
27,225 sqft, Punjabi-bigha = 43,560 sqft, Bengali-bigha = 14,400 sqft
and others) mean a single BIGHA enum value would silently corrupt the
20–40% of plot areas whose region uses a different definition, and a
`BIGHA_CUSTOM`-with-per-project-factor buys a knob nobody may use. If
the client's region uses bigha, this comes back as a new enum value
`BIGHA` plus a `Project.bighaSqftOverride: Decimal` — a genuinely
additive change once we know the factor.

**Not doing:** a `BigInt sqmm` canonical, mirroring paise. It buys
integer exactness for every conversion but hands every UI a 13-digit
number to divide, and no ledger-style operation happens on areas. The
Money discipline exists for a reason; misapplying it here is cost with
no matching benefit.

## 7. Pricing — store rate AS ENTERED, store area AS ENTERED, verify server-side

### 7.0 Why the earlier approach was wrong

Revision 1 stored `baseRatePaise` as "rate per sqft, always" and computed
`baseAmountPaise = ratePaise × landAreaSqft`. For farmland priced per
acre, that intermediate per-sqft representation rounds:

- ₹5,00,000/acre = 50,000,000 paise/acre.
- Normalised to paise/sqft: `floor(50,000,000 ÷ 43,560) = 1,147`
  paise/sqft. (The exact value is 1,147.842…, unrepresentable in
  paise.)
- Round-tripped back for 1 acre: 1,147 × 43,560 = 49,963,320 paise
  = ₹4,99,633.20.
- **Loss: ₹366.80 per acre.** ₹73,360 on a 200-acre township.
- Worse: the number the seller quoted the buyer ("₹5,00,000/acre") is
  no longer the number the booking records — a real problem when the
  customer asks why their receipt does not match the quote.

Revision 2 fixed the rate side (store per-rateUnit) but still routed
area through a sqft canonical: `areaInRateUnit = landAreaSqft ÷
sqftPerUnit[rateUnit]`. For the four integer-factor units the division
is exact (`43,560 sqft ÷ 43,560 = 1 acre` exactly), so the fix caught
the acre case — but the sqft canonical is itself rounded when the
entered unit is sqm (10.7639… sqft/sqm), which reintroduces the same
class of drift for a per-sqm-priced plot. Documented as an accepted
limitation. That was the wrong choice.

### 7.1 The design: store what the client entered, twice

For LAND_BASED units, store BOTH pieces of the pricing pipeline
in the unit the client typed them in:

- `Unit.baseRatePaise: BigInt` — paise per `Unit.rateUnit`
- `Unit.rateUnit: AreaUnit`
- `Unit.landAreaEntered: Decimal(20, 6)` — the numeric value the
  client typed
- `Unit.landAreaEnteredUnit: AreaUnit` — the unit picker's value
- `Unit.landAreaSqft: Decimal(20, 6)` — DERIVED at write time from
  the two above via the shared `convertToSqft` helper. Invariant
  enforced by the unit create/update service: `landAreaSqft ===
  convertToSqft(landAreaEntered, landAreaEnteredUnit)`.

`landAreaSqft` stays because reports, availability filters, area-sorted
listings and the "total plotted area" rollup all pivot on a single
comparable value. It is a projection of the source-of-truth pair, not
the source of truth itself.

`landAreaDisplayUnit` from revision 2 goes away. The entered unit IS the
natural display unit; keeping a separate display column invites drift
between "what we quote" and "what we show".

### 7.2 The pricing formula

```
if rateUnit == landAreaEnteredUnit:
    baseAmountPaise = round( ratePaise × landAreaEntered )
else:
    # Convert entered area to rate's unit basis, using EXACT rational
    # factors for integer-factor units.
    ratio           = Decimal(sqftPerUnit[enteredUnit]) / Decimal(sqftPerUnit[rateUnit])
    areaInRateUnit  = landAreaEntered × ratio
    baseAmountPaise = round( ratePaise × areaInRateUnit )
```

The common case — client entered `0.372 acre` and priced at `₹5,00,000
per acre` — hits the first branch. Multiplication only, no division,
one final rounding paise → BigInt. Exact for **every** unit including
sqm, because sqm never enters the arithmetic.

The uncommon cross-unit case (e.g. plot entered as sqyd, priced per
acre) hits the second branch, where the ratio is exact for any pair
drawn from the four integer-factor units (`9 / 43,560`, `1,089 /
43,560`, etc.). If either the rate unit or the entered unit is sqm,
the ratio rounds — the one narrow condition, documented in the code,
and one nobody hits by entering and pricing in the same unit.

### 7.3 Proof: 0.372-acre plot at ₹5,00,000/acre

Entered: `landAreaEntered = 0.372`, `landAreaEnteredUnit = ACRE`.
Priced: `ratePaise = 50,000,000`, `rateUnit = ACRE`.

`rateUnit == landAreaEnteredUnit`, so:

```
baseAmountPaise = 50,000,000 × 0.372 = 18,600,000 paise = ₹1,86,000.00
```

Exact. The number the seller quoted (`₹5,00,000/acre × 0.372 acre =
₹1,86,000`) is the number the booking records.

Round-trip: `18,600,000 ÷ 0.372 ÷ 100 = 5,00,000` — exact recovery of
the rate.

### 7.4 Server-side recomputation (defence against the ledger trusting client math)

Today, the client computes `baseAmountPaise` in the booking wizard and
submits it. `BookingService.createBooking` writes what it receives into
an append-only ledger. That trust was already thin for HIGH_RISE
(integer rate × integer area, JS handles it) and is a real risk for
LAND_BASED (Decimal areas, per-acre rates in the tens of millions of
paise, JS number precision runs out at 2⁵³).

**Add a pre-verifier UPSTREAM of `BookingService`.** New service
`BookingCostLineVerifier` in `apps/api/src/postsales/`, called by
`BookingController.create` **before** it calls `BookingService.createBooking`:

- Loads the target Unit's `baseRatePaise`, `rateUnit`, `landAreaEntered`,
  `landAreaEnteredUnit` (or, for HIGH_RISE, whichever configured area
  the project prices on).
- For each BASE cost line in the DTO, recomputes the expected
  `baseAmountPaise` using §7.2's formula via the shared helper.
- Compares against the submitted `baseAmountPaise`. If they differ by
  more than 1 paise (the largest-remainder allocation slack that
  already exists in the codebase's Money utility), reject the whole
  request with a specific 400 that names the line and both amounts.
- For PLC lines: verifies against `UnitPlc.amountPaise` (already
  snapshotted at assignment — see `unit-pricing.service.ts`).
- For OTHER / PARKING / CLUB / MAINTENANCE: pass-through today, since
  those are ad-hoc and not derivable from the Unit. If the client
  reveals a rule for any of these, it becomes a follow-up.

**Why not inside `BookingService`?** The frozen contract is *"given
valid cost lines, produce a ledger"*. Verifying that cost lines match
the source-of-truth rate × area is a PRE-condition check on inputs, not
part of ledger production. Putting it upstream in the controller path
keeps the frozen service byte-identical (except the one place-of-supply
line called out in §10) and keeps the verifier freely testable in
isolation. If a future change needs a different verification rule, it
edits the verifier, not the ledger service.

**Why not a Zod refinement on the DTO?** Zod refinements would need to
open a Prisma transaction to look up the Unit — that's beyond what the
DTO layer does elsewhere in this codebase, and it would run on every
request even when the verifier's answer is cached from a preflight.
Service in the controller path is the established pattern (mirrors how
the receipt entry flow works).

### 7.5 Adapting to shape

**HIGH_RISE (semantics unchanged, storage now explicit):**
- `Unit.baseRatePaise` — paise/sqft (same as before).
- `Unit.rateUnit` — always `SQFT`.
- HIGH_RISE units do not populate `landAreaEntered` /
  `landAreaEnteredUnit` — those columns are LAND_BASED-only and stay
  null. Booking wizard: same math, same DTO shape.

**LAND_BASED:**
- `Unit.baseRatePaise` — paise per `Unit.rateUnit` (typically ACRE for
  farmland, SQYD for urban plots).
- `Unit.rateUnit` — whatever the client entered.
- `Unit.landAreaEntered` / `landAreaEnteredUnit` — the area value and
  unit the client typed. `landAreaSqft` derived from them at write.
- Booking wizard: constructs the same DTO shape; the frontend uses the
  shared `AreaUnit` module to compute `baseAmountPaise` client-side for
  the preview, and the server verifier is the authoritative check.

**Farmhouse-shaped units with both land and built area:** wizard
produces **two BASE-family cost lines** —
`{ kind: BASE, label: "Land — 0.5 acre × ₹5,00,000/acre" }` and
`{ kind: OTHER, label: "Covered structure — 1800 sqft × ₹2,500/sqft" }`.
No new `CostLineKind` enum value — the existing OTHER is exactly what
it is for. The verifier recomputes both against the Unit's stored land
area, built-up area, and separate rate fields (see below).

**Farmhouse rates need two rate columns on Unit.** Added in §5.2's spec
as a follow-up detail: `Unit.builtUpRatePaise` (paise/sqft, for the
built portion) alongside `baseRatePaise` (per land unit). Null on
plots-only and on apartments. This IS a schema addition — noted here so
it doesn't slip past the schema review. If the client's farmhouse
pricing is actually a single combined rate, the column drops.

**Rate revisions:** `UnitRateRevision.rateUnit` mirrors the Unit's rate
unit. Rate history displays with the appropriate label; comparisons
across revisions with different units convert both sides to a canonical
per-sqft display for the trend chart only.

**PLC:**
- Existing PLC types (`corner`, `park-facing`, ...) work as-is for
  LAND_BASED — they are already master rows.
- Client will likely want new PLC types for plots (`main-road-facing`,
  `two-side-open`). These are master rows an admin adds, not schema.
- PLC AMOUNTS come from `UnitPlc.amountPaise` — a BigInt. The
  computation ("2% of base rate" for a percentage PLC) already lives in
  `unit-pricing.service.ts`. Note the interaction: a percentage PLC
  needs to know "percent of WHAT" — today it's percent of base rate ×
  area. When rate is stored per-acre and PLC is percentage, the
  snapshot logic in unit-pricing.service.ts also needs to know the
  rate/area interpretation. Called out as a specific test case in §11.

## 8. API surface changes

Additive, no breaking changes to existing endpoints. Existing HIGH_RISE
flows keep their contract byte-identical.

**New endpoints:**
- `GET/POST /projects/:id/inventory-groups` — list/create SECTOR/BLOCK/CLUSTER.
- `PATCH/DELETE /inventory-groups/:id` — edit/deactivate.
- `POST /projects/:id/units/land-based` — sibling to the existing unit
  bulk-generate; takes a land-based DTO instead of a floor-based one.
  A distinct route rather than a switch on the existing one to keep DTO
  validation clean.

**Changed validation (conditional, gated on `Project.shape`):**
- `POST /projects/:id/towers` — 400 if shape is LAND_BASED. "This
  project is a LAND_BASED project. Towers/floors are for HIGH_RISE
  projects. Use POST /projects/:id/inventory-groups instead."
- `POST /projects/:id/towers/:towerId/floors/:floorId/units` — the
  existing floor-scoped unit creation — 400 if shape is LAND_BASED (same
  message).
- `POST /projects/:id/units/land-based` — 400 if shape is HIGH_RISE.
- Unit update: if the update sets `floorId`, the project must be
  HIGH_RISE; if it sets `inventoryGroupId` or `landAreaSqft`, LAND_BASED.

**New response fields (unconditional, nullable except where noted):**
- `Project.shape` (NOT NULL, defaults HIGH_RISE) and
  `Project.landAreaDefaultUnit`.
- `Unit.projectId` (NOT NULL after backfill), `Unit.shape` (NOT NULL
  after backfill), `Unit.rateUnit` (NOT NULL after backfill, default
  SQFT), `Unit.inventoryGroupId`, `Unit.landAreaEntered`,
  `Unit.landAreaEnteredUnit`, `Unit.landAreaSqft` (derived),
  `Unit.landRecordRef`, `Unit.facing`, `Unit.lengthFeet`,
  `Unit.breadthFeet`, `Unit.builtUpRatePaise`.
- `Unit.floorId`, `Unit.floor` — become nullable in the API type.
  **Frontend clients must handle null**; the existing apps/web is under
  our control (Phase C) but any external client (unlikely today, but the
  webhook payload includes a Unit shape via CommunicationLog) sees a
  type change. Called out in the changelog.

**New service in the controller path (upstream of BookingService):**
- `BookingCostLineVerifier.verifyForCreate(companyId, unitId, costLines)`
  — computes the expected `baseAmountPaise` per line from the Unit's
  stored rate, rateUnit, area and PLC snapshots, and rejects the
  request with a 400 if any submitted line differs by more than 1
  paise. Called from `BookingController.create` BEFORE
  `BookingService.createBooking`. Not touching the frozen service — the
  verifier's whole job is precondition validation on inputs. See §7.1
  for the argument.

**No changes to:** Booking create/get/list, receipts, cheques,
installments, ledger, refunds, cancellations, transfers, commissions,
NOC, TDS, letter templates, dispatch, communications, followups,
inquiries, applicants, roles/permissions, portal auth.

**Permission surface — audit result:** every existing permission that
references inventory (`inventory.tower.*`, `inventory.unit.*`,
`inventory.rate.*`, `inventory.upload.*`) is Unit-scoped or
Tower/Floor-scoped. Tower/Floor-scoped permissions become no-ops for
LAND_BASED projects (nothing to grant them over), which is fine — the
grant remains, the UI does not offer the action. **New permissions:**
- `inventory.inventory-group.manage` — create/edit/deactivate Sector/
  Block/Cluster on LAND_BASED projects. Assigned to `company_admin` and
  `sales_manager` (mirrors `inventory.tower.manage`).
- No new READ permission — Unit read already covers groups via the
  Unit-list response.

## 9. UI: which screens fork by shape, which stay shared

**Shared — no fork:**
- Project list, project detail top-of-page (name/code/RERA/GST etc.).
- Applicant list/detail, inquiry list/detail, follow-ups, tickets.
- Booking list, booking detail, receipt entry, cheque queue, dues
  dashboard, applicant 360, reports (see §9.1 for what changes inside
  them).
- Broker screens, commission screens, NOC screens.
- Every admin screen (users, roles, masters, custom fields, letter
  templates, plugins, webhooks).
- Portal profile, portal security, portal support, portal broker
  dashboard/NOC/documents.

**Forked by shape:**
- **Project → Inventory management** (project detail's inner tabs). Two
  layouts:
  - HIGH_RISE: current UI — Tower list, per-tower floor list, per-floor
    unit list, bulk-generate, rate revision multi-select.
  - LAND_BASED: InventoryGroup list (or "all units" if the project uses
    no groups), per-group unit list with LAND_BASED columns (land area,
    facing, land record ref), bulk-import (existing XLSX import gets a
    LAND_BASED template).
- **Unit form / unit detail.** Different fields visible. Same page
  component with a conditional field block, not two separate pages —
  the URL and permission gating are identical.
- **Booking wizard, unit-selection step.** HIGH_RISE picks project →
  tower → floor → unit. LAND_BASED picks project → (optional group) →
  unit. Steps after unit selection (applicant, plan, confirm) are
  identical, because everything downstream of "which unit" doesn't
  branch on shape.

**Portal — see §12 for the customer-visible change specifically.**

### 9.1 Reports and availability

Reports today lean heavily on the `floor.tower.projectId` traversal —
grep counts **35 coupling sites** across `apps/api/src/inventory` and
`apps/api/src/reports`. These break for LAND_BASED units (floor is
null).

**The systemic fix**, done once and reused: every report query that
today reads `where: { floor: { tower: { projectId } } }` becomes
`where: { projectId }` using the new `Unit.projectId` scalar. This is
strictly a routing simplification — the answer is the same. Applied
uniformly across `postsales-reports.service.ts`, `broker-reports.service.ts`,
`presales/reports.service.ts` where they resolve unit → project.

**Availability views:**
- HIGH_RISE tower/floor pivot survives (real HIGH_RISE users want it).
- LAND_BASED needs a flat unit list with an optional group filter and
  a status filter. This is a genuinely new view; adding "grouped by
  Sector/Block" as a secondary tab is a follow-up, not a shipping
  blocker.
- The "Units sold vs available" summary report today groups by
  project — LAND_BASED slots into it with no change.

**Post-sales reports (collection, dues, ageing, GST rollups) do not
change.** They already project through Booking; the `floor.tower`
traversal in their `where` clauses is only used for project filtering,
which becomes `where: { projectId }` per above.

## 10. What is NOT changing in the financial core

Enumerated so a reviewer can confirm at a glance and, later, a bisect
can trust it.

**Services untouched (no signature change, no body change):**
- `BookingService` — except one line: the place-of-supply lookup walks
  `unit.project.areaLocation` via the new scalar instead of
  `unit.floor.tower.project.areaLocation`. Semantics identical (both
  resolve the same Project). Everything else in the service —
  cost-line loop, GST split, TDS receivable, unit-status transitions,
  event emission — byte-identical.
- **New: `BookingCostLineVerifier` sits UPSTREAM of `BookingService`**,
  called by `BookingController.create` before the service call. Its
  addition does not touch `BookingService`. The reason "verify cost
  lines against unit rate × area" is a precondition on inputs, not
  ledger production; see §7.1 for the full argument.
- `PaymentPlanService`
- `ReceiptService`
- `InterestService`
- `TransferService`
- `CancellationService`
- `RefundService`
- `ExtraChargeService`
- `LedgerService`
- `NumberSequenceService`
- `CommissionService`, `CommissionPaymentService`
- `NocService`
- `TdsService` (194-IA on receipts, 194-H on commission payments)
- `DispatchService`, `DocumentService`
- `PortalAuthService`, `TokenService`

**Models untouched:**
- `Booking` (except: it will now receive a Unit with `floorId=null` in
  the include — Prisma handles nullable optional relations natively; no
  schema or DTO change on Booking itself)
- `BookingCostLine`, `CostLineKind` enum
- `PaymentPlan`, `PaymentPlanMilestone`, `PaymentPlanTemplate`
- `Installment`
- `LedgerEntry`, `LedgerEntryType` enum, `LedgerAllocationType` enum
- `Receipt`, `ReceiptAllocation`, `ChequeStatusEvent`
- `Refund`, `PaymentVoucher`, `Cancellation`, `Transfer`
- `ExtraCharge`, `InterestAccrual`
- `TdsDeduction`, `TdsCertificate`
- `BrokerBookingCommission`, `CommissionLedgerEntry`, `CommissionPayment`
- `BrokerNoc`

**Enforcement mechanisms untouched:**
- The `forbid_financial_mutation` PL/pgSQL trigger and its GUC escape
  hatch.
- The `withTenantTx` / `runWithTenant` ambient tenant context.
- The append-only-by-discipline rules on dispatch and audit rows.
- The property-based ledger test (`postsales-property.test.ts`).

**Property-based ledger test still passes untouched.** The test builds a
booking against a Unit and drives receipts/reversals/waivers through it.
The Unit's shape does not affect any of that. Verified structurally by
the equivalence test in §11.2, but the pre-existing property test does
not need to change.

## 11. Test plan

### 11.1 Direct-service tests
- `AreaUnit` conversion property test (`packages/shared`): round-trip
  every enum value through `convertToSqft → formatArea` and back within
  0.01 tolerance (the 2-decimal-place display precision).
- `Project.shape` invariants: rejecting a Tower create on LAND_BASED,
  rejecting an InventoryGroup on HIGH_RISE, rejecting a Unit with both
  `floorId` and `inventoryGroupId`, rejecting a `floorId` update onto a
  LAND_BASED unit.
- **Rate-storage exactness (the specific tests the reviewer asked for):**
  - `perAcreRoundsTripsExactly`: create a LAND_BASED unit with
    `landAreaEntered=0.372, landAreaEnteredUnit=ACRE`, priced at
    ₹5,00,000/acre; assert `computeExpectedBaseAmount()` returns
    exactly `18_600_000n` paise (₹1,86,000.00). Invert: divide by
    landAreaEntered and by 100 (paise → rupees), assert recovered
    rate = ₹5,00,000 with zero drift. **This test is what catches a
    regression to per-sqft normalisation on its own** — a
    reintroduced sqft intermediate makes the result 18,586,355 paise,
    not 18,600,000, and the assertion fails. No hardcoded gap
    constant needed; the exact-equality check does the work.
  - `perAcreMatchesQuote`: for a rate of ₹5,00,000/acre, the
    verifier's `computeExpectedBaseAmount()` for whole-integer acre
    counts (1, 5, 10, 200) returns exactly `ratePaise × acreCount`,
    with no floor/round anywhere in the chain.
  - `perSqmExactWhenMatched`: a plot with `landAreaEntered=500,
    landAreaEnteredUnit=SQM`, priced at ₹3,000/sqm. Assert the result
    is exactly `500 × 300_000 = 150_000_000n` paise. This is the case
    revision 2's design would have rounded (sqm through the sqft
    canonical) and design (a) does not, because rateUnit ==
    enteredUnit routes through flat multiplication with no
    conversion.
  - `crossUnitIntegerFactorsExact`: `landAreaEntered=4840,
    landAreaEnteredUnit=SQYD` (= 1 acre exactly), priced at
    ₹5,00,000/acre. Assert result = `50_000_000n` paise. Proves the
    cross-unit `9/43560` ratio path stays exact when both units are
    integer-factor.
  - `invariantEnforcedOnWrite`: attempt to create a Unit with
    `landAreaEntered=1, landAreaEnteredUnit=ACRE, landAreaSqft=99999`
    (deliberately wrong). Assert the service rejects with a specific
    message naming both values. Proves the derived-column invariant
    is not just documentation.
  - `percentPlcAgainstPerAcreRate`: a 2%-of-base-rate PLC on a
    LAND_BASED unit priced per-acre. Assert the snapshotted
    `UnitPlc.amountPaise` matches `round(baseAmountPaise × 2 ÷ 100)`
    without going through a per-sqft intermediate — the interaction
    §7.5's last paragraph flagged.

### 11.2 Ledger byte-identity (the property the brief explicitly asked for)

The single most important test. Structurally: two projects (one
HIGH_RISE with tower/floor, one LAND_BASED with a group), one unit each
with the same `baseRatePaise`, one applicant reused, an identical
`createBookingDto` (identical cost lines, identical payment plan),
identical receipt sequence, identical bounce, identical reversal.

Property: after stripping every id, timestamp, and human-readable label,
the resulting ledger entries (types, signed amounts, allocations,
cheque status events) are byte-identical between the two bookings.

Written as a hand-rolled equivalence check rather than fast-check
because the property is "these two sequences of operations produce the
same ledger" — one-shot equivalence, not a random-input search. Lives
alongside the existing property test in `postsales-property.test.ts`.

### 11.3 Through-the-wire (supertest)
- `POST /projects/:id/inventory-groups` — happy path, permission gate,
  cross-project (referencing a project of the wrong shape) rejection.
- `POST /projects/:id/units/land-based` — happy path, LAND_BASED-only
  route rejects HIGH_RISE project.
- `POST /projects/:id/towers` — refuses on LAND_BASED with a legible
  message.
- **`POST /bookings` verifier gate:** submit a booking DTO with a
  BASE `baseAmountPaise` deliberately off by 1000 paise from the
  correct rate × area; assert 400 with a message naming the line and
  both amounts. Then submit with an amount off by exactly 1 paise;
  assert 201 (the allowed slack). Then submit the exact amount;
  assert 201.
- Existing routes: regression that a HIGH_RISE project + unit + booking
  still works with a fresh full-suite run.

### 11.4 Playwright
- Create a LAND_BASED project, add an InventoryGroup, create three
  plots with land areas in acre/gunta/sq yd, verify canonical sqft in
  the DB matches the conversion, book a plot end-to-end, verify the
  cost breakup displays land in the project's default unit.
- Regression: the existing `plc-booking.spec.ts` (HIGH_RISE with a PLC)
  still passes.
- Portal side: log in as a customer whose booking is against a plot;
  the Property page renders sensibly (see §12).

### 11.5 CI
No new jobs. `native-upgrade-from-populated` proves the migration lands
against a real populated baseline — the ONE most important CI gate for
this change, and the one that saved us on the `refresh_tokens`
migration recently. Its lock-timeout fix from that decisions-log entry
covers this migration too.

## 12. Portal impact — what the customer sees

Small but visible.

**`apps/portal/src/pages/Property.tsx` today renders literally:**
> `{p.tower.name} · {p.floor.name} · Unit {p.unit.number}`

This is unconditional. For a LAND_BASED unit `tower` and `floor` are
null on the wire (§8) and this line NPEs.

**Change:** Property.tsx renders shape-aware:
- HIGH_RISE: `{p.tower.name} · {p.floor.name} · Unit {p.unit.number}`
  (unchanged).
- LAND_BASED with group: `{p.inventoryGroup.name} · Plot {p.unit.number}`
- LAND_BASED without group: `Plot {p.unit.number}`

Plus, if `landAreaSqft` is present, show it under the header using the
project's default display unit ("0.5 acre" / "1,089 sqft" / etc.). The
existing `carpetAreaSqft` display path stays for HIGH_RISE.

**PortalPropertyService** (`apps/api/src/customer-portal/`) — the
`select`/`include` for the property list needs to gain the new
Unit/Project fields conditionally. Nothing about RLS or scoping
changes — `Booking` → `Unit` remains the sole path a customer reaches
inventory through.

Broker portal statement PDFs reference the Unit by number, not by tower
— no change needed there.

## 13. Risks and rollback

### 13.1 The 35 coupling sites in reports

The most concrete risk in this change. Every one is a `where: { floor:
{ tower: { projectId } } }` traversal that will return no rows for a
LAND_BASED unit unless it moves to `where: { projectId }` via the new
scalar. Missing one silently under-reports LAND_BASED activity, which
is exactly the class of bug the "assert the OUTCOME, not the mechanism"
standing rule warns about.

Mitigation: a Phase A stop-and-verify script that greps the codebase
for `floor: { tower:` inside a `where`, produces the list, and fails
Phase B if any remain. Not an ESLint rule — a one-off migration check.

### 13.2 The check constraint is now exact (upgrade from revision 1)

Revision 1 had a weaker CHECK because `shape` was not on `Unit`. With
the denormalisation in §5.2 (safe because `Project.shape` is immutable
per §13.3), the CHECK is exact: every one of the four invalid
combinations (HIGH_RISE without floor, HIGH_RISE with group, LAND_BASED
with floor, unit with both) is rejected at the row level, before any
application code runs. Application-layer validation stays as
defence-in-depth for a better error message, but the DB is now the
authoritative enforcer.

### 13.3 Shape set wrong, discovered after units exist

The brief specifically asked how to correct this. The honest answer:

**Never allowed via the API.** `Project.shape` is immutable after
creation, enforced in `ProjectService.update`. Reason: even for a
project with only AVAILABLE units, converting HIGH_RISE → LAND_BASED
means orphaning Floor/Tower rows or forcing sqft → land-area
reinterpretation; LAND_BASED → HIGH_RISE means inventing Floor/Tower
data. Neither is safely automatable and both silently corrupt the
inventory if done wrong.

**Correct workflow if shape was set wrong:**
1. Create a new project with the correct shape.
2. If no bookings exist on the wrong-shape project: hard-delete it via
   a documented one-shot admin script (unit_status_changes and any
   inventory rows cascade). Not a UI action; requires an admin
   password confirmation in the script.
3. If bookings exist: mark the wrong-shape project `isActive = false`
   and leave it (its bookings continue through their lifecycle
   correctly — the shape does not affect the ledger). New activity
   goes on the new-shape project.

An explicit `deploy/native/repair-project-shape.sh` script covers case
2, with the same break-glass discipline as `reset-admin-password.sh`.
The script is called out in the changelog as the ONLY supported path.

### 13.4 Migration rollback

`Unit.projectId` is a NOT NULL scalar after backfill. Rollback strategy
if the migration lands but the change is judged wrong:
- Data rollback is nondestructive: drop the new columns and the
  InventoryGroup table; the pre-existing `floor.tower.project` traversal
  still works for HIGH_RISE data.
- Prisma marks the migration reversed via `prisma migrate resolve`.
- The `MIGRATION_LOCK_TIMEOUT` mechanism ensures the DDL either applies
  or aborts fast — it does not leave the DB half-migrated.

### 13.5 Import/export (XLSX)

The existing `import-export.service.ts` handles HIGH_RISE unit import.
LAND_BASED needs its own template (columns for land area, unit, land
record ref, rateUnit, etc.). Moved to Phase C per reviewer — a real
farmland client may want to bulk-import their inventory sheet, and
building that carefully with the client's actual columns in view beats
speculating in Phase B. The initial handful of plots at pilot can be
added through the UI.

## 14. Sequenced implementation, with a hard stop-and-verify

Numbered so a reviewer can approve up to a point and defer the rest.

### Phase A — schema, migration, RLS. STOP AND VERIFY.
1. `InventoryShape` and `AreaUnit` enums, `Project.shape`,
   `Project.landAreaDefaultUnit`.
2. `Unit.projectId` scalar (backfilled, then NOT NULL).
3. `Unit.shape` denormalised copy (backfilled from Project.shape, then
   NOT NULL).
4. `Unit.rateUnit` (backfilled to SQFT for existing rows, then NOT NULL)
   and `UnitRateRevision.rateUnit` (same).
5. `Unit.floorId` → nullable.
6. `Unit.inventoryGroupId`, land fields (`landAreaEntered`,
   `landAreaEnteredUnit`, `landAreaSqft` (derived)), `landRecordRef`,
   `facing`, `lengthFeet`, `breadthFeet`, `builtUpRatePaise`.
7. `InventoryGroup` model + RLS ENABLE + `TENANT_SCOPED_MODELS` entry
   + Phase 3-style policy loop.
8. CHECK constraint on `units` (exact form using `shape`; added AFTER
   the backfill).
9. Backfill script (ordered UPDATEs, per §5.5).
10. `AreaUnit` module in `packages/shared` with property tests.

**Stop point.** Deploy A to the VM. Verify:
- Existing project/booking data is byte-identical (a spot-check of
  cost-line rows on a real booking before and after).
- All existing tests pass unchanged.
- `Unit.projectId` populated on every existing row.
- `native-upgrade-from-populated` CI job green.
- RLS: a raw connection cannot see another company's inventory groups.

**Do not proceed to Phase B until every one of the above is green.**

### Phase B — API surface, service edits.
1. The one-line edit inside `BookingService.createBooking` to walk
   `unit.project.areaLocation` instead of `unit.floor.tower.project.
   areaLocation`. **Ledger equivalence test (§11.2) must be added and
   passing before this commit merges.**
2. New `BookingCostLineVerifier` in `apps/api/src/postsales/`, wired
   into `BookingController.create` UPSTREAM of `BookingService`. Tests
   from §11.3 (verifier gate) are the merge gate for this commit.
3. Conditional validation on Tower/Floor/Unit create endpoints.
4. New endpoints: `GET/POST /projects/:id/inventory-groups`,
   `POST /projects/:id/units/land-based`, `PATCH`/`DELETE` for groups.
5. The 35 report-coupling sites' traversal update, ONE PR reviewable
   independently.
6. Portal `Property` service — expose the new fields.
7. `ADMIN_TEAM_SCOPE_ALL`-style backfill for
   `inventory.inventory-group.manage` in `sync-permissions.ts` (grants
   to company_admin/sales_manager only — the "sync only what has
   changed for the seeded roles" pattern the recent Decisions log
   documents).
8. Full backend suite green. Full Playwright suite green including
   HIGH_RISE regression.

### Phase C — UI, staff app.
1. Project create wizard: shape picker (HIGH_RISE default), land-area
   default unit (only if LAND_BASED).
2. Project detail: shape-conditional inventory tab (Towers vs.
   InventoryGroups).
3. Unit form: shape-conditional field block (including `rateUnit`
   picker for LAND_BASED units).
4. Booking wizard: shape-conditional unit-selection step; wizard
   preview uses the shared `AreaUnit` module to compute
   `baseAmountPaise` client-side, with the server verifier as the
   authoritative check on submit.
5. Reports: no fork visible to the user; the backend edits in B5
   handle it.
6. Availability: LAND_BASED flat list with group filter.
7. **LAND_BASED XLSX import** — template built against the client's
   own inventory sheet so column choice is grounded in real data
   rather than speculation. Moved here from Phase B per reviewer.
8. Playwright: LAND_BASED end-to-end booking scenario.

### Phase D — Portal.
1. Property.tsx shape-conditional rendering.
2. Land area display on Property.tsx.
3. Playwright: customer of a LAND_BASED booking sees the right page.

### Phase E — Deploy, client walkthrough.
1. Deploy to the VM.
2. Real-browser walkthrough on the VM: create a LAND_BASED project end
   to end, book a plot, generate a receipt, cancel the booking.
3. Ship to the pilot client with docs on the LAND_BASED unit import
   template.

---

## Explicit open questions to close before Phase B

Resolved in review, retained here for the audit trail:

- ~~Confirm the 2-shape recommendation.~~ Approved. §3.2.
- ~~Confirm `shape` (not `projectType`) as the field name and the
  distinct-enum-vs-master-column resolution.~~ Approved with the
  denormalised copy on Unit for the check constraint. §3.1, §5.2.
- ~~XLSX import in B or C?~~ Deferred to Phase C, built against the
  client's real inventory sheet. §14.
- ~~Bigha handling.~~ Dropped for now; comes back as a new enum value
  only if the client's region uses it. §6.
- ~~`Project.shape` truly immutable after creation?~~ Confirmed;
  §13.3 is the accepted answer, and it is what unlocks the denormalised
  copy on Unit.
- ~~Storing rate per-sqft was lossy.~~ Fixed in revision 2: store rate
  AS ENTERED with `Unit.rateUnit`, verify server-side, single rounding
  at the very end of the pipeline. §7.

Still open — client input required before Phase B:

1. **Which area units does the client actually use?** SQFT, SQYD, SQM,
   ACRE, GUNTA ship. Bigha absent by design; comes back if needed.
   Answers whether Phase B ships all five or a subset.
2. **Which land-record identifier vocabulary?** Field is generic text
   (`landRecordRef`); the per-project LABEL config waits on this.
3. **Farmhouse pricing model — single combined rate or land + structure
   separate?** Determines whether `Unit.builtUpRatePaise` (§5.2, §7.2)
   ships at all.
4. **Land-use classification vocabulary.** Master-table content, not
   schema. Blocking for the client's real inventory only, not for
   Phase A.
5. **Do they use Sector/Block/Cluster grouping at all?** If flat plot
   list, we skip building the group-picker UI in Phase C.
