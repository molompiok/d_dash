import logger from '@adonisjs/core/services/logger' // Supposons que c'est votre logger
import db from '@adonisjs/lucid/services/db' // Supposons que c'est votre instance DB
import * as wkx from 'wkx'
import { Buffer } from 'node:buffer' // Important pour WKB

// Vos types existants sont bons
export type LatLng = { lat: number; lng: number }

export type GeoJsonPoint = {
  type: 'Point'
  coordinates: [number, number] // [lng, lat]
}

export type GeoJsonLineString = {
  type: 'LineString'
  coordinates: [number, number][] // array de [lng, lat]
}

export type GeoJsonPolygon = {
  type: 'Polygon'
  coordinates: [number, number][][] // array de rings, chaque ring est un array de [lng, lat]
}

export type AnyGeoJsonGeometry = GeoJsonPoint | GeoJsonLineString | GeoJsonPolygon;

export default class GeoService {
  // --- WKT Parsing/Formatting using wkx (plus robuste) ---


  static ewkbHexToGeoJsonPoint(ewkbHexString: string | null): GeoJsonPoint | null {
    if (!ewkbHexString) {
      return null;
    }
    try {
      const buffer = Buffer.from(ewkbHexString, 'hex');
      const geometry = wkx.Geometry.parse(buffer); // Parser le Buffer
      if (geometry instanceof wkx.Point) {
        // geometry.toGeoJSON() pour Point retourne { type: 'Point', coordinates: [x, y] }
        return geometry.toGeoJSON() as GeoJsonPoint;
      }
      logger.warn({ wkb: ewkbHexString }, 'EWKB string is not a Point');
      return null;
    } catch (error) {
      logger.error({ err: error, wkb: ewkbHexString }, 'Failed to parse EWKB hex to GeoJSON Point');
      return null;
    }
  }

  /**
   * PREPARE: Convertit un objet GeoJSON Point (de l'application) en chaîne WKT.
   * Cette fonction est destinée à être utilisée avec db.raw(`ST_GeomFromText(?, 4326)`)
   */
  static geoJsonPointToWkt(pointObject: GeoJsonPoint | null): string | null {
    if (!pointObject || pointObject.type !== 'Point' || !pointObject.coordinates || pointObject.coordinates.length !== 2) {
      logger.warn({ point: pointObject }, 'Invalid GeoJSON Point object for WKT conversion');
      return null;
    }
    const [lng, lat] = pointObject.coordinates;
    return `POINT(${lng} ${lat})`;
  }

  static pointToWkt(point: LatLng): string {
    const wkxPoint = new wkx.Point(point.lng, point.lat)
    return wkxPoint.toWkt()
  }

  static wktToPoint(wktString: string): LatLng | null {
    try {
      const geometry = wkx.Geometry.parse(wktString)
      if (geometry instanceof wkx.Point) {
        return { lng: geometry.x, lat: geometry.y }
      }
      logger.warn({ wkt: wktString }, 'WKT string is not a Point')
      return null
    } catch (error) {
      logger.error({ err: error, wkt: wktString }, 'Failed to parse WKT to Point')
      return null
    }
  }

  static pointsToWktLineString(points: LatLng[]): string {
    if (!points.length) throw new Error('Aucune coordonnée pour LineString')
    if (!points.every((p) => GeoService.isValidLatLng(p.lat, p.lng))) {
      throw new Error('Coordonnées invalides pour LineString')
    }
    const wkxPoints = points.map((p) => new wkx.Point(p.lng, p.lat))
    const lineString = new wkx.LineString(wkxPoints)
    return lineString.toWkt()
  }

  static wktToGeoJsonLineString(wktString: string): GeoJsonLineString | null {
    try {
      const geometry = wkx.Geometry.parse(wktString)
      if (geometry instanceof wkx.LineString) {
        return geometry.toGeoJSON() as GeoJsonLineString
      }
      logger.warn({ wkt: wktString }, 'WKT string is not a LineString')
      return null
    } catch (error) {
      logger.error({ err: error, wkt: wktString }, 'Failed to parse WKT to LineString')
      return null
    }
  }

