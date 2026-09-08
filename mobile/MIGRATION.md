# Expo Go migration plan

Keep the verified SwiftUI release intact in `../ios`. Implement the active Expo / React Native client in this directory, with no cloud build needed for normal JavaScript UI and logic iteration.

1. Port shared data, session calendar, charts and transaction invariants. Price/volume charts retain MA and pre/post labels, pinch/pan and inline trade layout.
2. Implement direct Schwab HTTP, manual callback paste, secure device storage, immutable order review, no automatic write retry, persisted uncertain-write marker, and distinct demo mode.
3. Port five Chinese screens and stock detail, all previously requested stock/ETF flows. Preserve explicit confirmation and incomplete-data states.
4. Run fixture-based unit tests, TypeScript checks, Expo dependency validation and iOS JavaScript export. Verify the running web preview, then start Metro on the local network and provide the Expo Go link/QR for physical iPhone validation.

Expo Go cannot register our own OAuth redirect scheme. Keep the existing browser login → `https://127.0.0.1` → explicit paste workflow; do not claim automatic callback support. Sensitive configuration must stay out of committed sources, public manifests, logs and web exports. Do not run live orders or consume EAS build credits during this migration.
