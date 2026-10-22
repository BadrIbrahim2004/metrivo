import type { PrismaService } from '../src/prisma.service'

export interface RawQueryCall {
  text: string
  values: unknown[]
}

interface TestPrisma {
  user: {
    findUnique(args: unknown): Promise<unknown>
  }
  $queryRaw(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<unknown[]>
  $executeRaw(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<number>
  $transaction<T>(
    callback: (tx: TestPrisma) => Promise<T>,
    options?: { isolationLevel?: string },
  ): Promise<T>
}

interface TestPrismaOptions {
  queryResults?: unknown[][]
  queryResponder?: (call: RawQueryCall) => unknown[] | undefined
  executeResponder?: (call: RawQueryCall) => number | undefined
  serializeTransactions?: boolean
  userResults?: unknown[]
  failAuditWrites?: boolean
  failRateLimitWrites?: boolean
}

export function createPrismaMock(options: TestPrismaOptions = {}) {
  const optionsConfig = options
  const queryResults = [...(options.queryResults ?? [])]
  const userResults = [...(options.userResults ?? [])]
  const queryCalls: RawQueryCall[] = []
  const executeCalls: RawQueryCall[] = []
  const userFindUniqueCalls: unknown[] = []
  const transactionOptions: Array<{ isolationLevel?: string } | undefined> = []
  let transactionCount = 0
  let transactionTail = Promise.resolve()

  const mock: TestPrisma = {
    user: {
      async findUnique(args) {
        userFindUniqueCalls.push(args)
        return userResults.shift() ?? null
      },
    },
    async $queryRaw(strings, ...values) {
      queryCalls.push({ text: strings.join('?'), values })
      const call = queryCalls[queryCalls.length - 1]
      if (
        options.failRateLimitWrites &&
        call.text.includes('"InvitationAcceptanceRateLimit"')
      ) {
        throw new Error('rate limit storage unavailable')
      }
      const response = options.queryResponder?.(call)
      if (response !== undefined) {
        return response
      }
      return queryResults.shift() ?? []
    },
    async $executeRaw(strings, ...values) {
      const call = { text: strings.join('?'), values }
      executeCalls.push(call)
      if (
        options.failAuditWrites &&
        (call.text.includes('"SupportAccessAuditLog"') ||
          call.text.includes('"PlatformAuditLog"'))
      ) {
        throw new Error('audit storage unavailable')
      }
      if (
        options.failRateLimitWrites &&
        call.text.includes('"InvitationAcceptanceRateLimit"')
      ) {
        throw new Error('rate limit storage unavailable')
      }
      const response = options.executeResponder?.(call)
      if (response !== undefined) {
        return response
      }
      return 1
    },
    async $transaction(callback, options) {
      transactionCount += 1
      transactionOptions.push(options)
      if (!optionsConfig.serializeTransactions) {
        return callback(mock)
      }
      const previous = transactionTail
      let release!: () => void
      transactionTail = new Promise<void>((resolve) => {
        release = resolve
      })
      await previous
      try {
        return await callback(mock)
      } finally {
        release()
      }
    },
  }

  return {
    prisma: mock as unknown as PrismaService,
    queryCalls,
    executeCalls,
    userFindUniqueCalls,
    transactionOptions,
    get transactionCount() {
      return transactionCount
    },
  }
}
