# ADR-0003: Cost the hosting candidates per 1,000 concurrent players and escalate the choice

- **Status:** **Board-gated** for the provider choice and the monthly budget (§7, §10).
  **Accepted** for the workload model (§2), the constraint findings (§5) — including the
  disqualification of Upstash as the production live-state store — and the free-tier path (§8).
- **Date:** 2026-09-30
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
cannot be deployed without downtime), **1 Redis** ≥ 256 MB with `noeviction` and AOF, **1
Postgres** ~4 GB with 50 GB storage, **526 GB egress** (U₂₄).

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

**Redis is a self-run Fly Machine under our own `redis.conf`, not Upstash.** See §5.1 — this is
a correctness requirement, and it happens to be cheaper.

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

### 5.1 Redis must support `maxmemory-policy noeviction`

[ADR-0001](./0001-v1-stack.md) §6: live room state is authoritative in Redis between Postgres
snapshots, so a silently evicted key is a lost match.

| Provider | Verdict                                                                                                                             | Finding                                                                                                                                                                                                                                                                                     |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Render   | **Pass — cleanest of the five**                                                                                                     | Render Key Value exposes the maxmemory policy explicitly, including `noeviction`: _"Don't evict data. Instead, return an error on write operations whenever the instance is out of memory."_ Journal + Snapshot persistence runs `appendfsync everysec`, matching our `docker-compose.yml`. |
| Railway  | **Pass**                                                                                                                            | Redis runs as our own container under our own `redis.conf`. Identical config to local.                                                                                                                                                                                                      |
| Hetzner  | **Pass** self-run / **conditional** with an external managed tier — which must be one that exposes `maxmemory-policy`. Not Upstash. |
| AWS      | **Pass**                                                                                                                            | `maxmemory-policy = noeviction` via a **custom** parameter group. The _default_ parameter group is immutable, so this is a required provisioning step, not a default. (`r6gd` data-tiering nodes restrict the allowed policies — not a node type we would use.)                             |
| Fly.io   | **Conditional pass — and a disqualification inside it**                                                                             | See below.                                                                                                                                                                                                                                                                                  |

**Upstash is disqualified as the production live-state store**, on Fly or anywhere else. It does
not expose `maxmemory-policy`. It offers an eviction **on/off toggle** whose algorithm, when on,
is a proprietary `optimistic-volatile` scheme (volatile-random, then allkeys-random). Its default
is no eviction, so the _behaviour_ is correct today — but the guarantee is a vendor default we
cannot pin in configuration, cannot assert in a test, and cannot notice changing. For a key whose
loss is a lost match, "the vendor's current default happens to be right" is not a guarantee.
**Fly therefore passes via a self-run Redis Machine with our own `redis.conf`** — the same file
we already run locally — which is also $1.31/month cheaper than an Upstash fixed plan.

Two related notes that de-risk this constraint:

- **Upstash's per-request pricing is a trap at our shape.** At the 450 ops/s of §2.1, pay-as-you-go
  at $0.20 per 100k commands is **1.18 Bn commands/month = $2,366/month**. Anyone reaching for
  Upstash must be on a fixed plan. Recorded so nobody discovers this from an invoice.
- **Every provider's Redis risks ≤1 s of writes on failure** (`appendfsync everysec`). That is
  acceptable for us and it is worth writing down why: Postgres holds the match log and is the
  replay source ([ADR-0001](./0001-v1-stack.md) §6), so losing ≤1 s of Redis costs a replay, not
  a match. _Eviction_ is unrecoverable because it is silent and selective; _crash loss_ is
  recoverable because it is detectable and total. That asymmetry is the whole reason this
  constraint is about `noeviction` specifically.

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

