param(
  [Parameter(Mandatory = $true)]
  [string]$SandboxId,

  [Parameter(Mandatory = $true)]
  [string]$TrafficToken,

  [string]$GatewayUrl = "https://agent-gateway-90is-gztggnjthe.agentgateway.cn-south-1.huaweicloud-agentnetwork.com",
  [int]$LocalPort = 13080,
  [int]$SandboxPort = 3080
)

$ErrorActionPreference = "Stop"
$ScriptDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Node.js is not installed or node.exe is not in PATH"
}
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  throw "npm is not installed or npm.cmd is not in PATH"
}

Push-Location $ScriptDirectory
try {
  if (-not (Test-Path (Join-Path $ScriptDirectory "node_modules/http-proxy"))) {
    Write-Host "Installing the local bridge dependency..."
    npm install --omit=dev --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw "npm install failed" }
  }

  $env:AGENT_GATEWAY_URL = $GatewayUrl.TrimEnd('/')
  $env:BROWSER_PROXY_PORT = [string]$LocalPort
  $env:E2B_TRAFFIC_ACCESS_TOKEN = $TrafficToken
  $env:E2B_SANDBOX_ID = $SandboxId
  $env:E2B_SANDBOX_PORT = [string]$SandboxPort

  Write-Host "Disable ModHeader and AgentSphere header extensions for this test."
  Write-Host "Keep this window open, then visit http://127.0.0.1:$LocalPort"
  node browser-proxy.js
  if ($LASTEXITCODE -ne 0) { throw "local bridge exited with code $LASTEXITCODE" }
}
finally {
  Remove-Item Env:AGENT_GATEWAY_URL -ErrorAction SilentlyContinue
  Remove-Item Env:BROWSER_PROXY_PORT -ErrorAction SilentlyContinue
  Remove-Item Env:E2B_TRAFFIC_ACCESS_TOKEN -ErrorAction SilentlyContinue
  Remove-Item Env:E2B_SANDBOX_ID -ErrorAction SilentlyContinue
  Remove-Item Env:E2B_SANDBOX_PORT -ErrorAction SilentlyContinue
  Pop-Location
}
