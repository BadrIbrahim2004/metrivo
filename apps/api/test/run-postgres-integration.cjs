const { spawnSync } = require('node:child_process')
const { randomBytes } = require('node:crypto')
const path = require('node:path')
const { PrismaClient } = require('@prisma/client')
const npmCli = process.env.npm_execpath

const repositoryRoot = path.resolve(__dirname, '..', '..', '..')
const composeFile = path.join(repositoryRoot, 'compose.pos-test.yml')
const projectName = `metrivo-pos-${randomBytes(16).toString('hex')}`
const databaseUrl =
  'postgresql://metrivo_pos_test_app@127.0.0.1:55432/metrivo_pos_test?schema=public'
const expectedMarker = randomBytes(32).toString('hex')
const migrations = [
  '20261018230000_platform_owner_admin_foundation',
  '20261019000000_tenant_invitations',
  '20261019004400_invitation_role_policy',
  '20261019122000_products_inventory_branch_scope',
  '20261019124700_sales_pos',
]
let projectWasAbsentBeforeStartup = false
let startupAttempted = false

function docker(args, options = {}) {
  const result = spawnSync(
    'docker',
    ['compose', '-f', composeFile, '-p', projectName, ...args],
    {
      cwd: repositoryRoot,
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      ...options,
    },
  )
  if (result.error) {
    throw new Error('Docker Compose is required for PostgreSQL integration tests')
  }
  if (result.status !== 0) {
    throw new Error(
      `Docker Compose failed (${args[0]}): ${(result.stderr || result.stdout).trim()}`,
    )
  }
  return result.stdout.trim()
}

function dockerCli(args) {
  const result = spawnSync('docker', args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  })
  if (result.error || result.status !== 0) {
    throw new Error('Unable to verify isolated PostgreSQL container identity')
  }
  return result.stdout.trim()
}

function dockerCliIds(args, resourceDescription) {
  try {
    return dockerCli(args).split(/\r?\n/).filter(Boolean)
  } catch {
    throw new Error(`Unable to verify isolated Compose ${resourceDescription}`)
  }
}

function psql(databaseName, databaseUser, args) {
  return docker([
    'exec',
    '-T',
    'postgres',
    'psql',
    '-h',
    '127.0.0.1',
    '-v',
    'ON_ERROR_STOP=1',
    '-U',
    databaseUser,
    '-d',
    databaseName,
    ...args,
  ])
}

function getProjectNetworkIds() {
  const projectLabel = `label=com.docker.compose.project=${projectName}`
  const labeledNetworks = dockerCliIds(
    ['network', 'ls', '-q', '--filter', projectLabel],
    'network state',
  )
  const expectedNameNetworks = dockerCliIds(
    ['network', 'ls', '-q', '--filter', `name=${projectName}_default`],
    'network state',
  )
  return [...new Set([...labeledNetworks, ...expectedNameNetworks])]
}

function verifyProjectNetwork(container) {
  const networkIds = getProjectNetworkIds()
  if (networkIds.length !== 1) {
    throw new Error('Refusing SQL: expected exactly one project network')
  }

  const inspected = dockerCli(['network', 'inspect', networkIds[0]])
  const [network] = JSON.parse(inspected)
  const labels = network?.Labels ?? {}
  const attachments = Object.keys(network?.Containers ?? {})
  const attachedExpectedContainer = attachments.some(
    (containerId) =>
      containerId === container.Id ||
      container.Id?.startsWith(containerId) ||
      containerId.startsWith(container.Id ?? ''),
  )

  if (
    network?.Name !== `${projectName}_default` ||
    labels['com.docker.compose.project'] !== projectName ||
    labels['com.docker.compose.network'] !== 'default' ||
    attachments.length !== 1 ||
    !attachedExpectedContainer
  ) {
    throw new Error('Refusing SQL: Compose network ownership or service attachment is unverified')
  }
}

function verifyComposeContainer() {
  const containerIds = docker(['ps', '--quiet', 'postgres'])
    .split(/\r?\n/)
    .filter(Boolean)
  if (containerIds.length !== 1) {
    throw new Error('Refusing SQL: isolated Compose project must have exactly one test container')
  }

  const inspected = dockerCli(['inspect', containerIds[0]])
  const containers = JSON.parse(inspected)
  const container = containers[0]
  const labels = container?.Config?.Labels ?? {}
  const portBindings = container?.NetworkSettings?.Ports?.['5432/tcp'] ?? []
  const tmpfs = container?.HostConfig?.Tmpfs ?? {}
  const expectedProject = projectName

  if (
    container?.State?.Running !== true ||
    container?.Config?.Image !== 'postgres:18' ||
    labels['com.docker.compose.project'] !== expectedProject ||
    labels['com.docker.compose.service'] !== 'postgres' ||
    labels['com.docker.compose.project.config_files'] !== composeFile ||
    labels['com.docker.compose.project.working_dir'] !== repositoryRoot ||
    portBindings.length !== 1 ||
    portBindings[0]?.HostIp !== '127.0.0.1' ||
    portBindings[0]?.HostPort !== '55432' ||
    !Object.prototype.hasOwnProperty.call(tmpfs, '/var/lib/postgresql') ||
    (container?.Mounts ?? []).some((mount) => mount.Type === 'volume')
  ) {
    throw new Error('Refusing SQL: Compose container is not the expected isolated loopback test instance')
  }
  verifyProjectNetwork(container)
}

