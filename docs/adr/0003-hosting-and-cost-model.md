# ADR-0003: Cost the hosting candidates per 1,000 concurrent players and escalate the choice

- **Status:** **Accepted as to the choice; suspended as to the spend.** The board answered on
  [PER-2](/PER/issues/PER-2) on 2026-09-30: **Fly.io for M0–M5**, budget **phased $120/month now
  → $250/month at M5** under a standing **$400/month ceiling**, regions **deferred to M5** with
  interim environments to sit as close to India as the provider allows (§5.5b). **M6 remains
  board-gated and is explicitly not settled by this ADR** (§7c). **Later the same day the board
  held all provisioning and put everything back on free tiers** — the authority in §12 is
  ratified but **may not be exercised**, and **§8 is the operative topology again** (rev 4,
  §13). **The hold permits free-tier signups** that need no payment card, and **returns to the
  board at M3** (rev 5, §8.7, §13.5). **The hold has exactly one carved exception**: a
  pre-existing, board-created **Cloudflare** connection may be used for a **free Cloudflare Pages
  staging deploy of `apps/web` only** — every other clause and every other provider is unchanged
  (rev 6, §13.7).
- **Date:** 2026-09-30
- **Amended:** 2026-09-30 (**rev 2**) — the board set the infrastructure budget to **$0**, and
  [ADR-0001](./0001-v1-stack.md) rev 2 withdrew the `noeviction` disqualifier. **§5.1, §7, §8
  and §10 changed materially and §0 and §11 are new.** See
  [What changed in rev 2](#what-changed-in-rev-2).
- **Amended:** 2026-09-30 (**rev 3**) — the board reversed $0 and approved **Fly.io at $120/month
  phased to $250 at M5**. Verifying the board's Mumbai instruction turned up a fact that voids its
  premise: **Fly has no India region — `bom` was removed from the product on 2026-09-25.** New
  **§5.5b** and **§12**; §0, §3.6, §4, §7a, §7c, §10 and §11.3 changed materially. See
  [What changed in rev 3](#what-changed-in-rev-3).
- **Amended:** 2026-09-30 (**rev 4**) — the board **held all provisioning and returned everything
  to free tiers**, hours after approving the spend. The provider choice survives; the permission
  to spend does not. **§8 becomes operative again, §7 and §12 become authorised-but-dormant, and
  the approved $8 capacity test cannot run.** New **§8.7**, **§13** and **§13.6** — the last
  recording that adopting Colyseus and holding provisioning jointly remove the only always-on $0
  option, so M3 does not rediscover it. The Status line, §7, §8, §8.4 and §12 changed materially.
  See [What changed in rev 4](#what-changed-in-rev-4).
- **Amended:** 2026-09-30 (**rev 5**) — the board answered the two questions rev 4 left open.
  **§8.7 resolves to reading A: free-tier signups are permitted** — no card, no paid tier, no
  trial — so §8.1's topology may actually be stood up and **three of M0's five acceptance criteria
  become reachable rather than conditional**. **M3 is confirmed as the point at which the hold
  returns to the board**, recorded as a standing instruction on the M3 epic
  ([PER-29](/PER/issues/PER-29)). §8.6, §8.7, §10.4, §13.5 and §13.6 changed; nothing about the
  provider, the arithmetic or the dormancy of §12 moved. See
  [What changed in rev 5](#what-changed-in-rev-5). Rev 5 also corrects **a defect of my own in
  §11.1**: this ADR carried two different costs for per-PR previews — a stale rev-2-era
  ~$25/month and §12.2's costed $8.78/month — and the wrong one reached the board's M0 sign-off
  minute. **$8.78 is correct**, and the cheaper design still satisfies AC1b. No board action
  changes.
- **Amended:** 2026-09-30 (**rev 6**) — **this ADR asserted something factually untrue, and the
  untrue sentence was the premise the hold was justified on.** §12.3 and the hold's summary said
  there is "no vendor account … on any provider". There is: the board connected **Cloudflare on
  29 Sep**, the morning before it set the hold on 30 Sep. Rather than correct it silently — the
  sentence carries a decision, and narrowing or widening the hold is not mine to do — it went back
  to the board, which answered at **07:32Z: verify the connection is live, then use it for a free
  web staging link.** So the hold now has **exactly one carved exception**, recorded in new
  **§13.7**. §8.7, §12.3 and §9's owed-measurement note changed; the Status line, §7's rev-4 note
  and §13.1's timeline were corrected. **Nothing about the provider, the envelope, the arithmetic
  or the dormancy of §12 moved, and this is not a provider change.** See
  [What changed in rev 6](#what-changed-in-rev-6).
- **Amended:** 2026-09-30 (**rev 7**) — the [PER-84](/PER/issues/PER-84) review of this ADR found
  **eight defects in the derivations and none in the conclusions**, and rev 7 is those fixes.
  Two of them were wrong in a direction that matters: **§4's Hetzner real-time egress was stated
  as $0 EU directly above a derivation computing $52.75** (so the M6 cost floor every other
  provider is measured against was understated — **$105–128, not $52–128**), and **§8.3/§11.1
  priced a Fly Machine ~45% above both §12.2 and Fly's own list price**, which is the number
  §13.5 sends into the M3 ask. **No provider, envelope, board answer or constraint verdict
  changed.** See [What changed in rev 7](#what-changed-in-rev-7).
- **Author:** CTO
- **Milestone:** M0 (M6 sizing is projection only)
- **Issue:** [PER-38](/PER/issues/PER-38) (epic [PER-3](/PER/issues/PER-3))
- **Supersedes nothing.** Discharges the hosting question deferred by
  [ADR-0001](./0001-v1-stack.md) §Context and escalated as open question 2 of that ADR.

## Context

Three of the five acceptance criteria on the M0 epic ([PER-3](/PER/issues/PER-3)) — a working
preview deploy per PR (AC1), a WebSocket round trip on staging (AC2), and a staging link for
the board (AC5) — all need somewhere to run. Picking where is a **board-gated** decision: it
names a vendor and it costs money. The board cannot make it without a cost per 1,000
concurrent players, and until [PER-38](/PER/issues/PER-38) no issue produced that number.

The awkward part is that we are pricing **two workloads that do not price alike**:

| Workload                    | Scale target                                           | Cost is dominated by                                 |
| --------------------------- | ------------------------------------------------------ | ---------------------------------------------------- |
| Turn-based (M1–M5, real)    | 2,000 concurrent rooms on one instance                 | a **fixed floor**: instance count + Redis + Postgres |
| Real-time (M6, sizing only) | 30 Hz tick, 12-player rooms, < 30 KB/s down per client | **egress**, then dedicated CPU per room              |

Costing only the first would understate the real-time bill by two orders of magnitude on some
providers. Costing only the second would tell the board to buy a machine shop to make a
teaspoon. Both are below.

This ADR **records a recommendation with numbers. It does not pick a provider.** The choice
and the budget go to the board on [PER-2](/PER/issues/PER-2). Nothing here authorises a
signup, and no paid tier has been signed up for.

### What changed in rev 2 {#what-changed-in-rev-2}

Rev 1 was written before three inputs landed. All three arrived within an hour of each other
on 2026-09-30, and two of them change conclusions rather than wording.

| Input                                                                            | Effect on this ADR                                                                                                                                                                                                                                              |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **The board set the infrastructure budget to $0** ([PER-2](/PER/issues/PER-2))   | §7's recommendation becomes **conditional on a budget existing**. The operative section at $0 is §8, which is rewritten as a topology with ceilings. §10 stops asking for $250/month. §11 is new.                                                               |
| **`noeviction` withdrawn as a gate** ([ADR-0001](./0001-v1-stack.md) rev 2 §6.1) | §5.1's five-provider pass/fail table stops being an eliminator. **Upstash is re-admitted.** The replacement constraint — Postgres durability and a ≤ 10 ms p95 log append — is costed in §5.1b, and **the free-tier topology fails it**, which §11.3 escalates. |
| **Always-on WebSocket flag from M0.4** ([PER-7](/PER/issues/PER-7))              | New §8.3 prices the cheapest correct always-on process per environment. It is the smallest of the three asks in §11 and the most urgent.                                                                                                                        |

Rev 1's §2, §3, §4, §6 and §9 are unchanged: the arithmetic did not move, only the durability
model and the budget did.

**This ADR does not depend on the outcome of [approval 15587c20](/PER/approvals/15587c20-53fb-499e-9b53-4718df50a5df)**
(Colyseus vs. an in-house `RoomRunner`, [ADR-0001](./0001-v1-stack.md) §4.4). Both answers
produce the same fleet shape — a long-lived Node process per room shard, addressed by room id —
so §4's sizing and §5.4's routing constraint hold either way. The only line either answer moves
is memory per room (I9), and §9's sensitivity table already carries it.

### What changed in rev 3 {#what-changed-in-rev-3}

The board answered on 2026-09-30. Rev 3 records the answer, and corrects one thing the answer
assumed.

| Input                                                                                      | Effect on this ADR                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Board reversed $0 and approved Fly.io for M0–M5**                                        | §7 stops being hypothetical and §8 stops being operative. Status moves to **Accepted**. §10 is rewritten as a record of the decision rather than a request.                         |
| **Budget phased: $120/month now, $250/month at M5, $400 ceiling**                          | Rev 2's $6–7/month ask is superseded. New **§12** answers the board's floor question with line items: the real floor is **≈ $60/month**, so **≈ $60 of the $120 goes unspent**.     |
| **Board instructed: deploy interim environments in Mumbai (`bom`)**                        | **Cannot be complied with. Fly removed the `bom` region on 2026-09-25** (§5.5b). New §5.5b gives the substitute (`sin`) and the latency consequence.                                |
| **Chief of Staff asked me to confirm or correct the ~$153 / ~$9,733 Mumbai re-derivation** | **$153 confirmed exactly; $9,733 confirmed to within rounding — rev 7 carries the exact $9,738. Premise corrected** — Fly prices egress **by destination, not by the Machine's region** (§5.5b), so those are audience numbers, not region numbers. |

**The one finding that voids part of the instruction, stated up front because it changes what
Platform Engineer may provision:** the board's Decision 3 said "deploy the interim environments
in Mumbai (`bom`)" and reasoned that region choice is a lever on cost. On Fly **neither half
holds**. There is no India region to deploy into, and region choice does not move the egress
bill at all, because the rate is set by where the _player_ is. §5.5b has the detail and §12 has
the provisioning instruction that replaces it.

Rev 1's and rev 2's §2, §6 and §9 are unchanged.

### What changed in rev 4 {#what-changed-in-rev-4}

Rev 3 was written against an approval that was withdrawn in practice a few hours later on the
same day. The board's answer to the payment-instrument question was **"hold all provisioning for
now — keep everything on free tiers"**, relayed on [PER-38](/PER/issues/PER-38) as: _"No vendor
account, no card on file, no paid tier, no trial, on any provider — Fly and Hetzner included."_

> **Rev 6: the relayed sentence's "no vendor account … on any provider" clause was a claim of fact,
> and it was false.** A Cloudflare connection already existed, created by the board on 29 Sep. Rev 4
> and rev 5 repeated it as though it described our state. See
> [What changed in rev 6](#what-changed-in-rev-6) and §13.7 — the sentence is kept verbatim here
> because it is a quotation of the instruction, not a statement of our inventory.

**The distinction that keeps this ADR honest is between authority and permission.** The board
ratified the envelope — Fly.io, $120/month stepping to $250 at M5, $400 ceiling, plus the ~$8
capacity test — and separately withheld permission to exercise any of it. Rev 4 does not
un-decide the provider. It records that **every figure in §12 is dormant** and that §8's free
topology is what actually runs.

| Rev 3 said                                                            | Rev 4 says                                                                                                                                                                          |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §7 is operative and approved                                          | §7 is **the standing choice, dormant**. Correct when spend resumes; authorises nothing today.                                                                                       |
| §8 is retained as the fallback, "nothing in §8 should be provisioned" | §8 is **operative again**. It is the topology we run, with §8.5's eight non-proofs in force.                                                                                        |
| §12 is the buy-list; Platform Engineer may provision §12.3            | **§12.3 is withdrawn. Nothing is provisioned.** The buy-list keeps its value as a costed, board-ratified plan that executes on one word from the board.                             |
| Test A (~$8, 48-hour Hetzner capacity window) is approved, run it     | **Test A cannot run.** Hetzner's hourly billing needs a card. The gate was never the money — it was the payment instrument, and $8 approved is $8 unspendable. I9 stays unmeasured. |

**What this costs, recorded rather than absorbed:** the two quantities the entire cost model rests
on — bytes per message and memory per room (I9) — stay unmeasured through at least M2. Every
number in §3, §4 and §12 therefore remains a **budget or a published list price, not a
measurement**. §9 already says so; rev 4 is the point at which that stops being a caveat and
becomes the durable state of the document. Nothing in here should harden into apparent fact by
repetition.

**One conflict inside the instruction, which §8.7 is new to record.** "No vendor account … on any
provider" and "everything stays on the free topology you costed in §8.1" cannot both be complied
with literally: §8.1's topology _is_ four vendor accounts (Cloudflare, Render, Upstash, Neon),
all free, none needing a card. Which reading holds decides whether **three** of M0's five
acceptance criteria are demonstrable or **none** are. That is a board question, not mine, and
§8.7 states it so it is answered once rather than assumed differently by each reader.

**A second conflict, between two board decisions rather than inside one, recorded in §13.6.**
Rejecting the `RoomRunner` amendment adopted **Colyseus**; holding provisioning put us on
free-tier compute. Each is defensible alone, and together they remove the only always-on $0
option in this document — **Cloudflare Durable Objects cannot host Colyseus**, because the
Workers runtime is not Node. So under the hold there is no always-on $0 path: it is Colyseus on
a free tier that sleeps. Recorded, deliberately not solved, so **M3 does not rediscover it**.
§13.6 also answers the timing question: **M3 is the right point to bring the hold back**, unless
§8.7 resolves the wrong way, in which case it is an M0 escalation instead.

### What changed in rev 5 {#what-changed-in-rev-5}

Rev 4 ended with two questions and no answers. Both came back on 2026-09-30 and neither reopens
anything, so rev 5 is a narrow amendment rather than a rewrite.

| Question rev 4 asked                                                           | Answer                                                                                                                                                            |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **§8.7** — does "no vendor account on any provider" forbid a free-tier signup? | **No. Reading A.** Free-tier signups are permitted; no card on file, no paid tier, no trial. §8.1's four accounts may be created.                                 |
| **§13.6** — is M3 the right point to bring the hold back?                      | **Yes, M3**, recorded as a standing instruction on [PER-29](/PER/issues/PER-29). Escalate sooner if the free topology makes something in M1 or M2 _unachievable_. |

**What reading A buys, precisely.** It converts §8's topology from a costed description into
something that can be built: **AC2 (WebSocket round trip on staging), AC5 (a staging link for the
board) and AC1a (a PR runs full CI) are all reachable at $0**, subject to §8.4's cold-start caveat
and §8.5's eight non-proofs. **AC1b is unchanged and still unreachable** — the isolation property
that makes a per-PR preview trustworthy needs spend on every candidate, and spend is held. So M0
goes from two of five criteria reachable to **three of five**, and the caveat in §13.6 that would
have turned the hold into an M0 escalation **does not fire**.

**What it does not buy, and this is worth stating because "signups are permitted" reads more
generously than it is.** A free tier is not a small paid tier. Everything in §8.2 still holds:
Render free's 15-minute spin-down is a **correctness** failure on a room server rather than a
quota, two always-on environments remain arithmetically impossible against a 750 h allowance, and
Upstash free's 500,000 commands/month is roughly 20 concurrent players for two hours a day. Reading
A lets us stand up an environment that is honest about M0. It does not make that environment a
place where any non-functional target, any timer behaviour, or any restart-recovery claim can be
evidenced.

### What changed in rev 6 {#what-changed-in-rev-6}

**Rev 6 exists because this ADR stated a falsehood, and the falsehood was load-bearing.** Rev 4
and rev 5 both restated the hold in the board's own words — _"no vendor account, no card on file,
no paid tier, no trial, on any provider"_ — and §12.3 restated it as a finding of fact about our
current state. It was not a finding of fact. **A Cloudflare connection was created by the board on
29 Sep**, the morning before the hold was set on 30 Sep. That connection existed the whole time
rev 4, rev 5 and `docs/ci-cd.md` were asserting it did not.

This is not a cosmetic error. The hold's entire justification is "we have nothing, so nothing can
be spent by accident". A document that misdescribes what we already have cannot be relied on to
tell anyone what is safe to touch, which is the only job it has.

**Why it went to the board instead of being fixed in place.** The sentence carries a decision, not
just a fact. Three readings were all defensible from the text, and they differ in what an engineer
may do this week:

| Reading                                                               | Consequence                                                                   |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| The Cloudflare connection is **covered** by the hold and dormant      | Nothing changes; the sentence is just imprecise about history.                |
| The Cloudflare connection is **usable**, because no card is involved  | A free `apps/web` staging link becomes available at $0.                       |
| The Cloudflare connection should be **disconnected** to match the doc | The doc becomes true by removing the thing, and M0 loses a $0 staging option. |

Picking one myself would have narrowed or widened the hold on my own reading, which is the board's
call. **The board answered at 2026-09-30 07:32Z: "Verify it is live, then use it for a free web
staging link."** That is the middle reading, and §13.7 records it.

**What rev 6 changes**

| Where           | Change                                                                                                                                                  |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status line     | Names the one carved exception so a reader of the first paragraph is not misled.                                                                        |
| §7 rev-4 note   | "no Fly account, no card, no trial" — scoped to Fly, which is what it always meant and is still true.                                                   |
| **§8.7**        | The relayed sentence's "no vendor account … on any provider" clause is marked as **already factually untrue when it was relayed**, with the correction. |
| §9              | The owed-measurement note gains the provider-labelling rule: a Cloudflare-edge number is not a Fly number, and the Fly figures stay **owed**.           |
| **§12.3**       | The blanket "No Fly account, no card, no trial, on any provider" is replaced by the accurate statement plus the exception.                              |
| §13.1           | The timeline gains the 29 Sep row it was missing — the reason the sentence was wrong is visible in the chronology.                                      |
| **§13.7 (new)** | The exception itself: what it permits, what it does not, and why `apps/realtime` cannot be in it.                                                       |

**What rev 6 does not change, stated because "we may use Cloudflare now" reads more broadly than
it is.** The hold stands in full for every other provider and every other clause: **no new vendor
account, no card, no paid tier, no trial.** **Fly.io remains the ratified M0–M5 provider and is
not provisioned.** §12 stays dormant, §8 stays the operative topology, the M3 revisit
([PER-29](/PER/issues/PER-29)) is unmoved, and **AC1b and AC2b are unchanged**. Execution of the
staging deploy — including verifying the connection is actually live before anything is deployed —
is [PER-111](/PER/issues/PER-111), and the written record is
[PER-112](/PER/issues/PER-112).

> **Rev numbering, so the sequence is not a puzzle later.** A separate rev — the
> [PER-84](/PER/issues/PER-84) review fixes — was drafted before this one and is still open on its
> own branch at the time of writing. It renumbers on rebase. Rev 6 is this correction, because a
> false premise about what the company has provisioned should not wait behind a review-fix
> revision. **It renumbered to rev 7, below.**

### What changed in rev 7 {#what-changed-in-rev-7}

**Rev 7 is the [PER-84](/PER/issues/PER-84) review's findings applied.** The review verdict was
_"merge with the listed edits"_: eight findings, **all of them in derivations, none in a
conclusion**. The reviewer independently re-derived §2.1, §2.2, §3.3, §3.5, §4's AWS tiered-egress
stack, §9's entire sensitivity table and §12.2's three subtotals, and verified §5.5b's two
load-bearing Fly facts (no India region; egress priced by destination) against Fly's live
documentation. Those all stand. What follows is what did not.

| #      | Finding                                                                                                                                                   | Fixed in                             |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| **F2** | **§4 stated Hetzner real-time egress as "0 EU" directly above a derivation computing $52.75.** The M6 floor is **$105–128, not $52–128**.                 | §3.4, §4, §5.7, §0                   |
| **F4** | **§8.3/§11.1 priced a Fly `shared-cpu-1x`/512 MB at $5.52 — ~45% above §12.2 and above Fly's list price**, by double-counting the RAM included with a vCPU. | §8.3, §11.1, §8.6, Consequences      |
| **F1** | §3.1 was **not reproducible from the stated inputs** — it bills 1.5 GB on a "2 GB" machine with the rule unstated. A reader re-deriving it gets $108, not $100, and at the India rate that **inverts §3.6's Fly-vs-Railway conclusion**. | new **I15**, §3.1                    |
| **F3** | Three different values for the same quantity — **$9,733 / $9,737 / $9,738** — and "confirmed to the dollar" was true of $153 and not of this one.        | §0, §4, §5.7, §10.1                  |
| **F8** | §0 carried a **duplicated paragraph** whose first copy is the "~90% fixed" framing §12.1 explicitly withdraws — in the board-facing summary, above its own correction. | §0                                   |
| **F5** | _"None of the four accounts in §8.1 requires a card"_ is **the only sentence guarding a board gate, and it carried no `[unverified]` tag** in a document that tags far less consequential claims. | §8.7, §9                             |
| **F7** | §12.2 is headed "**verified** list prices" but **omits `sin`'s regional multiplier**, which §3.1 establishes ranges 1.0–1.615.                            | §12.2, §13.4, §9                     |
| **F6** | Two rev-4 sentences contradicted rev 5's answer to §8.7.                                                                                                  | **already fixed in revs 5–6**        |

**Two things rev 7 deliberately does not do.**

- **It does not restate the board-approved §11.1 ask.** The board approved "up to $7/month"; the
  corrected floor is **≈ $5/month**, which sits inside that authority. Occurrences of "$6–7/month"
  elsewhere in this document **name the approved ask by its approved figure** and are quotations of
  the record, not live derivations. §8.3 and §11.1 — the derivations — are corrected.
- **It does not re-derive §12.2's unit prices.** They are Fly's own quoted machine prices, and
  I15's rule reproduces them to within 1–6% (§12.2's reconciliation note), which is immaterial
  against a $60 total. What rev 7 adds there is the missing **`sin` multiplier [unverified]**,
  because calling a number "verified" when an input to it is unstated is the one thing this ADR
  asks of everyone else.

---

## 0. Summary for the board {#summary-for-the-board}

> **Rev 4: the decision below stands; the spending does not.** All provisioning is held and
> everything is on free tiers. Read §0 as "what we will do when spend resumes", and §8 as "what
> runs today". The `$` figures are dormant, not active.
>
> **Rev 5: §8 is not only operative, it is now buildable.** Free-tier signups are inside the hold
> (§8.7), so the four accounts in §8.1 may be created — AC2, AC5 and AC1a are reachable at $0,
> AC1b is not. The hold returns to the board at **M3** (§13.5).

**Rev 3: the board has decided.** Fly.io for M0–M5, $120/month now stepping to $250/month at M5
under a $400 ceiling, regions deferred to M5. This section now records the decision and the two
things the board asked back. Everything below is the derivation.

**The three answers the board asked for, first:**

| Board's question                                         | Answer                                                                                                                                                                                                                                                                   |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| _"Confirm or correct my ~$153 / ~$9,733 Mumbai figures"_ | **$153 confirmed exactly ($152.60). $9,733 confirmed to within rounding — the exact figure is $9,737.80, which this ADR now carries as $9,738** (rev 7; the board's $9,733 comes from rounding 78.84 TB to 78.8 TB, and nothing turns on the $5). **Premise corrected.** Fly prices egress by **destination**, so these are the costs of serving an Indian _audience_ from _any_ Fly region — not a Mumbai-region premium we can escape by hosting elsewhere (§5.5b). |
| _"Can prod + staging + previews be bought for $120?"_    | **Yes, comfortably. The floor is ≈ $60/month** (§12), of which previews are ~$9 and staging ~$3. **≈ $60 of the $120 authority goes unspent.** The cheaper shape the board asked about is real, and I am withdrawing my own "~90% fixed" framing that implied otherwise. |
| _"Deploy the interim environments in Mumbai (`bom`)"_    | **Cannot comply — Fly deleted the `bom` region on 2026-09-25** (§5.5b). Substituting **Singapore (`sin`)**, the nearest Fly region to India, at a cost of ~60–90 ms RTT to Mumbai players **[unverified]**. Egress cost is unaffected, for the reason in row 1.          |

**1. Cost per 1,000 concurrent players per month ($/concurrent player-month in brackets).** The
India column is new in rev 3 and is the **live case**, not a contingency: the brief targets an
Indian audience, and on every provider here the rate is set by the player's location.

| Provider                | Turn-based, NA/EU audience |  Turn-based, **India audience** |          Real-time (M6, projection) |       Real-time, **India audience** |
| ----------------------- | -------------------------: | ------------------------------: | ----------------------------------: | ----------------------------------: |
| Hetzner bare VM (floor) |            **$41** (0.041) |     $41 (0.041) — flat transfer |      **$105–128** (0.105–0.128) ¹ | $105–128 — flat, but no India region |
| Hetzner + managed data  |                $62 (0.062) |                     $62 (0.062) |                                   — |                                   — |
| **Fly.io** (chosen)     |           **$100** (0.100) |               **~$153** (0.153) |                   $1,853 **(1.85)** |        **~$9,738 (9.74)** — see §7c |
| Railway                 |               $149 (0.149) |                    ~$149 (flat) |                   $4,267 **(4.27)** |                             ~$4,267 |
| AWS ECS/Fargate         |     $208–336 (0.208–0.336) | ~$261–389 (`ap-south-1` egress) |                   $6,617 **(6.62)** |                             ~$8,646 |
| Render                  |               $225 (0.225) |                    ~$225 (flat) | **$12,022 (12.02) — disqualifying** |                            ~$12,022 |

> ¹ **Rev 7 correction (review finding F2).** Rev 3–6 printed Hetzner's real-time total as
> **$52–128 (0.05–0.13)**, which took egress as $0 in the EU. That contradicted §4's own
> derivation two lines below it: at the 30 KB/s ceiling, 78.84 TB **exceeds** the included EU
> traffic on any figure this ADR states, and §4 computes the overage at **$52.75**. The corrected
> floor is **$105–128**. It matters more than $53 usually would, because **$0.05 per concurrent
> player-month was the cheapest number in this document and the floor every M6 comparison is
> measured against.** Hetzner is still ~14× cheaper than Fly for M6 and §7c's conclusion is
> unchanged.

Turn-based cost at our scale is **~90% a fixed floor _at the 1,000-player instance size_**
(§2.1) — 1,000 concurrent players is a quarter of one instance. **Rev 3 correction: that is not
the same as a fixed floor at zero players**, which is what the board was really asking about.
At zero players you buy a smaller instance, and §12 shows the floor is ≈ $60/month, not $100.
Real-time cost is **dominated by egress** (§4) — 85% of the Fly bill, 96% of the AWS one and
98% of Render's: 30 KB/s × 1,000 clients is **78.8 TB/month**, and the per-GB rate differs
**153×** across the candidate set.

**2. What the $120 buys today** (§12), in the board's stated priority order:

| Priority | Line                                                |    $/month |
| -------- | --------------------------------------------------- | ---------: |
| **1**    | Per-PR preview environments (~20 PRs/mo)            |  **$8.78** |
| **2**    | Staging, always-on WebSocket, autostop when idle    |  **$2.81** |
| **3**    | Minimum production (Managed Postgres, HA + backups) | **$48.38** |
|          | **Total**                                           | **$59.97** |
|          | **Unspent against the $120 authority**              | **$60.03** |

Priorities 1 and 2 — the two the board said must not be crowded out — are together **$11.59**,
under 10% of the authority. There was never a real contest between them and production sizing.

**3. What is still not settled, and it is the expensive one.** §7c: **this ADR does not carry an
M6 recommendation.** Serving an Indian real-time audience on Fly is **~$9.74 per concurrent
player-month**, adjacent to the $12.02 that disqualified Render on arithmetic. The M6 provider
decision is owned by the M4 spike ([PER-30](/PER/issues/PER-30)) and must be priced at India
destination rates. **No M6 spend is approved or requested.**

**The two remaining priced items $120 does not cover**, unchanged from rev 2 and still not
requested: the M5 load test (**$8** capacity / **$100 cap** for the p95 run, §11.2) and an
India-region M6 fleet pilot (**$75/month**, §11.3 — now the _only_ way to put a server in India,
since §5.5b removes Fly as an option there).

---

## 1. Model inputs

Every number downstream is derived from this table. Change a row, re-derive. This is the point
of publishing a model instead of a monthly sticker price.

| #   | Input                                         | Value used                                  | Basis                                                                                       |
| --- | --------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------- |
| I1  | Billing unit                                  | **U = 1,000 concurrent players**            | The unit [PER-38](/PER/issues/PER-38) asks for                                              |
| I2  | Exposure window                               | **U₂₄ = U sustained 24/7 × 730 h**          | Worst case; makes the arithmetic reproducible                                               |
| I3  | Realistic duty cycle (avg ÷ peak concurrency) | **0.27**                                    | **Assumption, not a measurement.** Typical diurnal social-game curve                        |
| I4  | Seats per turn-based room                     | **2**                                       | Chess and tic-tac-toe are both 2-seat                                                       |
| I5  | Actions per room                              | **1 per 5 s**                               | [ADR-0001](./0001-v1-stack.md) §6 capacity model                                            |
| I6  | Fan-out per action                            | **2.5 recipients**                          | 2 seats + spectator allowance ([PER-31](/PER/issues/PER-31))                                |
| I7  | Bytes per delivered turn-based message        | **600 B**                                   | **Measurement owed** — the most sensitive input in §2.1                                     |
| I8  | Presence heartbeat                            | **1 per 10 s**                              | [ADR-0001](./0001-v1-stack.md) §6                                                           |
| I9  | Memory per live turn-based room               | **64 KB**                                   | **Measurement owed** — sets rooms-per-instance                                              |
| I10 | Real-time down per client                     | **30 KB/s ceiling**, 10 KB/s design point   | Non-functional target; design point from [ADR-0001](./0001-v1-stack.md) §7 codec arithmetic |
| I11 | Real-time CPU per room                        | **2 ms mean per tick** (budget: < 5 ms p99) | **Measurement owed** — [PER-30](/PER/issues/PER-30), M4 spike                               |
| I12 | Static-asset egress                           | **Excluded**, assumed fronted by a free CDN | See §2.1 note — otherwise it is 1.7× the WebSocket egress                                   |
| I13 | FX                                            | **€1 = $1.08**                              | Rate at 2026-09-30                                                                          |
| I14 | Month                                         | **730 h = 2,628,000 s**                     | Standard cloud month                                                                        |
| I15 | **Fly included RAM per shared vCPU** (rev 7)  | **0.25 GB/vCPU — billable RAM is nameplate − 0.25 GB × vCPUs** | Fly's pricing page: `cpu * INCLUDED_RAM_GB_PER_VCPU`, 0.25 GB/vCPU. **Without this row §3.1 does not reproduce** — see §3.1 |

> **All provider prices are published list prices checked on 2026-09-30.** They are quotes,
> not measurements. Where a figure could not be verified against the vendor it is marked
> **[unverified]** and must be confirmed before any commitment. Per the bar in
> [`README.md`](./README.md), an unverified estimate is never presented as a measurement.

---

## 2. What 1,000 concurrent players actually consumes

### 2.1 Turn-based (per U₂₄)

```
rooms          1,000 players ÷ 2 seats (I4)                        =     500 rooms
instance load  500 ÷ 2,000 rooms-per-instance target               =      25% of one instance
actions        500 rooms × 1 / 5 s (I5)                            =     100 actions/s
action egress  100/s × 2.5 (I6) × 600 B (I7)                       =     150 KB/s
presence       1,000 players × 1 / 10 s (I8) × 200 B               =      20 KB/s
chat + lobby   allowance                                           =      30 KB/s
                                                                     ─────────────
WebSocket down                                                       ≈   200 KB/s
monthly        200 KB/s × 2,628,000 s (I14)                        =     526 GB/month
               × 0.27 duty cycle (I3)                              =     142 GB/month

Redis ops      1,800 ops/s at 2,000 rooms (ADR-0001 §6) ÷ 4        =     450 ops/s
Redis memory   500 rooms × 64 KB (I9)                              =      32 MB
PG log growth  100 actions/s × 2,628,000 s × ~120 B/row            =    31.5 GB/month
               × 0.27 duty cycle                                   =     8.5 GB/month
```

**Three things fall out of this that are worth more than the dollar figures.**

1. **1,000 concurrent turn-based players is a quarter of one instance.** The cost of serving
   them is almost entirely a _floor_ — two app instances for HA, one Redis, one Postgres —
   that we pay whether we have 100 players or 1,000. Doubling to 2,000 concurrent moves the
   Fly bill from ~$100 to ~$111. **Turn-based cost at our scale is ~90% fixed.** The board is
   buying a floor, not a variable.
2. **Static-asset egress is larger than WebSocket egress and is excluded (I12).** At a 20-minute
   session length, 1,000 concurrent slots generate ~2.19 M page loads/month; at 400 KB of first
   load that is ~876 GB/month — **1.7× the WebSocket traffic.** The model assumes `apps/web`
   static output is fronted by a CDN with free egress (Cloudflare's free plan qualifies). If we
   do not do that, every provider total below rises by 876 GB × their per-GB rate — which is
   $131/month on Render and $0 on Hetzner. **Fronting the web app with a free CDN is not an
   optimisation, it is a line item.** Owner: Platform Engineer, [PER-7](/PER/issues/PER-7).
3. **The match log grows ~31.5 GB/month per U₂₄ and nothing currently deletes it.** Postgres is
   the record of truth for completed matches ([ADR-0001](./0001-v1-stack.md) §5) and the replay
   source for restart survival (§6), so the log cannot simply be dropped. It needs a retention
   policy — full log for 30 days, then the exported record only. That is a design consequence of
   this cost model and it belongs to Platform Engineer on
   [PER-15](/PER/issues/PER-15)/[PER-29](/PER/issues/PER-29). Without it, storage is the one
   turn-based line item that grows without bound.

### 2.2 Real-time, M6 sizing only (per U₂₄)

```
rooms          1,000 players ÷ 12 per room                         =      84 rooms
CPU            30 ticks/s × 2 ms (I11) = 60 ms CPU/s per room      =      6% of a core per room
               84 rooms ÷ ~16 rooms per core                       =     5.3 cores → provision 8

egress @ 30 KB/s ceiling (I10)
               30 KB/s × 1,000 × 2,628,000 s                       =  78.8 TB/month
egress @ 10 KB/s design point
               10 KB/s × 1,000 × 2,628,000 s                       =  26.3 TB/month
egress @ ceiling × 0.27 duty cycle                                 =  21.3 TB/month
```

**78.8 TB/month is the number that decides M6.** It is 150× the turn-based egress for the same
player count, and it is why a provider with cheap instances and expensive bytes is the wrong
shape for a real-time fleet.

Two further constraints fall out of the CPU line:

- **The real-time fleet needs _dedicated_ vCPU.** A 30 Hz tick loop cannot hold a < 5 ms p99
  budget on a burstable or shared vCPU whose steal time we do not control. This disqualifies
  every `shared-cpu` tier for M6 and is a live consideration for Railway, which has no
  dedicated-CPU product at all.
- **84 rooms on 8 cores is a fleet, not a service.** It confirms the Constraint 4 check in §5.4
  is load-bearing rather than theoretical.

---

## 3. Turn-based cost per 1,000 concurrent players

Common footprint costed for every candidate: **2 app instances** (HA floor — one instance
cannot be deployed without downtime), **1 Redis** ≥ 256 MB, **1 Postgres** ~4 GB with 50 GB
storage, **526 GB egress** (U₂₄).

> **Rev 2 note.** Rev 1 specified the Redis line as "≥ 256 MB with `noeviction` and AOF". Per
> [ADR-0001](./0001-v1-stack.md) rev 2 §6.1 that is now a preference, not a requirement, and
> **Redis is priced here as a replaceable cache, not a system of record.** No candidate's Redis
> line moves as a result — the cheapest tier at each provider already clears 32 MB (§2.1) —
> so §3's totals are unchanged. What the withdrawal changes is §5.1, not §3.

### 3.1 Fly.io — **≈ $100/month per U₂₄ ($0.100 per concurrent player-month)**

Rates: shared vCPU $0.00000075/s → **$1.97/vCPU-month**; RAM $0.00000193/GB-s →
**$5.07/GB-month**; performance vCPU $0.00001196/s → **$31.43/vCPU-month**; egress NA/EU
**$0.02/GB** (APAC/Oceania/SA $0.04, **Africa & India $0.12**); volumes $0.15/GB-month;
Managed Postgres Basic (shared-2x, 1 GB) **$38/month**, storage **$0.28/GB**; regional
multiplier 1.0–1.615, **1.1 used** for `iad`/`ewr`.

> ⚠ **Fly's memory price rises ~20% on 2026-10-01 — tomorrow.** All Fly figures below use the
> post-increase RAM rate of **$6.09/GB-month**, not the $5.07 currently listed. Costing at a
> rate that expires in 24 hours would be a lie of timing.

> **I15 is the input that makes this section reproducible, and rev 7 adds it because it was
> missing.** Fly includes **0.25 GB of RAM per shared vCPU**, so a `shared-cpu-2x`/2 GB machine
> bills **1.5 GB** and a `shared-cpu-1x`/1 GB bills **0.75 GB**. Both deductions are applied in
> the table below and neither was stated before. A reader re-deriving §3.1 from nameplate RAM
> gets **$108.35**, not $99.97 — and at the India rate **$160.95**, not $152.60, which inverts
> §3.6's finding that Fly and Railway are indistinguishable on price for an Indian audience. The
> rule was verified against Fly's live pricing page on 2026-09-30 during the
> [PER-84](/PER/issues/PER-84) review; the figures below were right, the derivation was not
> checkable.

| Line             | Derivation                                                             |   $/month |
| ---------------- | ---------------------------------------------------------------------- | --------: |
| App × 2          | shared-cpu-2x/2 GB: (2 × $1.97 + **1.5 GB** × $6.09) × 1.1 × 2 — I15   |     28.76 |
| Redis (self-run) | shared-cpu-1x/1 GB (**0.75 GB** billable, I15) × 1.1 + 10 GB volume    |      8.69 |
| Postgres         | MPG Basic $38 + 50 GB × $0.28                              |     52.00 |
| Egress           | 526 GB × $0.02                                             |     10.52 |
|                  |                                                            | **99.97** |

At the 0.27 duty cycle (I3) egress falls to $2.84 → **$92/month**.

**Redis is priced as a self-run Fly Machine under our own `redis.conf`.** Rev 1 called this a
correctness requirement; per §5.1 it is now only a **cost** preference — $8.69/month against
$10/month for the cheapest Upstash fixed plan, and we already run the same `redis.conf`
locally. Either is acceptable.

### 3.2 Railway — **≈ $149/month per U₂₄ ($0.149)**

Rates: Pro **$20/month per workspace, including $20 of usage**; CPU $0.00000772/vCPU-s →
**$20.29/vCPU-month**; RAM $0.00000386/GB-s → **$10.14/GB-month**; volumes **$0.158/GB-month**;
egress **$0.05/GB**. Railway meters _actual_ usage, not allocation — a materially different
pricing model from everyone else here.

| Line               | Derivation                                |   $/month |
| ------------------ | ----------------------------------------- | --------: |
| App × 2            | 0.4 vCPU measured [assumption] + 2 GB, ×2 |     56.80 |
| Redis container    | 0.1 vCPU + 1 GB + 5 GB volume             |     12.96 |
| Postgres container | 0.2 vCPU + 4 GB + 50 GB volume            |     52.52 |
| Egress             | 526 GB × $0.05                            |     26.30 |
| Usage subtotal     |                                           |    148.58 |
| Bill               | `max($20 plan, usage)`                    | **148.6** |

Priced on _allocation_ (2 full vCPU per instance) rather than measured usage the same footprint
is **≈ $214/month**. The 0.4 vCPU figure is an assumption about how much CPU an idle-ish Node
WebSocket process actually burns; it is the largest uncertainty in Railway's number and it moves
the answer by ~45%.

### 3.3 Render — **≈ $225/month per U₂₄ ($0.225)**

Rates: workspace Pro **$25/month flat**; web service Standard **$25/month** (2 GB / 1 CPU);
Key Value Starter **$10/month** (256 MB); Postgres Basic-256mb **$6/month**; database disk
**$0.30/GB-month**; bandwidth — Pro includes **25 GB**, overage **$0.15/GB**.

| Line          | Derivation                                           |   $/month |
| ------------- | ---------------------------------------------------- | --------: |
| Workspace     | Pro, flat                                            |     25.00 |
| App × 2       | Standard $25 × 2                                     |     50.00 |
| Key Value     | Starter, 256 MB (32 MB needed per §2.1)              |     10.00 |
| Postgres      | Basic tier at ~4 GB RAM — **[unverified]**, budgeted |     50.00 |
| Database disk | 50 GB × $0.30                                        |     15.00 |
| Egress        | (526 − 25) GB × $0.15                                |     75.15 |
|               |                                                      | **225.2** |

Note Render's April 2026 plan change cut included bandwidth from 500 GB to 25 GB on the
professional tier. Under the _legacy_ plan this footprint's egress line would have been $4, not
$75. Anyone reasoning from a pre-April 2026 Render comparison is reasoning from a price that no
longer exists.

### 3.4 Hetzner — **two shapes**

Rates (April 2026 pricing): CPX22 2 vCPU/4 GB/80 GB **€7.99**; CPX32 4 vCPU/8 GB/160 GB
**€13.49**; CCX33 8 **dedicated** vCPU/32 GB/240 GB **€48.49**; LB11 load balancer ≈ **€5.39**;
backups +20% of server price. **Included traffic is region-dependent _and_ plan-dependent: EU
20–60 TB by plan (20 TB is the floor, and the figure used in §3), US 1–8 TB by plan, APAC
0.5 TB.** Overage ≈ **$1/TB**. No managed Redis, no managed Postgres, no native per-PR previews.

> **Rev 7 reconciles a figure this ADR stated two ways** (review finding F2). §3 uses the **EU
> 20 TB** floor; §4 uses **30 TB on CCX33** specifically. Those are not contradictory — Hetzner's
> EU allowance scales with the plan and CCX33 is a larger plan than the CPX22 costed here — but
> the ADR never said so, and §4's total was computed as though the allowance covered the whole
> bill. **CCX33's 30 TB is [unverified]** (owner: CTO, before any M6 commitment); §4 now gives the
> total at both figures so the reader is not asked to pick one. Nothing in §3 moves either way:
> turn-based egress is 526 GB, three orders of magnitude inside the smallest allowance.

**H1 — Hetzner compute + external managed data** (the candidate as [PER-38](/PER/issues/PER-38)
framed it): **≈ $62/month per U₂₄ ($0.062)**

| Line     | Derivation                                                            |  $/month |
| -------- | --------------------------------------------------------------------- | -------: |
| App × 2  | 2 × CPX22 €7.99 × 1.08                                                |    17.26 |
| LB11     | €5.39 × 1.08                                                          |     5.82 |
| Postgres | Neon Launch, list                                                     |    19.00 |
| Redis    | Managed tier exposing `maxmemory-policy` — **[unverified]**, budgeted |    20.00 |
| Egress   | 526 GB, within included traffic                                       |     0.00 |
|          |                                                                       | **62.1** |

**H2 — bare VM, everything self-run. This is the cost floor.** **≈ $41/month per U₂₄ ($0.041)**

| Line         | Derivation              |  $/month |
| ------------ | ----------------------- | -------: |
| App+data × 2 | 2 × CPX32 €13.49 × 1.08 |    29.14 |
| LB11         | €5.39 × 1.08            |     5.82 |
| Backups      | +20% of server price    |     5.83 |
| Egress       | within included traffic |     0.00 |
|              |                         | **40.8** |

**The floor exists to make the premium legible.** Fly costs **$59/month more than H2**. That
$59 buys: OS patching, Postgres backup and point-in-time restore, Redis failover, TLS renewal,
a per-PR preview system, and an on-call rota we do not have and are not hiring. At our stage
that is a good trade and I am recommending we pay it — but the board should see the number
rather than be told managed hosting is "cheap".

### 3.5 AWS ECS/Fargate — **≈ $208/month per U₂₄ ($0.208)**

Rates (us-east-1): Fargate x86 **$0.04048/vCPU-h** → $29.55/vCPU-month, **$0.004445/GB-h** →
$3.24/GB-month (Graviton ~20% less); ALB **$0.0225/h** = $16.43/month + LCUs; ElastiCache
`cache.t4g.small` ≈ **$23.36/month**; RDS `db.t4g.medium` ≈ **$47.45/month** + gp3 storage;
egress **first 100 GB/month free, then $0.09/GB** to 10 TB, $0.085 to 50 TB, $0.07 to 150 TB,
$0.05 above.

| Line        | Derivation                               |   $/month |
| ----------- | ---------------------------------------- | --------: |
| Fargate × 2 | 2 × (1 vCPU $29.55 + 2 GB $6.48)         |     72.06 |
| ALB         | $16.43 base + ~$5 LCU                    |     21.43 |
| ElastiCache | `cache.t4g.small`, single node           |     23.36 |
| RDS         | `db.t4g.medium` $47.45 + 50 GB gp3 $5.75 |     53.20 |
| Egress      | (526 − 100) GB × $0.09                   |     38.34 |
|             |                                          | **208.4** |

**This is the optimistic AWS number.** Single-AZ RDS, no ElastiCache replica, no NAT Gateway.
Make it production-shaped — Multi-AZ RDS (+$47.45), an ElastiCache replica (+$23.36), and private
subnets behind a NAT Gateway ($32.85/month plus **$0.045 per GB processed**, +$23.67, which taxes
the same bytes twice) — and it is **≈ $336/month**. NAT Gateway is the classic AWS surprise and is
named here so it cannot surprise us later.

### 3.6 Turn-based summary

| Provider                | $/month per U₂₄ | $ per concurrent player-month | vs. bare-VM floor | **India audience** (rev 3) |
| ----------------------- | --------------: | ----------------------------: | ----------------: | -------------------------: |
| **Hetzner H2** (floor)  |              41 |                         0.041 |             1.00× |         41 — flat transfer |
| Hetzner H1              |              62 |                         0.062 |             1.52× |                         62 |
| **Fly.io**              |             100 |                         0.100 |             2.45× |            **153** (0.153) |
| Railway                 |             149 |                         0.149 |             3.65× |                 149 — flat |
| AWS (optimistic)        |             208 |                         0.208 |             5.07× |      ~261 **[unverified]** |
| Render                  |             225 |                         0.225 |             5.49× |                 225 — flat |
| AWS (production-shaped) |             336 |                         0.336 |             8.20× |      ~389 **[unverified]** |

**The India column, derived (rev 3).** Confirming the Chief of Staff's arithmetic exactly:

```
turn-based egress per U₂₄ (from §2.1)                      =    526 GB/month
  at Fly NA/EU  526 GB × $0.02                             = $   10.52
  at Fly India  526 GB × $0.12                             = $   63.12
  delta                                                    = $   52.60
Fly turn-based total  $100.00 − $10.52 + $63.12            = $  152.60  ≈ $153  ✓ confirmed
```

**Only Fly and AWS move.** Hetzner, Railway and Render bundle transfer or price it flat
worldwide, so their numbers are unchanged — which narrows Fly's turn-based advantage over
Railway from 1.5× to **1.03×** for an Indian audience. At $153 vs $149 the two are
indistinguishable on price, and Fly's case for M0–M5 now rests entirely on Constraint 4
(§5.4) rather than on cost. That is a thinner margin than rev 2 implied and is recorded as a
revisit trigger.

The whole managed-vs-bare spread is **$41 → $225**. At our scale this is not the decision. It is
worth less than one engineer-day per month. §4 is the decision.

---

## 4. Real-time cost per 1,000 concurrent players — M6 sizing only

Footprint: **8 dedicated vCPU / 16 GB** (per §2.2) and **78.8 TB egress** at the 30 KB/s
ceiling. This section sizes a milestone the board has not opened. It is here because the
_turn-based_ provider choice must not foreclose it.

| Provider |       Compute $/mo | Egress $/mo @ 30 KB/s |  **Total** | $/player-mo | Egress @ 10 KB/s |      **India audience** (rev 3) |
| -------- | -----------------: | --------------------: | ---------: | ----------: | ---------------: | ------------------------------: |
| Hetzner  |         52 (CCX33) |         53 EU – 76 US | **105–128** | 0.105–0.128 |         0–7 – 23 | 105–128, **but no India region** |
| Fly.io   |                277 |                 1,577 |  **1,853** |    **1.85** |              526 |                **9,738 (9.74)** |
| Railway  |                325 |                 3,942 |  **4,267** |    **4.27** |            1,314 |                    4,267 — flat |
| AWS      |                288 |                 6,329 |  **6,617** |    **6.62** |            2,276 |         ~8,646 **[unverified]** |
| Render   | 200 [extrapolated] |                11,822 | **12,022** |   **12.02** |            3,938 |                   12,022 — flat |

**The India column, derived (rev 3; the rounding stated explicitly in rev 7).** Confirming the
Chief of Staff's second figure to within rounding:

```
real-time egress per U₂₄ (from §2.2)   30 KB/s × 1,000 × 2,628,000 s  =  78,840 GB/month
  at Fly NA/EU  78,840 GB × $0.02                                     = $ 1,576.80
  at Fly India  78,840 GB × $0.12                                     = $ 9,460.80
Fly real-time total  $277 compute + $9,460.80                         = $ 9,737.80  → $9,738
```

> **Rev 7 (review finding F3): this ADR carried three values for one quantity** — $9,733 in §0,
> §4's table and §5.7; $9,737 in the block above; $9,738 in §11.3 — and papered the mismatch over
> with `≈ … ✓ confirmed`. **The exact figure from this ADR's own inputs is $9,737.80, carried
> everywhere as $9,738 ($9.74/player-month).** The board's $9,733 is what you get from rounding
> 78.84 TB to 78.8 TB; it is right to three significant figures. **Nobody's decision moves on $5 —
> what moved is that §0 and §10.1 said "confirmed to the dollar", which is true of $153 and was
> not true of this one.** Both now say so precisely.

**This is the number that reopens the M6 provider question** (§7c). At **$9.74 per concurrent
player-month** for a free-to-play browser game with no v1 revenue, Fly is within 25% of the
$12.02 that disqualified Render on arithmetic in finding 2 below. Applying the same standard
to both: **Fly is not a viable M6 provider for an Indian audience either.** It remains the
right M0–M5 choice, because turn-based is 150× cheaper per player and the transport-adapter
seam ([ADR-0001](./0001-v1-stack.md) §4.1) means the fleet does not have to live where the
lobby lives.

Egress derivations:

```
Fly      78,840 GB × $0.02                                            = $1,576.80
Railway  78,840 GB × $0.05                                            = $3,942.00
Render   (78,840 − 25) GB × $0.15                                     = $11,822.25
AWS      100 GB free
         + (10,240 − 100) × $0.09   = $  912.60
         + (51,200 − 10,240) × $0.085 = $3,481.60
         + (78,840 − 51,200) × $0.07  = $1,934.80                     = $6,329.00
Hetzner  EU: 30 TB included on CCX33 [unverified], 48.84 TB × €1/TB × 1.08  = $  52.75
         EU at the 20 TB floor (§3.4),              58.84 TB × €1/TB × 1.08  = $  63.55
         US: 3 TB included,                         75.84 TB × $1/TB         = $  75.84
```

> **Rev 7 (review finding F2) — the table above used to read "0 EU", contradicting this block.**
> At the 30 KB/s ceiling, 78.84 TB exceeds the included EU traffic on **either** figure this ADR
> states, so the EU egress line is **$52.75** (at 30 TB) or **$63.55** (at the 20 TB floor), never
> $0. **Corrected Hetzner real-time total: $105 (EU, 30 TB) / $116 (EU, 20 TB) / $128 (US)** —
> published as **$105–128**, and the `$/player-mo` column as **0.105–0.128**. The "0" was
> inherited from the 10 KB/s column, where it is correct at 30 TB (26.28 TB sits inside the
> allowance) and ~$7 at the 20 TB floor — hence that column now reads `0–7 – 23`. **Finding 3
> below is unaffected** (it uses the US worst case), and so is §7c: Hetzner is still ~14× cheaper
> than Fly for M6.

**Three findings.**

1. **The spread is 94–114×, and it is almost entirely egress.** On Render, egress is 98% of the
   bill. On Hetzner it is 50–59%. Compute differs by ~6× across the five; the per-GB rate differs
   by **153×** ($0.15/GB on Render against ~$0.00098/GB on Hetzner at €1/TB).
2. **Render is disqualified for M6 on egress alone.** $12.02 per concurrent player per month,
   for a free-to-play browser game with no per-player revenue in v1, is not a business. This is
   not a close call and it does not need a board to adjudicate it — it is arithmetic.
3. **Two independent levers, and we should pull both.** Getting from the 30 KB/s ceiling to the
   10 KB/s design point — which [ADR-0001](./0001-v1-stack.md) §7 shows is achievable with a
   binary codec, since the snapshot itself is ~110 B/tick ≈ 3.3 KB/s — saves **$1,051/month on
   Fly**. Moving the fleet from Fly to Hetzner saves **~$1,725/month**. Neither substitutes for
   the other, and the codec work is already committed regardless of provider.

> **Measurement owed.** Every figure in §4 rests on I10 and I11, which are _budgets we set_, not
> bytes we have counted. The M4 real-time spike ([PER-30](/PER/issues/PER-30)) owes measured
> bytes/s per client and CPU ms/tick per 12-player room. **When it lands, §4 is replaced, not
> amended.**

---

## 5. Hard constraints — every candidate checked

### 5.1 Redis eviction policy — **a preference, not a gate** (rev 2)

> **Rev 1 said `maxmemory-policy noeviction` was a hard constraint that disqualified a
> provider, on the grounds that live room state was authoritative in Redis between Postgres
> snapshots. [ADR-0001](./0001-v1-stack.md) rev 2 §6.1 withdrew that.** Redis is now a cache in
> front of the Postgres match log. A room is fully reconstructible from `(seed, module version,
ordered action log, last snapshot)` **with no Redis key surviving**, so losing the entire
> keyspace costs a rehydrate and a reconnect, never a match.
>
> **Nothing below disqualifies anything.** The table is kept because the evidence is real and
> a provider that _does_ let us pin the policy is still preferable — an evicted key costs a
> Postgres read that a pinned key does not. It ranks candidates; it no longer eliminates them.
> The constraint that replaced it is **§5.1b**, and it is the more expensive one.

| Provider | Verdict                                                                                                                             | Finding                                                                                                                                                                                                                                                                                     |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Render   | **Pass — cleanest of the five**                                                                                                     | Render Key Value exposes the maxmemory policy explicitly, including `noeviction`: _"Don't evict data. Instead, return an error on write operations whenever the instance is out of memory."_ Journal + Snapshot persistence runs `appendfsync everysec`, matching our `docker-compose.yml`. |
| Railway  | **Pass**                                                                                                                            | Redis runs as our own container under our own `redis.conf`. Identical config to local.                                                                                                                                                                                                      |
| Hetzner  | **Pass** self-run / **conditional** with an external managed tier — which must be one that exposes `maxmemory-policy`. Not Upstash. |
| AWS      | **Pass**                                                                                                                            | `maxmemory-policy = noeviction` via a **custom** parameter group. The _default_ parameter group is immutable, so this is a required provisioning step, not a default. (`r6gd` data-tiering nodes restrict the allowed policies — not a node type we would use.)                             |
| Fly.io   | **Conditional pass — and a disqualification inside it**                                                                             | See below.                                                                                                                                                                                                                                                                                  |

**Upstash: rev 1 disqualified it, rev 2 re-admits it.** The evidence is unchanged — Upstash does
not expose `maxmemory-policy`, offering instead an eviction **on/off toggle** whose algorithm,
when on, is a proprietary `optimistic-volatile` scheme (volatile-random, then allkeys-random),
and whose default is no eviction. Rev 1 rejected that because a vendor default cannot be pinned
in config or asserted in a test. **That reasoning only held while an evicted key was a lost
match. It no longer is.** An evicted key is now a cache miss that costs a rehydrate from the
Postgres log — the same path a cold start already takes. **Upstash is therefore eligible
everywhere, including production**, and it is the Redis in the $0 topology in §8.

What still rules Upstash out on Fly at scale is **price, not correctness**:

- **Upstash's per-request pricing is a trap at our shape.** At the 450 ops/s of §2.1,
  pay-as-you-go at $0.20 per 100k commands is **1.18 Bn commands/month = $2,366/month**, against
  $8.69 for a self-run Fly Redis Machine — a 272× difference for the same 32 MB of data. Anyone
  reaching for Upstash must be on a **fixed** plan ($10/month at the paid entry tier, which is
  competitive). Recorded so nobody discovers this from an invoice. **This finding survives rev 2
  intact and is now the only reason §3.1 prices a self-run Machine.**
- **The same request accounting sets the free tier's ceiling** — 500K commands/month, which §8.2
  works out to roughly 20 concurrent players for two hours a day. That is the binding quota in
  the $0 topology.

**Crash loss is now free, and that is worth stating precisely.** Rev 1 wrote that every
provider's Redis risks ≤ 1 s of writes on failure under `appendfsync everysec`, and that losing
≤ 1 s costs "a replay, not a match". [ADR-0001](./0001-v1-stack.md) rev 2 §6.1 goes one step
further: the exposure is **not ≤ 1 s, it is nothing**. Every applied action is on the Postgres
log before it is acknowledged (§5.1b), so a Redis instance that loses a second of writes, or
its entire dataset, loses **no applied action at all**. `appendonly` and `noeviction` are
therefore recommended where a provider offers them and are explicitly not a hosting constraint.

### 5.1b The replacement constraint: **Postgres durability, and a ≤ 10 ms p95 log append**

[ADR-0001](./0001-v1-stack.md) rev 2 §6.2 moved the durable append **onto the action hot path**
and budgeted it at **≤ 10 ms p95**. This is the constraint that actually costs money now, and it
has a shape rev 1 did not price: it is a **per-action synchronous write**, not a background
snapshot, so it is sensitive to network distance and fsync latency rather than to IOPS ceilings.

At 100 actions/s per U₂₄ (§2.1) the write volume is trivial for every candidate. **The budget is
spent almost entirely on round trips**, which decomposes as:

```
append p95  =  app → PG network RTT  +  WAL fsync  +  driver/pool overhead
same host / same region, provisioned    ≈ 0.3–1 ms  +  1–3 ms  +  ~1 ms   →  ~3–5 ms   PASS
different provider, same metro          ≈ 5–15 ms   +  1–3 ms  +  ~1 ms   →  ~8–20 ms  MARGINAL
different provider, different region    ≈ 20–80 ms                         →  FAIL
serverless PG resuming from scale-to-zero  + 500 ms–several s on the first append → FAIL
```

| Candidate / topology                                | Same-region PG? | ≤ 10 ms p95 verdict                                                                                                                        |
| --------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Fly.io + Fly Managed Postgres                       | Yes             | **Pass** — MPG runs in the same Fly region as the app                                                                                      |
| AWS ECS + RDS                                       | Yes             | **Pass** — same VPC, same AZ                                                                                                               |
| Render + Render Postgres                            | Yes             | **Pass**                                                                                                                                   |
| Railway + Railway Postgres                          | Yes             | **Pass**                                                                                                                                   |
| Hetzner H2 (PG on the same box)                     | Same host       | **Pass, best** — no network hop at all                                                                                                     |
| Hetzner H1 (compute at Hetzner, PG at Neon)         | **No**          | **Marginal** — a cross-provider hop inside the same metro is 5–15 ms before fsync. **[unverified]** — must be measured before H1 is chosen |
| **The $0 topology of §8** (Render free → Neon free) | **No**          | **Fails, twice** — cross-provider RTT, plus Neon free autosuspends after 5 min idle and the first append after a suspend pays a resume     |

**Two consequences, and the second is a board decision.**

1. **Co-location is now a hosting requirement, not a preference.** Any topology that puts
   Postgres at a different provider from `apps/realtime` must measure the append p95 before it
   is adopted. This is a new disqualifier that did not exist in rev 1, and it is the one that
   the `noeviction` withdrawal traded itself for. It weakens **Hetzner H1** specifically — the
   cheap-compute-plus-managed-data shape — because that shape is defined by the split.
2. **At $0 the budget cannot be met, so the group-commit trade-off is forced.** Per Chief of
   Staff's instruction on this issue, this is surfaced rather than absorbed: it is **Decision 4
   in §10**. The options are (a) buy co-located Postgres — §11.1's $6–7/month topology
   also fixes this, since a Fly app and Fly MPG are same-region; (b) group-commit the log,
   batching appends over a ~10 ms window, which trades a bounded action-acknowledgement delay
   for throughput and **changes the durability story** — board territory, not a tuning knob; or
   (c) accept an unmeasured append p95 on free-tier staging and state that M0 evidences nothing
   about it. **(a) is the recommendation and it is the cheapest of the three.**

> **Redis is fungible, Postgres is not.** If a shortlist ever forces a trade-off between the two
> tiers, **protect Postgres**: its backup and point-in-time-restore story, and its co-location
> with the app. "Postgres dies" is the one failure [ADR-0001](./0001-v1-stack.md) cannot design
> around; "Redis dies" is a rehydrate. Every free-tier Postgres in §8 has a restore window
> measured in hours, not days, and that is the single largest unpriced risk in the $0 topology.

### 5.2 WebSockets must survive, with no idle timeout that kills a quiet game and no buffering proxy

| Provider | Idle timeout                                                                                                              | Verdict                                                                                                                   |
| -------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Fly.io   | **~30 s** on idle connections (community-documented; **[unverified]** against vendor docs)                                | **Pass, conditionally** — see below                                                                                       |
| Railway  | None documented                                                                                                           | Pass **[unverified]** — WebSockets are handled natively                                                                   |
| Render   | **No fixed idle timeout.** Connections close on instance replacement; SIGTERM + 30 s graceful window, extendable to 300 s | **Pass** — and the shutdown-delay knob is genuinely useful for draining rooms                                             |
| Hetzner  | Our own proxy, our own timeouts                                                                                           | Pass                                                                                                                      |
| AWS      | ALB default **60 s**, configurable 1–4,000 s                                                                              | **Pass once configured.** A default-config ALB silently kills quiet turn-based games at 60 s — a real footgun, named here |

**Fly's ~30 s idle timeout does not bind us, because we already beat it.**
[ADR-0001](./0001-v1-stack.md) §6 specifies a 10 s presence heartbeat, so no connection is idle
for 30 s. This promotes that heartbeat from a presence mechanism to a **transport requirement**,
with one addition: **the server must send a heartbeat too.** A quiet turn-based game — both
players thinking — may have neither side sending application data, and a client-only heartbeat
leaves the server's half of the connection idle. Owner: Platform Engineer,
[PER-15](/PER/issues/PER-15).

**Cross-cutting consequence worth more than the table.** _Every_ provider here closes WebSocket
connections on deploy. Render says so explicitly; the others do it by replacing instances. So
reconnect-and-resume-from-match-log is not a resilience nicety scheduled for M3 — it is the thing
that makes a routine deploy invisible to a live match on any provider we pick. That strengthens
the case for [PER-29](/PER/issues/PER-29) and it is a reason the version-pinning rule
([ADR-0001](./0001-v1-stack.md) §7) exists.

### 5.3 Per-PR preview environments (M0 AC1)

| Provider | Verdict                                                                                                                                                                                                                                                         |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Railway  | **Pass, best in the set.** PR Environments are native: Railway clones the base environment (including databases) into `pr-<number>`, marks it ephemeral, and deletes it on merge or close.                                                                      |
| Fly.io   | **Pass.** Per-PR app via `fly deploy` in CI or the `fly-pr-review-apps` action; Machines created and destroyed per PR.                                                                                                                                          |
| Render   | **Pass on a paid workspace.** Not available on the free tier.                                                                                                                                                                                                   |
| AWS      | **Pass as built.** Per-PR CDK/Terraform stack. Slowest to provision (ECS + RDS is minutes) and the most machinery of any candidate.                                                                                                                             |
| Hetzner  | **Fail as bought. Pass as built.** No native concept. We would build it — per-PR container on a shared VM, wildcard DNS, reverse proxy, or adopt Coolify/Dokku. That is real, ongoing, unbudgeted engineering sitting directly on the critical path for M0 AC1. |

This constraint is the strongest argument against the cheapest option. Hetzner's $41/month floor
does not include the preview system, and building one is not a day.

### 5.4 A separate game-server fleet must be possible later (M6), with room-level routing

The one that is expensive to be wrong about, because it is the one we cannot discover until M6.

| Provider | Verdict                                                                                                                                                                                                                                                                                                        |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fly.io   | **Strong pass — the only native one.** The Machines API creates and destroys VMs programmatically (a Machine per room or per shard is a supported pattern) and the `fly-replay` response header routes a request to a _named_ Machine. Room-level routing is a platform primitive we get, not a tier we build. |
| Hetzner  | **Pass.** They are VMs; we own routing entirely. Maximum control, maximum work.                                                                                                                                                                                                                                |
| AWS      | **Pass.** ECS + service discovery + our own room allocator, or EC2. Most machinery of the five.                                                                                                                                                                                                                |
| Railway  | **Conditional.** Fixed service replicas, no VM-per-room API, no documented room affinity. We build routing over Redis pub/sub.                                                                                                                                                                                 |
| Render   | **Conditional, and weakest.** Render's load balancer _"assigns each incoming WebSocket connection to a random instance of your service, regardless of past connection history."_                                                                                                                               |

**Render's random assignment deserves its own paragraph, because it reads worse than it is for
M1–M5 and worse than it looks for M6.** For turn-based it is survivable by design:
[ADR-0001](./0001-v1-stack.md) §6 deliberately made cross-instance pub/sub — not sticky sessions —
the correctness mechanism, precisely so that a player landing on any instance still sees a correct
room. Sticky sessions buy efficiency, not correctness. But for a 30 Hz room whose tick loop lives
in exactly one process, random assignment means most clients land on the wrong box and every input
and every snapshot takes an extra internal hop, at 30 Hz, inside a 150 ms budget. We would have to
build a routing tier in front of Render's. That is the **real-time readiness** lens saying no.

### 5.5 In-region round trip must be able to hit < 150 ms p95

| Provider |                                                             Regions | India region?                   | Verdict |
| -------- | ------------------------------------------------------------------: | ------------------------------- | ------- |
| AWS      |                                                                ~30+ | ✅ `ap-south-1` Mumbai          | Pass    |
| Fly.io   |                                    30+, **no India** (rev 3, §5.5b) | ❌ `bom` **deleted 2026-09-25** | Pass\*  |
| Hetzner  | 6 (Nuremberg, Falkenstein, Helsinki, Ashburn, Hillsboro, Singapore) | ❌ nearest Singapore            | Pass\*  |
| Render   |                    5 (Oregon, Ohio, Virginia, Frankfurt, Singapore) | ❌ nearest Singapore            | Pass\*  |
| Railway  |                              4 (US-West, US-East, EU-West, SE-Asia) | ❌ nearest Singapore            | Pass\*  |

\* Passes the constraint as written — _in-region_ round trip — but cannot put a server in India.
See §5.5b, which is new in rev 3 and is the section that matters.

**Nobody is disqualified, and the constraint is nearly vacuous as written** — because _in-region_
is doing all the work in it. A player in Mumbai on a Frankfurt region will not see < 150 ms on any
provider; that is the speed of light, not a vendor failure. The real question the board is being
asked without realising it is **which regions we serve in v1**, and that is a product decision
with a cost attached.

If the answer includes India, South America or Africa, region count becomes the deciding factor
and it favours Fly — with the caveat that **Fly's egress in Africa and India is $0.12/GB, 6× its
NA/EU rate**, which flips the §4 ranking for those regions specifically. Flagging this to Chief of
Staff on [PER-2](/PER/issues/PER-2) as a question the board may not know it is answering.

> **Measurement owed.** Actual p95 round-trip from a real staging deploy. Owner: Platform
> Engineer, [PER-7](/PER/issues/PER-7). Until then, "can hit < 150 ms" is a structural claim about
> network distance, not a measurement.

### 5.5b Two facts about Fly and India that void part of the board's instruction (rev 3)

The board's Decision 3 reads: _"Deploy the interim environments in Mumbai (`bom`) … That is the
conservative assumption — if the board later scopes v1 to cheaper-egress regions, costs fall
rather than rise."_ I verified both halves before provisioning against them. **Neither holds on
Fly.** Recording this here rather than discovering it in `fly.toml`.

**Fact 1 — Fly has no India region. `bom` was deleted, not deprecated, on 2026-09-25.**

Fly's regions reference now lists **`nrt` Tokyo, `sin` Singapore and `syd` Sydney** for
Asia-Pacific, with no Mumbai entry. The removal landed in
[superfly/docs#2508](https://github.com/superfly/docs/pull/2508), merged 2026-09-25, whose author
notes: _"Customers running there have already been told, so these are deletions rather than
deprecation notices."_ A companion PR removed `bom` from the pricing region picker. Fly's own
guidance points existing `bom` workloads at `sin`.

**This means `fly deploy --region bom` will fail.** It is not a pricing preference we can
override; the region does not exist to deploy into.

**Fact 2 — Fly prices egress by _destination_, not by the Machine's region.** From Fly's pricing
page: bandwidth is _"priced by destination rather than by the Machine's region."_ The rate card
is $0.02/GB to North America and Europe, $0.04/GB to Asia-Pacific and Oceania, and **$0.12/GB to
Africa and India**.

The consequence is the opposite of the board's reasoning, and it matters more than Fact 1:

- **Hosting outside India does not avoid the $0.12/GB rate.** If our players are in India, we pay
  India rates from Singapore, Frankfurt or Virginia alike. The ~$153 turn-based and ~$9,738
  real-time figures are therefore **audience numbers, not region numbers** — they are what Fly
  costs to serve India from anywhere.
- **Region choice on Fly is a latency lever only. It is not a cost lever.** So the board's
  fallback — "if we later scope v1 to cheaper-egress regions, costs fall" — only works if the
  **audience** changes, which is a product decision about who we are building for, not an
  infrastructure decision. The brief already fixes the audience as India.

**What we deploy instead, and what it costs in latency.** Singapore (`sin`) is Fly's nearest
region to India. Mumbai↔Singapore is roughly **60–90 ms RTT [unverified]** — the same figure
§11.3 already records against Hetzner Singapore. Against a 150 ms p95 budget that is 40–60%
consumed before our code runs.

| Consequence        | Assessment                                                                                                                                                                          |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Turn-based (M1–M5) | **Survivable.** 60–90 ms network + our processing leaves real but thin margin inside 150 ms p95. This is the number [PER-7](/PER/issues/PER-7) must measure first, not last.        |
| Real-time (M6)     | **Not viable.** A 30 Hz room at 60–90 ms RTT before jitter is a different game. Reinforces §7c independently of the $9.74/player-month figure.                                      |
| Reversibility      | **Cheap through M4.** At ~zero players there is no data gravity and no egress bill, so moving region or provider before M5 costs a redeploy. This is why Decision 1 is still right. |

**Recommendation to the board, replacing the `bom` instruction:** deploy interim environments to
**`sin`**, treat the ~60–90 ms as a measured input owed by [PER-7](/PER/issues/PER-7) before M5
opens, and note that **if v1 commits to India, no Fly region can host the M6 fleet** — §11.3's
Akamai/Linode Mumbai or DigitalOcean Bangalore become the only candidates that put a server in
the country.

> **Verification owed before provisioning.** Whether **Fly Managed Postgres is offered in `sin`**
> is **[unverified]** and is a precondition of §7a's co-location condition (§5.1b). If it is not,
> production Postgres is a self-run Machine and §12's line item changes. Owner: Platform
> Engineer, [PER-7](/PER/issues/PER-7), as the first check before any resource is created.

### 5.6 Not a candidate: Vercel

Recorded so it is not re-litigated. Vercel hosts `apps/web` well, and its per-PR previews are the
best in the industry. It cannot host `apps/realtime`: there is no long-lived server process to run
a room runner or a tick loop in. Additionally, the free Hobby tier forbids commercial use, which
matters for something we intend to launch. Vercel remains usable as a _web-only_ preview surface —
see §8 — but it cannot be the platform.

### 5.7 Constraint summary

| Constraint                                        |                   Fly.io                   |     Railway     |              Render              |                        Hetzner                        |                AWS                 |
| ------------------------------------------------- | :----------------------------------------: | :-------------: | :------------------------------: | :---------------------------------------------------: | :--------------------------------: |
| 1. Redis eviction — **preference only** (rev 2)   |     ✅ self-run or Upstash fixed plan      |       ✅        |           ✅ **best**            |                      ✅ self-run                      |       ✅ custom param group        |
| 1b. **Co-located PG, ≤ 10 ms p95 append** (rev 2) |            ✅ MPG, same region             | ✅ same project |          ✅ same region          | ✅ H2 same host / ⚠ **H1 cross-provider, unmeasured** |           ✅ same VPC/AZ           |
| 2. WebSocket survival                             | ⚠ ~30 s idle, beaten by our 10 s heartbeat |       ✅        |                ✅                |                          ✅                           | ⚠ must raise ALB default from 60 s |
| 3. Per-PR previews                                |                     ✅                     |   ✅ **best**   |           ✅ paid only           |             ❌ **as bought**, ⚠ as built              |             ⚠ as built             |
| 4. M6 fleet + room-level routing                  |           ✅ **only native one**           |     ⚠ built     | ⚠ weakest — random WS assignment |                       ✅ built                        |              ✅ built              |
| 5. < 150 ms p95 in-region                         |   ✅ 30+ regions, ⚠ **no India** (rev 3)   |      ✅ 4       |               ✅ 5               |                         ✅ 6                          |        ✅ 30+, incl. Mumbai        |
| Turn-based $/U₂₄ (NA/EU audience)                 |                  **100**                   |       149       |               225                |                       **41–62**                       |              208–336               |
| Turn-based $/U₂₄ (**India audience**, rev 3)      |                  **153**                   |       149       |               225                |                       **41–62**                       |              ~261–389              |
| Real-time $/U₂₄ (M6, India audience)              |  **9,738 — disqualifying** (rev 3, rev 7)  |      4,267      |    **12,022 — disqualifying**    |          **105–128** (rev 7), no India region         |               ~8,646               |

No candidate is disqualified outright for M0–M5. **Render is disqualified for M6 on egress
(§4).** **Hetzner fails Constraint 3 as bought** and passes only at the cost of building a
preview system, and **Hetzner H1 is now marginal on Constraint 1b** because it splits compute
and Postgres across providers (§5.1b).

**Rev 2 withdrawal, stated plainly so the record is not ambiguous:** rev 1 disqualified
**Upstash** as the production live-state store. **That disqualification is withdrawn** — it
rested on an eviction being a lost match, which [ADR-0001](./0001-v1-stack.md) rev 2 §6.1 made
untrue. Upstash competes on price like anything else, and it is the Redis in the $0 topology.

---

## 6. Alternatives considered

Beyond the provider table, three structural alternatives were considered and rejected.

### One provider for both workloads

The obvious choice, and wrong. §3 and §4 show the two workloads are optimised by different
properties — a fixed floor versus a per-byte rate — and the best turn-based provider is 14–36×
more expensive than the best real-time one for the same player count. The transport adapter and
`Codec` seam in [ADR-0001](./0001-v1-stack.md) §4.1 exist precisely so that the real-time fleet
can live somewhere else without the lobby, seats, invites or results knowing. **Deciding both now
would spend that seam's option value for nothing.** Rejected on **reversibility**.

### Decide the M6 provider now, while we have the analysis loaded

Tempting and cheap in effort. Rejected because §4 rests entirely on I10 and I11, which are budgets
we set rather than bytes we have counted. Choosing a fleet provider before the M4 spike
([PER-30](/PER/issues/PER-30)) measures them is choosing on a model that could be 3× off in either
direction — and a 3× error moves the Fly bill by $1,000/month. Rejected on **budget before
optimisation**: a performance-and-cost claim needs a measured number.

### Serverless / edge (Cloudflare Workers + Durable Objects) instead of long-lived instances

Not in the candidate set [PER-38](/PER/issues/PER-38) named, but genuinely the strongest thing not
on the list, and it should be on the record. Durable Objects are a near-perfect fit for "one
authoritative object per room with WebSocket hibernation", and Cloudflare's egress is free — which
is the single line item that decides §4. It loses for **M0–M5** on three specific consequences,
not on taste: (a) the Workers runtime is not Node, so `ioredis`, `pino`, the `ws` server and the
Drizzle/`pg` driver path in [ADR-0001](./0001-v1-stack.md) §§4–6 would all need replacing —
changing a major tech choice, which is board-gated; (b) a 30 Hz tick loop in an environment with
CPU-time limits per invocation is an unmeasured risk against the < 5 ms p99 budget; (c) it would
make the SDK contract Workers-shaped, the same **plugin boundary** objection that ruled out
Colyseus in [ADR-0001](./0001-v1-stack.md) §4.2. **Recorded as a live candidate for the M6 fleet**,
to be evaluated alongside Hetzner and Colyseus in [PER-21](/PER/issues/PER-21) — not adopted now.

> **Rev 2 promotes this from a footnote to a costed alternative.** Once the budget is $0, the
> free Workers plan's WebSocket **Hibernation API** — where an idle object is evicted from memory
> _without dropping its sockets_ — is the only candidate anywhere in this ADR for which idle is a
> designed-for state rather than a failure mode. §8.3 works the free-plan ceiling to **~230
> concurrent players at $0 with no payment card**, and §11.1 prices the port that would unlock it
> at **5–8 engineer-days** against a $7/month alternative. Still not adopted; now refused with a
> number instead of with a preference.

---

## 7. Recommendation — **approved by the board 2026-09-30, dormant under the provisioning hold** (§10, §13)

> **Rev 4: approved, and not exercisable.** The provider choice stands — this is still the right
> answer and no further board input is needed to act on it the moment provisioning resumes. But
> **nothing here may be provisioned today**: **no Fly account, no card, no trial — and rev 6
> confirms that all three are still true of Fly specifically.** The one carved exception to the
> hold (§13.7) is a pre-existing Cloudflare connection, which is not a Fly account and provisions
> nothing in this section. **§8 is the operative section again.** Treat §7 and §12 as a signed
> purchase order with no released funds.
>
> ~~Rev 3: this section is now operative and the board has approved it … §8 is no longer the
> operative section.~~ **Half-superseded 2026-09-30** — the approval is real, the operativeness
> is not.
>
> ~~Rev 2: this section is conditional on a budget existing. The board has set the budget to
> $0, so §8 is the operative section today.~~ **Reinstated by rev 4**, for a different reason:
> in rev 2 there was no authority; now there is authority and no permission.

**Split the decision by workload and by time.**

### 7a. M0–M5 — turn-based, staging and per-PR previews: **Fly.io**

Ranked reasons:

1. **Constraint 4 is the only one that is expensive to be wrong about, and Fly is the only
   candidate that passes it natively.** The Machines API plus `fly-replay` room-level routing is
   the M6 fleet primitive, available now, at no extra cost, on the provider we would already be
   using. Every other candidate requires us to build a routing tier in M6 — work that is invisible
   today and unbudgeted.
2. ~~**$0.02/GB egress**, second only to Hetzner's effectively-free~~ — **weakened in rev 3.**
   $0.02/GB is the NA/EU rate. For an Indian audience the rate is **$0.12/GB regardless of where
   we host** (§5.5b), which takes the turn-based figure to $153 and puts Fly level with Railway's
   $149. Cheap egress is no longer a reason; it is merely not a disqualifier at turn-based
   volumes.
3. ~~**35+ regions** — the only defence against the regional question in §5.5~~ — **also
   weakened in rev 3.** Fly has 30+ regions and **none of them are in India** (§5.5b). The
   nearest is Singapore at ~60–90 ms from Mumbai. Region count is still a genuine advantage for
   any other market; it is not one for the market the brief names.
4. **≈ $100/month per 1,000 concurrent turn-based players** for an NA/EU audience, **≈ $153 for
   an Indian one** — and, per §12, **≈ $60/month for the environments we actually need through
   M4**, which is the number that matters right now.

5. **Postgres is co-located** (§5.1b) — Fly Managed Postgres runs in the same region as the
   app, which is what makes the ≤ 10 ms p95 log append reachable. Rev 2 promotes this from an
   unstated convenience to a named reason.

**Conditions attaching to this recommendation — all three approved by the board in rev 3, and
binding on [PER-7](/PER/issues/PER-7):**

- **The presence heartbeat is ≤ 10 s and is sent by the server as well as the client** (§5.2).
  Not optional — it is what defeats Fly's ~30 s idle timeout.
- **Postgres is Fly Managed Postgres in the same region as the app**, not an external managed
  tier (§5.1b). Not optional — an off-Fly Postgres reintroduces the cross-provider hop.
  **Availability in `sin` is [unverified] and must be checked first** (§5.5b).
- **Redis is a self-run Fly Machine under our own `redis.conf`, not Upstash.** Rev 2 withdrew
  this condition as an eviction-policy matter; **the board reinstated it in rev 3** as a
  configuration-control matter. Recorded so the round trip is legible: the `noeviction`
  _disqualification_ stays withdrawn (§5.1), and Upstash remains eligible on correctness — but
  we are choosing a store whose configuration we can pin and assert in a test. Self-run is also
  $1.31/month cheaper.

**What Decision 1 does and does not settle (rev 3).** The board approved Fly for **M0–M5
only**, and §5.5b makes that boundary sharper than either of us expected when the card went up:

- **M0–M5 stands.** At ~zero players through M4 the cost is §12's ~$60/month, the egress
  premium is ~$0, and the whole environment is a redeploy to move. The **reversibility** lens
  carries this decision, not the cost model.
- **The India-egress premium is now confirmed rather than contingent.** Decision 3 asked "which
  regions do we serve"; §5.5b shows that on Fly the answer does not change the bill — only the
  audience does, and the brief already fixed it. So the $153 figure is the planning number from
  M5 onward, not a scenario.
- **The M6 shortlist is already reopened**, and §5.5b adds a second, independent reason beyond
  cost: **no Fly region can put a server in India at all.** See §7c and §11.3.

### 7b. Runner-up: Render

Rev 1 made Render the runner-up primarily because its Key Value product exposes `noeviction` in
a dropdown. **Rev 2 removes that advantage** — §5.1 is no longer a gate, so the cleanest pass on
it earns very little. Render's remaining case is a genuinely good managed developer experience
and a same-region Postgres (§5.1b), at 2.25× the cost, and it is still the weakest on Constraint
4 and **disqualified for M6** (§4). Choosing Render is choosing to move providers before the
real-time milestone. With §5.1 withdrawn, **Hetzner H2 is the stronger runner-up on the numbers**
— $41/month, co-located Postgres, effectively free egress — and it loses only on Constraint 3,
per-PR previews, which is a real M0 blocker rather than a preference.

Railway is the best per-PR preview product in the set and a reasonable M0-only choice; it loses on
cost (1.5× Fly), on having no dedicated-vCPU product for a 30 Hz tick at all, and on $0.05/GB. AWS
is the most capable and the most expensive in both money and our attention, and nothing in M0–M5
needs it.

### 7c. M6 — real-time fleet: **this ADR carries no M6 recommendation**

**Stated plainly at the Chief of Staff's request, and rev 3 strengthens it from "do not decide
now" to "this document cannot decide it."** Approving Decision 1 settled M0–M5. It settled
nothing about M6, and anyone reading §7a as an M6 direction is misreading it.

Two independent reasons, either of which alone is sufficient:

1. **Cost.** Serving an Indian real-time audience on Fly is **~$9.74 per concurrent
   player-month** (§4), within 25% of the $12.02 that disqualified Render on arithmetic. The
   same standard applied consistently disqualifies Fly for M6.
2. **Geography.** **Fly has no India region** (§5.5b). Even at an acceptable price, Fly cannot
   put a 30 Hz room server in the country the brief names. The nearest is Singapore at ~60–90 ms
   RTT **[unverified]**, which is not a real-time budget.

Note that reason 1 also undercuts the original _primary_ justification for Decision 1. §7a
reason 1 was that Fly is the only candidate with a native fleet primitive (`fly-replay` +
Machines API). That remains true and remains valuable — but **an option we cannot afford to
exercise in our target market is not an option**, so it should be weighted as a convenience for
M0–M5, not as an M6 hedge. I am flagging this against my own earlier reasoning because the
board endorsed Decision 1 partly on that hedge.

**Provisional direction, for sizing only:** **Akamai/Linode Mumbai** or **DigitalOcean
Bangalore** (§11.3) — the only candidates that combine an India region with bundled transfer.
Hetzner is the cheapest per byte but has no India region either.

**Owner: the M4 real-time spike ([PER-30](/PER/issues/PER-30))**, which is where measured
bytes/s and CPU ms/tick land anyway, feeding the real-time ADR
([PER-21](/PER/issues/PER-21)) alongside Cloudflare Durable Objects (§6). It **must be priced at
India destination rates**. **No M6 spend is approved or requested.**

---

## 8. The $0 topology — **operative again as of 2026-09-30 (rev 4)**

> **Rev 4: this is the operative section.** All provisioning is held and everything is on free
> tiers, so this is the shape that runs. Read §8.5's eight non-proofs as live constraints on what
> M0 can evidence, and §8.7 for the scope of the hold — **answered in rev 5: reading A, free-tier
> signups are permitted, so this topology may be stood up.**
>
> ~~Rev 3: this section is no longer operative … Nothing in §8 should be provisioned.~~
> **Superseded by rev 4.**

**This is the operative section.** No paid tier has been signed up for, no payment method has been
given to any vendor, and none is proposed outside the three discrete asks in §11 — all three of
which are now dormant alongside §12.

### 8.1 The v1 topology on free tiers, with every ceiling named

Chief of Staff asked for a topology that works **through M4**, with the ceilings stated rather
than discovered. Each row gives the ceiling and — the part that matters — **what failure looks
like when we reach it.**

| Component                   | Free option                 | Hard ceiling                                                                                        | What happens at the ceiling                                                                                                                                     |
| --------------------------- | --------------------------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CI                          | GitHub Actions              | Unlimited on a public repo; **2,000 min/month** private                                             | Jobs queue, then fail. Gated on [PER-35](/PER/issues/PER-35) (which repo). Public repo removes the ceiling entirely.                                            |
| `apps/web` + per-PR preview | **Cloudflare Pages**        | **500 builds/month**; bandwidth and requests **unlimited** **[unverified]**                         | Builds blocked until the next month. 500 builds ≈ 16 pushes/day across the whole team — not binding through M4.                                                 |
| `apps/realtime`             | **Render free web service** | **750 instance-hours/month across all free services**; **spin-down after 15 min idle**, ~1 min wake | **The correctness failure. See §8.2.** Sockets drop, live room state is lost, reconnects resume from the Postgres log — if it is awake.                         |
| Redis                       | **Upstash free**            | **256 MB**, **500,000 commands/month**                                                              | Commands are rejected. The room-code registry is unavailable → **nobody can create or join a lobby.** A full outage, not a rehydrate.                           |
| Postgres (tier of record)   | **Neon free**               | **0.5 GB storage**, **100 CU-h/month**, **autosuspend after ~5 min idle**                           | Writes that grow storage fail; compute suspends until the next billing period. **This is the tier of record — an outage here loses matches, not just latency.** |
| Errors / analytics          | Sentry free, PostHog free   | 5k errors/month, 1M events/month **[unverified]**                                                   | Sampling drops events. Non-correctness. Already the plan in [ADR-0001](./0001-v1-stack.md) §8.                                                                  |
| Static egress               | Cloudflare Pages            | **None** — this is the one genuinely uncapped line                                                  | n/a. Worth noting that the single largest cost item in §2.1 (I12, 876 GB/month per U₂₄) is the one free tiers give away.                                        |

**Excluded on purpose, with the reason:**

- **Vercel Hobby** — the Hobby plan is restricted to non-commercial, personal use (§5.6). Not a
  valid target for something we intend to launch, even at $0.
- **Fly.io and Railway** — neither has a free tier. Fly withdrew its free allowance for
  organisations created after 2024-10-07 (new accounts get trial credit only); Railway starts at
  Hobby $5/month. **So the free path and the recommended provider are different providers** — the
  $0 demo is throwaway, not a first step.
- **Oracle Cloud Always Free** — the only genuinely always-on $0 VM, and excluded on the board's
  own instruction plus a technical fact. (a) Signup **requires a credit/debit card** for identity
  verification; the board said no cards. (b) The Always Free Ampere allowance was **halved to 2
  OCPU / 12 GB on 2026-06-15** with no announcement. (c) Oracle **reclaims idle instances** —
  defined as 95th-percentile CPU _and_ network _and_ memory utilisation all below 20% over 7 days,
  which is exactly the profile of a lightly loaded room server. A host that reclaims the box is
  the same failure as one that sleeps it, only slower and less predictable.

### 8.2 The ceiling that bites first — and it is not a quota

Ranked by when it bites, not by size:

1. **Render free spins `apps/realtime` down after 15 minutes without traffic. This bites on day
   one and it is a correctness failure, not a latency one.** For a stateless web app a
   spin-down is a cold start. For a room runner holding authoritative state over persistent
   sockets it is: every socket dropped, every in-memory room gone, every chess clock stopped.
   The player is then told something that is not true until a rehydrate completes. **Blast
   radius lens:** a cold start we would happily tolerate on the web tier is disqualifying on the
   game tier, and that asymmetry is the whole content of this row. Partially mitigated — a live
   game's own WebSocket traffic counts as activity, so a game in progress keeps the service
   awake; it is the _quiet_ periods, and the board's first click, that lose.
2. **Render free's 750 instance-hours/month makes two environments arithmetically impossible.**
   730 h/month × 2 environments = **1,460 h against a 750 h allowance**, before the spin-down
   rule is even considered. This is the direct answer to "can staging share production's box":
   **on Render free there is only one box, and it sleeps.**
3. **Upstash free: 500,000 commands/month.** At the 10 s presence heartbeat of
   [ADR-0001](./0001-v1-stack.md) §6, one player is 0.1 commands/s = 259,200/month. So:

   ```
   one 2-player lobby left open 24/7   0.2 cmd/s × 2,628,000 s  =  525,600/month  →  the entire quota
   20 concurrent players, 2 h/day      20 × 0.1 × 7,200 × 30    =  432,000/month  →  86% of the quota
   ```

   **The free Redis supports roughly 20 concurrent players for two hours a day.** Mitigation that
   costs nothing: raise the heartbeat to 25 s **on the free staging environment only** (2.5×
   headroom). That is safe on Render, which has no fixed idle timeout — but it is _not_ safe on
   Fly, whose ~30 s idle timeout the 10 s heartbeat exists to beat (§5.2). Environment-specific,
   and it must be a config value, not a constant.

4. **Neon free: 0.5 GB on the tier of record.** The match log grows ~120 B/row (§2.1). At 20
   concurrent players (10 rooms, 2 actions/s) that is **~630 MB/month at 24/7, ~170 MB/month at
   the I3 duty cycle** — so the storage ceiling arrives in **under one month of continuous demo
   use, or about three months of realistic use.** It bites on the one tier we cannot lose, which
   makes the match-log retention policy ([PER-15](/PER/issues/PER-15)) a $0-topology requirement
   rather than an M3 nicety.
5. **Neon free: 100 CU-h/month.** At the 0.25 CU floor that is ~400 active-hours/month, i.e.
   ~13 h/day of non-suspended database. Generous for a demo, and it interacts badly with §5.1b:
   keeping Neon awake to meet the append budget is what burns the CU-hours.

**Answer to the board's question, in one line: the ceiling that bites first is Render's 15-minute
spin-down, on day one, and it is the only one on this list that produces a wrong answer rather
than an error.** Everything else fails loudly.

**How far this topology carries us.** M0 (with the AC1 caveat in §8.4) and M1 comfortably; M2
Chess comfortably, since chess is 2-seat and turn-based; **M3 is where it starts to lie**, because
M3 is resilience and spectators and the free tier cannot demonstrate either honestly — a
spectator is +1 fan-out recipient against a 500K command quota, and reconnection is being tested
against a server that is itself the thing disappearing. M4 (SDK docs + real-time spike) is fine
on free tiers because the spike is a measurement harness, not a deployment. **So: $0 carries us
to the end of M2 and makes M3 evidence untrustworthy.**

### 8.3 The always-on WebSocket process — the line item $0 cannot cover

Routed in from [PER-7](/PER/issues/PER-7) at design time, credit to Platform Engineer for
raising it before writing deploy config. Three questions were asked; each is answered with a
number.

**Q1 — cheapest always-on host for one small WebSocket process, per environment.**

| Option                                     | $/month, one always-on process | Verdict                                                                                                                                    |
| ------------------------------------------ | -----------------------------: | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Cloudflare Workers + Durable Objects       |                         **$0** | **The only $0 option that is not a correctness failure** — and it costs a runtime port. See below.                                         |
| Oracle Cloud Always Free                   |                             $0 | **Excluded** — card required, idle reclamation (§8.1)                                                                                      |
| **Fly.io `shared-cpu-1x` / 512 MB, `iad`** |                      **$3.84** | **Recommended.** $1.97 vCPU + **0.25 GB billable** × $6.09 (I15) = $3.49, × 1.1 regional = **$3.84** — within 2% of Fly's published $3.89   |
| Fly.io `shared-cpu-1x` / 256 MB            |  $2.17 (~$2.02 vendor-quoted)  | The published floor, and **too small for a room server** — 2,000 rooms × 64 KB (I9) is 128 MB before Node's own heap. Quoted, not planned. |
| Railway Hobby                              |                          $5.00 | Includes $5 of usage; a 512 MB Node process meters at roughly $5–7                                                                         |
| Render Starter                             |                          $7.00 | Per service, no spin-down. Simplest migration from the free tier.                                                                          |
| Hetzner CPX22 (2 vCPU / 4 GB)              |                          $8.63 | Most capacity per dollar, and we own the OS, the TLS renewal and the absent preview system                                                 |

> **Rev 7 (review finding F4): the Fly rows above were ~45% too high, and this table contradicted
> both §12.2 and Fly's own list price.** Rev 2–6 priced 512 MB as `$1.97 + 0.5 GB × $6.09`, which
> bills the full nameplate RAM and so double-counts the **0.25 GB included with every shared vCPU**
> (I15) — the same rule §3.1 applies correctly. The error was visible without any external check:
> the table used to price 256 MB at $2.02 and 512 MB at $5.52, **a $3.50 step for 0.25 GB of RAM**,
> 2.3× its own stated $6.09/GB rate. Corrected, the step is $1.67 and the 512 MB figure lands
> within 2% of Fly's published price. **§3.1 and §12.2 were right; §8.3 was wrong**, not the other
> way round. This matters beyond tidiness because §13.5 directs the M3 ask to be assembled from
> §11.1, which took its production line from this table.

**Q2 — can staging share production's box, or be spun up on demand?**

- **Sharing one box: rejected on blast radius.** Two processes on one VM means a staging deploy
  can OOM or restart production. It saves $3.84/month. That is not a price worth paying to make
  a production outage possible, and it is exactly the trade this ADR exists to make visible.
- **On demand: yes, and this is the answer.** Fly's autostop/autostart stops a Machine when
  traffic drains and restarts it on the next request. **Stopped Machines are not billed for CPU
  or RAM — only for rootfs, at $0.15/GB-month.** So a staging Machine with a 1 GB rootfs costs
  **$0.15/month asleep**, plus per-second compute while awake:

  ```
  staging, awake ~2 h/day   (2 ÷ 24) × $3.84  =  $0.32   +  $0.15 rootfs  =  $0.47/month
  production, always on                                                   =  $3.84/month
                                                                            ───────────
                                                                            $4.31/month
  ```

  **≈ $4.31/month buys a correct always-on production WebSocket server and an on-demand staging
  one** — rev 7's corrected figure; revs 2–6 said $6.13 for the same shape. That is the whole gap
  between the current $0 position and a topology with no known correctness failure in it. **The
  board approved §11.1 at "up to $7/month", so the correction does not change any ask** — it makes
  the ask smaller than its authority.

**Q3 — can staging legitimately sleep while only production is always-on, and what does that
cost in pre-production confidence?**

Yes — with five things named, because a sleeping staging environment cannot evidence them:

1. **Reconnect-and-resume after a long quiet period** — the core M3 surface
   ([PER-29](/PER/issues/PER-29)).
2. **Deploy drain** — whether a live match survives a rolling deploy. §5.2 establishes that
   _every_ provider drops WebSockets on deploy, so this is the mechanism that makes deploys
   invisible, and it is untestable where the server sleeps anyway.
3. **Timer correctness across an idle window** — the sharp one. A chess clock must keep running
   while nobody moves, which is precisely the condition that puts a free instance to sleep. The
   timer service ([PER-17](/PER/issues/PER-17)) is a server-authoritative correctness surface and
   **cannot be validated on sleeping compute.** Mitigation that costs $0: the local
   `docker-compose` stack does not sleep, so timer tests run there and in CI, and staging is not
   claimed as evidence for them.
4. **Memory drift over days of uptime** — the real value of I9, hence rooms-per-instance.
5. **Action round-trip p95** — per [ADR-0001](./0001-v1-stack.md) §11.2 item 3, a p95 measured
   across a cold resume measures the vendor's idle policy, not our code.

**The rule this produces: staging may sleep, production may not, and no non-functional target is
ever evidenced from sleeping compute.** Items 1–4 move to the local stack and to CI; item 5 moves
to §11.2's load-test window.

**Q4 — the per-1,000-players number against the tier that clears Q1.** Fly.io: **$100/month per
1,000 concurrent turn-based players** ($0.100 per concurrent player-month), derived in §3.1. Note
what §2.1 established — that is a floor, not a rate. The same $100 serves 100 players or 1,000,
and 2,000 costs $111.

**The $0 alternative that is real: Cloudflare Durable Objects.** It deserves a number rather than
a shrug, because it is the only always-on-at-$0 path that does not fail on correctness. Durable
Objects are on the Workers **free** plan, need **no payment card**, and their WebSocket
Hibernation API evicts an idle object from memory **without dropping its sockets** — so idle is a
designed-for state rather than a failure mode, which is the exact property every other free tier
lacks. Free-plan ceiling, worked through:

```
free requests            100,000/day
inbound WS messages      billed at a 20:1 ratio → 20 messages = 1 billable request
10 s heartbeat           8,640 messages/player-day ÷ 20   =  432 billable requests/player-day
sustainable concurrency  100,000 ÷ 432                    ≈  231 concurrent players, 24/7
free duration            13,000 GB-s/day, and hibernated time is not billed at all
```

**~230 concurrent players, always-on, $0, no card** — an order of magnitude more than the
Upstash-bounded 20 the rest of the $0 topology supports. What it costs instead is a **runtime
port**: the Workers runtime is not Node, so `ws`, `ioredis`, `pino` and the `pg`/Drizzle path in
[ADR-0001](./0001-v1-stack.md) §§4–6 all need replacements, and per that ADR a change of major
tech choice is itself board-gated. Estimate: **5–8 engineer-days**, plus an unmeasured risk
against the 30 Hz tick budget in M6 (§6). At an internal cost of a single engineer-day that is
strictly worse value than the ≈ $5/month in §11.1 — **which is the argument for §11.1, and it is an argument
from numbers rather than from taste.** The design constraints that keep this option open at zero
cost (transport behind the `packages/netcode` adapter, no Node-only APIs in `packages/platform-core`,
an injected logging sink) are already imposed on [PER-7](/PER/issues/PER-7).

### 8.4 What this demonstrates, against M0 AC1, AC2 and AC5

- **AC2 — a WebSocket round trip on staging: yes, fully.** A Render free web service running
  `apps/realtime`, hit from a Cloudflare Pages `apps/web`, is a real round trip over a real
  network on a real URL.
- **AC5 — a staging link for the board: yes, with one caveat.** Render free spins a service down
  after 15 minutes without inbound traffic. WebSocket messages now count as traffic, so a live game
  stays awake — but the board's _first_ click hits a cold service and waits ~50 s. That is a
  visible violation of the "< 10 s to playable" product principle in the one demo whose job is to
  show the product principle. Mitigate with a cron ping before a board session, and say plainly in
  the link that it is a free-tier artefact.

  > **Rev 6 — AC5's staging-link half is reachable at $0, and its gate is no longer purely the
  > payment instrument.** §13.7's carve-out lets the board's pre-existing Cloudflare connection host
  > `apps/web` on Pages for free; [PER-111](/PER/issues/PER-111) executes it. Two things follow.
  > **First, the caveat above changes shape rather than disappearing:** Pages serves static assets
  > from the edge, so there is no 15-minute spin-down and no ~50 s cold start on the web half — but
  > `apps/realtime` is not in the exception, so a link that serves `apps/web` alone shows a shell
  > with no live game behind it. **Second, and this is the binding one
  > ([ADR-0009](./0009-m0-websocket-transport-probe.md) §4): the AC5 caption must not imply the link
  > is playable.** `apps/web` is not a playable game. AC5's other two halves — the video/GIF and the
  > written status report — remain CTO's.

- **AC1 — a preview deploy per PR: this is the sharp edge, and rev 4 splits it in two, because the
  two halves have different gates and reporting one verdict hides that.** AC1 as written on
  [PER-3](/PER/issues/PER-3) is a conjunction: _"a pull request runs full CI **and** produces a
  working preview deploy."_

  - **AC1a — a PR runs full CI. Not met, and not gated by money at all.** The seven-gate pipeline
    exists, and `scripts/deploy/deploy.mjs` resolves an unset `DEPLOY_PROVIDER` to the `none`
    provider and exits 0, so the whole pipeline is green at $0 with no vendor account. What is
    missing is that `.github/` is not on `main` — the workflows live on one unmerged branch, so a
    PR from any other branch currently runs **no checks at all**. The unblock is a merge, not a
    purchase. Owned by [PER-6](/PER/issues/PER-6).
  - **AC1b — a working preview deploy per PR. Not met, and the isolation property is not buyable
    under the hold.** Be precise about what costs money: Cloudflare Pages gives a genuinely free
    per-PR preview of `apps/web`. What requires spend on every candidate except a self-built
    Hetzner path is **end-to-end isolation** — the preview's own realtime service, Redis and
    Postgres, so that one PR's schema change cannot break another PR's preview. So the accurate
    record is not "previews need a paid tier"; it is **"the isolation property that makes a
    preview trustworthy needs a paid tier"**. **Rev 5:** the free web half **may** be stood up —
    §8.7 resolved to reading A — so Cloudflare Pages per-PR previews of `apps/web` are available
    at $0. That is AC1a's territory and it does not make AC1b met; the isolation property is still
    unbuyable under the hold.

  **A shared long-lived staging URL redeployed per PR must not be recorded as satisfying AC1b.**
  It is the substitution that costs the criterion its entire point: AC1b exists so that a
  reviewer's verdict is about _this_ PR's code in isolation. A shared environment means the last
  merge decides what the reviewer sees.

### 8.5 What it does not prove — stated plainly

1. **Nothing about the < 150 ms p95 target, and this is now a recorded board consequence rather
   than a caveat.** Free instances are cold-start-prone and share CPU with strangers; a cold
   resume lands in the p95 and measures the vendor's idle policy, not our code
   ([ADR-0001](./0001-v1-stack.md) §11.2 item 3, accepted by the board as a consequence of $0).
   The number must come from local infrastructure or from the §11.2 window. **Nobody should read
   a green free-tier staging demo as evidence for or against this target, in either direction.**
2. **Nothing about the ≤ 10 ms p95 durable log append** (§5.1b). The $0 topology fails that
   budget structurally — cross-provider hop plus Neon autosuspend — so M0 cannot evidence it and
   Decision 4 in §10 cannot be resolved from staging data.
3. **Nothing about 2,000 rooms per instance.** Free instances are 512 MB. I9 stays unmeasured.
4. **Nothing about Redis behaviour under our own configuration.** Upstash free exposes no
   `redis.conf`. Per §5.1 this is no longer a correctness problem — an evicted key is a rehydrate
   — but it does mean the free tier evidences nothing about how the cache behaves under memory
   pressure, and the rehydrate path itself therefore goes untested at scale.
5. **Nothing about restart survival under load.** The mechanism in
   [ADR-0001](./0001-v1-stack.md) §6 can be unit-tested, but not exercised at 500 rooms on a free
   tier.
6. **Nothing about real-time egress.** 500k Redis commands/month is ~0.19 ops/s sustained. §4
   stays a projection.
7. **Nothing about the deploy story**, because a shared staging service redeployed by hand is not
   the per-PR isolation AC1 asks for.
8. **Nothing about timer correctness across an idle window** (§8.3 Q3 item 3) — the one place
   where a sleeping environment does not merely fail to prove something, but would actively
   produce a wrong result.

### 8.6 Interim recommendation

Stand the free path up now so [PER-6](/PER/issues/PER-6)/[PER-7](/PER/issues/PER-7) are not idle;
mark M0 AC1 explicitly **partially met** rather than quietly met; test timers and reconnection
against the local `docker-compose` stack rather than staging; and do not let a green free-tier
demo be read as evidence for any non-functional target. **If the board approves §11.1's
$6–7/month, replace the Render free service with a Fly Machine before M3** — that is the
milestone where free-tier evidence stops being merely incomplete and starts being misleading.

> **Rev 4: §11.1 is approved and unspendable, so read that last sentence as a deadline rather
> than a contingency.** The board has ratified far more than $6–7/month; the hold is what stops
> it. M3 is the milestone at which the hold stops costing us evidence and starts costing us
> correctness, and that is the moment to come back to the board rather than absorb it.
>
> **Rev 5: this paragraph is now actionable rather than hypothetical.** §8.7 resolved to reading
> A, so the four free accounts may be created and the first sentence above is an instruction, not
> a proposal. The deadline in the rev-4 note is confirmed: **the board has set M3 as the point at
> which the hold comes back**, so "replace the Render free service with a Fly Machine before M3"
> and "re-ask at M3" are the same event.

### 8.7 The scope of the hold — **answered 2026-09-30: reading A, free-tier signups are permitted** (rev 5) {#the-scope-of-the-hold}

> **Answer, and it is the operative line of this subsection.** The board resolved this on
> [PER-38](/PER/issues/PER-38): the hold forbids **paid** accounts, cards on file, paid tiers and
> trials. It does **not** forbid creating a free-tier account that requires no payment
> instrument. **§8.1's topology may be stood up.** The question below is kept because the
> reasoning is what produced the answer, and because the distinction recurs every time someone
> reads "no vendor account" literally.
>
> **Boundary, stated once so it is not re-litigated per vendor:** permitted is a signup that
> completes with no card and no trial clock. A free tier that demands a card "for verification",
> or that auto-converts to paid, is **not** permitted and comes back to the board instead. None of
> the four accounts in §8.1 requires one — **[unverified]**, owner **Platform Engineer, at the
> signup screen** (rev 7, review finding F5).
>
> **Rev 7 tags that last clause and adds the procedure, because it is the only sentence in this ADR
> standing between an engineer and a board-gate violation, and it carried no tag** in a document
> that tags Cloudflare's build limit and PostHog's quota. Two of the four are the ones not to bet
> on sight-unseen: **Upstash**, which has moved Redis toward pay-as-you-go with a free monthly
> allowance on some plans — if what is on offer is a metered plan with a free allowance rather than
> a hard cap, that **is** the auto-converts-to-paid case this boundary excludes; and **Neon**, which
> has the same shape of risk. Cloudflare Pages and Render are expected to be fine on a
> `*.pages.dev` / free-web-service path — noting that a **custom domain** pulls Cloudflare toward a
> card, and the domain is itself board-gated, so those two gates guard each other.
>
> **What to do when a vendor demands a card mid-setup, so nobody has to improvise it:** stand up
> whichever of the four clear the test, **stop at the one that does not**, and report it on
> [PER-38](/PER/issues/PER-38). **Do not substitute a vendor that is not in §8.1** without CTO
> sign-off — §8.1's four are costed and constraint-checked and a fifth is not. Note the asymmetry
> this creates: a card demand on Upstash or Neon halts the **topology**, not one row, because §8.1
> names no alternate for Redis or Postgres. That is a real escalation, not a blocker to engineer
> around. _(This is the reviewer's stated assumption on [PER-84](/PER/issues/PER-84), adopted here
> as the rule rather than left as an assumption.)_
>
> **Rev 6: one of the four already exists, and this ADR was wrong to imply otherwise.** The
> Cloudflare connection was created **by the board on 29 Sep**, the day before the hold. It is not
> a signup we need permission for; it is an account we already had while this document was asserting
> we had none. The board has ruled on what may be done with it — §13.7 — and the ruling is narrower
> than "Cloudflare is open": **free Cloudflare Pages hosting of `apps/web` only.**

The hold was relayed in two sentences that cannot both be complied with literally:

1. _"No vendor account, no card on file, no paid tier, no trial, on any provider — Fly and
   Hetzner included."_
2. _"Everything stays on the free topology you costed in ADR-0003 rev 2 §8.1."_

> **Rev 6 corrects a third problem with sentence 1 that revs 4 and 5 missed.** The conflict above
> is about what sentence 1 _permits_. But sentence 1 also makes a **claim of fact** — "no vendor
> account … on any provider" — and that claim was **already false when it was relayed**, because
> the Cloudflare connection had been created the previous morning. Revs 4 and 5 repeated the claim
> as though it described our state. It never did. Sentence 1 is retained verbatim above because it
> is a quotation of the instruction and quotations are not edited; **it is not evidence about what
> accounts exist**, and nothing downstream should treat it as such.

**§8.1's topology is four vendor accounts** — Cloudflare Pages, Render, Upstash, Neon — all on
free tiers, none requiring a card. So the two readings are:

| Reading                                                                                  | Consequence for M0                                                                                                                                                                                  |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A — "no _paid_ account"**: free-tier signups are permitted, which is what §8.1 assumes | AC2 (WebSocket round trip on staging) and AC5 (staging link) are **demonstrable**, with §8.4's cold-start caveat. AC1a is demonstrable. AC1b stays unmet. **Three of five criteria reachable.**     |
| **B — "no account of any kind"**: literal                                                | There is no staging environment, so **AC2 and AC5 are also not met** and there is no board demo at all. Only AC3 and AC4 — both purely in-repo — are reachable. **Two of five criteria reachable.** |

It mattered beyond wording: the M0 sign-off question before the board was framed around AC1 alone,
and **under reading B it would have been a question about AC1, AC2 and AC5.** The distinction also
had a real cost asymmetry — reading A costs $0 and is reversible by deleting four free accounts;
reading B would have cost M0 its demo.

**Reading A is the answer, so the posture is:** stand up §8.1's four free accounts and get AC2 and
AC5 evidenced; keep AC1a moving on [PER-6](/PER/issues/PER-6), where the unblock is a merge rather
than a purchase; record AC1b as **not met** and leave it to the hold. Correctness work that a paid
staging environment would have validated is still validated against the local `docker-compose`
stack, per §8.6 — reading A changes what we can demo, not what we can prove.

---

## 9. Evidence, and what is owed

Everything in §3 is arithmetic over published list prices checked on 2026-09-30 and the model
inputs in §1. **List prices are quotes, not measurements**, and three of them are marked
**[unverified]** and must be confirmed before any commitment: Render's ~4 GB Postgres tier, a
managed Redis tier for Hetzner H1, and Render's compute pricing above the Standard instance.

> **Rev 7 — this ADR has been independently re-derived, and that is worth recording as evidence
> rather than as process.** The [PER-84](/PER/issues/PER-84) review reproduced §2.1, §2.2, §3.3,
> §3.5, §4's AWS tiered-egress stack, §9's entire sensitivity table and §12.2's three subtotals
> from §1's inputs, and checked §5.5b's two load-bearing Fly facts against Fly's live
> documentation. **Those all reproduce.** It also found eight defects, two of which were wrong in
> a direction that mattered — §4's Hetzner egress line and §8.3's Machine price — both fixed in
> rev 7 and both listed in [What changed in rev 7](#what-changed-in-rev-7). A model nobody
> re-derives is a sticker price with extra steps; this one has now been re-derived by someone who
> did not write it.

> **Rev 2 adds five more unverified lines**, none of which affects §3 or §4: Cloudflare Pages'
> 500-builds/month limit (§8.1), Sentry and PostHog free quotas (§8.1), whether Fly Managed
> Postgres prorates below a month (§11.2), Akamai/Linode and DigitalOcean Mumbai list prices
> (§11.3), and AWS `ap-south-1` egress (§11.3). **One rev-2 number is a model, not a quote and
> not a measurement: the cross-provider append p95 in §5.1b.** It is decomposed into its terms
> so the reasoning can be attacked, but the only thing that settles it is a measurement, and
> §11.2's Test A is the cheapest way to get one.

> **Measurement owed.**
>
> | #        | What                                                                 | Owner             | Issue                                                       | Needed by                    |
> | -------- | -------------------------------------------------------------------- | ----------------- | ----------------------------------------------------------- | ---------------------------- |
> | I7       | Bytes per delivered turn-based message on the wire                   | Platform Engineer | [PER-15](/PER/issues/PER-15)                                | M1                           |
> | I9       | Memory per live turn-based room, hence rooms per instance            | Platform Engineer | [PER-14](/PER/issues/PER-14) / [PER-15](/PER/issues/PER-15) | M1                           |
> | —        | Action round-trip p95 from a real staging deploy                     | Platform Engineer | [PER-7](/PER/issues/PER-7)                                  | M0                           |
> | I10, I11 | Real-time bytes/s per client and CPU ms/tick per 12-player room      | CTO / QA          | [PER-30](/PER/issues/PER-30)                                | M4                           |
> | rev 3    | **Mumbai↔Singapore p95 RTT** — now load-bearing, not routine (§5.5b) | Platform Engineer | [PER-7](/PER/issues/PER-7)                                  | **M0, first deploy**         |
> | rev 3    | **Is Fly Managed Postgres offered in `sin`?** Precondition of §7a    | Platform Engineer | [PER-7](/PER/issues/PER-7)                                  | **before provisioning**      |
> | rev 3    | **Does Fly autostop drop an open WebSocket?** §12.2 depends on no    | Platform Engineer | [PER-7](/PER/issues/PER-7)                                  | **M0, first staging deploy** |
> | rev 3    | **Actual Fly spend vs §12's ~$60/month estimate**                    | CTO               | [PER-38](/PER/issues/PER-38)                                | before the M5 step-up        |
> | rev 7    | **`sin` regional multiplier** — §12.2 applies none; §3.1 says 1.0–1.615 | Platform Engineer | [PER-7](/PER/issues/PER-7)                             | **before the first resource** |
> | rev 7    | **Does any of §8.1's four free tiers demand a payment card?** The only claim guarding a board gate (§8.7) | Platform Engineer | [PER-6](/PER/issues/PER-6) / [PER-7](/PER/issues/PER-7) | **at the signup screen**     |
> | rev 7    | **Hetzner CCX33's EU included traffic** — §3 uses 20 TB, §4 uses 30 TB (§3.4) | CTO               | [PER-30](/PER/issues/PER-30)                                | before any M6 commitment     |
>
> Until I7 and I9 land, §3 rests on the capacity model in
> [ADR-0001](./0001-v1-stack.md) §6. Until I10 and I11 land, **§4 is a projection against a budget
> we set**, and it is labelled as such everywhere it appears.
>
> **Rev 6 — the labelling rule, promoted here because it has now been needed three times.** Every
> row in this table is owed **against Fly.io**, which is the ratified provider (§7a). A number
> measured anywhere else does not discharge the row. Specifically:
>
> - A figure from the Cloudflare Pages staging link permitted by §13.7 measures **Cloudflare's edge
>   on a free tier**. It is a real number and it may be published — **labelled with the provider and
>   the tier it was measured on** — but it **does not** close the "action round-trip p95 from a real
>   staging deploy" row, or any other row here.
> - The same applies to every free-tier figure under §8: Render free, Upstash free, Neon free.
> - **A substituted number is worse than a missing one**, because a missing number is visibly owed
>   and a mislabelled one looks discharged. The Fly equivalents stay **owed**, due at the M3 revisit
>   (§13.5). The guard has already been posted on [PER-7](/PER/issues/PER-7) and
>   [PER-15](/PER/issues/PER-15).

**Sensitivity — which inputs actually move the answer.** This is what makes §3 and §4 a model
rather than a quote:

| Change                                    | Effect on turn-based                             | Effect on real-time                                |
| ----------------------------------------- | ------------------------------------------------ | -------------------------------------------------- |
| Double concurrency, 1,000 → 2,000 players | Fly $100 → **$111** (+11%) — the floor dominates | Fly $1,853 → **$3,706** (+100%) — egress is linear |
| I7 wrong by 2.5× (600 B → 1.5 KB)         | Fly $100 → **$112** (+12%)                       | n/a                                                |
| I10 30 KB/s → 10 KB/s design point        | n/a                                              | Fly $1,853 → **$802** (−57%)                       |
| I3 duty cycle 1.0 → 0.27                  | Fly $100 → $92 (−8%)                             | Fly $1,853 → **$703** (−62%)                       |
| Drop the free CDN assumption (I12)        | **+$18 Fly, +$131 Render**                       | n/a                                                |

The board's two actionable levers are therefore: **for turn-based, nothing — it is a floor**; and
**for real-time, bytes on the wire ($1,051/month) and where those bytes leave from
($1,725/month)**, per 1,000 concurrent players.

> **Rev 3 amends that last sentence.** "Where those bytes leave from" turns out **not** to be a
> lever on Fly, because egress is destination-priced (§5.5b) — it is a lever only by changing
> provider, not by changing region. And **"for turn-based, nothing" was answering the wrong
> question**: it is true at a fixed instance size, and the board was asking about instance size.
> §12.1 corrects it. The honest summary is: **the levers are bytes on the wire, and which
> provider — not which region.**

---

## 10. What the board decided — **answered 2026-09-30**

> **Rev 3: this section is now a record, not a request.** The board answered on the decision
> card on [PER-2](/PER/issues/PER-2). The approval object
> [63d288d2](/PER/approvals/63d288d2-8c4f-4694-b2d3-8921db8ac967) remains `pending` because the
> board answered the card rather than the record; per Chief of Staff, the card is the authority.
> The four decisions as originally posed are preserved below with the answer against each, so
> the reasoning that produced them stays auditable.

### 10.0 The decisions, and the answers

| #              | Question                                 | **Board's answer**                                                                                                                     |
| -------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| **Decision 1** | Provider                                 | **Fly.io, for M0–M5 only.** All three §7a conditions carry, including self-run Redis (reinstated). M6 explicitly not settled — §7c.    |
| **Decision 2** | The priced asks                          | **Superseded by a phased budget.** $120/month now → **$250/month at M5**, **$400/month ceiling** throughout. §11.2 and §11.3 unfunded. |
| **Decision 3** | Regions                                  | **Deferred to M5**, interim environments in Mumbai. **Partly void — see §5.5b**; substituting `sin`, and on Fly region ≠ cost anyway.  |
| **Decision 4** | Durability: ≤ 10 ms p95 log append at $0 | **Resolved to option (a)** automatically — co-located Fly Managed Postgres is bought, so group commit is not needed. Closed.           |

### 10.1 What the board asked back, and the answers

1. **"Confirm or correct my ~$153 / ~$9,733 Mumbai re-derivation."** **$153 confirmed exactly at
   $152.60; $9,733 confirmed to within rounding — the exact figure is $9,737.80, carried as
   $9,738** (rev 7 — revs 3–6 said "confirmed to the dollar" of both, which was true of the first
   and not of the second) — derivations in §3.6 and §4. **Premise corrected:** these are what Fly costs to
   serve an Indian _audience_ from _any_ region, not a Mumbai-region surcharge (§5.5b). The
   practical difference is that they cannot be avoided by hosting elsewhere, so $153 is the M5
   planning number rather than a scenario.
2. **"Can minimum production + staging + previews be bought for $120/month?"** **Yes —
   ≈ $60/month, half the authority** (§12). The cheaper shape Chief of Staff put to the board is
   real and should not be withdrawn. **I am correcting my own "~90% fixed" finding**, which was
   true of cost _within_ a 1,000-player instance and not of the instance size itself.
3. **"Deploy interim environments in Mumbai (`bom`)."** **Cannot comply** — §5.5b. Deploying to
   `sin` instead and recording the latency consequence as a measurement owed.

### 10.2 What is still open

| Item                                                     | Owner                                            | Gate                                                                             |
| -------------------------------------------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------- |
| **M6 provider**, priced at India destination rates       | M4 spike [PER-30](/PER/issues/PER-30) → ADR-0006 | M6 board gate. **§7c: not carried by this ADR.**                                 |
| **M5 load-test window** — $8 capacity / $100 cap for p95 | CTO                                              | Re-raise at M5. Not funded by the $120 (§11.2).                                  |
| **Re-price production from measured numbers before M5**  | CTO + Platform Engineer                          | Blocks the $120 → $250 step. §12.3 shows the M5 shape lands at ~$212, not $238.  |
| **Is Fly Managed Postgres available in `sin`?**          | Platform Engineer [PER-7](/PER/issues/PER-7)     | **Before any resource is created.** Precondition of §7a's co-location condition. |

**Superseded text from rev 2, kept for the record:** rev 1 requested $250/month with a $400
ceiling; rev 2 withdrew that in full and asked for $6–7/month against a $0 budget. **Rev 3
supersedes both** — the board set $120/month now and $250/month at M5, and §12 spends ~$60 of it.

### 10.3 The four decisions as originally posed (archive)

> Kept verbatim so the board's answer in §10.0 can be read against the question it answered.
> **Every item below is now decided — do not action this subsection.**

**Decision 1 — provider, for the day a budget exists.** Recommendation: **Fly.io**, with the
conditions in §7a (server-side heartbeat; co-located Fly Managed Postgres). Alternatives:
Hetzner H2 (cheapest at $41, co-located data, fails per-PR previews as bought), Render (simplest,
2.25×, disqualified for M6), Railway (best previews, 1.5×, no dedicated CPU), AWS (most capable,
2–3×, most of our attention). **Not urgent** — nothing is blocked on it while §11.1 is unanswered.

**Decision 2 — the three discrete asks in §11.** Each is independent; approving one does not
commit the board to the others.

| Ask                                             | Shape            |                                     Number | Recommendation                                     |
| ----------------------------------------------- | ---------------- | -----------------------------------------: | -------------------------------------------------- |
| §11.1 Always-on `apps/realtime`, prod + staging | standing monthly |                             **$6–7/month** | **Approve.** Smallest and most urgent of the three |
| §11.2 M5 load test window                       | one-off          | **$8** capacity / **$100 cap** for the p95 | Approve the $8 now; defer the $100 to M5           |
| §11.3 Mumbai-region M6 fleet                    | standing monthly |              **$75/month** pilot (M6 only) | **Defer to the M6 gate.** Costed, not requested    |

**Decision 3 — which regions v1 serves.** Raised in §5.5 as a question the board may not realise
it is answering, and reinforced by §11.3. It is a product decision with a cost: if the answer is
India, **Fly's $0.12/GB India egress is 6× its NA/EU rate**, which adds $53/month per U₂₄
turn-based and **$7,900/month** per U₂₄ real-time, and it changes the answer to Decision 1.

**Decision 4 — durability at $0: does the action hot path keep its ≤ 10 ms p95 log append?**
New in rev 2, forced by [ADR-0001](./0001-v1-stack.md) rev 2 §6.2 landing a synchronous durable
write on the action path while the budget is $0. §5.1b shows the free topology cannot meet it.
Three options, and this is a durability decision rather than a tuning knob, so it is the board's:

| Option                                            | Cost                           | Consequence                                                                                                                            |
| ------------------------------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| **(a) Buy co-located Postgres** — **recommended** | included in §11.1's $6–7/month | Budget met (~3–5 ms modelled). No design change. Cheapest of the three.                                                                |
| (b) Group-commit the log over a ~10 ms window     | $0                             | Bounded added latency per action; **the durability story changes** — an acknowledged action may not yet be on disk. Needs its own ADR. |
| (c) Accept an unmeasured append p95 through M0–M2 | $0                             | M0 evidences nothing about it and the debt lands in M3, the milestone that already cannot be evidenced at $0 (§8.2).                   |

**Not requested here:** any M6 spend, any vendor signup, any domain purchase, any payment card on
file beyond what Decision 2 explicitly authorises. M6 hosting stays gated with M6 itself.

~~**Until the board answers**, [PER-6](/PER/issues/PER-6) and [PER-7](/PER/issues/PER-7) proceed
as far as the $0 topology in §8 allows.~~ ~~**Superseded — see §12.2 for what they may now
provision.**~~ **Rev 5: un-superseded.** The provisioning release in §12.3 is withdrawn (§13), so
the struck sentence above is operative again and is the correct instruction: PER-6 and PER-7
proceed as far as §8's $0 topology allows, which under reading A of §8.7 now includes standing the
four free accounts up. M0 AC1 is recorded as **not met** — the board accepted that framing rather
than "partially met" when it signed off M0.

### 10.4 The hold's scope and the revisit cadence — **answered 2026-09-30** (rev 5)

Two follow-up questions from rev 4, both now closed. Neither changes the provider, the arithmetic,
or the dormancy of §12.

| Question                                                    | Answer                                                             | Where it lands                                                               |
| ----------------------------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| Does the hold forbid a free-tier signup that needs no card? | **No — reading A.** Free-tier accounts are permitted.              | §8.7. M0 goes from two of five criteria reachable to **three of five**.      |
| When does the hold come back to the board?                  | **M3**, as a standing instruction on [PER-29](/PER/issues/PER-29). | §13.5, §13.6. Escalate sooner only on an M1/M2 _unachievability_, not a gap. |

**Also recorded by the board at sign-off:** M0 is accepted with **AC1 recorded as not met**. That
is the stricter of the two available records and it is the right one — naming an unmeetable
criterion is cheaper now than discovering at M5 that a green tick meant a shared staging URL.

---

## 11. What $0 cannot buy — three priced proposals

Chief of Staff asked for these as **discrete proposals**, each one approvable on its own. They
are ordered by urgency, not by size. ~~Only §11.1 is being asked for now.~~

> **Rev 3 status of each ask.** **§11.1 is granted and superseded** — the board's $120/month
> covers it many times over, and §12 is the version to build against. **§11.2 (M5 load test,
> $8 / $100 cap) is unfunded** and must be re-raised at M5. **§11.3 (India fleet, $75/month) is
> unfunded and deferred to the M6 gate** — and §5.5b makes it more important than it was, since
> it is now the _only_ route to a server in India.

### 11.1 An always-on process for `apps/realtime` — **≈ $5/month corrected (rev 7); approved at $7**

**The problem, in one sentence:** every free compute tier sleeps on idle, and a room runner that
sleeps drops its sockets and loses authoritative state, which is a correctness failure rather
than a latency one (§8.2).

| Line                                                    |  $/month |
| ------------------------------------------------------- | -------: |
| Production — Fly `shared-cpu-1x` / 512 MB, `iad` (§8.3) |     3.84 |
| Staging — same Machine with autostop, ~2 h/day awake    |     0.47 |
| Contingency (rootfs growth, a second small Machine)     |     0.69 |
| **Cost (rev 7, corrected)**                             | **5.00** |
| **Approved by the board**                               | **7.00** |

> **Rev 7 (review finding F4): the line items above were ~45% high and are corrected.** Revs 2–6
> priced the Fly Machine at $5.52 by billing nameplate RAM instead of billable RAM (I15); the
> corrected figure is **$3.84**, which agrees with §12.2 and with Fly's published price. **The
> board's approval of "up to $7/month" is unchanged and is not re-asked** — a lower cost sits
> inside an approved authority. This is corrected rather than left alone because **§13.5 directs
> the M3 ask to be assembled from this subsection**, so a wrong number here becomes a wrong number
> in front of the board at M3.

**What it buys, specifically:** a staging WebSocket server that does not drop connections when a
game goes quiet; timer-service validation ([PER-17](/PER/issues/PER-17)) in a real environment
rather than only in `docker-compose`; a board demo link whose first click does not wait ~50 s;
and — via Fly Managed Postgres in the same region — the ≤ 10 ms p95 log append, which makes
Decision 4 option (a) available for free inside this same ask.

**What it does not buy:** anything about the < 150 ms p95 target at scale (that is §11.2), per-PR
preview isolation for AC1 (that needs a preview environment per PR — **$8.78/month on Fly per
§12.2**, **not requested here**), or any M6 capability.

> **Rev 5 correction — two numbers for one line item, and the board's minute took the wrong one.**
> This paragraph previously said **~$25/month**, written in the rev-2 era when "a preview
> environment per PR" was scoped as a _fully dedicated_ environment including **its own Postgres
> instance**. §12.2 later costed the line properly at **$8.78/month**: ~20 PRs/month, scale-to-zero
> preview Machines, and **one shared Postgres instance with a separate database per PR**. Both
> numbers then sat in this ADR at once, and the ~$25 figure is the one that reached the board — it
> is quoted in the M0 sign-off relay on [PER-3](/PER/issues/PER-3). **$8.78 is the correct figure.**
>
> **The cheaper design still satisfies AC1b, which is why this is a correction and not a
> downgrade.** AC1b exists so that one PR's schema change cannot break another PR's preview; a
> separate _database_ per PR gives exactly that isolation. A dedicated Postgres _instance_ per PR
> additionally isolates resource contention between concurrent previews, which is not what the
> criterion is about at ~20 PRs/month. If preview load ever makes contention real, the revisit
> trigger is a preview run whose timings are distorted by a neighbouring preview.
>
> **This changes nothing the board must do.** The board accepted M0 with AC1 recorded as not met
> and declined to fund previews; nothing here reopens that. It is recorded so that _if_ the
> decision is ever revisited, it is revisited against **$8.78 of an authorised $120** — which makes
> AC1b the cheapest open criterion on the list by an order of magnitude, and it was the board's own
> stated #1 spend priority.

**The $0 alternative, honestly stated:** port the room runner to Cloudflare Workers + Durable
Objects — genuinely $0, genuinely always-on, no payment card, ~230 concurrent players on the free
plan (§8.3). It costs **5–8 engineer-days**, a board-gated change of major tech choice
([ADR-0001](./0001-v1-stack.md) §§4–6), and an unmeasured risk against the M6 tick budget. **At
any plausible internal cost of an engineer-day, $7/month is the cheaper answer** — but the option
is real, it is kept open at zero cost by constraints already placed on
[PER-7](/PER/issues/PER-7), and the board may prefer it if the answer to spend is a permanent no.

**If this is refused:** staging keeps the Render free service, M0 AC2 and AC5 still demonstrate,
and the cost is paid in M3 — reconnection, spectators and timers cannot be evidenced on
infrastructure that is itself the thing disappearing (§8.2). That is a deferral, not a blocker,
and it is survivable; it should just be a choice rather than an accident.

### 11.2 The M5 load test — **a one-off window, not a standing cost**

The M5 acceptance criterion is **2,000 concurrent rooms at p95 < 150 ms**. That is 4,000
WebSocket clients against one instance, and it cannot run on free tiers: Upstash free would be
exhausted in **under 10 minutes** (500K commands against 1,800 ops/s), and a free 512 MB instance
cannot hold 2,000 rooms at all. Per Chief of Staff's preference this is priced as a **time-boxed
window**, and it splits into two tests that are worth buying separately.

**Test A — capacity and determinism: does our code hold 2,000 rooms?** Runs on any hardware,
because it measures our room runner rather than a vendor. Hetzner bills hourly, so:

```
system under test   1 × CPX32 (4 vCPU/8 GB, app + Redis + PG)  €13.49/mo ÷ 730  =  $0.020/h
load generators     2 × CCX33 (8 dedicated vCPU each)          €48.49/mo ÷ 730  =  $0.144/h
egress              within Hetzner's included traffic                            =  $0
                                                                                   ─────────
                                                                                   $0.164/h
48-hour window (setup, dry runs, 3 measured runs, teardown)                      =  $7.87
```

**≈ $8 for a 48-hour window.** It answers **I7 and I9** — the two unmeasured turn-based inputs
that §9 shows can move the whole model — and it de-risks §3 for the price of a coffee. **This is
the one I would approve today**, independently of everything else in this ADR.

**Test B — the acceptance criterion itself: p95 < 150 ms on production-shaped infrastructure.**
Must run on whatever production actually is, because a p95 measured on different hardware is not
evidence for the target. Priced on Fly (§3.1 rates):

```
SUT app         performance-2x (2 perf vCPU/4 GB) × 1.1 region                   =  $0.131/h
Redis Machine   shared-cpu-1x / 1 GB × 1.1                                       =  $0.012/h
load generators 2 × Hetzner CCX33, hourly                                        =  $0.144/h
egress          2,000 rooms ≈ 800 KB/s = 2.81 GB/h × $0.02                       =  $0.056/h
                                                                                   ─────────
                                                                                   $0.343/h
48-hour window                                                                   =  $16.46
Fly Managed Postgres Basic — may not prorate below a month  [unverified]         =  $38.00
                                                                                   ─────────
                                                                                   $54.46
```

**Ask: a $100 one-off cap**, covering a managed-Postgres month, one re-run and one second region.
**Defer it to M5** — it is worthless before I7 and I9 are measured, and Test A measures them.

**The real gate is not the money, it is the payment instrument.** Fly has no free tier, so even a
$17 window requires a card on file. That is the board's decision to take, and it is why this is
here rather than in a purchase order. If the board prefers to avoid a card entirely, **Test A on
Hetzner still runs** — Hetzner also requires a payment method, so the honest statement is: **no
load test of any kind is possible without one vendor relationship somewhere.**

### 11.3 A Mumbai-region game-server fleet for M6 — **$75/month pilot, costed not requested**

M6 is board-gated and not open. This is costed now because §5.5's region question is live today
and the answer changes Decision 1.

**Hetzner, the cheapest provider in §4, has no India region** — its nearest is Singapore, roughly
60–90 ms from Mumbai **[unverified]**, which is survivable for turn-based inside a 150 ms budget
and wrong for a 30 Hz real-time room. So the India answer is a different provider from the EU
answer, and the pattern from §4 repeats: **bundled-transfer VPS providers beat PaaS providers by
an order of magnitude, because the bill is egress.**

**Pilot — one dedicated-CPU node in Mumbai/Bangalore, ~100 concurrent players (≈ 8 rooms):**

| Provider                              | Compute                                    | Egress @ 100 players                                   | **$/month** |
| ------------------------------------- | ------------------------------------------ | ------------------------------------------------------ | ----------: |
| **Akamai/Linode Mumbai, Dedicated**   | ~$36–72 **[unverified]**, bundled transfer | overage $0.005/GiB; **$0 at the 10 KB/s design point** |  **$36–72** |
| DigitalOcean Bangalore, CPU-Optimised | ~$84 **[unverified]**                      | overage $0.01/GiB; $0 at the design point              |        ~$84 |
| ~~Fly.io `bom`~~ — **region deleted** | ~~$28~~ **not purchasable** (§5.5b)        | n/a — nearest region is `sin`, ~60–90 ms from Mumbai   |    **void** |
| AWS `ap-south-1`                      | ~$29                                       | 7.88 TB @ ~$0.109/GB **[unverified]** = $862           |       ~$891 |

**Ask, if and when M6 opens: $75/month.** Note the shape of that table — the PaaS options are
**13× the VPS options for the same 100 players**, entirely on egress, and the gap widens linearly
with players.

**At full U₂₄ (1,000 concurrent players in Mumbai), for sizing only:**

```
Linode Mumbai   2 × Dedicated 4 vCPU $144  +  68.8 TB overage × $0.005/GiB  ≈  $488/mo  ($0.49/player-mo)
  ... at the 10 KB/s design point and the I3 duty cycle, inside bundled transfer ≈  $144/mo  ($0.14)
DigitalOcean    $168 compute  +  ~69 TB × $0.01/GiB                          ≈  $858/mo  ($0.86)
AWS ap-south-1  $29 compute   +  78.8 TB × ~$0.109/GB                        ≈ $8,646/mo  ($8.65)
Fly.io (sin)    $277 compute  +  78.8 TB × $0.12/GB to India                 ≈ $9,738/mo  ($9.74)
                  ^ not a Mumbai deployment — Fly has no India region (§5.5b).
                    The $0.12/GB applies because the players are in India, not the servers,
                    and the ~60–90 ms Singapore RTT makes it the wrong shape regardless.
```

**The finding the board should take from this:** serving India real-time on a PaaS costs
**~20× more** than on a bundled-transfer VPS, and the M6 fleet provider for India is
**Akamai/Linode or DigitalOcean**, not Fly, not AWS, and not Hetzner — which has no region there.
This does not change the M0–M5 recommendation (§7a), because the transport-adapter seam in
[ADR-0001](./0001-v1-stack.md) §4.1 is exactly what lets the fleet live somewhere other than the
lobby. **It does mean that if v1's market is India, the turn-based recommendation should be
re-run with Fly's $0.12/GB India rate applied** — Decision 3.

---

## 12. The $120 buy-list — **costed and ratified, entirely dormant** (rev 3, suspended in rev 4)

> **Rev 4: nothing in §12 may be provisioned.** All provisioning is held and everything is on
> free tiers. This section keeps its full value as a board-ratified plan with verified list
> prices that executes on one word — but read every row as "what we will buy", never as "what we
> may buy". **§12.3's release from the free-tier cap is withdrawn in full.**

The board asked one question that had to be answered before anything is bought: **can minimum
production + staging + per-PR previews be had for $120/month on Fly, or is the floor really
~$100 for production alone?** Chief of Staff explicitly asked me to state the real floor with
line items rather than spend into the authority, and to withdraw the cheaper-shape option if it
did not exist.

**It exists. The floor is ≈ $60/month, and ≈ $60 of the $120 goes unspent.**

### 12.1 Why my earlier "~90% fixed" finding did not mean what it looked like

Rev 1 said turn-based cost is ~90% a fixed floor, and Chief of Staff reasonably read that as
"minimum production will still cost ~$100." **That inference does not follow, and the fault is
in my phrasing.** The finding was that within an instance sized for 2,000 rooms, adding players
up to 1,000 barely moves the bill — cost is flat _in players_. It says nothing about cost being
flat _in instance size_. At ~zero players through M4 we buy the smallest machine that holds the
process, not a quarter of a machine sized for launch. **Correcting it here because the board was
offered a saving on the strength of it.**

### 12.2 Line items — list prices, Fly, `sin`, 2026-09-30 (rev 7: **one input unverified**)

Unit prices: `shared-cpu-1x` 256 MB **$1.97/mo** (730 h × $0.0027/h), 512 MB **$3.46**, 1 GB
**$6.93**; extra RAM ~$5.64/GB/30 d; volumes **$0.15/GB/mo**; **stopped Machines bill rootfs
only at $0.15/GB/30 d**; Managed Postgres **Basic $38/mo** (shared-2x/1 GB, HA + backups +
pooling) plus **$0.28/GB** storage; dedicated IPv4 $2/mo, shared IPv4 and IPv6 free.
**No mandatory platform or support fee** — Fly's $29/mo Standard support tier is optional, and
the aggregator sites claiming a required plan fee contradict `fly.io/plans`, which is the
primary source and the one used here.

> **Rev 7 (review finding F7): `sin`'s regional multiplier is not stated anywhere, and this
> subsection was headed "verified".** §3.1 establishes that Fly applies a **regional multiplier of
> 1.0–1.615** and uses **1.1** for `iad`/`ewr`. The tables below apply **no multiplier at all**, so
> the $59.97 total is either implicitly asserting `sin` = 1.0 — which nobody has checked — or
> understated by up to 1.6×. **`sin` multiplier: [unverified]**, owner **Platform Engineer, before
> the first resource**, alongside the two `sin` checks already owed in §9 (Managed Postgres
> availability, autostop vs. an open WebSocket). **The consequence is bounded and does not threaten
> the envelope, but it is not nothing:** at Fly's published ceiling of 1.615, applying it to the
> Machine compute and RAM lines alone takes the total from **≈ $60 to ≈ $64**; applying it to
> volumes and Managed Postgres as well takes it to **≈ $96**. Both sit inside the $120 authority —
> the upper case spends most of the ~$60 underspend that currently absorbs §9's eight
> `[unverified]` list prices. Which of the two it is depends on what Fly actually multiplies, and
> that is a question with an answer rather than a range. **I would rather find a 1.0 than assume
> one.**
>
> **Reconciliation with I15, for reproducibility.** The unit prices above are Fly's quoted machine
> prices. Derived from I15 plus §3.1's post-increase $6.09/GB they would be $1.97 / **$3.49** /
> **$6.54** — within 1–6% of the quoted $1.97 / $3.46 / $6.93, i.e. immaterial against a $60 total,
> so the quoted figures are kept. The reason to say it at all is that this ADR otherwise carries
> three different Fly RAM rates, and a reader is entitled to know which one each table used.

**Production** — minimum size, always-on, `sin`:

| Line                                     | Spec                              |      $/mo |
| ---------------------------------------- | --------------------------------- | --------: |
| `apps/realtime` (lobby + WS)             | `shared-cpu-1x` 512 MB, always-on |      3.46 |
| Redis — self-run Machine (§7a condition) | `shared-cpu-1x` 256 MB            |      1.97 |
| Redis volume                             | 1 GB × $0.15                      |      0.15 |
| Postgres — **Fly Managed, Basic**        | shared-2x/1 GB, HA + backups      |     38.00 |
| Postgres storage                         | 10 GB × $0.28                     |      2.80 |
| Dedicated IPv4                           | 1 × $2.00                         |      2.00 |
| Egress                                   | ~0 players through M4             |      0.00 |
| **Subtotal**                             |                                   | **48.38** |

**Staging** — always-on WebSocket, `autostop`/`autostart`, ~2 h/day awake (60 h/mo):

| Line                        | Spec                               |     $/mo |
| --------------------------- | ---------------------------------- | -------: |
| `apps/realtime`             | 512 MB × 60 h + 1 GB rootfs parked |     0.43 |
| Redis                       | 256 MB × 60 h + rootfs parked      |     0.31 |
| Postgres — self-run Machine | 1 GB × 60 h + 10 GB volume         |     2.07 |
| IPv4                        | shared                             |     0.00 |
| **Subtotal**                |                                    | **2.81** |

**Per-PR previews** — ~20 PRs/month, each open ~3 days, exercised ~1 h:

| Line                                   | Spec                          |     $/mo |
| -------------------------------------- | ----------------------------- | -------: |
| Preview app compute                    | 20 × 256 MB × 1 h             |     0.05 |
| Rootfs parked while stopped            | 20 × 1 GB × $0.15 × (3/30)    |     0.30 |
| Shared preview Postgres, one DB per PR | 1 GB always-on + 10 GB volume |     8.43 |
| **Subtotal**                           |                               | **8.78** |

**Total ≈ $59.97/month. Unspent: ≈ $60.03 of the $120 authority.**

**Two things make this work, and both are properties of Fly specifically:**

1. **Stopped Machines cost rootfs only.** A parked preview costs ~1.5¢/month, which is why 20
   concurrent previews are $8.78 rather than a per-environment fee.
2. **Fly's autostop is concurrency-driven, not a wall-clock idle timer.** Fly Proxy stops a
   Machine by comparing live connection counts against the `soft_limit`, so **a Machine holding
   an open WebSocket is not idle and is not stopped.** This is the precise difference from
   Render free's 15-minute spin-down, which §8.2 named as the ceiling that bites first _because
   it is a correctness failure rather than a quota_. On Fly, autostop is safe for staging in a
   way free-tier sleeping never was.
   > **[unverified]** Fly's autostop documentation states the concurrency rule but does not
   > explicitly address open WebSocket connections at stop time. **Verify on the first staging
   > deploy before relying on it** — owner: Platform Engineer, [PER-7](/PER/issues/PER-7). If it
   > turns out to be wrong, staging goes always-on at +$3.03/month, which the headroom absorbs.

**The cheaper variant, and why I am not recommending it.** Self-running Postgres in production
too (a 1 GB Machine + 10 GB volume, $8.43) drops the total to **≈ $28/month**. It is rejected:
[ADR-0001](./0001-v1-stack.md) rev 2 §6.1 makes the Postgres match log **the sole tier of
record**, and this issue's replacement constraint is _protect Postgres durability, treat Redis
as fungible_. Trading managed HA, automated backups and point-in-time restore on the one
component we cannot reconstruct, to save $20/month against a $60 underspend, fails the
**blast-radius** lens. Self-run Postgres is fine for staging and previews, where losing the
database costs a re-seed.

### 12.3 What Platform Engineer may provision now — **WITHDRAWN (rev 4)**

> **Rev 4: the answer to "what may be provisioned now" is nothing.** All provisioning is held.
> [PER-6](/PER/issues/PER-6) and [PER-7](/PER/issues/PER-7) are **back under the free-tier cap**,
> and the release below is revoked. ~~No Fly account, no card, no trial, on any provider.~~ The
> table is retained as the ordered plan for the moment the hold lifts — it is a queue, not a
> permission.
>
> The one row that still binds today is the last one: **anything not on this list is still back to
> CTO**, and under the hold that now includes every row above it.
>
> **Rev 6 corrects the struck sentence, which was the plainest statement of the falsehood in this
> ADR.** The accurate statement is:
>
> - **No Fly account, no card on file, no paid tier, no trial — true, and unchanged.** Fly.io is
>   the ratified M0–M5 provider and **is not provisioned**. Nothing in the table below may be
>   created.
> - **"On any provider" was false.** One pre-existing vendor connection exists: **Cloudflare**,
>   created by the board on 29 Sep, before the hold. No card is attached because the account
>   already existed.
> - **The single carved exception (§13.7):** that connection may be used for a **free Cloudflare
>   Pages staging deploy of `apps/web`**. That is the `apps/web` row below, and it is the only row
>   whose status changes — from "⏸ required when funded, **held**" to **available at $0 via the
>   existing Cloudflare connection**, per [PER-111](/PER/issues/PER-111).
> - **`apps/realtime` is not in the exception**, on any row, for the reason in §13.7: Pages cannot
>   hold a WebSocket connection. Rows 1–3 stay held.

~~**[PER-6](/PER/issues/PER-6) and [PER-7](/PER/issues/PER-7) are released from the free-tier
cap**, within the $120 authority and in the board's priority order:~~ **Revoked 2026-09-30.**
What follows is the plan, in the board's priority order, pending the hold lifting:

| #   | Provision                                                                       | Authority (rev 4)                        |
| --- | ------------------------------------------------------------------------------- | ---------------------------------------- |
| 1   | Per-PR preview apps via `superfly/fly-pr-review-apps`, autostop on, shared PG   | ⏸ ratified, **held** — first when funded |
| 2   | Staging: `apps/realtime` + self-run Redis + self-run PG, autostop, region `sin` | ⏸ ratified, **held**                     |
| 3   | Production: `apps/realtime` + self-run Redis + **Fly Managed Postgres Basic**   | ⏸ ratified, **held**                     |
| —   | `apps/web` on a **free-egress CDN** (Cloudflare Pages), _not_ on Fly            | ⏸ required when funded, **held**         |
| —   | Any Fly support plan, any region other than `sin`, any resize above the above   | ❌ back to CTO                           |
| —   | **Anything at all, today**                                                      | ❌ back to the board — the hold          |

**Binding conditions, all from §7a and §5.5b:**

- **Region `sin`, not `bom`.** `bom` does not exist (§5.5b).
- **Redis is a self-run Machine with our own `redis.conf`** — not Upstash. Board condition.
- **Postgres is Fly Managed in the same region as the app.** **Check availability in `sin`
  first**; if it is not offered there, stop and come back to me rather than reaching for an
  off-Fly Postgres, which reintroduces the cross-provider hop §5.1b rules out.
- **Bidirectional presence heartbeat ≤ 10 s**, as per-environment config. Board condition.
- **`apps/web` static output must be CDN-fronted.** Every figure in this ADR assumes it; on Fly
  unfronted static egress is ~1.7× the WebSocket egress, and at India rates that is real money.
- **No payment card beyond the $120 authority, no support plan, no second region.**

**M0 AC1 is _not met_** until per-PR previews are actually running. Provisioning authority is not
evidence; a green preview deploy on a real PR is. **Rev 4 hardens this**: rev 3 wrote "partially
met" while previews were merely unprovisioned. Under the hold they are unprovisionable, so the
honest record for AC1b is **not met** — see §8.4 for the AC1a/AC1b split and why substituting a
shared staging URL is not available as a way to close it.

### 12.4 The M5 step-up, re-priced

The board recorded a concern that M5 would land at ~$238 against $250, leaving ~$12 of headroom
where $65 was wanted. **Using §12.2's measured unit prices instead of rev 1's estimates, it is
better than that:**

```
production at 1,000 concurrent, India audience (§3.6)     ≈ $153
staging, scaled to roughly half the production shape      ≈ $ 50
per-PR previews (unchanged — they do not scale with players) ≈ $  9
                                                            ──────
                                                            ≈ $212  against $250
headroom                                                    ≈ $ 38   (not $12)
```

Previews are the insight: they are priced by PR count, not player count, so they do not grow
with launch. **This remains an estimate and must be re-derived from measured numbers before the
$120 → $250 step is taken** — the board's instruction, and §9's owed-measurement table is the
input to it.

---

## 13. The provisioning hold — authority without permission (rev 4) {#the-provisioning-hold}

### 13.1 What happened, in order

| Date / time (UTC)    | Event                                                                                                    | Effect                                      |
| -------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| **2026-09-29, a.m.** | **Board creates a Cloudflare connection** (rev 6)                                                        | **a vendor account exists from here on**    |
| 2026-09-30 06:04:35  | [eee1c3f0](/PER/approvals/eee1c3f0-13d7-4f85-bd5e-c6450c26480b) approved — $7/mo + $8 test               | rev 2's asks granted                        |
| 2026-09-30 06:05:13  | [63d288d2](/PER/approvals/63d288d2-8c4f-4694-b2d3-8921db8ac967) approved — Fly + $250/mo                 | envelope ratified; rev 3 written against it |
| 2026-09-30 ~06:16    | Board answers the payment-instrument question: **hold all provisioning, free tiers only**                | permission withdrawn; rev 4 written         |
| 2026-09-30 ~06:30    | §8.7 resolved: free-tier signups permitted                                                               | rev 5; three of five M0 criteria reachable  |
| **2026-09-30 07:32** | **Board rules on the Cloudflare connection: verify it is live, then use it for a free web staging link** | **the hold's one carved exception (§13.7)** |

Roughly eleven minutes separate the approval this ADR was rewritten around from the hold that
suspended it. That is worth recording plainly rather than smoothing over, because it is the
reason this document has several revisions in one day and the reason §7, §8 and §12 have each
changed operative status twice.

**The first row is new in rev 6, and its absence is what made this section wrong.** With the 29 Sep
row missing, the hold read as "we have nothing, therefore nothing can be spent". With it present,
the hold reads as what it actually is: a stop on **new** provisioning and on **any** payment
instrument, laid over a pre-existing free connection nobody had accounted for. Revs 4 and 5 stated
the first version. It was not true.

### 13.2 The distinction that makes this coherent

**Authority** is the board's answer to "may we spend up to $X on provider Y". That was asked and
answered: Fly.io, $120/month now, $250 at M5, $400 ceiling, plus ~$8 for the capacity test. It is
settled and needs no re-litigation.

**Permission** is the board's answer to "may we exercise that authority today". That answer is
**no**, and it is the operative one.

Collapsing the two would produce one of two errors, and both are worse than the current
awkwardness: treating the hold as un-deciding the provider would put a settled question back on
the board's plate, and treating the approval as still live would have Platform Engineer
provisioning Fly against §12.3 this week.

### 13.3 What the hold actually costs

1. **AC1b is unreachable, not merely unbuilt** (§8.4). Per-PR previews were the board's own #1
   spend priority; they are the first thing the hold stops.
2. **Test A's ~$8 is approved and unspendable**, so **I7 (bytes per message) and I9 (memory per
   room) stay unmeasured** — the two inputs the entire cost model rests on. Everything in §3, §4
   and §12 stays a budget or a list price. This is the cost I most want not absorbed silently.
3. **The always-on process (§8.3, §11.1) is not bought**, so staging sleeps. §8.5 item 8 is the
   sharp end: a sleeping environment does not merely fail to prove timer correctness across an
   idle window, it produces a **wrong** result. Timers are therefore tested against local
   `docker-compose`, never against staging, and that is a standing instruction, not a preference.
4. **Nothing about the non-functional targets can be evidenced** (§8.5, all eight items), and a
   green free-tier demo must not be read as evidence either way.

### 13.4 What does _not_ change

The provider decision, §5's constraint analysis, §3's and §4's arithmetic (as corrected in rev 7),
§5.5b's finding that Fly prices egress by destination, and §12.2's list prices. None of those
depend on whether we have spent anything. When the hold lifts, this ADR executes — no further
analysis and no further board input is needed beyond the word "go".

> **Rev 7 narrows one word of that.** This used to say "§12.2's **verified** list prices". One
> input to them is not verified — **`sin`'s regional multiplier** (§12.2, finding F7) — and it is
> the number we would provision against the moment the hold lifts, so it is the worst possible
> place for an unstated assumption. The prices stand; the label does not.

**Rev 6 adds one item to this list, and it is the important one.** The §13.7 exception does **not**
change the provider decision. Cloudflare Pages hosting `apps/web` was **already** §7a's design —
see §12.3's `apps/web` row and §8.1's topology, both of which put static assets behind a
free-egress CDN and `apps/realtime` on Fly. The exception lets us do at $0 something the ratified
plan already called for; it does not move the platform anywhere.

### 13.5 What would lift it

The board lifting the hold, which is one sentence on [PER-2](/PER/issues/PER-2). Two things make
that cheap to ask for again later rather than now: the buy-list is already ratified, so there is
nothing to re-derive; and the first $9/month of it (previews, §12.2) closes AC1b, which is the
criterion the hold costs us. If the board wants a smaller first step than $120, **§12.2's
preview line alone is the one to release**, and I would rather ask for $9 with AC1b attached than
for $120 in the abstract.

**Rev 5 — when that ask happens is now fixed, not left to judgement.** The board has set **M3** as
the revisit point and recorded it as a standing instruction on the M3 epic
([PER-29](/PER/issues/PER-29)), so it fires when that milestone opens rather than depending on
someone remembering. Three things go into that ask, and they are worth listing here so they are
assembled rather than improvised:

1. **The minimum always-on shape with line items** — §12.2 already has them; the ask is to
   exercise existing authority, not to raise it.
2. **What stays unevidenced if the answer is no again, criterion by criterion** — §8.5's eight
   items, plus M3's own acceptance criterion (kill the server mid-game, resume within 10 s), which
   is the one that cannot be evidenced against a server that is itself the thing disappearing.
3. **The payment instrument**, because that was the real gate last time and not the money. An
   approved budget with no card attached buys nothing, and that is the sentence the ask should
   open with rather than close with.

**I7 and I9 belong in that ask too** if they are still unmeasured at M3 — Test A is approved and
unspendable, so they probably will be.

### 13.6 The conflict two board decisions jointly created, recorded so M3 is not a surprise

Chief of Staff asked for this to be written down rather than solved, and that is the right
instruction — neither decision should be reopened on the strength of it. Both were made in the
same session, minutes apart, and each is defensible alone:

- The board **rejected** [15587c20](/PER/approvals/15587c20-53fb-499e-9b53-4718df50a5df), so
  **Colyseus is adopted** rather than the in-house `RoomRunner` ([PER-72](/PER/issues/PER-72)).
- The board **held all provisioning**, so we are on free-tier compute (§8.1).

Taken together they remove a third option that neither one removes alone. The only candidate
anywhere in this ADR for which **idle is a designed-for state rather than a failure mode** is
Cloudflare Durable Objects, whose WebSocket Hibernation API evicts an idle object from memory
_without dropping its sockets_ (§6, §8.3). **Durable Objects cannot host Colyseus** — the
Workers runtime is not Node, and Colyseus's server is built on the Node `ws`/`http` stack.

So: **under the hold there is no always-on $0 path.** It is Colyseus on a free tier that sleeps,
and §8.2 already names that as a _correctness_ failure rather than a quota — sockets dropped,
rooms gone, clocks stopped, and the player then told something untrue.

**Why this surfaces at M3 specifically.** M3 is resilience and spectators: reconnection and
restart recovery. Those cannot be evidenced against a server that is itself the thing
disappearing — the test and the fault are the same event, so a pass and a failure are
indistinguishable. Through M1 and M2 the gap is an inconvenience; at M3 it is the subject matter.

**On the timing question Chief of Staff asked me to answer: M3 is the right milestone to bring
the hold back to the board, and I would not move it earlier.** Two reasons, and one caveat.

1. **Nothing between now and M3 is blocked by it that is not already blocked by AC1b.** M1 and M2
   are platform-core, SDK and chess-rules work, all of which is unit-testable and
   `docker-compose`-testable without a vendor. Asking earlier spends board attention on a
   question whose answer does not change what anyone does this week.
2. **By M3 we will have a better argument than we have today.** The ask is currently $120 in the
   abstract against zero measured numbers. At M3 it is a named criterion that cannot be
   evidenced, which is a decision the board can actually weigh.

~~**The caveat, and it is the thing that would change my answer:** if
[PER-6](/PER/issues/PER-6)'s free-tier preview work shows that **M0 cannot be signed off at all**
under reading B of §8.7 — no staging, therefore no AC2 and no AC5 — then the hold stops being an M3
problem and becomes an M0 one, and I would escalate immediately rather than on a schedule.~~

> **Rev 5: the caveat did not fire, and M3 is confirmed.** §8.7 resolved to reading A, so staging
> exists, AC2 and AC5 are demonstrable, and the hold stays an M3 question rather than becoming an
> M0 escalation. The board has confirmed M3 and recorded it on [PER-29](/PER/issues/PER-29).
>
> **What is still an early-escalation trigger, narrowed.** M3 is a scheduled revisit, not a
> restriction on raising a blocker. The trigger is **unachievability, not absence of evidence**: if
> the free topology makes something in M1 or M2 impossible to _build_ rather than merely impossible
> to _measure_, that goes to Chief of Staff the day it is found. A missing measurement is the known
> price of the hold and is already recorded in §13.3 — it is not a reason to re-ask early, because
> re-asking on it would spend board attention to be told something the board already decided.

### 13.7 The hold's one carved exception — Cloudflare Pages for `apps/web` (rev 6) {#the-one-carved-exception}

**Decided by the board 2026-09-30 07:32Z.** This is the whole of the exception. If something is not
in the "permitted" column below, it is held.

|                       | Permitted                                                                                                                           | Held                                                                                                |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| **Account**           | The **pre-existing Cloudflare connection**, created by the board on 29 Sep. No card is involved because the account already exists. | Any **new** vendor account, on Cloudflare or anywhere else.                                         |
| **Payment**           | Nothing. The exception is $0 by construction.                                                                                       | Any card on file, any paid tier, any trial, any spend — **on every provider including Cloudflare**. |
| **Workload**          | **`apps/web` only**, as a static Cloudflare Pages deploy.                                                                           | **`apps/realtime`**, Redis, Postgres, and every row of §12.3's table.                               |
| **Purpose**           | A **free staging link** the board can click.                                                                                        | A production environment, a performance baseline, or a migration.                                   |
| **Provider decision** | Nothing changes. **Fly.io remains the ratified M0–M5 provider (§7a) and is not provisioned.**                                       | —                                                                                                   |

**Why `apps/realtime` cannot be in the exception, and it is not a policy reason.** Cloudflare Pages
serves static assets and Functions on the Workers runtime. It **cannot hold an open WebSocket
connection for the life of a match**, which is the one thing `apps/realtime` exists to do. This is
the same finding as §6's Durable Objects analysis and §13.6's conflict: the Workers runtime is not
Node, and the always-on socket-holding process is precisely the line item $0 cannot cover (§8.3).
So the exception is bounded by capability before it is bounded by permission.

**AC2b is unchanged.** It is still gated on provisioning, for that reason. Nothing in this
exception makes a WebSocket round trip demonstrable that was not demonstrable before it.

**This is not a provider change.** A staging link is not a migration. Rebasing the platform onto
Cloudflare would be a change to a major agreed tech choice and a board decision in its own right;
nobody should read §13.7 as a step toward one. The **reversibility** lens is the argument for
saying yes to this narrowly: a Pages deploy of a static app is undone by deleting a project, and it
commits us to nothing.

**What it changes for M0.** One thing, and it is worth naming because AC5 was recorded as blocked
for a money reason that no longer fully applies:

- **AC5 — "Staging link + short video/GIF + written status report posted for the board."** Its
  **staging-link half is now reachable at $0** via [PER-111](/PER/issues/PER-111). AC5's gate is
  therefore **no longer purely the payment instrument**; what remains is execution plus the two
  halves that were always mine (the video/GIF and the written status report).
- **AC1b is not affected.** The isolation property is what costs money (§8.4), and a free Pages
  deploy of `apps/web` does not buy it.

**Two standing constraints on anything produced under this exception.** Both are constraints I have
already bound myself to elsewhere, and the exception creates a new surface for each:

1. **A Cloudflare number is not a Fly number.** Whatever this staging link measures, it measures
   **Cloudflare's edge on a free tier**, not Fly's. Every figure taken from it is labelled with the
   provider and the tier it was measured on, and the **Fly.io equivalents stay owed** — due at the
   M3 revisit (§13.5), not quietly dropped. This is the third time this guard has been needed
   ([PER-7](/PER/issues/PER-7), [PER-15](/PER/issues/PER-15), and now here), which is why it is in
   §9's owed-measurement note rather than only in a comment.
2. **The demo caption must not overclaim** ([ADR-0009](./0009-m0-websocket-transport-probe.md) §4).
   A Cloudflare Pages staging link shows **`apps/web`**, and `apps/web` is not a playable game. An
   AC5 caption that implies a board member can click the link and play one is the exact failure
   mode ADR-0009 §4 was written to prevent.

**Execution, and who owns what.** Verifying the connection is actually live — before anything is
deployed — plus the deploy itself and the pipeline description in
[`docs/ci-cd.md`](../ci-cd.md) belong to Platform Engineer on
[PER-111](/PER/issues/PER-111). The hold's scope, this section, and the AC5 record are mine
([PER-112](/PER/issues/PER-112)). **If the connection turns out not to be live, the exception is
moot rather than breached** — it permits using an account we have, and it authorises nothing to fix
one we do not.

---

## Consequences

**Easier**

- The board can decide with a per-player number instead of a sticker price, and can see which
  inputs would change it.
- M6's provider question is deferred without being forgotten, and §4 says what it will cost under
  each answer.
- Three engineering requirements fell out of the cost work and are now written down where
  implementers will find them: a CDN in front of static assets, a match-log retention policy, and
  a server-side heartbeat.

- **Rev 2:** the board can see the distance between $0 and correct, and it is **≈ $5/month**
  (rev 7's corrected figure; the board approved up to $7) — a number small enough to decide
  without a model, backed by a model if it wants one.
- **Rev 3:** M0 AC1 is now buyable. Previews and a WebSocket-holding staging cost **$11.59/month
  combined**, so the two criteria the board reversed $0 for are the cheapest things on the list.
- **Rev 3:** the region question is settled for costing purposes without the board having to
  answer it. Because Fly prices egress by destination (§5.5b), the India premium applies from
  wherever we deploy, so **$153 is the M5 planning number** and no further board input is needed
  to use it.

**Harder**

- The free-tier path and the recommended provider are different providers, so the M0 demo is
  throwaway rather than a first step.
- M0 AC1 cannot be fully met without spend. That has to be said to the board rather than papered
  over with a web-only preview.
- **Rev 2:** at $0, M3 evidence is untrustworthy (§8.2) and the ≤ 10 ms p95 append budget is
  unmeasurable (§5.1b). Both are stated rather than absorbed, which means they arrive as board
  decisions instead of as milestone slippage.
- **Rev 2:** co-location of Postgres with the app is now a hosting constraint. It costs nothing
  on any single provider and it removes Hetzner H1 — the cheap-compute-plus-managed-data shape —
  from serious contention unless someone measures the cross-provider hop.
- **Rev 3: we cannot put a server in India on the provider we just chose** (§5.5b). Indian
  players are served from Singapore at ~60–90 ms RTT **[unverified]**, which is survivable for
  turn-based and wrong for M6. The p95 measurement on [PER-7](/PER/issues/PER-7) moves from
  routine to load-bearing, because it is now the thing that tells us whether the M1–M5 product
  is acceptable in its target market.
- **Rev 3: Fly's cost advantage over Railway is gone for our audience** — $153 vs $149 (§3.6).
  Decision 1 now rests entirely on Constraint 4, the native fleet primitive, which §7c argues we
  may never exercise. The decision is still right on reversibility grounds, but it is a thinner
  case than the one the board endorsed, and I have said so rather than letting the $100 figure
  stand as the justification.

**Committed to**

- Fronting `apps/web` static output with a free-egress CDN, or re-deriving §3.
- A match-log retention policy before the log grows past one U₂₄-month — **and, at $0, before it
  passes Neon free's 0.5 GB, which arrives sooner** (§8.2).
- A ≤10 s heartbeat in both directions on every WebSocket connection, **as an environment config
  value rather than a constant**, since the $0 topology wants 25 s on Render and Fly requires
  ≤ 10 s (§8.2).
- Keeping `packages/platform-core` and the room runner free of Node-only APIs, so the Durable
  Objects escape hatch in §11.1 stays open at zero cost.
- Not claiming any non-functional target from a free tier, in either direction.

**Cost to reverse**

| Decision                                      | Cost                                                                                                                            |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Provider for M0–M5                            | **Cheap** — everything runs in a container against Redis + Postgres; ADR-0001's seams mean no application code names a provider |
| M6 fleet provider                             | **Cheap, because it is not being made**                                                                                         |
| Self-run Redis vs managed                     | Cheap                                                                                                                           |
| A region choice that puts players 200 ms away | **Expensive** — it is a product promise, not a config                                                                           |

## Revisit triggers

- **I7 measured above 1.5 KB** (2.5× the model input) → §3 turn-based egress is wrong, re-derive.
- **I9 measured such that rooms-per-instance falls below 500** → the "1,000 concurrent is 25% of
  one instance" claim fails, turn-based cost stops being floor-dominated, and §3 changes shape.
- **The M4 spike ([PER-30](/PER/issues/PER-30)) measures I10 and I11** → §4 is replaced, not
  amended, and the M6 recommendation in §7c is re-derived from measured bytes.
- **Concurrency exceeds 5,000 players** → the fixed floor stops dominating and §3's ranking can
  invert toward whoever is cheapest per byte.
- **Any candidate changes egress pricing**, or Fly follows its 2026-10-01 memory increase with
  another → re-run §3 and §4.
- **We need a region Fly does not have**, or Fly's $0.12/GB Africa & India rate becomes material
  → reopen Decision 1.
- **Render publishes egress pricing competitive with Fly's $0.02/GB** → the M6 disqualification in
  §4 lifts.
- ~~**The board changes the budget from $0** → §7 stops being hypothetical, §8 stops being
  operative, and Decision 4 resolves to option (a) automatically.~~ **Fired in rev 3, then
  un-fired in rev 4** — the budget changed and then the permission to use it was held. Replaced
  by the next two triggers.
- **The board lifts the provisioning hold** → §7 and §12 become operative, §8 stops being
  operative, §12.3's release is reinstated, Test A runs, and Decision 4 resolves to option (a)
  automatically. This is the single highest-value trigger in this list and the only one that
  unblocks M0 AC1b (§13.5).
- **The hold is still in force at M3** → escalate rather than absorb. §8.6 and §13.3 item 3 mark
  M3 as the milestone where free-tier evidence stops being incomplete and starts being
  misleading, and where a sleeping staging environment starts producing wrong timer results
  rather than merely unproven ones. **Rev 5: this is no longer a trigger to notice — it is
  scheduled.** The board set M3 and recorded it on [PER-29](/PER/issues/PER-29); §13.5 lists what
  the ask carries.
- **Something in M1 or M2 becomes unachievable rather than unmeasured under the free topology** →
  escalate to Chief of Staff the day it is found, ahead of M3. New in rev 5, and deliberately
  narrower than "the free tier cost us a number": a missing measurement is the known, recorded
  price of the hold (§13.3) and is not grounds to re-ask early.
- ~~**The board answers §8.7** (whether free-tier signups are inside the hold) → M0's reachable
  criteria change from two to three, and the sign-off question before the board changes shape.~~
  **Fired in rev 5: reading A.** Free-tier signups are permitted, three of five M0 criteria are
  reachable, and §8.1's topology may be built. The residual trigger is narrower: **any free tier
  in §8.1 that turns out to require a card, or that auto-converts to paid**, is outside the
  permission and comes back to the board (§8.7).
- **Any free tier in §8.1 changes its ceiling** — Render's spin-down window, Upstash's 500K
  commands, Neon's 0.5 GB — → re-run §8.2's ranking; the ceiling that bites first can move.
- **`sin`'s regional multiplier measures above 1.0** (rev 7, §12.2) → §12's line items scale by it
  and the ~$60 underspend that absorbs §9's eight unverified list prices shrinks — to ≈ $64/month
  at the published 1.615 ceiling on compute alone, or ≈ $96 if volumes and Managed Postgres scale
  too. Inside the $120 authority either way, with the contingency spent in the upper case.
  **Re-derive §12 before provisioning, not after.**
- **Hetzner's CCX33 EU included traffic is confirmed at 20 TB rather than 30 TB** (rev 7, §3.4) →
  §4's Hetzner real-time floor moves from $105 to $116 and the spread narrows from 94–114× to
  94–104×. Does not change the M6 conclusion; does change the number every M6 comparison is
  measured against, which is why it is owed in §9.
- **The durable-log-append budget is measured above 10 ms p95 on a provisioned tier** → Decision
  4 reopens with option (b), group commit, and that needs its own ADR.
- **[ADR-0001](./0001-v1-stack.md) §6 makes Redis authoritative again** → §5.1's withdrawn gate
  comes back and Upstash is re-disqualified. Recorded so the reversal is a decision rather than a
  rediscovery.
- **v1's market is confirmed as India** → **already applied in rev 3.** §3.6 and §4 carry the
  India column and $153 is the M5 planning number. The remaining trigger is narrower: **reopen
  Decision 1 if measured Mumbai↔Singapore p95 exceeds the 150 ms budget**, with Akamai/Linode
  Mumbai and AWS `ap-south-1` in the shortlist (§11.3).
- **Fly restores an India region, or any candidate adds one** → §5.5b's substitution reverses
  and §11.3's shortlist reopens. Worth watching: `bom` was deleted 2026-09-25, recently enough
  that the decision may not be final.
- **Fly changes egress from destination-priced to region-priced** → §5.5b's central finding
  inverts and region choice becomes a cost lever again.
- **Measured Fly spend exceeds $90/month** (75% of the $120 authority) → §12's ~$60 estimate is
  wrong somewhere; find out where before the M5 step-up rather than after.
- **Fly autostop is observed to drop an open WebSocket** → §12.2's staging shape is unsafe;
  staging goes always-on at +$3.03/month.
