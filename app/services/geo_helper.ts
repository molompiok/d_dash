// app/services/geo_helper.ts
import env from '#start/env'
import logger from '@adonisjs/core/services/logger'
import { Point } from 'geojson'
// Optionnel mais recommandé pour les requêtes HTTP
// npm install axios
import axios, { AxiosError } from 'axios'
// Nécessite un package pour décoder les polylines de Valhalla/OSRM
// npm install @mapbox/polyline
import polyline from '@mapbox/polyline'
import { CalculationEngine } from '#models/order'

// --- Interfaces pour les retours (simplifiées) ---
interface GeocodeResult {
  coordinates: Point['coordinates'] // [longitude, latitude]
  city?: string
  postcode?: string
  country_code?: string
  // rawDetails?: any; // Pourrait contenir la réponse brute de Nominatim
}

interface MatrixResult {
  durationSeconds: number | null
  distanceMeters: number | null
  engine: CalculationEngine
}

const GEOCODING_TIMEOUT = 5000
const ROUTING_TIMEOUT = 10000
const MATRIX_TIMEOUT = 7000

interface RouteDetails {
  distanceMeters: number
  durationSeconds: number
  geometry: { type: 'LineString'; coordinates: number[][] } // GeoJSON LineString
  engine: CalculationEngine
  // rawDetails?: any; // Réponse brute du moteur de routage
}

class GeoHelper {
  private nominatimUrl = env.get('NOMINATIM_URL') // Ex: 'http://localhost:8080'
  private valhallaUrl = env.get('VALHALLA_URL') // Ex: 'http://localhost:8002'
  private osrmUrl = env.get('OSRM_URL') // Ex: 'http://localhost:5000'

  /**
   * Géocode une adresse textuelle en coordonnées via Nominatim.
   */
  async geocodeAddress(addressString: string): Promise<GeocodeResult | null> {
    if (!this.nominatimUrl) {
      logger.error('NOMINATIM_URL non défini dans .env')
      return null
    }

    const url = `${this.nominatimUrl}/search?format=json&q=${encodeURIComponent(addressString)}&limit=1&addressdetails=1`
    logger.debug(`Geocoding request to: ${url}`)

    try {
      const response = await axios.get(url, { timeout: GEOCODING_TIMEOUT }) // Timeout 5s

      if (response.status === 200 && response.data && response.data.length > 0) {
        const result = response.data[0]
        logger.debug({ nominatimResult: result }, 'Geocoding success')

        // --- ATTENTION: La structure de réponse de Nominatim peut varier ---
        // Vérifie la structure de TA réponse Nominatim
        if (result.lon && result.lat) {
          return {
            // Format GeoJSON : [longitude, latitude]
            coordinates: [
              Number(Number.parseFloat(result.lon)),
              Number(Number.parseFloat(result.lat)),
            ],
            city: result.address?.city || result.address?.town || result.address?.village,
            postcode: result.address?.postcode,
            country_code: result.address?.country_code,
            // rawDetails: result
          }
        } else {
          logger.warn({ addressString, result }, 'Nominatim result found but no coordinates')
          return null
        }
      } else {
        logger.warn(
          { status: response.status, data: response.data },
          `Geocoding failed for address: ${addressString}`
        )
        return null
      }
    } catch (error) {
      logger.error({ err: error, addressString }, 'Error during geocoding request')
      return null
    }
  }

  /**
   * Calcule l'itinéraire complet (public).
   * Tente Valhalla puis OSRM comme fallback.
   */
  async calculateRouteDetails(
    startCoords: Point['coordinates'],
    endCoords: Point['coordinates']
  ): Promise<RouteDetails | null> {
    // Priorité 1: Valhalla
    if (this.valhallaUrl) {
      const valhallaResult = await this.callValhallaRouteAPI(startCoords, endCoords)
      if (valhallaResult) return valhallaResult // Succès Valhalla
      logger.warn(
        `Valhalla route failed for [${startCoords}]->[${endCoords}], attempting OSRM fallback.`
      )
    }
    // Priorité 2: OSRM (Fallback)
    if (this.osrmUrl) {
      const osrmResult = await this.callOsrmRouteAPI(startCoords, endCoords)
      if (osrmResult) return osrmResult // Succès OSRM
      logger.warn(`OSRM route fallback also failed for [${startCoords}]->[${endCoords}].`)
    }
    // Échec des deux
    logger.error(`Failed to calculate route details using both Valhalla and OSRM.`)
    return null
  }

