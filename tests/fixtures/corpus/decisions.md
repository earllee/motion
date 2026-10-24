# Decisions

| Date | Decision | Why |
| --- | --- | --- |
| 2026-09-02 | Use SQS over Kafka | Ops cost; volume is < 1k msg/s |
| 2026-09-15 | Keep Postgres | Team knows it \| no migration budget |
| 2026-10-01 | Drop `legacy_id` | Unused since v3 |

Each row links back to the thread where it was decided.
