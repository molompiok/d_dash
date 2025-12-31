import { BaseSchema } from '@adonisjs/lucid/schema'
import db from '@adonisjs/lucid/services/db'

export default class extends BaseSchema {
  async up() {
    // Vérifier si la table clients existe encore (elle a peut-être déjà été renommée ou n'existe pas)
    const clientsTableResult = await db.rawQuery(
      "SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'clients')"
    )
    const clientsExists = clientsTableResult.rows[0]?.exists || false

    const companiesTableResult = await db.rawQuery(
      "SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'companies')"
    )
    const companiesExists = companiesTableResult.rows[0]?.exists || false

    // Si clients existe et companies n'existe pas, renommer
    if (clientsExists && !companiesExists) {
      await db.rawQuery('ALTER TABLE clients RENAME TO companies')
    }

    // Vérifier et renommer la colonne is_valid_client en is_valid_company
    const hasIsValidClient = await db.rawQuery(
      "SELECT EXISTS (SELECT FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'companies' AND column_name = 'is_valid_client')"
    )
    if (hasIsValidClient.rows[0]?.exists) {
      await db.rawQuery('ALTER TABLE companies RENAME COLUMN is_valid_client TO is_valid_company')
    }

    // Renommer toutes les colonnes client_id en company_id dans toutes les tables
    // Orders
    const ordersHasClientId = await db.rawQuery(
      "SELECT EXISTS (SELECT FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'orders' AND column_name = 'client_id')"
    )
    const ordersHasCompanyId = await db.rawQuery(
      "SELECT EXISTS (SELECT FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'orders' AND column_name = 'company_id')"
    )
    if (ordersHasClientId.rows[0]?.exists && !ordersHasCompanyId.rows[0]?.exists) {
      await db.rawQuery('ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_client_id_foreign')
      await db.rawQuery('ALTER TABLE orders RENAME COLUMN client_id TO company_id')
      await db.rawQuery(
        'ALTER TABLE orders ADD CONSTRAINT orders_company_id_foreign FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE'
      )
    }

    // Drivers - vérifier si company_id existe déjà (créée par migration précédente)
    const driversHasClientId = await db.rawQuery(
      "SELECT EXISTS (SELECT FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'drivers' AND column_name = 'client_id')"
    )
    const driversHasCompanyId = await db.rawQuery(
      "SELECT EXISTS (SELECT FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'drivers' AND column_name = 'company_id')"
    )
    if (driversHasClientId.rows[0]?.exists && !driversHasCompanyId.rows[0]?.exists) {
      await db.rawQuery('ALTER TABLE drivers DROP CONSTRAINT IF EXISTS drivers_client_id_foreign')
      await db.rawQuery('ALTER TABLE drivers RENAME COLUMN client_id TO company_id')
      await db.rawQuery(
        'ALTER TABLE drivers ADD CONSTRAINT drivers_company_id_foreign FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE SET NULL'
      )
    } else if (driversHasClientId.rows[0]?.exists && driversHasCompanyId.rows[0]?.exists) {
      // Si les deux existent, supprimer client_id et mettre à jour la contrainte
      await db.rawQuery('ALTER TABLE drivers DROP CONSTRAINT IF EXISTS drivers_client_id_foreign')
      await db.rawQuery('ALTER TABLE drivers DROP COLUMN IF EXISTS client_id')
      await db.rawQuery('ALTER TABLE drivers DROP CONSTRAINT IF EXISTS drivers_company_id_foreign')
      await db.rawQuery(
        'ALTER TABLE drivers ADD CONSTRAINT drivers_company_id_foreign FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE SET NULL'
      )
    }

    // Order transactions
    const orderTransactionsHasClientId = await db.rawQuery(
      "SELECT EXISTS (SELECT FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'order_transactions' AND column_name = 'client_id')"
    )
    const orderTransactionsHasCompanyId = await db.rawQuery(
      "SELECT EXISTS (SELECT FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'order_transactions' AND column_name = 'company_id')"
    )
    if (orderTransactionsHasClientId.rows[0]?.exists && !orderTransactionsHasCompanyId.rows[0]?.exists) {
      await db.rawQuery('ALTER TABLE order_transactions DROP CONSTRAINT IF EXISTS order_transactions_client_id_foreign')
      await db.rawQuery('ALTER TABLE order_transactions RENAME COLUMN client_id TO company_id')
      await db.rawQuery(
        'ALTER TABLE order_transactions ADD CONSTRAINT order_transactions_company_id_foreign FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE SET NULL'
      )
    }

    // Support tickets
    const supportTicketsHasClientId = await db.rawQuery(
      "SELECT EXISTS (SELECT FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'support_tickets' AND column_name = 'client_id')"
    )
    const supportTicketsHasCompanyId = await db.rawQuery(
      "SELECT EXISTS (SELECT FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'support_tickets' AND column_name = 'company_id')"
    )
    if (supportTicketsHasClientId.rows[0]?.exists && !supportTicketsHasCompanyId.rows[0]?.exists) {
      await db.rawQuery('ALTER TABLE support_tickets DROP CONSTRAINT IF EXISTS support_tickets_client_id_foreign')
      await db.rawQuery('ALTER TABLE support_tickets RENAME COLUMN client_id TO company_id')
      await db.rawQuery(
        'ALTER TABLE support_tickets ADD CONSTRAINT support_tickets_company_id_foreign FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE SET NULL'
      )
    }

    // Subscription payments
    const subscriptionPaymentsHasClientId = await db.rawQuery(
      "SELECT EXISTS (SELECT FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'subscription_payments' AND column_name = 'client_id')"
    )
    const subscriptionPaymentsHasCompanyId = await db.rawQuery(
      "SELECT EXISTS (SELECT FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'subscription_payments' AND column_name = 'company_id')"
    )
    if (subscriptionPaymentsHasClientId.rows[0]?.exists && !subscriptionPaymentsHasCompanyId.rows[0]?.exists) {
      await db.rawQuery('ALTER TABLE subscription_payments DROP CONSTRAINT IF EXISTS subscription_payments_client_id_foreign')
      await db.rawQuery('ALTER TABLE subscription_payments RENAME COLUMN client_id TO company_id')
      await db.rawQuery(
        'ALTER TABLE subscription_payments ADD CONSTRAINT subscription_payments_company_id_foreign FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE SET NULL'
      )
    }
  }

