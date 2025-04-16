import { execPromise } from "./helpers.js";
import fs from "fs/promises";

/**
 * Supprime le fond d'une image avec `rembg`
 * @param inputPath Chemin du fichier original
 * @returns Chemin du fichier sans fond
 */
export async function removeBackground(inputPath: string): Promise<string> {
  const outputPath = inputPath.replace(/\.\w+$/, "_no_bg.png");

  try {
    // Vérifie que `rembg` est installé
    await execPromise("rembg -v");

    // Supprime le fond de l'image
    await execPromise(`rembg i "${inputPath}" "${outputPath}"`);

    // Vérifie si le fichier a été généré
    await fs.stat(outputPath);
    
    return outputPath;
  } catch (error) {
    console.error("Erreur suppression fond :", error);
    throw new Error("Impossible de supprimer le fond de l'image.");
  }
}
