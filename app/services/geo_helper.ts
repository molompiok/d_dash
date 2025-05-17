// app/services/geo_helper.ts (ou ValhallaService.ts)
import env from '#start/env'
import logger from '@adonisjs/core/services/logger'
import axios, { AxiosError } from 'axios'
import polyline from '@mapbox/polyline' // Pour décoder les polylines
import { CalculationEngine, waypointStatus, type WaypointSummaryItem } from '#models/order' // Importer CalculationEngine
import type { LegManeuver } from '#models/order_route_leg' // Importer l'interface
import { GeoJsonLineString } from './geo_service.js'

const GEOCODING_TIMEOUT = 30000  // ms
const ROUTING_TIMEOUT = 20000 // ms, augmenté car peut être plus long pour multi-points
const MATRIX_TIMEOUT = 7000   // ms

// Interface pour un waypoint d'entrée pour Valhalla
interface ValhallaLocation {
  lat: number
  lon: number
  type: 'break' | 'through' // 'break' pour un arrêt, 'through' pour un point de passage sans arrêt
  heading?: number
  // ... autres options Valhalla si besoin (side_of_street, etc.)
}

// Structure de la réponse attendue de Valhalla pour les legs (simplifiée)
interface ValhallaLeg {
  summary: {
    time: number // secondes
    length: number // kilomètres
    end_point: {
      lat: number
      lon: number
    }
    start_point: {
      lat: number
      lon: number
    }
    // ... autres champs du résumé du leg
  }
  maneuvers: LegManeuver[] // Utilise ton interface LegManeuver
  shape: string // Polyline encodée (Google Polyline Algorithm)
}

interface ValhallaTrip {
  locations: ValhallaLocation[]
  legs: ValhallaLeg[]
  summary: {
    time: number // secondes
    length: number // kilomètres
    end_point: {
      lat: number
      lon: number
    }
    start_point: {
      lat: number
      lon: number
    }
    // ...
  }
  status: number // Code de statut Valhalla
  status_message: string
  units: string // 'kilometers' ou 'miles'
}

// Structure pour le retour du calcul d'itinéraire optimisé
export interface OptimizedRouteDetails {
  global_summary: {
    total_duration_seconds: number
    total_distance_meters: number
  }
  legs: Array<{
    geometry: { type: 'LineString'; coordinates: number[][] } // GeoJSON LineString [lon, lat][]
    duration_seconds: number
    distance_meters: number
    maneuvers: LegManeuver[]
    raw_valhalla_leg_data?: ValhallaLeg // Optionnel: pour stocker le leg brut
    // Tu pourrais aussi ajouter les coordonnées de début/fin du leg ici si Valhalla ne les donne pas explicitement par leg
  }>
  calculation_engine: CalculationEngine
  waypoints_summary_for_order?: WaypointSummaryItem[] // Pour aider à construire Order.waypoints_summary
}


class GeoHelper {
  private nominatimUrl = env.get('NOMINATIM_URL')
  private valhallaUrl = env.get('VALHALLA_URL')
  // private osrmUrl = env.get('OSRM_URL') // Si tu gardes OSRM en fallback

  constructor() {
    if (!this.valhallaUrl) {
      logger.warn('VALHALLA_URL non configuré dans .env. Les calculs d\'itinéraire Valhalla échoueront.')
    }
    // Idem pour Nominatim et OSRM si utilisés
  }

  // --- Géocodage (inchangé par rapport à ta version, mais le garder ici) ---
  async geocodeAddress(addressString: string): Promise<{
    coordinates: [number, number]; // lon, lat
    city?: string;
    postcode?: string;
    country_code?: string;
    // rawDetails?: any;
  } | null> {
    if (!this.nominatimUrl) {
      logger.error('NOMINATIM_URL non défini dans .env pour geocodeAddress')
      return null
    }
    const url = `${this.nominatimUrl}/search?format=json&q=${encodeURIComponent(addressString)}&limit=1&addressdetails=1`
    try {
      const response = await axios.get(url, { timeout: GEOCODING_TIMEOUT })
      if (response.status === 200 && response.data && response.data.length > 0) {
        const result = response.data[0]
        if (result.lon && result.lat) {
          return {
            coordinates: [parseFloat(result.lon), parseFloat(result.lat)],
            city: result.address?.city || result.address?.town || result.address?.village,
            postcode: result.address?.postcode,
            country_code: result.address?.country_code?.toUpperCase(),
            // rawDetails: result,
          }
        }
      }
      logger.warn({ addressString, responseData: response.data }, 'Geocoding failed or no results')
      return null
    } catch (error) {
      this.logApiError('Nominatim Geocoding', url, error)
      return null
    }
  }

