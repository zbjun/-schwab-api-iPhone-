/** Share a read within one account snapshot generation; serialize newer generations.
 * A post-trade refresh must wait for, but never reuse, a pre-trade response. */
export function createAccountReader<T>() {
  let pending: { key: object; promise: Promise<T> } | undefined;
  async function read(key: object, load: () => Promise<T>): Promise<T> {
    if (pending) {
      if (pending.key === key) return pending.promise;
      await pending.promise.catch(() => {});
      return read(key, load);
    }
    const entry = { key, promise: Promise.resolve().then(load) };
    pending = entry;
    try {
      return await entry.promise;
    } finally {
      if (pending === entry) pending = undefined;
    }
  }
  return { read };
}
