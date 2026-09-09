import type { Broker, Draft } from "./types.ts";

// The caller holds the shared action lock across prepare, submit, and refresh.
export async function submitQuickOrder({
  broker,
  accountID,
  draft,
  isDemo,
  isCurrent,
}: {
  broker: Pick<Broker, "prepare" | "submit">;
  accountID: string;
  draft: Draft;
  isDemo: boolean;
  isCurrent: () => boolean;
}) {
  const changed = () => new Error("账户、交易模式或订单内容已变化，请重新下单。");
  if (!isCurrent()) throw changed();
  const snapshot = await broker.prepare(accountID, Object.freeze({ ...draft }));
  if (!isCurrent() || snapshot.accountID !== accountID || snapshot.isDemo !== isDemo)
    throw changed();
  const age = Date.now() - snapshot.preparedAt;
  if (!Number.isFinite(age) || age < 0 || age > 60000)
    throw new Error("订单核对已失效，请重新下单。");
  // Preserve the broker's frozen identity and propagate failures without retrying.
  const result = await broker.submit(snapshot);
  return { snapshot, result };
}
