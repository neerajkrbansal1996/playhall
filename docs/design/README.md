# Design specs

Implementation-level specifications, owned by the engineer who owns the surface. An ADR in
[`docs/adr`](../adr/README.md) decides *what* and *why* and is owned by the CTO; a design spec
here fixes the constants, frame shapes, timeouts and tests that make an ADR buildable, and is
binding on the implementation in the same way.

A spec here may not contradict an ADR. If building against one shows the ADR is wrong, the spec
records the conflict and the ADR is amended — the spec does not quietly win.

Each spec names the issue it serves, the owner, and the evidence that proves it works.

| Spec                                                     | Serves                        | Owner             |
| -------------------------------------------------------- | ----------------------------- | ----------------- |
| [Transport keepalive](transport-keepalive.md)             | [PER-15](/PER/issues/PER-15)  | Platform Engineer |
| [Match log retention](match-log-retention.md)             | [PER-15](/PER/issues/PER-15)  | Platform Engineer |
