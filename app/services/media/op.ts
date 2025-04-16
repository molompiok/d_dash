import fs from "fs/promises";
import { HttpContext } from "@adonisjs/core/http";
import env from "#start/env";
import {RollbackManager} from "./RollbackManager.js";
import { createFile } from "./CreateFiles.js";

type OptionsType = {
  maxSize?: number;
  min?: number;
  max?: number;
  extname?: string[];
  compress?: "none" | "img" | "video";
  resize?: { width: number; height: number };
  removeBackground?: boolean;
  crop?: { x: number; y: number; width: number; height: number };
  throwError?: boolean;
};

export async function updateFiles({
  request,
  table_id,
  table_name,
  column_name,
  options,
  distinct,
  lastUrls,
  newPseudoUrls,
}: {
  lastUrls: string[];
  newPseudoUrls: string | undefined;
  request: HttpContext["request"];
  table_id: string;
  table_name: string;
  distinct?: string;
  column_name: string;
  options?: OptionsType;
}): Promise<string[]> {
  console.log("🔄 Mise à jour des fichiers pour :", { column_name, table_id, table_name });

  let _newPseudoUrls: string[] = [];
  let _lastUrls: string[] = lastUrls || [];
  const { extname, max, maxSize, min, compress, resize, removeBackground,crop, throwError } = options || {};
  let fileLength = 0;

  // 🔹 Vérifier et parser les nouvelles URLs
  try {
    if (typeof newPseudoUrls === "string") {
      _newPseudoUrls = JSON.parse(newPseudoUrls);
    } else if (Array.isArray(newPseudoUrls)) {
      _newPseudoUrls = newPseudoUrls;
    }
  } catch (error) {
    console.warn("⚠️ Erreur de parsing des nouvelles URLs :", error);
  }

  const pointer = (distinct ? distinct + ":" : "") + column_name + "_";
  const promisesAdd: Promise<string | null>[] = [];

  for (const pseudoUrl of _newPseudoUrls) {
    try {
      if (pseudoUrl.startsWith(pointer)) {
        // 📌 Nouveau fichier reçu via la requête
        const file = request.file(pseudoUrl);
        if (!file) continue;

        if (extname && !extname.includes(file.extname || "")) {
          if (throwError) throw new Error(`❌ Mauvaise extension : ${file.extname}`);
          continue;
        }

        if (maxSize && file.size > maxSize) {
          if (throwError) throw new Error(`❌ Fichier trop volumineux : ${file.size} octets`);
          continue;
        }

        fileLength++;

        promisesAdd.push(
          createFile({
            request,
            table_id,
            file,
            table_name,
            column_name,
            options: { compress, resize, removeBackground, maxSize },
          }).then((filePath) => {
            console.log('!!!!!',filePath);
            
            // RollbackManager.add(filePath); // ✅ Ajout au rollback
            console.log();
            
            return filePath||null; // On retourne le premier fichier traité
          })
        );
      } else {
        // 📌 Vérification des fichiers existants
        const fileStorageUrl = env.get("FILE_STORAGE_URL") || "";
        const filePath = `${env.get("FILE_STORAGE_PATH")}${pseudoUrl.replace(fileStorageUrl, "")}`;

        promisesAdd.push(
          fs.access(filePath)
            .then(() => pseudoUrl)
            .catch(() => null)
        );
      }
    } catch (error) {
      console.error("⚠️ Erreur lors de la gestion d'un fichier :", error);
      promisesAdd.push(Promise.resolve(null));
    }
  }

  // 🔹 Vérifier le nombre de fichiers
  if (min && fileLength < min) {
    if (throwError) throw new Error(`❌ Nombre minimal de fichiers : ${min}`);
    else return [];
  }
  if (max && fileLength > max) {
    if (throwError) throw new Error(`❌ Nombre maximal de fichiers : ${max}`);
    else return [];
  }

  // 🔹 Attendre que tous les fichiers soient traités
  const newUrls = (await Promise.allSettled(promisesAdd))
    .filter((f) => f.status === "fulfilled" && (f as any).value !== null)
    .map((m) => (m as any).value as string);

  // 🔥 Supprimer les anciens fichiers qui ne sont plus utilisés
  const deletePromises = _lastUrls
    .filter((lastUrl) => !newUrls.includes(lastUrl) && lastUrl.includes(table_id))
    .map(async (lastUrl) => {
      try {
        const filePath = `${env.get("FILE_STORAGE_PATH")}${lastUrl.replace(env.get("FILE_STORAGE_URL") || "", "")}`;
        await fs.unlink(filePath);
        console.log(`🗑️ Fichier supprimé : ${filePath}`);
      } catch (error) {
        console.warn(`⚠️ Impossible de supprimer le fichier : ${lastUrl}`, error);
      }
    });

  await Promise.all(deletePromises);

  console.log("📌 Anciennes URLs :", _lastUrls);
  console.log("✅ Nouvelles URLs :", newUrls);

  return newUrls;
}
