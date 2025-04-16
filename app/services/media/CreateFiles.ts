//app\controllers\Utils\media\CreateFiles.ts

import { HttpContext } from "@adonisjs/core/http";
import sharp from "sharp";
import env from '#start/env'
import { removeBackground } from "./removeBackground.js";
import { createDir, generateFileName, isImage, isVideo } from "./helpers.js";
import { execPromise } from "./helpers.js";


export { createFiles, createFile }

type FileType = ReturnType<HttpContext["request"]["file"]>;

type ParamType = {
  request: HttpContext["request"];
  table_id: string;
  table_name: string;
  column_name: string;
  options?: OptionsType;
}
interface OptionsType {
  maxSize?: number;
  resize?: { width: number; height: number };
  removeBackground?: boolean;
  compress?: "none" | "img" | "video";
  crop?: { x: number; y: number; width: number; height: number };
  min?: number;
  max?: number;
  extname?: string[]
  throwError?: boolean;
}


async function createFiles({
  request,
  table_id,
  distinct,
  table_name,
  column_name,
  options = {},
}: ParamType & { distinct?: string }) {
  const promises: Promise<any>[] = [];
  const filesList: FileType[] = [];
  const { min, max, throwError } = options
  for (const [name, file] of Object.entries(request.allFiles())) {
    if (name.startsWith(`${distinct ? distinct + ':' : ''}${column_name}_`))
      filesList.push(Array.isArray(file) ? file[0] : file);
  }
  if (min && filesList.length < min) {
    if (throwError) throw new Error(column_name + " number of Files must be >= " + min);
    else return [];
  }
  if (max && filesList.length > max) {
    if (throwError) throw new Error(column_name + " number of Files must be <= " + max);
    else return [];
  }
  filesList.forEach((file) => {

    promises.push(
      createFile({
        column_name, request, table_id, table_name, file, options
      })
    )
  })
  await createDir(env.get("FILE_STORAGE_PATH") || "")

  return (await Promise.allSettled(promises))
    .filter((f) => f.status == "fulfilled")
    .map((m) => (m as any).value); //urls
}

async function createFile({
  request,
  table_id,
  table_name,
  column_name,
  file: _file,
  options = {},
}: ParamType & { file?: FileType }): Promise<string | null | undefined> {

  const { throwError, extname, maxSize } = options

  let file: FileType | undefined = undefined;
  if (_file) file = _file;
  else {
    for (const [name, f] of Object.entries(request.allFiles())) {
      if (name.startsWith(`${column_name}_`))
        file = Array.isArray(f) ? f[0] : f;
      break;
    }
  }
  if (!file) return null;

  file.extname = file.extname?.toLowerCase() || "";

  if (extname && !extname.includes(file.extname)) {
    if (throwError) throw new Error("File bad Extension : " + file?.extname);
    else return;
  }
  if (maxSize && file.size > maxSize) {
    if (throwError)
      throw new Error("File  size must be < " + file.size + " byte");
    else return;
  }
  await createDir(env.get("FILE_STORAGE_PATH") || "");

  const ext = file.extname?.toLowerCase() || "jpg";
  const fileName = generateFileName(table_name, column_name, table_id, ext);
  let filePath = `${env.get("FILE_STORAGE_PATH")}/${fileName}`;
  let url = `${env.get("FILE_STORAGE_URL")}/${fileName}`;

  if (isImage(ext) && file.tmpPath) {
    let image = sharp(file.tmpPath);

    if (options?.resize) {
      image = image.resize(options.resize.width, options.resize.height);
    }

    if (options?.removeBackground) {
      filePath = await removeBackground(file.tmpPath);
      url = filePath.replace(env.get("FILE_STORAGE_PATH"), env.get("FILE_STORAGE_URL"));
    } else {
      image = image.webp({ quality: 90 });
      await image.toFile(filePath);
    }
  } else if (isVideo(ext) && options?.compress === "video") {
    const compressedFilePath = filePath.replace(/\.\w+$/, ".webm");
    await execPromise(`ffmpeg -i "${file.tmpPath}" -b:v 1M -c:v libvpx-vp9 -crf 30 "${compressedFilePath}"`);
    filePath = compressedFilePath;
    url = filePath.replace(env.get("FILE_STORAGE_PATH"), env.get("FILE_STORAGE_URL"));
  } else {
    await file.move(env.get("FILE_STORAGE_PATH") || "", { name: fileName, overwrite: true });
  }

  return url;
}