function ensureProjectResourcesAbsent() {
  const projectLabel = `label=com.docker.compose.project=${projectName}`
  const containers = dockerCliIds(
    ['ps', '-aq', '--filter', projectLabel],
    'container state',
  )
  const networks = getProjectNetworkIds()
  const volumes = dockerCliIds(
    ['volume', 'ls', '-q', '--filter', projectLabel],
    'volume state',
  )
  if (containers.length || networks.length || volumes.length) {
    throw new Error('Refusing startup: random Compose project name already has Docker resources')
  }
  projectWasAbsentBeforeStartup = true
}

function verifyProjectResourcesForCleanup() {
  if (!projectWasAbsentBeforeStartup || !startupAttempted) {
    throw new Error('Cleanup skipped: this invocation did not establish ownership of the Compose project')
  }

  const projectLabel = `label=com.docker.compose.project=${projectName}`
  const containers = dockerCliIds(
    ['ps', '-aq', '--filter', projectLabel],
    'container cleanup state',
  )
  const networks = getProjectNetworkIds()
  const volumes = dockerCliIds(
    ['volume', 'ls', '-q', '--filter', projectLabel],
    'volume cleanup state',
  )

  for (const containerId of containers) {
    const inspected = dockerCli(['inspect', containerId])
    const [container] = JSON.parse(inspected)
    const labels = container?.Config?.Labels ?? {}
    if (
      labels['com.docker.compose.project'] !== projectName ||
      labels['com.docker.compose.service'] !== 'postgres' ||
      labels['com.docker.compose.project.config_files'] !== composeFile ||
      labels['com.docker.compose.project.working_dir'] !== repositoryRoot ||
      container?.Config?.Image !== 'postgres:18' ||
      (container?.Mounts ?? []).some((mount) => mount.Type === 'volume')
    ) {
      throw new Error('Cleanup skipped: container ownership could not be conclusively verified')
    }
  }

  const verifiedContainers = containers.map((containerId) => {
    const inspected = dockerCli(['inspect', containerId])
    return JSON.parse(inspected)[0]
  })

  for (const networkId of networks) {
    const inspected = dockerCli(['network', 'inspect', networkId])
    const [network] = JSON.parse(inspected)
    const labels = network?.Labels ?? {}
    const attachedContainerIds = Object.keys(network?.Containers ?? {})
    const attachedContainerIsVerified = attachedContainerIds.some((attachedId) =>
      verifiedContainers.some((container) =>
        attachedId === container?.Id ||
        container?.Id?.startsWith(attachedId) ||
        attachedId.startsWith(container?.Id ?? ''),
      ),
    )
    if (
      network?.Name !== `${projectName}_default` ||
      labels['com.docker.compose.project'] !== projectName ||
      labels['com.docker.compose.network'] !== 'default' ||
      attachedContainerIds.length !== 1 ||
      !attachedContainerIsVerified
    ) {
      throw new Error('Cleanup skipped: network ownership could not be conclusively verified')
    }
  }

  if (!containers.length && !networks.length) {
    throw new Error('Cleanup skipped: no invocation-owned Compose resources were found')
  }

  if (volumes.length) {
    throw new Error('Cleanup limitation: project volumes were found and will not be deleted')
  }
}

function verifyBootstrapIdentity() {
  const identity = psql('postgres', 'postgres', [
    '-At',
    '-c',
    "SELECT current_database() || '|' || current_user || '|' || inet_server_addr()::text || '|' || inet_server_port() || '|' || EXISTS (SELECT 1 FROM pg_catalog.pg_database WHERE datname = 'metrivo_pos_test')",
  ])
  if (identity !== 'postgres|postgres|127.0.0.1/32|5432|false') {
    throw new Error(
      `Refusing bootstrap SQL: PostgreSQL bootstrap identity is not clean and isolated (observed ${JSON.stringify(identity)})`,
    )
  }
}

