// app/services/pricing_helper.ts
import logger from '@adonisjs/core/services/logger'

// --- Interface pour les infos d'UN colis, à passer dans un tableau ---
export interface SimplePackageInfo {
  // Exporte l'interface pour le contrôleur
  dimensions: {
    weight_g: number
    depth_cm?: number
    width_cm?: number
    height_cm?: number
  }
  quantity: number // Ne pas oublier la quantité
  mention_warning?: string // Si ça affecte le prix (ex: fragile = +cher ?)
}

// --- Constantes de Prix (inchangées, mais peuvent être ajustées) ---
const BASE_FEE = 3.0
const PER_KM_FEE = 0.75
const PER_MINUTE_FEE = 0.15
const WEIGHT_SURCHARGE_THRESHOLD_G = 10000 // 10kg TOTAL
const WEIGHT_SURCHARGE_PER_KG_OVER = 0.2 // Ex: 0.20 EUR par KG au-dessus du seuil
const VOLUME_SURCHARGE_THRESHOLD_M3 = 0.5 // 0.5 m3 TOTAL
const VOLUME_SURCHARGE_AMOUNT = 3.0 // Supplément volume
// const FRAGILE_SURCHARGE = 1.50; // Exemple supplément
const DRIVER_PERCENTAGE = 0.75
const PLATFORM_MARGIN_FACTOR = 1.2 // Augmentation de 20% pour le client vs coût?

class PricingHelper {
  /**
   * Calcule les frais client et la rémunération livreur estimés
   * pour une commande pouvant contenir plusieurs colis.
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
      let totalVolumeM3 = 0 // Approximation du volume
      let hasFragile = false

      for (const pkg of packages) {
        const quantity = pkg.quantity || 1
        const weight = pkg.dimensions.weight_g * quantity
        totalWeightG += weight

        // Calcul simple du volume (si dimensions fournies)
        if (pkg.dimensions.depth_cm && pkg.dimensions.width_cm && pkg.dimensions.height_cm) {
          const volumeCm3 =
            pkg.dimensions.depth_cm * pkg.dimensions.width_cm * pkg.dimensions.height_cm
          totalVolumeM3 += (volumeCm3 / 1_000_000) * quantity // Conversion cm3 en m3
        }

        if (pkg.mention_warning === 'fragile') {
          // Adapte selon la valeur de l'enum PackageMentionWarning
          hasFragile = true
        }
        // Autres vérifications (ex: 'keep_cold') si nécessaire
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
        'Calculating fees based on aggregated package data'
      )

      // 1. Calculer le coût de base (inchangé)
      let calculatedCost = BASE_FEE + distanceKm * PER_KM_FEE + durationMinutes * PER_MINUTE_FEE

      // 2. Ajouter suppléments basés sur les données agrégées
      if (totalWeightG > WEIGHT_SURCHARGE_THRESHOLD_G) {
        // Exemple: Surcharge par KG supplémentaire
        const overweightKg = (totalWeightG - WEIGHT_SURCHARGE_THRESHOLD_G) / 1000
        const weightSurcharge = overweightKg * WEIGHT_SURCHARGE_PER_KG_OVER
        calculatedCost += weightSurcharge
        logger.debug(
          `Applying weight surcharge for ${overweightKg.toFixed(2)}kg over: ${weightSurcharge.toFixed(2)}`
        )
      }
      if (totalVolumeM3 > VOLUME_SURCHARGE_THRESHOLD_M3) {
        calculatedCost += VOLUME_SURCHARGE_AMOUNT
        logger.debug(`Applying volume surcharge: ${VOLUME_SURCHARGE_AMOUNT}`)
      }
      // if (hasFragile) {
      //      calculatedCost += FRAGILE_SURCHARGE;
      //      logger.debug(`Applying fragile surcharge: ${FRAGILE_SURCHARGE}`);
      // }

      // 3. Calculer la rémunération Driver (à baser sur le coût *avant* marge plateforme?)
      //    Exemple TRES simpliste: Une partie du coût de base + une majorité de la partie variable/surcharges
      const variableCostPart = calculatedCost - BASE_FEE // Approximation
      let driverRemuneration = BASE_FEE * 0.5 + variableCostPart * DRIVER_PERCENTAGE
      // Ou baser sur la distance/temps + bonus sur les surcharges? La structure exacte est clé.

      // 4. Calculer le prix Client
      //    Exemple: Coût total calculé (incluant surcharges) * facteur de marge
      let clientFee = calculatedCost * PLATFORM_MARGIN_FACTOR

      // 5. Arrondir et Vérifier minimums
      clientFee = Math.max(1.0, Math.round(clientFee * 100) / 100) // Prix client minimum 1 EUR
      driverRemuneration = Math.max(0.5, Math.round(driverRemuneration * 100) / 100) // Remuneration min 0.50 EUR

      // ** Ré-évaluer clientFee si besoin basé sur la rémunération minimale driver **
      // Si la marge est appliquée sur la rémunération, il faut s'assurer que le client paie assez.
      // Exemple: clientFee = Math.max(clientFee, driverRemuneration / (1 - (1/PLATFORM_MARGIN_FACTOR)))

      logger.info(
        `Calculated Fees - Client: ${clientFee.toFixed(2)} EUR, Driver: ${driverRemuneration.toFixed(2)} EUR`
      )

      return { clientFee, driverRemuneration }
    } catch (error) {
      logger.error(
        { err: error, distanceMeters, durationSeconds },
        'Error calculating fees for multiple packages'
      )
      throw new Error('Erreur lors du calcul du prix de la course.')
    }
  }
}

export default new PricingHelper()
