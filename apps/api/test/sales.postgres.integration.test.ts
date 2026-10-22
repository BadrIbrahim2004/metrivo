import 'reflect-metadata'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, describe, it } from 'node:test'
import {
  type CallHandler,
  type ExecutionContext,
  Module,
  type NestInterceptor,
  ValidationPipe,
} from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { PrismaClient } from '@prisma/client'
import type { AddressInfo } from 'node:net'
import { SalesController } from '../src/sales.controller'
import { SalesService } from '../src/sales.service'
import { PrismaService } from '../src/prisma.service'

const TEST_DATABASE = 'metrivo_pos_test'
const TEST_USERNAME = 'metrivo_pos_test_app'
const TEST_MARKER = process.env.METRIVO_TEST_IDENTITY_MARKER
const SALE_PATH = (tenantId: string, branchId: string) =>
  `/api/tenants/${encodeURIComponent(tenantId)}` +
  `/branches/${encodeURIComponent(branchId)}/sales`

let prisma: PrismaClient
let app: Awaited<ReturnType<typeof NestFactory.create>>
let baseUrl: string
let currentActorId = ''

class TestPrincipalInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler) {
    const request = context.switchToHttp().getRequest<{
      user?: { userId: string }
    }>()
    request.user = { userId: currentActorId }
    return next.handle()
  }
}

interface Fixture {
  userId: string
  tenantId: string
  branchId: string
  productId: string
  price: string
}

async function createFixture(stock: number, price = '10.50'): Promise<Fixture> {
  const suffix = randomUUID()
  const userId = `pos-user-${suffix}`
  const tenantId = `pos-tenant-${suffix}`
  const branchId = `pos-branch-${suffix}`
  const roleId = `pos-role-${suffix}`
  const membershipId = `pos-membership-${suffix}`
  const productId = `pos-product-${suffix}`
  const user = await prisma.user.create({
    data: {
      id: userId,
      email: `${suffix}@pos-test.invalid`,
      emailNormalized: `${suffix}@pos-test.invalid`,
      name: 'POS Integration User',
      status: 'ACTIVE',
    },
  })
  await prisma.tenant.create({
    data: { id: tenantId, name: `POS Test ${suffix}` },
  })
  await prisma.branch.create({
    data: { id: branchId, tenantId, name: `Branch ${suffix}` },
  })
  await prisma.tenantPermission.upsert({
    where: { key: 'sales.create' },
    create: {
      id: `permission-sales-create-${suffix}`,
      key: 'sales.create',
      description: 'Create sales in authorized branches',
    },
    update: {},
  })
  await prisma.tenantPermission.upsert({
    where: { key: 'sales.read' },
    create: {
      id: `permission-sales-read-${suffix}`,
      key: 'sales.read',
      description: 'Read sales in authorized branches',
    },
    update: {},
  })
  await prisma.role.create({
    data: { id: roleId, tenantId, name: 'POS Test Role' },
  })
  const createPermission = await prisma.tenantPermission.findUniqueOrThrow({
    where: { key: 'sales.create' },
  })
  const readPermission = await prisma.tenantPermission.findUniqueOrThrow({
    where: { key: 'sales.read' },
  })
  await prisma.tenantRolePermission.createMany({
    data: [
      { id: `role-create-${suffix}`, roleId, permissionId: createPermission.id },
      { id: `role-read-${suffix}`, roleId, permissionId: readPermission.id },
    ],
  })
  await prisma.tenantMembership.create({
    data: {
      id: membershipId,
      userId,
      tenantId,
      status: 'ACTIVE',
      branchAccessMode: 'SELECTED_BRANCHES',
    },
  })
  await prisma.membershipRole.create({
    data: {
      id: `member-role-${suffix}`,
      membershipId,
      tenantId,
      roleId,
    },
  })
  await prisma.branchMembership.create({
    data: {
      id: `branch-member-${suffix}`,
      membershipId,
      tenantId,
      branchId,
    },
  })
  await prisma.product.create({
    data: {
      id: productId,
      tenantId,
      sku: `POS-${suffix}`,
      name: 'Snapshot Coffee',
      price,
      createdByUserId: user.id,
    },
  })
  if (stock > 0) {
    await prisma.inventoryMovement.create({
      data: {
        id: `opening-${suffix}`,
        tenantId,
        branchId,
        productId,
        actorUserId: user.id,
        quantityDelta: stock,
        reason: 'POS integration opening stock',
      },
    })
  }
  currentActorId = userId
  return { userId, tenantId, branchId, productId, price }
}

function saleBody(
  productId: string,
  quantity: number,
  extra: Record<string, unknown> = {},
) {
  return {
    lines: [{ productId, quantity }],
    discount: '0.00',
    paymentMethod: 'CASH',
    ...extra,
  }
}

