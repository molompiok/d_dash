//app\controllers\Utils\media\multipleSizeMedia.ts
import { createFile} from "./CreateFiles.js";

export async function multipleSizeMedia(
  request: any,
  table_id: string,
  table_name: string,
  column_name: string,
  sizes: { width: number; height: number }[],
  options?: any
): Promise<string[]> {
  const urls = [];

  for (const size of sizes) {
    const url = await createFile({
      request,
      table_id,
      table_name,
      column_name,
      options: { ...options, resize: size },
    });

    if (url) urls.push(url);
  }

  return urls;
}