| Constraint                       |                   Fly.io                   |   Railway   |              Render              |               Hetzner                |                AWS                 |
| -------------------------------- | :----------------------------------------: | :---------: | :------------------------------: | :----------------------------------: | :--------------------------------: |
| 1. Redis `noeviction`            |        ⚠ pass, **not via Upstash**         |     ✅      |           ✅ **best**            | ⚠ self-run or a tier that exposes it |       ✅ custom param group        |
| 2. WebSocket survival            | ⚠ ~30 s idle, beaten by our 10 s heartbeat |     ✅      |                ✅                |                  ✅                  | ⚠ must raise ALB default from 60 s |
| 3. Per-PR previews               |                     ✅                     | ✅ **best** |           ✅ paid only           |     ❌ **as bought**, ⚠ as built     |             ⚠ as built             |
| 4. M6 fleet + room-level routing |           ✅ **only native one**           |   ⚠ built   | ⚠ weakest — random WS assignment |               ✅ built               |              ✅ built              |
| 5. < 150 ms p95 in-region        |               ✅ 35+ regions               |    ✅ 4     |               ✅ 5               |                 ✅ 6                 |               ✅ 30+               |
| Turn-based $/U₂₄                 |                  **100**                   |     149     |               225                |              **41–62**               |              208–336               |
| Real-time $/U₂₄ (M6)             |                   1,853                    |    4,267    |    **12,022 — disqualifying**    |              **52–128**              |               6,617                |

No candidate is disqualified outright for M0–M5. **Render is disqualified for M6 on egress
(§4).** **Upstash is disqualified as the production live-state store (§5.1).** **Hetzner fails
Constraint 3 as bought** and passes only at the cost of building a preview system.

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

---

## 7. Recommendation (board decides, §10)

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

**Two conditions attach to this recommendation and are not optional:**

- **Redis is a self-run Fly Machine under our own `redis.conf`, not Upstash** (§5.1).
- **The presence heartbeat is ≤10 s and is sent by the server as well as the client** (§5.2).

### 7b. Runner-up: Render

If the board weights "a managed Redis with an explicit `noeviction` setting and Journal+Snapshot
persistence, configured in a dropdown rather than by us" above everything else, Render is the
honest second. It is the cleanest pass on Constraint 1 and it is 2.25× the cost. It is the weakest
on Constraint 4 and **it is disqualified for M6**, so choosing it is choosing to move providers
before the real-time milestone. That is a legitimate trade — M6 is two board gates away — but it
should be made knowingly.

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

## 8. The free-tier path for M0 — and what it does not prove

No paid tier has been signed up for and none is proposed until the board answers §10. This is what
we can stand up on free tiers **today**, against M0 acceptance criteria 1, 2 and 5.

### What we can do for $0

| Component                 | Free option                                            | Notes                                                                                               |
| ------------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| CI                        | GitHub Actions                                         | Free on a public repo; 2,000 min/month private. Gated on [PER-35](/PER/issues/PER-35) (which repo). |
| `apps/web` staging        | **Cloudflare Pages** (free, unlimited egress)          | Preferred over Vercel Hobby, which forbids commercial use (§5.6).                                   |
| `apps/web` per-PR preview | Cloudflare Pages preview deployments                   | **Genuinely free and genuinely per-PR** — but web-only.                                             |
| `apps/realtime` staging   | **Render free web service**                            | The only candidate whose free tier runs a long-lived Node WebSocket process.                        |
| Redis                     | Upstash free (256 MB, 500k commands/month)             | Eviction off by default → correct behaviour for a demo. Not for production (§5.1).                  |
| Postgres                  | Neon free (0.5 GB, 100 CU-h) or Supabase free (500 MB) | Supabase free projects pause after a week idle; Neon does not. Prefer Neon.                         |
| Sentry / PostHog / uptime | Free tiers                                             | Already the plan in [ADR-0001](./0001-v1-stack.md) §8.                                              |

**Fly and Railway cannot be the free path.** Fly removed its free allowance for new accounts in
October 2024 (new signups get a trial only); Railway has no free tier, with Hobby at $5/month. This
is worth stating because it means **the free-tier path and the recommended provider are different
providers** — the free demo is throwaway, not a first step.

### What this demonstrates

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

### What it does not prove — stated plainly