  /**
     * Calcule le temps de trajet et optionnellement la distance
     * d'un point de départ à un point d'arrivée, via Valhalla /route.
     * Utile pour un ETA "direct" sans considérer les arrêts intermédiaires d'une tournée.
     */
  async getDirectRouteInfo(
    startCoordinates: [number, number], // lon, lat
    endCoordinates: [number, number],   // lon, lat
    costingModel: string = 'auto'
  ): Promise<{ durationSeconds: number; distanceMeters: number; geometry?: GeoJsonLineString } | null> {
    if (!this.valhallaUrl) {
      logger.error('Valhalla URL non défini pour getDirectRouteInfo.');
      return null;
    }

    const requestBody = {
      locations: [
        { lon: startCoordinates[0], lat: startCoordinates[1], type: 'break' as const },
        { lon: endCoordinates[0], lat: endCoordinates[1], type: 'break' as const },
      ],
      costing: costingModel,
      language: 'fr-FR', // Ou ta langue par défaut
      directions_options: { units: 'kilometers' },
    };

    const url = `${this.valhallaUrl}/route`;
    // logger.info({ start: startCoordinates, end: endCoordinates }, 'Calcul d\'itinéraire direct Valhalla (getDirectRouteInfo)');

    try {
      const response = await axios.post<{ trip: ValhallaTrip }>(url, requestBody, { timeout: ROUTING_TIMEOUT });

      if (response.status === 200 && response.data?.trip?.summary && response.data.trip.legs?.length > 0) {
        const tripSummary = response.data.trip.summary;
        const firstLeg = response.data.trip.legs[0]; // Pour un A->B, il n'y a qu'un leg

        const decodedShape = polyline.decode(firstLeg.shape, 6) as [number, number][];
        const geoJsonCoords = decodedShape.map(p => [p[1], p[0]]);

        return {
          durationSeconds: Math.round(tripSummary.time),
          distanceMeters: Math.round(tripSummary.length * 1000),
          //@ts-ignore
          geometry: { type: 'LineString' as const, coordinates: geoJsonCoords } // Optionnel, mais peut être utile
        };
      } else {
        logger.warn({ status: response.status, data: response.data }, `Valhalla Direct Route Info API returned unexpected data.`);
        return null;
      }
    } catch (error) {
      this.logApiError('Valhalla Direct Route Info', url, error);
      return null;
    }
  }
  /**
   * Calcule un itinéraire optimisé multi-points via Valhalla.
   * Prend une liste de waypoints (points de passage).
   * Le premier waypoint DOIT être la position actuelle du livreur.
   */
  async calculateOptimizedRoute(
    waypoints: Array<{
      coordinates: [number, number] // lon, lat
      type: 'break' | 'through' // 'break' pour un arrêt réel (pickup/delivery)
      // Optionnel : infos pour construire le waypoints_summary de l'Order
      address_id?: string
      address_text?: string
      waypoint_type_for_summary?: 'pickup' | 'delivery' // Pour distinguer de Valhalla 'type'
      package_name_for_summary?: string
      confirmation_code?: string
    }>
  ): Promise<OptimizedRouteDetails | null> {
    if (!this.valhallaUrl || waypoints.length < 2) {
      logger.error('Valhalla URL non défini ou nombre de waypoints insuffisant (<2).')
      return null
    }

    const valhallaLocations: ValhallaLocation[] = waypoints.map(wp => ({
      lon: wp.coordinates[0],
      lat: wp.coordinates[1],
      type: wp.type,
    }));

    const requestBody = {
      locations: valhallaLocations,
      costing: 'auto', // ou 'truck', 'bicycle', 'pedestrian' selon le véhicule/contexte
      costing_options: { // Exemple pour 'auto'
        auto: {
          top_speed: 30, // km/h
          // Uturn_penalty: 1000, // Default is 20s,
        }
      },
      language: 'fr-FR', // Ou autre langue supportée
      directions_options: { units: 'kilometers' }, // Valhalla retournera length en km
      // Pour un itinéraire optimisé (TSP - Traveling Salesperson Problem)
      // Valhalla ne fait pas de TSP out-of-the-box via /route.
      // L'optimisation de l'ordre des waypoints doit être faite AVANT d'appeler /route,
      // ou en utilisant l'endpoint /optimized_route si votre instance Valhalla le supporte
      // et que vous l'avez configuré pour.
      // Pour /route, l'ordre des `locations` est l'ordre du trajet.
    }

    const url = `${this.valhallaUrl}/route`; // Ou /optimized_route
    logger.info({ requestBody, url }, 'Calcul de l\'itinéraire optimisé Valhalla')

    try {
      const response = await axios.post<{ trip: ValhallaTrip }>(url, requestBody, { timeout: ROUTING_TIMEOUT })

      if (response.status === 200 && response.data && response.data.trip) {
        const trip = response.data.trip
        logger.debug({ trip }, 'Réponse Valhalla Trip')

        if (!trip.legs || trip.legs.length === 0) {
          logger.warn({ trip }, 'Valhalla a retourné un trip sans legs.')
          return null
        }

        const parsedLegs = trip.legs.map((leg: ValhallaLeg, index: number) => {
          const decodedShape = polyline.decode(leg.shape, 6) as [number, number][];
          const geoJsonCoords = decodedShape.map((p: [number, number]) => {
            // Ajouter une vérification si les coordonnées sont dans une plage raisonnable
            if (isNaN(p[0]) || isNaN(p[1]) || p[0] < -90 || p[0] > 90 || p[1] < -180 || p[1] > 180) {
              logger.warn({ lat: p[0], lon: p[1], legIndex: index }, "Coordonnée décodée invalide ou hors limites");
              // Retourner null ou une valeur par défaut, ou lever une erreur ?
              // Pour GeoJSON, il faut des coordonnées valides. On pourrait filtrer ce point.
              return null; // Ou [0, 0] ?
            }
            return [p[1], p[0]]; // lon, lat
          }).filter(coord => coord !== null) as [number, number][];

          const startWaypointOfLeg = waypoints[index]; // Le waypoint d'où part ce leg
          const endWaypointOfLeg = waypoints[index + 1]; // Le waypoint où ce leg arrive

          if (!startWaypointOfLeg || !endWaypointOfLeg) {
            logger.error(`Incohérence dans les waypoints pour le leg ${index}. Impossible de déterminer start/end.`);
            // Tu pourrais lever une erreur ici ou retourner un leg invalide
            // Pour l'instant, on va essayer de prendre de la shape si les waypoints manquent, bien que ce soit un fallback
            return {
              geometry: { type: 'LineString' as const, coordinates: geoJsonCoords },
              duration_seconds: Math.round(leg.summary.time),
              distance_meters: Math.round(leg.summary.length * 1000),
              maneuvers: leg.maneuvers,
              raw_valhalla_leg_data: leg,
              // Coordonnées de la shape comme fallback
              start_leg_coordinates_fallback: geoJsonCoords.length > 0 ? geoJsonCoords[0] : undefined,
              end_leg_coordinates_fallback: geoJsonCoords.length > 0 ? geoJsonCoords[geoJsonCoords.length - 1] : undefined,
            };
          }

          return {
            geometry: { type: 'LineString' as const, coordinates: geoJsonCoords },
            duration_seconds: Math.round(leg.summary.time),
            distance_meters: Math.round(leg.summary.length * 1000),
            maneuvers: leg.maneuvers,
            raw_valhalla_leg_data: leg,
            _internal_start_coords_for_leg: startWaypointOfLeg.coordinates,
            _internal_end_coords_for_leg: endWaypointOfLeg.coordinates,
          };
        });


        const waypointsSummaryForOrder: WaypointSummaryItem[] = [];

        function generateSecureCode(): string {
          const array = new Uint32Array(1);
          crypto.getRandomValues(array); // crypto sécurisé
          const code = array[0] % 1000000; // limite à 6 chiffres
          return code.toString().padStart(6, '0'); // toujours 6 chiffres (ex: 004381)
        }
        for (let i = 0; i < trip.legs.length; i++) {
          const destinationWaypointInfo = waypoints[i + 1];

          if (destinationWaypointInfo && destinationWaypointInfo.waypoint_type_for_summary) {
            waypointsSummaryForOrder.push({
              type: destinationWaypointInfo.waypoint_type_for_summary,
              address_id: destinationWaypointInfo.address_id || `generated_wp_id_${i + 1}`,
              address_text: destinationWaypointInfo.address_text,
              coordinates: destinationWaypointInfo.coordinates,
              sequence: i,
              status: waypointStatus.PENDING,
              confirmation_code: generateSecureCode(),
              is_mandatory: true,
              notes: '',
              start_at: null,
              end_at: null,
              photo_urls: [],
              name: destinationWaypointInfo.package_name_for_summary,
            });
          }
        }

        return {
          global_summary: {
            total_duration_seconds: Math.round(trip.summary.time),
            total_distance_meters: Math.round(trip.summary.length * 1000),
          },
          legs: parsedLegs.map(pLeg => ({ // Enlever les champs internes _internal_...
            geometry: pLeg.geometry,
            duration_seconds: pLeg.duration_seconds,
            distance_meters: pLeg.distance_meters,
            maneuvers: pLeg.maneuvers,
            raw_valhalla_leg_data: pLeg.raw_valhalla_leg_data,
          })),
          calculation_engine: CalculationEngine.VALHALLA,
          waypoints_summary_for_order: waypointsSummaryForOrder,
        };
      } else {
        logger.warn({ status: response.status, data: response.data }, `Valhalla Route API (optimized) returned unexpected data.`)
        return null
      }
    } catch (error) {
      this.logApiError('Valhalla Optimized Route', url, error)
      return null
    }
  }