  static ewkbHexToGeoJsonLineString(ewkbHexString: string | null): GeoJsonLineString | null {
    // Vérifiez si la chaîne est null ou vide dès le début
    if (!ewkbHexString) {
      // logger.warn({}, 'Received null or empty EWKB hex string'); // Loggez si vous voulez
      return null;
    }

    try {
      // Convertir la chaîne hexadécimale en Buffer
      const buffer = Buffer.from(ewkbHexString, 'hex');
      const geometry = wkx.Geometry.parse(buffer); // Parser le Buffer

      if (geometry instanceof wkx.LineString) {
        return geometry.toGeoJSON() as GeoJsonLineString;
      }
      logger.warn({ wkb: ewkbHexString }, 'Parsed geometry from EWKB is not a LineString');
      return null;
    } catch (error) {
      logger.error({ err: error, wkb: ewkbHexString }, 'Failed to parse EWKB hex to LineString');
      return null;
    }
  }

  static pointsToLineString(geoJsonLineString: { coordinates: number[][] }): string {
    const pointsString = geoJsonLineString.coordinates
      .map(coord => `${coord[0]} ${coord[1]}`)
      .join(',');
    return `LINESTRING(${pointsString})`;
  }

  // static geoJsonPolygonToWkt(polygon: GeoJsonPolygon): string {
  //   // wkx.Polygon attend des anneaux de wkx.Point
  //   const rings = polygon.coordinates.map((ringCoords) =>
  //     ringCoords.map(([lng, lat]) => new wkx.Point(lng, lat))
  //   )
  //   const wkxPolygon = new wkx.Polygon(rings)
  //   return wkxPolygon.toWkt()
  // }

  static wktToGeoJsonPolygon(wktString: string): GeoJsonPolygon | null {
    try {
      const geometry = wkx.Geometry.parse(wktString)
      if (geometry instanceof wkx.Polygon) {
        return geometry.toGeoJSON() as GeoJsonPolygon
      }
      logger.warn({ wkt: wktString }, 'WKT string is not a Polygon')
      return null
    } catch (error) {
      logger.error({ err: error, wkt: wktString }, 'Failed to parse WKT to Polygon')
      return null
    }
  }

  // --- WKB Hex Parsing/Formatting using wkx ---

  static hexWkbToGeoJSON(hexWkb: string): AnyGeoJsonGeometry | null {
    if (!hexWkb) return null;
    try {
      const buffer = Buffer.from(hexWkb, 'hex')
      const geometry = wkx.Geometry.parse(buffer)
      return geometry.toGeoJSON() as AnyGeoJsonGeometry // Assurez-vous que vos types GeoJson correspondent
    } catch (error) {
      logger.error({ err: error, hexWkb }, 'Failed to parse Hex WKB to GeoJSON')
      return null
    }
  }

  /**
   * Spécifiquement pour parser un WKB hex d'un Point en LatLng
   * C'est ce dont vous avez besoin pour votre problème initial.
   */
  static hexWkbToLatLng(hexWkb: string): LatLng | null {
    const geoJson = GeoService.hexWkbToGeoJSON(hexWkb);
    if (geoJson?.type === 'Point') {
      return { lng: geoJson.coordinates[0], lat: geoJson.coordinates[1] };
    }
    if (geoJson) { // Si c'est un autre type de géométrie
      logger.warn({ hexWkb, type: geoJson.type }, 'Hex WKB was parsed but is not a Point type for LatLng conversion');
    }
    return null;
  }


  static geoJsonToHexWkb(geometry: AnyGeoJsonGeometry): string | null {
    try {
      let wkxGeometry: wkx.Geometry
      switch (geometry.type) {
        case 'Point':
          wkxGeometry = new wkx.Point(geometry.coordinates[0], geometry.coordinates[1])
          break
        case 'LineString':
          wkxGeometry = new wkx.LineString(
            geometry.coordinates.map(([lng, lat]) => new wkx.Point(lng, lat))
          )
          break
        // case 'Polygon':
        //   wkxGeometry = new wkx.Polygon(
        //     geometry.coordinates.map((ring) =>
        //       ring.map(([lng, lat]) => new wkx.Point(lng, lat))
        //     )
        //   )
        // break
        default:
          logger.error({ geometry }, 'Unsupported GeoJSON type for WKB conversion')
          return null
      }
      return wkxGeometry.toWkb().toString('hex')
    } catch (error) {
      logger.error({ err: error, geometry }, 'Failed to convert GeoJSON to Hex WKB')
      return null
    }
  }

