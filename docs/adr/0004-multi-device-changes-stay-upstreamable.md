# Multi-device changes stay upstreamable

The multi-device work (device identity, device-local data, per-device graph ledgers, ownership markers, conflict copies, responsive UI) lives in the fork `Znerual/learnharness`, not upstream. It is still designed as if it would be proposed upstream: a single-device user sees no change in behavior, and every format change migrates by itself on first launch. The fork keeps merging upstream releases, and a fork-only format would conflict on every merge.
