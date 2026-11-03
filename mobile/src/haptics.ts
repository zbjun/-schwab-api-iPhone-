import * as Haptics from "expo-haptics";

/** A tick under the finger. Feedback is never worth an error: where it is unsupported or turned off, nothing happens. */
export function tick(strong = false): void {
  try {
    void (strong ? Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light) : Haptics.selectionAsync()).catch(() => {});
  } catch {}
}