  /**
   * Calcule la durée et/ou distance (public).
   * Tente Valhalla Matrix puis OSRM Table comme fallback.
   */
  async calculateTravelTime(
    startCoords: Point['coordinates'],
    endCoords: Point['coordinates'],
    calculateDistance: boolean = false
  ): Promise<MatrixResult | null> {
    // Priorité 1: Valhalla Matrix
    if (this.valhallaUrl) {
      const valhallaResult = await this.callValhallaMatrixAPI(
        startCoords,
        endCoords,
        calculateDistance
      )
      if (valhallaResult) return valhallaResult // Succès Valhalla
      logger.warn(
        `Valhalla matrix failed for [${startCoords}]->[${endCoords}], attempting OSRM fallback.`
      )
    }
    // Priorité 2: OSRM Table (Fallback)
    if (this.osrmUrl) {
      const osrmResult = await this.callOsrmTableAPI(startCoords, endCoords, calculateDistance)
      if (osrmResult) return osrmResult // Succès OSRM
      logger.warn(`OSRM table fallback also failed for [${startCoords}]->[${endCoords}].`)
    }
    // Échec des deux
    logger.error(`Failed to calculate travel time/distance using both Valhalla and OSRM.`)
    return null
  }

  // ================================================
  // Méthodes INTERNES pour les Appels API Moteurs
  // ================================================

  /**
   * [INTERNE] Appelle l'API Valhalla '/route' et parse la réponse.
   */
  private async callValhallaRouteAPI(
    startCoords: Point['coordinates'],
    endCoords: Point['coordinates']
  ): Promise<RouteDetails | null> {
    if (!this.valhallaUrl) return null // Sécurité
    const url = `${this.valhallaUrl}/route`
    const requestBody = {
      locations: [
        { lon: startCoords[0], lat: startCoords[1], type: 'break' },
        { lon: endCoords[0], lat: endCoords[1], type: 'break' },
      ],
      costing: 'auto',
      language: 'fr-FR',
      directions_options: { units: 'meters' },
    }
    logger.debug({ requestBody }, `Internal call: Valhalla Route API -> ${url}`)
    try {
      const response = await axios.post(url, requestBody, { timeout: ROUTING_TIMEOUT })
      if (
        response.status === 200 &&
        response.data?.trip?.summary &&
        response.data.trip.legs?.[0]?.shape
      ) {
        const trip = response.data.trip
        const distanceMeters = Math.round(trip.summary.length * 1000)
        const durationSeconds = Math.round(trip.summary.time)
        const geometryCoords = polyline
          .decode(trip.legs[0].shape)
          .map((p: number[]) => [p[1], p[0]])

        return {
          distanceMeters,
          durationSeconds,
          geometry: { type: 'LineString', coordinates: geometryCoords },
          engine: CalculationEngine.VALHALLA,
        }
      } else {
        logger.warn(
          { status: response.status, data: response.data },
          `Valhalla Route API returned unexpected data.`
        )
        return null
      }
    } catch (error) {
      this.logApiError('Valhalla Route', url, error)
      return null
    }
  }

  /**
   * [INTERNE] Appelle l'API Valhalla '/sources_to_targets' et parse la réponse.
   */
  private async callValhallaMatrixAPI(
    startCoords: Point['coordinates'],
    endCoords: Point['coordinates'],
    calculateDistance: boolean
  ): Promise<MatrixResult | null> {
    if (!this.valhallaUrl) return null
    const url = `${this.valhallaUrl}/sources_to_targets`
    const requestBody = {
      sources: [{ lon: startCoords[0], lat: startCoords[1] }],
      targets: [{ lon: endCoords[0], lat: endCoords[1] }],
      costing: 'auto',
    }
    logger.debug({ requestBody }, `Internal call: Valhalla Matrix API -> ${url}`)
    try {
      const response = await axios.post(url, requestBody, { timeout: MATRIX_TIMEOUT })
      if (response.status === 200 && response.data?.sources_to_targets?.[0]?.[0]) {
        const result = response.data.sources_to_targets[0][0]
        const durationSeconds = result.time !== null ? Math.round(result.time) : null
        const distanceMeters =
          calculateDistance && result.distance !== null ? Math.round(result.distance * 1000) : null

        if (durationSeconds !== null || (calculateDistance && distanceMeters !== null)) {
          return { durationSeconds, distanceMeters, engine: CalculationEngine.VALHALLA }
        } else {
          logger.warn({ result }, `Valhalla Matrix result has null time/distance.`)
          return null // Non routable selon Valhalla
        }
      } else {
        logger.warn(
          { status: response.status, data: response.data },
          `Valhalla Matrix API returned unexpected data.`
        )
        return null
      }
    } catch (error) {
      this.logApiError('Valhalla Matrix', url, error)
      return null
    }
  }

