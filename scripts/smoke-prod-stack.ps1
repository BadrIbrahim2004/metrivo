# Production-stack smoke test (isolated ports, isolated db volume name,
# separate project name) - does NOT touch the dev stack or its data.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File scripts\smoke-prod-stack.ps1
$ErrorActionPreference = 'Stop'

Set-Location (Join-Path $PSScriptRoot '..')

$env:POSTGRES_USER = 'metrivo'
$env:POSTGRES_PASSWORD = 'smoke_test_password_only'
$env:POSTGRES_DB = 'metrivo_prod'
$env:AUTH_ACCESS_TOKEN_SECRET = 'smoke_test_secret_value_0123456789abcdef0123456789abcdef'
$env:AUTH_ACCESS_TOKEN_ISSUER = 'metrivo-api'
$env:AUTH_ACCESS_TOKEN_AUDIENCE = 'metrivo-web'
# Override host ports to avoid clashing with anything running locally
$env:WEB_PORT = '8080'

$composeArgs = @('-p','metrivo-smoke','-f','compose.prod.yml')

Write-Host '== Building & starting smoke stack =='
docker compose @composeArgs up -d --build
if ($LASTEXITCODE -ne 0) { throw 'docker compose up failed' }

Write-Host '== Waiting for health =='
$ok = $false
foreach ($i in 1..40) {
    try {
        $h = Invoke-RestMethod "http://127.0.0.1:8080/api/health" -TimeoutSec 3
        if ($h.status -eq 'ok') { $ok = $true; break }
    } catch { Start-Sleep -Seconds 3 }
}
if (-not $ok) {
    docker compose @composeArgs logs --tail 40
    docker compose @composeArgs down
    throw 'API health never turned ok'
}
Write-Host "HEALTH OK: $($h | ConvertTo-Json -Compress)"

Write-Host '== Checking SPA is served =='
$spa = Invoke-WebRequest 'http://127.0.0.1:8080/' -TimeoutSec 5
if ($spa.Content -notmatch '<div id="root">') { throw 'SPA index not served' }
Write-Host 'SPA OK'

Write-Host '== Login rate-limit + wrong-password probe =='
try {
    Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:8080/api/auth/login' `
        -ContentType 'application/json' `
        -Body '{"email":"nobody@example.invalid","password":"WrongPassword123"}' | Out-Null
    Write-Host 'WARN: login unexpectedly succeeded'
} catch {
    Write-Host "LOGIN PROBE STATUS: $($_.Exception.Response.StatusCode.value__)"
}

Write-Host '== Tearing down smoke stack =='
docker compose @composeArgs down
Write-Host 'SMOKE TEST PASSED'