  static latLngToHexWkb(point: LatLng): string | null {
    try {
      const wkxPoint = new wkx.Point(point.lng, point.lat);
      return wkxPoint.toWkb().toString('hex');
    } catch (error) {
      logger.error({ err: error, point }, 'Failed to convert LatLng to Hex WKB');
      return null;
    }
  }


  // --- GeoJSON Utilities ---

  static toGeoJSONFeature(geom: AnyGeoJsonGeometry, properties: Record<string, any> = {}) {
    return {
      type: 'Feature',
      geometry: geom,
      properties: properties,
    }
  }

  // --- SQL Utilities (votre existant, potentiellement à adapter si les entrées changent) ---

  /**
   * Prend un objet GeoJSON Point et retourne un raw SQL pour ST_MakePoint
   */
  static geoJsonPointToSQL(value: GeoJsonPoint, srid: number = 4326) {
    const [lng, lat] = value.coordinates
    return db.raw(`ST_SetSRID(ST_MakePoint(?, ?), ?)`, [lng, lat, srid])
  }

  /**
   * Prend un LatLng et retourne un raw SQL pour ST_MakePoint
   */
  static latLngToSQL(value: LatLng, srid: number = 4326) {
    return db.raw(`ST_SetSRID(ST_MakePoint(?, ?), ?)`, [value.lng, value.lat, srid])
  }

  /**
   * Renommé pour clarifier que ça prend du WKT et retourne du GeoJSON Point
   */
  static wktToGeoJsonPoint(wkbHex: string): GeoJsonPoint | null {
    try {
      // Validate hex string
      if (!/^[0-9A-Fa-f]+$/.test(wkbHex)) {
        logger.warn({ wkb: wkbHex }, 'Invalid WKB hex string');
        return null;
      }

      // Convert WKB hex string to Buffer
      const buffer = Buffer.from(wkbHex, 'hex');
      const geometry = wkx.Geometry.parse(buffer);

      if (geometry instanceof wkx.Point) {
        return geometry.toGeoJSON() as GeoJsonPoint;
      }

      logger.warn({ wkb: wkbHex }, 'WKB string is not a Point');
      return null;
    } catch (error) {
      logger.error({ err: error, wkb: wkbHex }, 'Failed to parse WKB to GeoJSON Point');
      return null;
    }
  }


  static hexWkbToGeoJsonPoint(hexWkb: string | null): GeoJsonPoint | null {
    if (!hexWkb) return null;
    try {
      const buffer = Buffer.from(hexWkb, 'hex');
      const geometry = wkx.Geometry.parse(buffer);
      if (geometry instanceof wkx.Point) {
        return geometry.toGeoJSON() as GeoJsonPoint;
      }
      logger.warn({ hexWkb, type: 'Point' }, 'Hex WKB was parsed but is not a Point geometry type');
      return null;
    } catch (error) {
      logger.error({ err: error, hexWkb }, 'Failed to parse Hex WKB to GeoJsonPoint');
      return null;
    }
  }

  // --- Validation ---
  static isValidLatLng(lat: number, lng: number): boolean {
    return (
      typeof lat === 'number' &&
      typeof lng === 'number' &&
      lat >= -90 &&
      lat <= 90 &&
      lng >= -180 &&
      lng <= 180
    )
  }
}

// Exemple d'utilisation pour votre problème initial :
// const wkbHexString = "0101000020E61000007F6DFDF49FF50FC0B4AD669DF16D1540";
// const latLngCoords = GeoService.hexWkbToLatLng(wkbHexString);
// if (latLngCoords) {
//   console.log(latLngCoords); // Devrait donner { lng: -4.075756, lat: 5.335194 } (ou proche selon la précision)
// }

// const pointGeoJson = GeoService.hexWkbToGeoJSON(wkbHexString);
// if (pointGeoJson && pointGeoJson.type === 'Point') {
//     console.log(pointGeoJson.coordinates); // Devrait donner [-4.075756, 5.335194]
// }