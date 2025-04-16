import fs from "fs/promises";

export { RollbackManager }

class RollbackManager {
  private files: string[] = [];

  /**
   * Enregistre un fichier pour rollback en cas d'échec
   */
  add(filePath: string) {
    this.files.push(filePath);
  }

  /**
   * Supprime tous les fichiers enregistrés (rollback automatique en cas d'erreur)
   */
  async rollback() {
    for (const filePath of this.files) {
      try {
        await fs.unlink(filePath);
        console.log(`Rollback: Fichier supprimé -> ${filePath}`);
      } catch (error) {
        console.warn(`Rollback: Impossible de supprimer -> ${filePath}`);
      }
    }
    this.files = [];
  }

  /**
   * Nettoie les fichiers enregistrés si tout s'est bien passé
   */
  clear() {
    this.files = [];
  }
}
