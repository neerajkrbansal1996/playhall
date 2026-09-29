# ADR-0003: Cost the hosting candidates per 1,000 concurrent players and escalate the choice

- **Status:** **Board-gated** for the provider choice and for the three priced proposals in §11.
  **Accepted** for the workload model (§2), the cost models (§3, §4), the constraint findings
  (§5) and the $0 topology (§8).
- **Date:** 2026-09-30
- **Amended:** 2026-09-30 (**rev 2**) — the board set the infrastructure budget to **$0**, and
  [ADR-0001](./0001-v1-stack.md) rev 2 withdrew the `noeviction` disqualifier. **§5.1, §7, §8
  and §10 changed materially and §0 and §11 are new.** See
  [What changed in rev 2](#what-changed-in-rev-2).
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

---

## 0. Summary for the board {#summary-for-the-board}

The three things Chief of Staff asked for, in one screen. Everything below is the derivation.

**1. Cost per 1,000 concurrent players per month ($/concurrent player-month in brackets):**

| Provider                | Turn-based (M1–M5, real) |          Real-time (M6, projection) |
| ----------------------- | -----------------------: | ----------------------------------: |
| Hetzner bare VM (floor) |          **$41** (0.041) |             **$52–128** (0.05–0.13) |
| Hetzner + managed data  |              $62 (0.062) |                                   — |
| **Fly.io**              |         **$100** (0.100) |                   $1,853 **(1.85)** |
| Railway                 |             $149 (0.149) |                   $4,267 **(4.27)** |
| AWS ECS/Fargate         |   $208–336 (0.208–0.336) |                   $6,617 **(6.62)** |
| Render                  |             $225 (0.225) | **$12,022 (12.02) — disqualifying** |

Turn-based cost at our scale is **~90% a fixed floor** (§2.1): 1,000 concurrent players is a
quarter of one instance. Real-time cost is **dominated by egress** (§4) — 85% of the Fly bill,
96% of the AWS one and 98% of Render's: 30 KB/s × 1,000 clients is **78.8 TB/month**, and the
per-GB rate differs **153×** across the candidate set.

**2. What $0 buys, and where it stops.** §8 gives a free-tier topology — Cloudflare Pages +
Render free + Upstash free + Neon free — that carries M0 through roughly M2. **The ceiling
that bites first is not a quota, it is a correctness failure:** Render's free tier spins a
service down after 15 minutes without traffic, and a spun-down room server drops its sockets
and loses live room state (§8.2). The first _quota_ to bite is Upstash's 500K commands/month,
which at our 10 s heartbeat is **about 20 concurrent players for two hours a day** (§8.2).

**3. The three things $0 cannot buy, priced as discrete asks** (§11). They are deliberately
separate so the board can approve one and refuse the others:

| #     | Ask                                                      | Shape                | Number                                    |
| ----- | -------------------------------------------------------- | -------------------- | ----------------------------------------- |
| §11.1 | An always-on process for `apps/realtime`, prod + staging | **standing monthly** | **$6–7/month**                            |
| §11.2 | The M5 load test at 2,000 rooms                          | **one-off window**   | **$8** (capacity) / **$100 cap** (p95)    |
| §11.3 | A Mumbai-region fleet for M6                             | **standing monthly** | **$75/month** pilot; $488/mo at 1,000 CCU |

**The single most useful number in this document is $6–7/month.** That is the entire distance
between "$0, and the staging WebSocket server drops connections when a game goes quiet" and a
correct always-on production and staging pair. It is 0.03% of one engineer-day per month.

**One decision the board is making without being asked:** which regions v1 serves (§5.5,
§11.3). If the answer is India, **Fly's India egress is $0.12/GB — 6× its NA/EU rate** — which
adds $53/month to the turn-based number above and $7,900/month to the real-time one, and moves
the recommendation. Raised as Decision 3 in §10.

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

| Line             | Derivation                                                 |   $/month |
| ---------------- | ---------------------------------------------------------- | --------: |
| App × 2          | shared-cpu-2x/2 GB: (2 × $1.97 + 1.5 GB × $6.09) × 1.1 × 2 |     28.76 |
| Redis (self-run) | shared-cpu-1x/1 GB × 1.1 + 10 GB volume                    |      8.69 |
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
backups +20% of server price. **Included traffic is region-dependent: EU 20 TB, US 1–8 TB by
plan, APAC 0.5 TB.** Overage ≈ **$1/TB**. No managed Redis, no managed Postgres, no native
per-PR previews.

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

| Provider                | $/month per U₂₄ | $ per concurrent player-month | vs. bare-VM floor |
| ----------------------- | --------------: | ----------------------------: | ----------------: |
| **Hetzner H2** (floor)  |              41 |                         0.041 |             1.00× |
| Hetzner H1              |              62 |                         0.062 |             1.52× |
| **Fly.io**              |             100 |                         0.100 |             2.45× |
| Railway                 |             149 |                         0.149 |             3.65× |
| AWS (optimistic)        |             208 |                         0.208 |             5.07× |
| Render                  |             225 |                         0.225 |             5.49× |
| AWS (production-shaped) |             336 |                         0.336 |             8.20× |

The whole managed-vs-bare spread is **$41 → $225**. At our scale this is not the decision. It is
worth less than one engineer-day per month. §4 is the decision.

---

## 4. Real-time cost per 1,000 concurrent players — M6 sizing only

Footprint: **8 dedicated vCPU / 16 GB** (per §2.2) and **78.8 TB egress** at the 30 KB/s
ceiling. This section sizes a milestone the board has not opened. It is here because the
_turn-based_ provider choice must not foreclose it.

| Provider |       Compute $/mo | Egress $/mo @ 30 KB/s |  **Total** | $/player-mo | Egress @ 10 KB/s |
| -------- | -----------------: | --------------------: | ---------: | ----------: | ---------------: |
| Hetzner  |         52 (CCX33) |          0 EU – 76 US | **52–128** |   0.05–0.13 |           0 – 23 |
| Fly.io   |                277 |                 1,577 |  **1,853** |    **1.85** |              526 |
| Railway  |                325 |                 3,942 |  **4,267** |    **4.27** |            1,314 |
| AWS      |                288 |                 6,329 |  **6,617** |    **6.62** |            2,276 |
| Render   | 200 [extrapolated] |                11,822 | **12,022** |   **12.02** |            3,938 |

Egress derivations:

```
Fly      78,840 GB × $0.02                                            = $1,576.80
Railway  78,840 GB × $0.05                                            = $3,942.00
Render   (78,840 − 25) GB × $0.15                                     = $11,822.25
AWS      100 GB free
         + (10,240 − 100) × $0.09   = $  912.60
         + (51,200 − 10,240) × $0.085 = $3,481.60
         + (78,840 − 51,200) × $0.07  = $1,934.80                     = $6,329.00
Hetzner  EU: 30 TB included on CCX33, 48.8 TB × €1/TB × 1.08          = $   52.70
         US: 3 TB included, 75.8 TB × $1/TB                           = $   75.80
```

**Three findings.**

1. **The spread is 94–231×, and it is almost entirely egress.** On Render, egress is 98% of the
   bill. On Hetzner it is 0–59%. Compute differs by ~6× across the five; the per-GB rate differs
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

| Provider |                                                             Regions | Verdict |
| -------- | ------------------------------------------------------------------: | ------- |
| AWS      |                                                                ~30+ | Pass    |
| Fly.io   |                                                                 35+ | Pass    |
| Hetzner  | 6 (Nuremberg, Falkenstein, Helsinki, Ashburn, Hillsboro, Singapore) | Pass    |
| Render   |                    5 (Oregon, Ohio, Virginia, Frankfurt, Singapore) | Pass    |
| Railway  |                              4 (US-West, US-East, EU-West, SE-Asia) | Pass    |

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
| 5. < 150 ms p95 in-region                         |               ✅ 35+ regions               |      ✅ 4       |               ✅ 5               |                         ✅ 6                          |               ✅ 30+               |
| Turn-based $/U₂₄                                  |                  **100**                   |       149       |               225                |                       **41–62**                       |              208–336               |
| Real-time $/U₂₄ (M6)                              |                   1,853                    |      4,267      |    **12,022 — disqualifying**    |                      **52–128**                       |               6,617                |

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

## 7. Recommendation (board decides, §10)

> **Rev 2: this section is conditional on a budget existing.** The board has set the budget to
> **$0**, so **§8 is the operative section today** and §7 is what to buy on the day the answer
> changes — including for any of the three asks in §11, each of which lands on the provider
> chosen here. §7 is kept rather than deleted because "which provider, when there is money"
> is the question the board will ask next, and the analysis that answers it is already done.

**Split the decision by workload and by time.**

### 7a. M0–M5 — turn-based, staging and per-PR previews: **Fly.io**

Ranked reasons:

1. **Constraint 4 is the only one that is expensive to be wrong about, and Fly is the only
   candidate that passes it natively.** The Machines API plus `fly-replay` room-level routing is
   the M6 fleet primitive, available now, at no extra cost, on the provider we would already be
   using. Every other candidate requires us to build a routing tier in M6 — work that is invisible
   today and unbudgeted.
2. **$0.02/GB egress**, second only to Hetzner's effectively-free, and the cheapest of any
   provider with per-PR previews.
3. **35+ regions** — the only lever on Constraint 5, and the only defence against the regional
   question in §5.5.
4. **≈ $100/month per 1,000 concurrent turn-based players**, second-cheapest managed option and
   2.45× the bare-VM floor.

5. **Postgres is co-located** (§5.1b) — Fly Managed Postgres runs in the same region as the
   app, which is what makes the ≤ 10 ms p95 log append reachable. Rev 2 promotes this from an
   unstated convenience to a named reason.

**Conditions attaching to this recommendation** (rev 2 reduces three to two):

- **The presence heartbeat is ≤ 10 s and is sent by the server as well as the client** (§5.2).
  Not optional — it is what defeats Fly's ~30 s idle timeout.
- **Postgres is Fly Managed Postgres in the same region as the app**, not an external managed
  tier (§5.1b). Not optional — an off-Fly Postgres reintroduces the cross-provider hop.
- ~~Redis must be a self-run Machine, not Upstash~~ — **withdrawn in rev 2.** Self-run is still
  what §3.1 prices, because it is $1.31/month cheaper and we already own the `redis.conf`, but
  an Upstash fixed plan is now an acceptable substitute and the choice is reversible in an hour.

**This recommendation is conditional on Decision 3 (regions).** If v1 serves India, Fly's
**$0.12/GB** egress there is 6× its NA/EU rate; the turn-based U₂₄ egress line goes from $10.52
to $63, and reason 2 above — cheap egress — stops being true where it matters most. In that
case the shortlist should reopen with **Akamai/Linode Mumbai** and **AWS ap-south-1** in it
(§11.3). I am not pre-deciding that here because the region question is the board's.

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

### 7c. M6 — real-time fleet: **do not decide now**

Provisional direction, for sizing only: **Hetzner dedicated vCPU**, at ~$0.11–0.13 per concurrent
player-month against Fly's $1.85, Railway's $4.27, AWS's $6.62 and Render's $12.02. Decide at the
M6 gate, with measured bytes/s and CPU ms/tick from the M4 spike
([PER-30](/PER/issues/PER-30)), in the real-time ADR ([PER-21](/PER/issues/PER-21)), alongside
Cloudflare Durable Objects (§6). **No M6 spend is being requested here.**

---

## 8. The $0 topology — what free tiers buy, and where each one stops

**This is the operative section**, since the board has set the budget to $0. No paid tier has
been signed up for, no payment method has been given to any vendor, and none is proposed
outside the three discrete asks in §11.

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
| **Fly.io `shared-cpu-1x` / 512 MB, `iad`** |                      **$5.52** | **Recommended.** $1.97 vCPU + 0.5 GB × $6.09 = $5.02, × 1.1 regional = $5.52                                                               |
| Fly.io `shared-cpu-1x` / 256 MB            |           ~$2.02 vendor-quoted | The published floor, and **too small for a room server** — 2,000 rooms × 64 KB (I9) is 128 MB before Node's own heap. Quoted, not planned. |
| Railway Hobby                              |                          $5.00 | Includes $5 of usage; a 512 MB Node process meters at roughly $5–7                                                                         |
| Render Starter                             |                          $7.00 | Per service, no spin-down. Simplest migration from the free tier.                                                                          |
| Hetzner CPX22 (2 vCPU / 4 GB)              |                          $8.63 | Most capacity per dollar, and we own the OS, the TLS renewal and the absent preview system                                                 |

**Q2 — can staging share production's box, or be spun up on demand?**

- **Sharing one box: rejected on blast radius.** Two processes on one VM means a staging deploy
  can OOM or restart production. It saves $5.52/month. That is not a price worth paying to make
  a production outage possible, and it is exactly the trade this ADR exists to make visible.
- **On demand: yes, and this is the answer.** Fly's autostop/autostart stops a Machine when
  traffic drains and restarts it on the next request. **Stopped Machines are not billed for CPU
  or RAM — only for rootfs, at $0.15/GB-month.** So a staging Machine with a 1 GB rootfs costs
  **$0.15/month asleep**, plus per-second compute while awake:

  ```
  staging, awake ~2 h/day   (2 ÷ 24) × $5.52  =  $0.46   +  $0.15 rootfs  =  $0.61/month
  production, always on                                                   =  $5.52/month
                                                                            ───────────
                                                                            $6.13/month
  ```

  **$6–7/month buys a correct always-on production WebSocket server and an on-demand staging
  one.** That is the whole gap between the current $0 position and a topology with no known
  correctness failure in it.

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
strictly worse value than $6–7/month — **which is the argument for §11.1, and it is an argument
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
- **AC1 — a preview deploy per PR: partially, and this is the sharp edge.** Cloudflare Pages gives
  a genuinely free per-PR preview of `apps/web` — pointed at the single shared free staging
  realtime service. A preview that is _end-to-end isolated_ — its own realtime service, its own
  Redis, its own Postgres, so that one PR's schema change cannot break another PR's preview —
  **requires spend on every candidate except a self-built Hetzner path.** AC1 as written on
  [PER-3](/PER/issues/PER-3) is therefore blocked on the board's answer to §10.

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

---

## 9. Evidence, and what is owed

Everything in §3 is arithmetic over published list prices checked on 2026-09-30 and the model
inputs in §1. **List prices are quotes, not measurements**, and three of them are marked
**[unverified]** and must be confirmed before any commitment: Render's ~4 GB Postgres tier, a
managed Redis tier for Hetzner H1, and Render's compute pricing above the Standard instance.

> **Rev 2 adds five more unverified lines**, none of which affects §3 or §4: Cloudflare Pages'
> 500-builds/month limit (§8.1), Sentry and PostHog free quotas (§8.1), whether Fly Managed
> Postgres prorates below a month (§11.2), Akamai/Linode and DigitalOcean Mumbai list prices
> (§11.3), and AWS `ap-south-1` egress (§11.3). **One rev-2 number is a model, not a quote and
> not a measurement: the cross-provider append p95 in §5.1b.** It is decomposed into its terms
> so the reasoning can be attacked, but the only thing that settles it is a measurement, and
> §11.2's Test A is the cheapest way to get one.

> **Measurement owed.**
>
> | #        | What                                                            | Owner             | Issue                                                       | Needed by |
> | -------- | --------------------------------------------------------------- | ----------------- | ----------------------------------------------------------- | --------- |
> | I7       | Bytes per delivered turn-based message on the wire              | Platform Engineer | [PER-15](/PER/issues/PER-15)                                | M1        |
> | I9       | Memory per live turn-based room, hence rooms per instance       | Platform Engineer | [PER-14](/PER/issues/PER-14) / [PER-15](/PER/issues/PER-15) | M1        |
> | —        | Action round-trip p95 from a real staging deploy                | Platform Engineer | [PER-7](/PER/issues/PER-7)                                  | M0        |
> | I10, I11 | Real-time bytes/s per client and CPU ms/tick per 12-player room | CTO / QA          | [PER-30](/PER/issues/PER-30)                                | M4        |
>
> Until I7 and I9 land, §3 rests on the capacity model in
> [ADR-0001](./0001-v1-stack.md) §6. Until I10 and I11 land, **§4 is a projection against a budget
> we set**, and it is labelled as such everywhere it appears.

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

---

## 10. What the board must decide — **board-gated**

Escalated to Chief of Staff on [PER-2](/PER/issues/PER-2). Not decided here.

> **Rev 1's ask is withdrawn.** Rev 1 requested **$250/month with a $400 ceiling**, written
> before the board answered. **The board has answered: $0.** That request is withdrawn in full
> and replaced by the four decisions below, of which only Decision 2 involves money and it
> involves **$6–7/month**, not $250. The $250 model remains valid and is preserved in §3.1 and
> §7 as the answer to "what would it cost to run this properly", which is a different question
> from "what should we spend now".

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

**Until the board answers**, [PER-6](/PER/issues/PER-6) (CI + preview deploys) and
[PER-7](/PER/issues/PER-7) (environments) proceed as far as the $0 topology in §8 allows, and M0
AC1 is marked **partially met**, not met.

---

## 11. What $0 cannot buy — three priced proposals

Chief of Staff asked for these as **discrete proposals**, each one approvable on its own. They
are ordered by urgency, not by size. Only §11.1 is being asked for now.

### 11.1 An always-on process for `apps/realtime` — **$6–7/month, standing**

**The problem, in one sentence:** every free compute tier sleeps on idle, and a room runner that
sleeps drops its sockets and loses authoritative state, which is a correctness failure rather
than a latency one (§8.2).

| Line                                                    |  $/month |
| ------------------------------------------------------- | -------: |
| Production — Fly `shared-cpu-1x` / 512 MB, `iad` (§8.3) |     5.52 |
| Staging — same Machine with autostop, ~2 h/day awake    |     0.61 |
| Contingency (rootfs growth, a second small Machine)     |     0.87 |
| **Requested**                                           | **7.00** |

**What it buys, specifically:** a staging WebSocket server that does not drop connections when a
game goes quiet; timer-service validation ([PER-17](/PER/issues/PER-17)) in a real environment
rather than only in `docker-compose`; a board demo link whose first click does not wait ~50 s;
and — via Fly Managed Postgres in the same region — the ≤ 10 ms p95 log append, which makes
Decision 4 option (a) available for free inside this same ask.

**What it does not buy:** anything about the < 150 ms p95 target at scale (that is §11.2), per-PR
preview isolation for AC1 (that needs a preview environment per PR, ~$25/month on Fly, **not
requested here**), or any M6 capability.

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
| Fly.io `bom`                          | ~$28 (0.5 core equivalent)                 | 7.88 TB @ $0.12/GB = **$946** at the ceiling           |   **~$974** |
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
Fly.io bom      $277 compute  +  78.8 TB × $0.12/GB                          ≈ $9,738/mo  ($9.74)
```

**The finding the board should take from this:** serving India real-time on a PaaS costs
**~20× more** than on a bundled-transfer VPS, and the M6 fleet provider for India is
**Akamai/Linode or DigitalOcean**, not Fly, not AWS, and not Hetzner — which has no region there.
This does not change the M0–M5 recommendation (§7a), because the transport-adapter seam in
[ADR-0001](./0001-v1-stack.md) §4.1 is exactly what lets the fleet live somewhere other than the
lobby. **It does mean that if v1's market is India, the turn-based recommendation should be
re-run with Fly's $0.12/GB India rate applied** — Decision 3.

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

- **Rev 2:** the board can see the distance between $0 and correct, and it is **$7/month** — a
  number small enough to decide without a model, backed by a model if it wants one.

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
- **The board changes the budget from $0** → §7 stops being hypothetical, §8 stops being
  operative, and Decision 4 resolves to option (a) automatically.
- **Any free tier in §8.1 changes its ceiling** — Render's spin-down window, Upstash's 500K
  commands, Neon's 0.5 GB — → re-run §8.2's ranking; the ceiling that bites first can move.
- **The durable-log-append budget is measured above 10 ms p95 on a provisioned tier** → Decision
  4 reopens with option (b), group commit, and that needs its own ADR.
- **[ADR-0001](./0001-v1-stack.md) §6 makes Redis authoritative again** → §5.1's withdrawn gate
  comes back and Upstash is re-disqualified. Recorded so the reversal is a decision rather than a
  rediscovery.
- **v1's market is confirmed as India** → re-run §3 with Fly's $0.12/GB India egress, and reopen
  Decision 1 with Akamai/Linode Mumbai in the shortlist (§11.3).
