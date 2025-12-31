// // Exemple de logique à intégrer dans OrderController.create_order ou un service dédié
// // (Ceci est un extrait conceptuel, à adapter dans ta structure existante)

// import GeoHelper, { type OptimizedRouteDetails } from '#services/geo_helper' // Assure-toi du chemin
// import Order from '#models/order'
// import OrderRouteLeg from '#models/order_route_leg'
// import Address from '#models/address' // Pour récupérer les coordonnées des adresses
// import db from '@adonisjs/lucid/services/db'
// import { DateTime } from 'luxon'

// // ... (dans une méthode de contrôleur ou de service)

// // Supposons que tu as :
// // - driverCurrentLocation: [lon, lat] | null (si le driver est déjà assigné et a une position)
// // - pickupAddresses: Address[] (objets Address pour les collectes)
// // - deliveryAddresses: Address[] (objets Address pour les livraisons)
// // - L'ordre optimisé des waypoints a déjà été déterminé (P1, P2, D1 etc.)

// // 1. Construire la liste des waypoints pour GeoHelper
// // Le premier waypoint est la position actuelle du livreur (si disponible et assigné) ou le premier pickup
// // Adapter cette logique selon si la commande est créée avant ou après assignation du livreur.
// // Pour l'instant, imaginons que le livreur est déjà connu et a une position.
// const waypointsForValhalla = [];

// // Point de départ du livreur (si applicable pour le calcul initial)
// // Si la commande est créée par une entreprise, et qu'aucun livreur n'est encore assigné,
// // le premier "leg" sera calculé plus tard (Driver -> P1) ou le premier leg est P1 -> P2.
// // Ici, on suppose un scénario où on calcule tout dès qu'on a un point de départ.
// // Pour une création par entreprise pure, le premier waypoint serait la première adresse de collecte.

// let initialDeparturePoint: { coordinates: [number, number]; type: 'break' | 'through'; address_id?: string; address_text?: string; waypoint_type_for_summary?: undefined; } | null = null;

// if (driverCurrentLocation) { // Si on connaît la position du livreur
//   initialDeparturePoint = {
//     coordinates: driverCurrentLocation,
//     type: 'break', // Le départ est un "break"
//     // pas de waypoint_type_for_summary car c'est le livreur
//   };
// } else if (pickupAddresses.length > 0 && pickupAddresses[0].coordinates) { // Sinon, le 1er pickup est le point de départ pour Valhalla
//   initialDeparturePoint = {
//     coordinates: [pickupAddresses[0].coordinates.coordinates[0], pickupAddresses[0].coordinates.coordinates[1]],
//     type: 'break',
//     address_id: pickupAddresses[0].id,
//     address_text: pickupAddresses[0].street_address,
//     waypoint_type_for_summary: 'pickup', // Ce sera le premier waypoint de la tournée
//   };
// }

// if (!initialDeparturePoint) {
//   // Gérer l'erreur : impossible de déterminer un point de départ
//   logger.error('Impossible de déterminer un point de départ pour le calcul de l\'itinéraire.');
//   // return response.badRequest(...)
// }

// // Ajouter le point de départ
// waypointsForValhalla.push(initialDeparturePoint!);


// // Ajouter les waypoints de la commande (P1, P2, D1, etc.) dans l'ordre de la tournée
// // Tu dois avoir une logique pour déterminer cet ordre.
// // Exemple: D'abord tous les pickups, puis toutes les livraisons, ou un ordre optimisé.
// // Pour cet exemple, supposons que tu as un tableau `orderedWaypointsData`
// // qui contient les infos des adresses dans le bon ordre de tournée.

// /* Exemple de structure pour orderedWaypointsData:
// const orderedWaypointsData = [
//   { address: pickupAddress1, typeForValhalla: 'break', typeForSummary: 'pickup', packageName: 'Colis A' },
//   { address: pickupAddress2, typeForValhalla: 'break', typeForSummary: 'pickup', packageName: 'Colis B' },
//   { address: deliveryAddress1, typeForValhalla: 'break', typeForSummary: 'delivery' },
// ];
// */