async function verifyDatabaseIdentity() {
  const client = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
  })
  try {
    const identity = await client.$queryRaw`
      SELECT current_database() AS database_name,
             current_user AS database_user,
             inet_server_port() AS server_port,
             (SELECT identity_value
              FROM public.metrivo_pos_test_identity
              WHERE identity_key = 'environment') AS marker,
             to_regclass('public."User"')::text AS baseline_user
    `
    const row = identity[0]
    if (
      row?.database_name !== 'metrivo_pos_test' ||
      row?.database_user !== 'metrivo_pos_test_app' ||
      Number(row?.server_port) !== 5432 ||
      row?.marker !== expectedMarker ||
      row?.baseline_user !== null
    ) {
      throw new Error(
        'Refusing migration: PostgreSQL identity is not a clean isolated POS test database',
      )
    }
  } finally {
    await client.$disconnect()
  }
}

async function main() {
  if (!npmCli) {
    throw new Error('Run PostgreSQL integration tests through the npm test:postgres script')
  }
  const safeEnvironment = {
    ...process.env,
    DATABASE_URL: databaseUrl,
  }
  const generate = spawnSync(
    process.execPath,
    [npmCli, '--prefix', 'apps/api', 'run', 'prisma:generate'],
    { cwd: repositoryRoot, env: safeEnvironment, stdio: 'inherit' },
  )
  if (generate.status !== 0) {
    throw new Error('Prisma Client generation failed before integration setup')
  }

  const compile = spawnSync(
    process.execPath,
    [npmCli, '--prefix', 'apps/api', 'run', 'test:compile'],
    { cwd: repositoryRoot, env: safeEnvironment, stdio: 'inherit' },
  )
  if (compile.status !== 0) {
    throw new Error('API test compilation failed before integration setup')
  }

  ensureProjectResourcesAbsent()
  startupAttempted = true
  docker(['up', '--detach', '--wait', 'postgres'])
  verifyComposeContainer()
  verifyBootstrapIdentity()

  psql('postgres', 'postgres', [
    '-v',
    `test_marker=${expectedMarker}`,
    '-f',
    '/workspace/test-fixtures/postgres-init.sql',
  ])
  await verifyDatabaseIdentity()

  psql('metrivo_pos_test', 'metrivo_pos_test_migrator', [
    '-c',
    'SET ROLE metrivo_pos_test_owner',
    '-f',
    '/workspace/test-fixtures/postgres-baseline.sql',
  ])

  for (const migration of migrations) {
    psql('metrivo_pos_test', 'metrivo_pos_test_migrator', [
      '-c',
      'SET ROLE metrivo_pos_test_owner',
      '-f',
      `/workspace/prisma/migrations/${migration}/migration.sql`,
    ])
  }

  psql('metrivo_pos_test', 'metrivo_pos_test_migrator', [
    '-c',
    'SET ROLE metrivo_pos_test_owner',
    '-f',
    '/workspace/test-fixtures/postgres-test-controls.sql',
  ])
  psql('metrivo_pos_test', 'postgres', [
    '-c',
    'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO metrivo_pos_test_app; GRANT USAGE ON SCHEMA public TO metrivo_pos_test_app;',
  ])

  const tests = spawnSync(
    process.execPath,
    ['--test', '.test-build/test/sales.postgres.integration.test.js'],
    {
      cwd: path.join(repositoryRoot, 'apps', 'api'),
      env: {
        ...safeEnvironment,
        METRIVO_TEST_DATABASE_URL: databaseUrl,
        METRIVO_TEST_IDENTITY_MARKER: expectedMarker,
      },
      stdio: 'inherit',
    },
  )
  if (tests.status !== 0) {
    throw new Error('PostgreSQL sales integration tests failed')
  }
}

async function run() {
  let failure
  try {
    await main()
  } catch (error) {
    failure = error
    process.stderr.write(`${error.message}\n`)
  } finally {
    if (startupAttempted) {
      try {
        verifyProjectResourcesForCleanup()
        const result = spawnSync(
          'docker',
          ['compose', '-f', composeFile, '-p', projectName, 'down'],
          {
            cwd: repositoryRoot,
            encoding: 'utf8',
            maxBuffer: 1024 * 1024,
            stdio: 'ignore',
          },
        )
        if (result.error || result.status !== 0) {
          throw new Error('Failed to stop verified isolated Compose resources')
        }
      } catch (cleanupError) {
        const message = cleanupError instanceof Error
          ? cleanupError.message
          : 'Unknown cleanup verification failure'
        process.stderr.write(`${message}\n`)
        if (!failure) {
          failure = cleanupError instanceof Error
            ? cleanupError
            : new Error(message)
        }
      }
    }
  }
  if (failure) process.exitCode = 1
}

void run()
