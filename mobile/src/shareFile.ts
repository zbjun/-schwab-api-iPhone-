import { Platform, Share } from "react-native";
import { File, Paths } from "expo-file-system";

/** Hands a generated text file to the iOS share sheet (or a browser download on web). */
export async function shareTextFile(name: string, text: string, mimeType = "text/csv") {
  if (Platform.OS === "web") {
    const url = URL.createObjectURL(new Blob([text], { type: `${mimeType};charset=utf-8` }));
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return;
  }
  const file = new File(Paths.cache, name);
  file.create({ overwrite: true });
  file.write(text);
  try {
    await Share.share({ url: file.uri, title: name });
  } finally {
    // Trade history should not linger in the cache once the share sheet closes.
    try { file.delete(); } catch {}
  }
}
