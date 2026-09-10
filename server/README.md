# Personal shared Schwab server

One server owns the existing Schwab Client ID, Client Secret and OAuth tokens. Each phone uses a different device connection key. Refreshes run through the same broker instance; the server also shares one upstream market socket across both phones. There is no browser trading API and no dependency installation for the server itself.

This source is implemented and locally tested. A reachable server with HTTPS still needs to be configured before real phones can use it. No deployment, real trade or IPA build is implied by these instructions.

## Initial setup

Use Node **24.11 or newer**. Copy both `server/` and `mobile/src/` from this repository; the server reuses the existing broker and stream parser. Keep a single running server process per vault. Do not use a process manager cluster or multiple replicas.

From the repository root:

```sh
node server/init.mjs
```

This exclusively creates `server/config.json` and a random `server/vault.key`, without printing secrets. It generates independent random keys for two devices. Edit `config.json` locally on the server:

- `clientID` and `clientSecret`: the existing Schwab app credentials.
- `callbackURL`: preferably `https://YOUR-HOST/oauth/callback`, registered exactly in the existing Schwab developer app. This address must serve this gateway through HTTPS.
- `devices`: a unique ID and generated token per phone. In the app, enter the server's HTTPS origin and only that phone's token.
- `dataDirectory` and `encryptionKeyFile`: paths relative to the config file. Keep the encryption key separate from a copied vault backup.

The example's `https://127.0.0.1` callback is a fallback for manually pasting a callback URL in the app. It is not an automatic hosted callback. Do not replace it with an invented public host.

Start the service from the repository root:

```sh
node server/start.mjs server/config.json
```

It binds **127.0.0.1:8788** by default. Put an HTTPS reverse proxy in front, forward `/rpc`, `/market` and `/oauth/callback`, and allow at least 30 seconds for long-poll responses. Do not publicly expose the plain HTTP port. An example Caddy configuration for an actual controlled DNS host is:

```caddyfile
YOUR-HOST {
    reverse_proxy 127.0.0.1:8788
}
```

Ensure proxy/application access logs do not record OAuth callback query strings or Authorization headers. Protect config, key and data with permissions for the service user only. Windows users must also restrict the containing directory ACL; Unix file modes alone do not configure Windows ACLs.

## Switch both devices

1. Stop using direct Schwab authorization on both phones. Old direct-mode apps must not continue refreshing the same session.
2. On each updated app, open **Settings → Schwab connection → Server shared** and save the same HTTPS origin plus a different device key.
3. Authorize once from either device. The login runs on Schwab's official page; the server callback stores tokens in the encrypted vault. Return to the app and refresh. The second phone sees the same authorized session.
4. Forgetting a server connection removes that phone's local configuration only. To revoke a phone, remove or replace its token in the server config and restart the service. It does not revoke the other phone's Schwab session.

Phones receive accounts, orders, quotes and review results, never Schwab tokens or the Client Secret. The server cannot avoid a reauthorization explicitly required by Schwab; when needed, authorize once again for both phones.

## Orders and recovery

Preparations and writes are serialized across devices. Only the latest broker review is valid, bound to the device that requested it, and accepted once for 60 seconds. A review on the other phone can invalidate the first review; the app must request a new review rather than silently constructing or replaying an order.

An uncertain submit/replace/cancel outcome leaves a durable encrypted marker and blocks new writes for **both** devices. There is no automatic retry and no remote endpoint to erase that shared marker.

After checking the actual order result in Schwab:

1. Stop the server cleanly and make sure it has exited.
2. On the server, run the explicit operator recovery command:

```sh
node server/reconcile.mjs server/config.json --confirmed-at-broker
```

3. Restart the server. Affected phones can then acknowledge the already-verified result to clear their own local unknown-operation notice.

The recovery command clears the marker only; it neither verifies the order for you nor sends any brokerage request. It refuses to run while the server lock exists. If the server crashed, confirm no process still owns the vault before manually removing `data/process.lock`. Do not remove a lock just to bypass an active owner.

Back up `vault.enc` and its matching key securely. Tampered data or a wrong key fails closed. Never delete the vault to work around an uncertain transaction.

## Checks

From `server/`:

```sh
npm test
```

Tests use only fictional data, local HTTP fixtures and fake upstream sockets. Runtime config, encrypted vault, keys and lock files are ignored by Git. They must also be excluded from deployment bundles sent to unrelated services.
