import logger from '@adonisjs/core/services/logger';
import db from '@adonisjs/lucid/services/db'

export type LatLng = { lat: number; lng: number }

export type LineString = {
  type: 'LineString'
  coordinates: [number, number][]
}

export type Point = {
  type: 'Point'
  coordinates: [number, number]
}

export type Polygon = {
  type: 'Polygon'
  coordinates: [number, number][][] // Liste de listes de points
}

export default class GeoService {
  // ✅ Point ↔ WKT

  static pointToWkt(point: LatLng): string {
    return `POINT(${point.lng} ${point.lat})`
  }

  static wktToPoint(wkt: string): LatLng | null {
    const match = wkt.match(/^POINT\(([-\d.]+) ([-\d.]+)\)$/i)
    if (!match) return null
    return { lng: Number.parseFloat(match[1]), lat: Number.parseFloat(match[2]) }
  }

  // ✅ LineString ↔ WKT

  static pointsToLineString(points: LatLng[]): string {
    logger.error(`Converting ${JSON.stringify(points)} points to LineString`)
    if (!points.length) throw new Error('Aucune coordonnée')
    if (!points.every((p) => GeoService.isValidLatLng(p.lat, p.lng))) {
      throw new Error('Coordonnées invalides')
    }
    const coords = points.map((p) => `${p.lng} ${p.lat}`).join(', ')
    return `LINESTRING(${coords})`
  }

  static wktToLineString(wkt: string): LineString | null {
    const match = wkt.match(/^LINESTRING\((.+)\)$/i)
    if (!match) return null

    const coordinates = match[1].split(',').map((pair) => {
      const [lng, lat] = pair.trim().split(' ').map(Number)
      return [lng, lat] as [number, number]
    })

    return { type: 'LineString', coordinates }
  }

  // ✅ Polygon ↔ WKT

  static polygonToWkt(polygon: Polygon): string {
    const rings = polygon.coordinates.map(
      (ring) => '(' + ring.map(([lng, lat]) => `${lng} ${lat}`).join(', ') + ')'
    )
    return `POLYGON(${rings.join(', ')})`
  }

  static wktToPolygon(wkt: string): Polygon | null {
    const match = wkt.match(/^POLYGON\((.+)\)$/i)
    if (!match) return null

    const rings = match[1].split('),(').map((ring) =>
      ring
        .replace(/^\(|\)$/g, '')
        .split(',')
        .map((coord) => {
          const [lng, lat] = coord.trim().split(' ').map(Number)
          return [lng, lat] as [number, number]
        })
    )

    return {
      type: 'Polygon',
      coordinates: rings,
    }
  }

  // ✅ GeoJSON (optionnel)

  static toGeoJSON(geom: Point | LineString | Polygon) {
    return {
      type: 'Feature',
      geometry: geom,
      properties: {},
    }
  }

  static pointToSQL(value: { type: 'Point'; coordinates: [number, number] }) {
    const [lng, lat] = value.coordinates
    return db.raw(`ST_SetSRID(ST_MakePoint(?, ?), 4326)`, [lng, lat])
  }

  static wktToPointAsGeoJSON(wkt: string): { type: 'Point'; coordinates: [number, number] } | null {
    const match = wkt?.match(/^POINT\(([-\d.]+) ([-\d.]+)\)$/i)
    if (!match) return null

    return {
      type: 'Point',
      coordinates: [Number.parseFloat(match[1]), Number.parseFloat(match[2])],
    }
  }

  // ✅ Validation

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