  /**
   * [INTERNE] Appelle l'API OSRM '/route/v1' et parse la réponse.
   */
  private async callOsrmRouteAPI(
    startCoords: Point['coordinates'],
    endCoords: Point['coordinates']
  ): Promise<RouteDetails | null> {
    if (!this.osrmUrl) return null
    const profile = 'driving'
    const coordinatesString = `${startCoords[0]},${startCoords[1]};${endCoords[0]},${endCoords[1]}`
    // overview=full pour géométrie complète, steps=false pour moins de data
    const url = `${this.osrmUrl}/route/v1/${profile}/${coordinatesString}?overview=full&geometries=polyline&steps=false`
    logger.debug(`Internal call: OSRM Route API -> ${url}`)
    try {
      const response = await axios.get(url, { timeout: ROUTING_TIMEOUT })
      if (
        response.status === 200 &&
        response.data?.code === 'Ok' &&
        response.data.routes?.length > 0
      ) {
        const route = response.data.routes[0]
        const distanceMeters = Math.round(route.distance)
        const durationSeconds = Math.round(route.duration)
        // OSRM polyline est [lat,lon], besoin de convertir
        const geometryCoords = polyline.decode(route.geometry).map((p: number[]) => [p[1], p[0]])

        return {
          distanceMeters,
          durationSeconds,
          geometry: { type: 'LineString', coordinates: geometryCoords },
          engine: CalculationEngine.OSRM,
        }
      } else {
        logger.warn(
          { status: response.status, data: response.data },
          `OSRM Route API returned unexpected data.`
        )
        return null
      }
    } catch (error) {
      this.logApiError('OSRM Route', url, error)
      return null
    }
  }

  /**
   * [INTERNE] Appelle l'API OSRM '/table/v1' et parse la réponse.
   */
  private async callOsrmTableAPI(
    startCoords: Point['coordinates'],
    endCoords: Point['coordinates'],
    calculateDistance: boolean
  ): Promise<MatrixResult | null> {
    if (!this.osrmUrl) return null
    const profile = 'driving'
    const coordinatesString = `${startCoords[0]},${startCoords[1]};${endCoords[0]},${endCoords[1]}`
    const annotations = calculateDistance ? 'duration,distance' : 'duration'
    const url = `${this.osrmUrl}/table/v1/${profile}/${coordinatesString}?sources=0&destinations=1&annotations=${annotations}`
    logger.debug(`Internal call: OSRM Table API -> ${url}`)
    try {
      const response = await axios.get(url, { timeout: MATRIX_TIMEOUT })
      if (response.status === 200 && response.data?.code === 'Ok') {
        const durationSeconds =
          response.data.durations?.[0]?.[1] !== null &&
          response.data.durations?.[0]?.[1] !== undefined
            ? Math.round(response.data.durations[0][1])
            : null
        const distanceMeters =
          calculateDistance &&
          response.data.distances?.[0]?.[1] !== null &&
          response.data.distances?.[0]?.[1] !== undefined
            ? Math.round(response.data.distances[0][1])
            : null

        if (durationSeconds !== null || (calculateDistance && distanceMeters !== null)) {
          return { durationSeconds, distanceMeters, engine: CalculationEngine.OSRM }
        } else {
          logger.warn({ result: response.data }, `OSRM Table result has null time/distance.`)
          return null // Non routable selon OSRM
        }
      } else {
        logger.warn(
          { status: response.status, data: response.data },
          `OSRM Table API returned unexpected data.`
        )
        return null
      }
    } catch (error) {
      this.logApiError('OSRM Table', url, error)
      return null
    }
  }

  /**
   * [INTERNE] Helper pour logger les erreurs Axios de manière standardisée.
   */
  private logApiError(apiName: string, url: string, error: any) {
    if (axios.isAxiosError(error)) {
      const axiosError = error as AxiosError
      logger.error(
        {
          status: axiosError.response?.status,
          responseData: axiosError.response?.data,
          url,
          api: apiName,
        },
        `Error during ${apiName} request`
      )
    } else {
      logger.error({ err: error, url, api: apiName }, `Non-Axios error during ${apiName} request`)
    }
  }
}

// Exporte une instance ou la classe directement
export default new GeoHelper()
// ou: export default GeoHelper