  /**
   * Calcule un itinéraire simple (A vers B) pour le reroutage d'un leg.
   */
  async rerouteLeg(
    startCoordinates: [number, number], // lon, lat
    endCoordinates: [number, number],   // lon, lat
    costingModel: string = 'auto' // 'auto', 'truck', 'bicycle', etc.
  ): Promise<Omit<OptimizedRouteDetails['legs'][0], 'raw_valhalla_leg_data'> | null> {
    // Cette fonction est une version simplifiée de calculateOptimizedRoute pour un seul leg.
    // logger.info({ startCoordinates, endCoordinates }, 'Calcul de reroutage de leg Valhalla (rerouteLeg)');
    if (!this.valhallaUrl) return null

    const requestBody = {
      locations: [
        { lat: startCoordinates[1], lon: startCoordinates[0], type: 'break' as const },
        { lat: endCoordinates[1], lon: endCoordinates[0], type: 'break' as const },
      ],
      costing: costingModel,
      language: 'fr-FR',
      directions_options: { units: 'kilometers' },
    }

    const url = `${this.valhallaUrl}/route`;
    // logger.info({ requestBody, url }, 'Calcul de reroutage de leg Valhalla')

    try {
      const response = await axios.post<{ trip: ValhallaTrip }>(url, requestBody, { timeout: ROUTING_TIMEOUT })

      if (response.status === 200 && response.data?.trip?.legs?.length > 0) {
        const leg = response.data.trip.legs[0]
        const decodedShape = polyline.decode(leg.shape, 6) as [number, number][]
        const geoJsonCoords = decodedShape.map(p => [p[1], p[0]])
        // logger.info({ geoJsonCoords }, 'geoJsonCoords rerouted')
        return {
          geometry: { type: 'LineString' as const, coordinates: geoJsonCoords },
          duration_seconds: Math.round(leg.summary.time),
          distance_meters: Math.round(leg.summary.length * 1000),
          maneuvers: leg.maneuvers,
        }
      } else {
        logger.warn({ status: response.status, data: response.data }, `Valhalla Reroute Leg API returned unexpected data.`)
        return null
      }
    } catch (error) {
      this.logApiError('Valhalla Reroute Leg', url, error)
      return null
    }
  }


  // Helper pour logger les erreurs Axios de manière standardisée
  private logApiError(apiName: string, url: string, error: any) {
    if (axios.isAxiosError(error)) {
      const axiosError = error as AxiosError
      logger.error(
        {
          message: axiosError.message,
          status: axiosError.response?.status,
          responseData: axiosError.response?.data,
          url,
          api: apiName,
          code: axiosError.code,
          config: axiosError.config,
        },
        `Axios error during ${apiName} request`
      )
    } else {
      logger.error({ err: error, url, api: apiName }, `Non-Axios error during ${apiName} request`)
    }
  }
}

export default new GeoHelper()