  async down() {
    // Inverser toutes les opérations
    // Subscription payments
    await db.rawQuery('ALTER TABLE subscription_payments DROP CONSTRAINT IF EXISTS subscription_payments_company_id_foreign')
    await db.rawQuery('ALTER TABLE subscription_payments RENAME COLUMN company_id TO client_id')
    await db.rawQuery(
      'ALTER TABLE subscription_payments ADD CONSTRAINT subscription_payments_client_id_foreign FOREIGN KEY (client_id) REFERENCES companies(id) ON DELETE SET NULL'
    )

    // Support tickets
    await db.rawQuery('ALTER TABLE support_tickets DROP CONSTRAINT IF EXISTS support_tickets_company_id_foreign')
    await db.rawQuery('ALTER TABLE support_tickets RENAME COLUMN company_id TO client_id')
    await db.rawQuery(
      'ALTER TABLE support_tickets ADD CONSTRAINT support_tickets_client_id_foreign FOREIGN KEY (client_id) REFERENCES companies(id) ON DELETE SET NULL'
    )

    // Order transactions
    await db.rawQuery('ALTER TABLE order_transactions DROP CONSTRAINT IF EXISTS order_transactions_company_id_foreign')
    await db.rawQuery('ALTER TABLE order_transactions RENAME COLUMN company_id TO client_id')
    await db.rawQuery(
      'ALTER TABLE order_transactions ADD CONSTRAINT order_transactions_client_id_foreign FOREIGN KEY (client_id) REFERENCES companies(id) ON DELETE SET NULL'
    )

    // Drivers
    await db.rawQuery('ALTER TABLE drivers DROP CONSTRAINT IF EXISTS drivers_company_id_foreign')
    await db.rawQuery('ALTER TABLE drivers RENAME COLUMN company_id TO client_id')
    await db.rawQuery(
      'ALTER TABLE drivers ADD CONSTRAINT drivers_client_id_foreign FOREIGN KEY (client_id) REFERENCES companies(id) ON DELETE SET NULL'
    )

    // Orders
    await db.rawQuery('ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_company_id_foreign')
    await db.rawQuery('ALTER TABLE orders RENAME COLUMN company_id TO client_id')
    await db.rawQuery(
      'ALTER TABLE orders ADD CONSTRAINT orders_client_id_foreign FOREIGN KEY (client_id) REFERENCES companies(id) ON DELETE CASCADE'
    )

    // Companies table
    await db.rawQuery('ALTER TABLE companies RENAME COLUMN is_valid_company TO is_valid_client')
    await db.rawQuery('ALTER TABLE companies RENAME TO clients')
  }
}