1. **Nothing about the < 150 ms p95 target.** Free instances are cold-start-prone and share CPU
   with strangers. A p95 measured on a free tier is not evidence for or against the target.
2. **Nothing about 2,000 rooms per instance.** Free instances are 512 MB. I9 stays unmeasured.
3. **Nothing about Redis correctness under our control.** Upstash free exposes no `redis.conf`;
   we would be relying on the same vendor default that §5.1 disqualifies for production.
4. **Nothing about restart survival under load.** The mechanism in
   [ADR-0001](./0001-v1-stack.md) §6 can be unit-tested, but not exercised at 500 rooms on a free
   tier.
5. **Nothing about real-time egress.** 500k Redis commands/month is ~0.19 ops/s. §4 stays a
   projection.
6. **Nothing about the deploy story**, because a shared staging service redeployed by hand is not
   the per-PR isolation AC1 asks for.

**Recommendation for the interim:** stand the free path up now so
[PER-6](/PER/issues/PER-6)/[PER-7](/PER/issues/PER-7) are not idle, mark M0 AC1 explicitly
**partially met** rather than quietly met, and do not let a green free-tier demo be read as
evidence for any non-functional target.

---

## 9. Evidence, and what is owed

Everything in §3 is arithmetic over published list prices checked on 2026-09-30 and the model
inputs in §1. **List prices are quotes, not measurements**, and three of them are marked
**[unverified]** and must be confirmed before any commitment: Render's ~4 GB Postgres tier, a
managed Redis tier for Hetzner H1, and Render's compute pricing above the Standard instance.

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

**Decision 1 — provider for M0–M5.** Recommendation: **Fly.io**, with the two conditions in §7a.
Alternatives on the table: Render (cleanest Redis, 2.25×, disqualified for M6), Railway (best
previews, 1.5×, no dedicated CPU), Hetzner (cheapest, fails per-PR previews as bought), AWS (most
capable, 2–3×, most of our attention).

**Decision 2 — monthly infrastructure budget through M5.** Requesting **$250/month**, with a hard
ceiling of **$400/month** above which I return to the board.

| Line                                                                            | $/month |
| ------------------------------------------------------------------------------- | ------: |
| Production, up to 1,000 concurrent (§3.1)                                       |     100 |
| Staging (1 app machine + Redis + MPG Basic)                                     |      60 |
| Per-PR previews (ephemeral, ~30 PR-days/mo)                                     |      25 |
| Sentry, PostHog, uptime monitor                                                 |       0 |
| Subtotal                                                                        | **185** |
| Requested, absorbing the three **[unverified]** lines and a duty cycle above I3 | **250** |

**Decision 3 — which regions v1 serves.** Raised in §5.5 as a question the board may not realise
it is answering. It is a product decision with a cost, and it changes the weighting of Decision 1.

**Not requested here:** any M6 spend, any signup, any domain purchase. M6 hosting is gated with M6
itself.

**Until the board answers**, [PER-6](/PER/issues/PER-6) (CI + preview deploys) and
[PER-7](/PER/issues/PER-7) (environments) proceed only as far as the free-tier path in §8 allows,
and M0 AC1 is marked **partially met**, not met.

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

**Harder**

- We are committed to a self-run Redis on Fly rather than a managed one — one more process we own,
  chosen deliberately over a `noeviction` guarantee we cannot pin.
- The free-tier path and the recommended provider are different providers, so the M0 demo is
  throwaway rather than a first step.
- M0 AC1 cannot be fully met without spend. That has to be said to the board rather than papered
  over with a web-only preview.

**Committed to**

- Fronting `apps/web` static output with a free-egress CDN, or re-deriving §3.
- A match-log retention policy before the log grows past one U₂₄-month.
- A ≤10 s heartbeat in both directions on every WebSocket connection.
- Not using Upstash for authoritative live room state, in any environment that matters.

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
- **Upstash exposes a real `maxmemory-policy` control** → the §5.1 disqualification lifts.
- **Render publishes egress pricing competitive with Fly's $0.02/GB** → the M6 disqualification in
  §4 lifts.
