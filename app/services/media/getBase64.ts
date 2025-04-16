//app\controllers\Utils\media\getBase64.ts

import fs from "fs/promises";
import fetch from "node-fetch"; // Assurez-vous que "node-fetch" est installé : pnpm add node-fetch

export { getBase64, getFileBuffer,resizeImageToBase64}

async function getBase64(filePath: string): Promise<string> {
  try {

    if (filePath.startsWith("http")) {
      // 📌 Cas d'une URL distante
      const response = await fetch(filePath);
      if (!response.ok) throw new Error(`Erreur HTTP ${response.status}`);
      
      const arrayBuffer = await response.arrayBuffer();
      const fileBuffer = Buffer.from(arrayBuffer);

      return fileBuffer.toString("base64");

    } else {
      // 📌 Cas d'un fichier local
      const fileBuffer = await fs.readFile(filePath);
      return fileBuffer.toString("base64");
    }
  } catch (error) {
    console.error("❌ Erreur lors de la conversion en Base64 :", error);
    throw error;
  }
}

import sharp from "sharp";

/**
 * 📂🌍 Récupère un fichier sous forme de Buffer (local ou distant)
 */
async function getFileBuffer(filePath: string): Promise<Buffer> {
  if (filePath.startsWith("http")) {
    // 🌍 Fichier distant (via URL)
    const response = await fetch(filePath);
    if (!response.ok) throw new Error(`HTTP Error: ${response.status}`);

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } else {
    // 📂 Fichier local
    return fs.readFile(filePath);
  }
}

/**
 * 🖼️📦 Redimensionne une image en Base64
 */
async function resizeImageToBase64(filePath: string,size:[number,number]=[64,64]): Promise<string> {
  const imageBuffer = await getFileBuffer(filePath);

  // 🔄 Sharp pour redimensionner l'image
  const resizedBuffer = await sharp(imageBuffer)
    .resize(size[0], size[1]) // Redimensionner à 64x64
    .toFormat("webp") // Convertir en WebP (optionnel)
    .webp({ quality: 80 })
    .toBuffer(); // Récupérer le buffer final

  // 🔄 Convertir en base64
  return 'data:image/webp;base64,'+resizedBuffer.toString("base64");
}
