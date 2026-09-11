import type { submitQuickOrder } from "./quickTrading.ts";

export type QuickOrderFeedback = {
  phase: "pending" | "accepted" | "error";
  message: string;
};

// Submission and the subsequent read have different outcomes: a failed refresh
// must never turn an accepted order into a failed submission or retry the write.
export async function completeQuickOrder({
  submit,
  refresh,
  onAccepted,
  onFeedback,
}: {
  submit: () => ReturnType<typeof submitQuickOrder>;
  refresh: () => Promise<void>;
  onAccepted: () => void;
  onFeedback: (value: QuickOrderFeedback) => void;
}) {
  onFeedback({ phase: "pending", message: "正在核对并提交订单…" });
  let accepted: Awaited<ReturnType<typeof submitQuickOrder>>;
  try {
    accepted = await submit();
  } catch (error) {
    onFeedback({
      phase: "error",
      message: error instanceof Error ? error.message : "提交结果未确认，请先核实订单状态。",
    });
    throw error;
  }
  onAccepted();
  const { snapshot, result } = accepted;
  const receipt = `${snapshot.isDemo ? "演示" : ""}订单已提交${result.orderID ? ` #${result.orderID}` : ""}`;
  onFeedback({ phase: "accepted", message: `${receipt}，正在刷新订单状态。` });
  try {
    await refresh();
  } catch {
    onFeedback({
      phase: "accepted",
      message: `${receipt}。订单状态刷新失败，请刷新查看，勿重复提交。`,
    });
    return;
  }
  onFeedback({ phase: "accepted", message: `${receipt}，请在订单页查看成交状态。` });
}