async function postSale(
  fixture: Fixture,
  idempotencyKey: string,
  body: unknown,
  target = fixture,
) {
  return fetch(`${baseUrl}${SALE_PATH(target.tenantId, target.branchId)}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify(body),
  })
}

describe('Sales POS on isolated PostgreSQL', () => {
  before(async () => {
    const databaseUrl = process.env.METRIVO_TEST_DATABASE_URL
    assert.ok(TEST_MARKER, 'METRIVO_TEST_IDENTITY_MARKER is required')
    assert.ok(databaseUrl, 'METRIVO_TEST_DATABASE_URL is required')
    const parsed = new URL(databaseUrl)
    assert.equal(parsed.protocol, 'postgresql:')
    assert.equal(parsed.hostname, '127.0.0.1')
    assert.equal(parsed.port, '55432')
    assert.equal(parsed.username, TEST_USERNAME)
    assert.equal(parsed.pathname, `/${TEST_DATABASE}`)
    assert.equal(process.env.DATABASE_URL, databaseUrl)

    prisma = new PrismaClient({
      datasources: { db: { url: databaseUrl } },
    })
    const identity = await prisma.$queryRaw<Array<{
      databaseName: string
      databaseUser: string
      serverPort: number
      marker: string
    }>>`
      SELECT current_database() AS "databaseName",
             current_user AS "databaseUser",
             inet_server_port() AS "serverPort",
             (SELECT identity_value
              FROM public.metrivo_pos_test_identity
              WHERE identity_key = 'environment') AS marker
    `
    assert.equal(identity[0]?.databaseName, TEST_DATABASE)
    assert.equal(identity[0]?.databaseUser, TEST_USERNAME)
    assert.equal(Number(identity[0]?.serverPort), 5432)
    assert.equal(identity[0]?.marker, TEST_MARKER)

    class ConnectedSalesTestModule {}
    Module({
      controllers: [SalesController],
      providers: [
        SalesService,
        { provide: PrismaService, useValue: prisma },
      ],
    })(ConnectedSalesTestModule)
    app = await NestFactory.create(ConnectedSalesTestModule, { logger: false })
    app.setGlobalPrefix('api')
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    )
    app.useGlobalInterceptors(new TestPrincipalInterceptor())
    await app.listen(0, '127.0.0.1')
    const address = app.getHttpServer().address() as AddressInfo
    baseUrl = `http://127.0.0.1:${address.port}`
  })

  after(async () => {
    if (app) await app.close()
    if (prisma) await prisma.$disconnect()
  })

  it('commits invoice, price snapshots, and stock movements as one sale', async () => {
    const fixture = await createFixture(5)
    const response = await postSale(
      fixture,
      `integration-${randomUUID()}`,
      saleBody(fixture.productId, 2),
    )
    assert.equal(response.status, 201)
    const sale = await response.json() as {
      id: string
      invoiceNumber: string
      subtotal: string
      total: string
      items: Array<{ productName: string; productSku: string; unitPrice: string }>
    }
    assert.match(sale.invoiceNumber, /^POS-/)
    assert.equal(sale.subtotal, '21.00')
    assert.equal(sale.total, '21.00')
    assert.equal(sale.items[0]?.productName, 'Snapshot Coffee')
    assert.equal(sale.items[0]?.productSku.startsWith('POS-'), true)
    assert.equal(sale.items[0]?.unitPrice, '10.50')

    const movement = await prisma.inventoryMovement.findFirstOrThrow({
      where: { saleId: sale.id, tenantId: fixture.tenantId },
    })
    assert.equal(movement.quantityDelta, -2)
    const stock = await prisma.inventoryMovement.aggregate({
      where: {
        tenantId: fixture.tenantId,
        branchId: fixture.branchId,
        productId: fixture.productId,
      },
      _sum: { quantityDelta: true },
    })
    assert.equal(stock._sum.quantityDelta, 3)
    assert.equal(
      await prisma.saleItem.count({ where: { saleId: sale.id } }),
      1,
    )

    await prisma.product.update({
      where: { id: fixture.productId },
      data: { name: 'Renamed Coffee', price: '99.99' },
    })
    const detailResponse = await fetch(
      `${baseUrl}${SALE_PATH(fixture.tenantId, fixture.branchId)}/${sale.id}`,
    )
    assert.equal(detailResponse.status, 200)
    const detail = await detailResponse.json() as typeof sale
    assert.equal(detail.items[0]?.productName, 'Snapshot Coffee')
    assert.equal(detail.items[0]?.unitPrice, '10.50')
  })

  it('rejects client-supplied product prices and totals at the HTTP boundary', async () => {
    const fixture = await createFixture(5)
    const response = await postSale(
      fixture,
      `integration-${randomUUID()}`,
      saleBody(fixture.productId, 1, {
        unitPrice: '0.01',
        subtotal: '0.01',
        total: '0.01',
      }),
    )
    assert.equal(response.status, 400)
    assert.equal(await prisma.sale.count({ where: { tenantId: fixture.tenantId } }), 0)
  })

  it('rolls back invoice and items when the stock ledger insert fails', async () => {
    const fixture = await createFixture(4)
    await prisma.$executeRaw`
      UPDATE public.pos_test_controls
      SET fail_sale_inventory_insert = TRUE
      WHERE singleton = TRUE
    `
    try {
      const response = await postSale(
        fixture,
        `integration-${randomUUID()}`,
        saleBody(fixture.productId, 1),
      )
      assert.equal(response.status, 500)
    } finally {
      await prisma.$executeRaw`
        UPDATE public.pos_test_controls
        SET fail_sale_inventory_insert = FALSE
        WHERE singleton = TRUE
      `
    }
    assert.equal(await prisma.sale.count({ where: { tenantId: fixture.tenantId } }), 0)
    assert.equal(
      await prisma.saleItem.count({ where: { tenantId: fixture.tenantId } }),
      0,
    )
    assert.equal(
      await prisma.inventoryMovement.count({
        where: { tenantId: fixture.tenantId, saleId: { not: null } },
      }),
      0,
    )
  })

  it('rejects a sale quantity greater than available branch stock', async () => {
    const fixture = await createFixture(1)
    const response = await postSale(
      fixture,
      `integration-${randomUUID()}`,
      saleBody(fixture.productId, 2),
    )
    assert.equal(response.status, 400)
    assert.equal(await prisma.sale.count({ where: { tenantId: fixture.tenantId } }), 0)
  })

  it('serializes concurrent sales and never oversells the final unit', async () => {
    const fixture = await createFixture(1)
    const responses = await Promise.all([
      postSale(
        fixture,
        `integration-${randomUUID()}`,
        saleBody(fixture.productId, 1),
      ),
      postSale(
        fixture,
        `integration-${randomUUID()}`,
        saleBody(fixture.productId, 1),
      ),
    ])
    assert.deepEqual(
      responses.map((response) => response.status).sort(),
      [201, 400],
    )
    const total = await prisma.inventoryMovement.aggregate({
      where: {
        tenantId: fixture.tenantId,
        branchId: fixture.branchId,
        productId: fixture.productId,
      },
      _sum: { quantityDelta: true },
    })
    assert.equal(total._sum.quantityDelta, 0)
    assert.equal(await prisma.sale.count({ where: { tenantId: fixture.tenantId } }), 1)
  })

  it('returns the same sale for a retried idempotency key and conflicts on a changed request', async () => {
    const fixture = await createFixture(5)
    const key = `integration-${randomUUID()}`
    const body = saleBody(fixture.productId, 1)
    const first = await postSale(fixture, key, body)
    const repeated = await postSale(fixture, key, body)
    assert.equal(first.status, 201)
    assert.equal(repeated.status, 201)
    const firstSale = await first.json() as { id: string }
    const retrySale = await repeated.json() as { id: string }
    assert.equal(retrySale.id, firstSale.id)
    assert.equal(await prisma.sale.count({ where: { tenantId: fixture.tenantId } }), 1)
    assert.equal(
      await prisma.inventoryMovement.count({
        where: { tenantId: fixture.tenantId, saleId: { not: null } },
      }),
      1,
    )

    const changed = await postSale(
      fixture,
      key,
      saleBody(fixture.productId, 1, { discount: '1.00' }),
    )
    assert.equal(changed.status, 409)
    assert.equal(await prisma.sale.count({ where: { tenantId: fixture.tenantId } }), 1)
  })

  it('denies a branch and tenant outside the caller membership scope', async () => {
    const own = await createFixture(2)
    const siblingBranch = await prisma.branch.create({
      data: {
        id: `unassigned-branch-${randomUUID()}`,
        tenantId: own.tenantId,
        name: `Unassigned ${randomUUID()}`,
      },
    })
    const foreign = await createFixture(2)
    currentActorId = own.userId
    const branchResponse = await postSale(
      own,
      `integration-${randomUUID()}`,
      saleBody(own.productId, 1),
      { ...own, branchId: siblingBranch.id },
    )
    const tenantResponse = await postSale(
      own,
      `integration-${randomUUID()}`,
      saleBody(foreign.productId, 1),
      foreign,
    )
    assert.equal(branchResponse.status, 403)
    assert.equal(tenantResponse.status, 403)
    assert.equal(await prisma.sale.count({ where: { tenantId: own.tenantId } }), 0)
    assert.equal(await prisma.sale.count({ where: { tenantId: foreign.tenantId } }), 0)
  })

  it('enforces unique invoice numbers in PostgreSQL', async () => {
    const fixture = await createFixture(0)
    const invoiceNumber = `POS-CONSTRAINT-${randomUUID()}`
    const common = {
      tenantId: fixture.tenantId,
      branchId: fixture.branchId,
      actorUserId: fixture.userId,
      invoiceNumber,
      requestHash: 'a'.repeat(64),
      status: 'COMPLETED' as const,
      paymentMethod: 'CASH' as const,
      subtotal: '1.00',
      discount: '0.00',
      total: '1.00',
    }
    await prisma.sale.create({
      data: {
        id: `constraint-sale-${randomUUID()}`,
        ...common,
        idempotencyKey: `constraint-${randomUUID()}`,
      },
    })
    await assert.rejects(
      prisma.sale.create({
        data: {
          id: `constraint-sale-${randomUUID()}`,
          ...common,
          idempotencyKey: `constraint-${randomUUID()}`,
        },
      }),
      (error: unknown) =>
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'P2002',
    )
  })
})
