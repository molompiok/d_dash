//app\controllers\Utils\media\helpers.ts
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";

const execPromise = promisify(exec);

/**
 * Vérifie si un fichier est une image
 */
export function isImage(fileExt: string): boolean {
  return ["jpg", "jpeg", "png", "webp"].includes(fileExt.toLowerCase());
}

/**
 * Vérifie si un fichier est une vidéo
 */
export function isVideo(fileExt: string): boolean {
  return ["mp4", "mov", "avi", "mkv", "webm"].includes(fileExt.toLowerCase());
}

/**
 * Crée un répertoire s'il n'existe pas
 */
export async function createDir(dir: string): Promise<void> {
  try {
    await fs.stat(dir);
  } catch {
    await fs.mkdir(dir, { recursive: true });
  }
}

/**
 * Génère un nom unique pour un fichier
 */
export function generateFileName(
  tableName: string,
  columnName: string,
  tableId: string,
  ext: string
): string {
  return `${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .substring(2)}_${tableName}_${columnName}_${tableId}.${ext}`;
}

export { execPromise };
