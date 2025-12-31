import logger from '@adonisjs/core/services/logger'

// --- Interface pour les infos d'UN colis, à passer dans un tableau ---
export interface SimplePackageInfo {
  dimensions: {
    weight_g?: number
    depth_cm?: number
    width_cm?: number
    height_cm?: number
  }
  quantity: number // Nombre de colis identiques
  mention_warning?: string // Ex: "fragile" peut augmenter le prix
}

// --- Constantes de Prix en Franc CFA (XOF), adaptées au marché ivoirien ---
const BASE_FEE = 500 // Frais de base pour une livraison
const PER_KM_FEE = 150 // Frais par kilomètre parcouru
const PER_MINUTE_FEE = 0.6 // Frais par minute de trajet
const WEIGHT_SURCHARGE_THRESHOLD_G = 5000 // 5kg total pour surcharge
const WEIGHT_SURCHARGE_PER_KG_OVER = 100 // 100 CFA par kg au-dessus du seuil
const VOLUME_SURCHARGE_THRESHOLD_M3 = 0.2 // 0.2 m³ total pour surcharge
const VOLUME_SURCHARGE_AMOUNT = 500 // Supplément pour gros volumes
const FRAGILE_SURCHARGE = 300 // Supplément pour colis fragiles
const DRIVER_PERCENTAGE = 0.95 // 95% des coûts variables pour le livreur
const PLATFORM_MARGIN_FACTOR = 1.05 // Marge de 5% pour la plateforme

class PricingHelper {
  /**
   * Calcule les frais du client final (celui qui passe la commande) et la rémunération livreur estimés
   * pour une commande pouvant contenir plusieurs colis.
   * Tous les montants sont en Franc CFA (XOF).
   */
  async calculateFees(
    distanceMeters: number,
    durationSeconds: number,
    packages: SimplePackageInfo[]
  ): Promise<{ clientFee: number; driverRemuneration: number }> {
    try {
      const distanceKm = distanceMeters / 1000
      const durationMinutes = durationSeconds / 60

      // --- Agrégation des données des colis ---
      let totalWeightG = 0
      let totalVolumeM3 = 0
      let hasFragile = false

      for (const pkg of packages) {
        const quantity = pkg.quantity || 1
        const weight = pkg.dimensions?.weight_g || 10 * quantity
        totalWeightG += weight

        // Calcul du volume (si dimensions fournies)
        if (pkg.dimensions?.depth_cm && pkg.dimensions?.width_cm && pkg.dimensions?.height_cm) {
          const volumeCm3 =
            pkg.dimensions.depth_cm * pkg.dimensions.width_cm * pkg.dimensions.height_cm
          totalVolumeM3 += (volumeCm3 / 1_000_000) * quantity // Conversion cm3 en m3
        }

        if (pkg.mention_warning === 'fragile') {
          hasFragile = true
        }
      }
      // Arrondir le volume pour la lisibilité
      totalVolumeM3 = Math.round(totalVolumeM3 * 1000) / 1000

      logger.debug(
        {
          distanceKm,
          durationMinutes,
          packageCount: packages.length,
          totalWeightG,
          totalVolumeM3,
          hasFragile,
        },
        'Calcul des frais basé sur les données des colis'
      )

      // 1. Calculer le coût de base
      let calculatedCost = BASE_FEE + distanceKm * PER_KM_FEE + durationMinutes * PER_MINUTE_FEE

      // 2. Ajouter suppléments basés sur les données agrégées
      if (totalWeightG > WEIGHT_SURCHARGE_THRESHOLD_G) {
        const overweightKg = (totalWeightG - WEIGHT_SURCHARGE_THRESHOLD_G) / 1000
        const weightSurcharge = overweightKg * WEIGHT_SURCHARGE_PER_KG_OVER
        calculatedCost += weightSurcharge
        logger.debug(
          `Surcharge poids pour ${overweightKg.toFixed(2)}kg au-dessus: ${weightSurcharge.toFixed(2)} CFA`
        )
      }
      if (totalVolumeM3 > VOLUME_SURCHARGE_THRESHOLD_M3) {
        calculatedCost += VOLUME_SURCHARGE_AMOUNT
        logger.debug(`Surcharge volume: ${VOLUME_SURCHARGE_AMOUNT} CFA`)
      }
      if (hasFragile) {
        calculatedCost += FRAGILE_SURCHARGE
        logger.debug(`Surcharge fragile: ${FRAGILE_SURCHARGE} CFA`)
      }

      // 3. Calculer la rémunération du livreur
      const variableCostPart = calculatedCost - BASE_FEE
      let driverRemuneration = BASE_FEE * 0.5 + variableCostPart * DRIVER_PERCENTAGE

      // 4. Calculer le prix pour le client final (celui qui passe la commande)
      let clientFee = calculatedCost * PLATFORM_MARGIN_FACTOR

      // 5. Arrondir et vérifier minimums
      clientFee = Math.max(500, Math.round(clientFee)) // Prix client final minimum 500 CFA, arrondi à l'unité
      driverRemuneration = Math.max(300, Math.round(driverRemuneration)) // Rémunération min 300 CFA, arrondi à l'unité

      logger.info(
        `Frais calculés - Client final: ${clientFee} CFA, Livreur: ${driverRemuneration} CFA`
      )

      return { clientFee, driverRemuneration }
    } catch (error) {
      logger.error(
        { err: error, distanceMeters, durationSeconds },
        'Erreur lors du calcul des frais'
      )
      throw new Error('Erreur lors du calcul du prix de la course.')
    }
  }
}

export default new PricingHelper()