---
title: Q4 migration plan
status: in-progress
owner: alex
tags:
  - infra
  - migration
due: 2026-12-01
---

# Q4 migration plan

## Goals

1. Move ingestion to the new queue.
2. Cut p95 latency below 200 ms.
3. Retire the legacy cron box.

## Steps

- [x] Inventory current jobs
- [ ] Dual-write for two weeks
  - [ ] Add a comparison dashboard
  - [ ] Alert on drift > 0.1%
- [ ] Cut over

## Risks

> [!WARNING]
> Backfills may double-count events during dual-write.

See [the spec](specs/queue.md) and [[decisions]].
