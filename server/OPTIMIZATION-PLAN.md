# Authorization, trading and market updates

Implement the source review of Schwabdev without adding a Python runtime or dependencies.

1. Lock authorization recovery and quick-submit safety in broker regression tests. Refresh and retry a failed GET once; never replay a brokerage write. Keep session generations, latest funds/positions checks, durable uncertain-write markers and device serialization.
2. Reuse the existing stream parser and socket for symbol deltas and account activity. Account events invalidate cached reads; REST remains the reconciliation source. Keep polling when stream authorization or connectivity fails.
3. Coalesce client account/order reconciliation, including events received while a read is running. Preserve ordinary review/confirmation behavior; the quick route performs one fresh validation inside a single serialized operation.
4. Retain bounded real minute observations in separate encrypted server storage. Merge only missing historical buckets and expose retained/partial provenance. Never invent overnight candles. Continuous collection is restricted to an explicit server symbol list.
5. Verify with mocked broker/socket tests, mobile typecheck, server tests, and web export. No real orders, production deployment or IPA build are part of this local change.

Refactoring is limited to extracting/reusing the existing validation/write paths and reconcilers. Existing user files and unrelated changes stay intact.