// // Simuler orderedWaypointsData pour cet exemple, en excluant le premier pickup s'il a servi de initialDeparturePoint
// const waypointsToProcess = (driverCurrentLocation && pickupAddresses.length > 0) ? pickupAddresses : pickupAddresses.slice(1);
// // Ajouter les autres pickups et livraisons
// waypointsToProcess.forEach(addr => {
//   if (addr.coordinates) { // Vérifier que les coordonnées existent
//     waypointsForValhalla.push({
//       coordinates: [addr.coordinates.coordinates[0], addr.coordinates.coordinates[1]],
//       type: 'break', // Chaque pickup/delivery est un arrêt
//       address_id: addr.id,
//       address_text: addr.street_address,
//       waypoint_type_for_summary: 'pickup', // ou 'delivery'
//       // package_name_for_summary: // ... extraire le nom du colis associé
//     });
//   }
// });
// deliveryAddresses.forEach(addr => {
//   if (addr.coordinates) {
//     waypointsForValhalla.push({
//       coordinates: [addr.coordinates.coordinates[0], addr.coordinates.coordinates[1]],
//       type: 'break',
//       address_id: addr.id,
//       address_text: addr.street_address,
//       waypoint_type_for_summary: 'delivery',
//     });
//   }
// });


// // 2. Appeler GeoHelper pour calculer l'itinéraire et les legs
// const routeDetails: OptimizedRouteDetails | null = await GeoHelper.calculateOptimizedRoute(waypointsForValhalla);

// if (!routeDetails) {
//   // Gérer l'échec du calcul de l'itinéraire
//   logger.error('Échec du calcul de l\'itinéraire optimisé via GeoHelper.');
//   // await trx.rollback();
//   // return response.internalServerError({ message: "Impossible de calculer l'itinéraire." });
//   // Ou mettre la commande en état d'attente de calcul manuel, etc.
//   // Pour l'instant, on va considérer ça comme une erreur bloquante pour la création
//   throw new Error("Impossible de calculer l'itinéraire pour la commande.");
// }

// // Démarrer une transaction DB (si ce n'est pas déjà fait plus haut dans ta méthode)
// const trx = await db.transaction();
// try {
//   // 3. Créer/Mettre à jour l'Order
//   // newOrder est ton instance d'Order en cours de création/modification
//   newOrder.calculation_engine = routeDetails.calculation_engine;
//   newOrder.delivery_date_estimation = DateTime.now().plus({ seconds: routeDetails.global_summary.total_duration_seconds });
//   // Stocker le résumé des waypoints construit par GeoHelper
//   newOrder.waypoints_summary = routeDetails.waypoints_summary_for_order || null;
//   // ... autres champs de l'order
//   await newOrder.useTransaction(trx).save();


//   // 4. Créer les OrderRouteLegs
//   for (let i = 0; i < routeDetails.legs.length; i++) {
//     const legData = routeDetails.legs[i];
//     const leg = new OrderRouteLeg();
//     leg.fill({
//       order_id: newOrder.id,
//       leg_sequence: i,
//       geometry: legData.geometry,
//       duration_seconds: legData.duration_seconds,
//       distance_meters: legData.distance_meters,
//       maneuvers: legData.maneuvers,
//       raw_valhalla_leg_data: legData.raw_valhalla_leg_data,
//       // Déterminer start_address_id et end_address_id basé sur waypointsForValhalla
//       // Le leg `i` va de `waypointsForValhalla[i]` à `waypointsForValhalla[i+1]`
//       start_address_id: waypointsForValhalla[i]?.address_id || null,
//       end_address_id: waypointsForValhalla[i + 1]?.address_id || null,
//       start_coordinates: { type: 'Point', coordinates: waypointsForValhalla[i].coordinates },
//       end_coordinates: { type: 'Point', coordinates: waypointsForValhalla[i + 1].coordinates },
//     });
//     await leg.useTransaction(trx).save();
//   }

//   await trx.commit();
//   // Succès, newOrder et ses route_legs sont sauvegardés.

// } catch (error) {
//   await trx.rollback();
//   logger.error({ err: error, orderId: newOrder.id }, 'Erreur lors de la sauvegarde de l\'order et de ses route_legs.');
//   throw error; // Relancer l'erreur pour qu'elle soit gérée plus haut
// }