param([string]$LanAddress, [int]$Port = 8081)
$ErrorActionPreference = 'Stop'
$projectPath = Join-Path $PSScriptRoot '../mobile'
if (-not $LanAddress) {
    $LanAddress = Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway } |
        ForEach-Object { $_.IPv4Address.IPAddress } |
        Where-Object { $_ -match '^(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.)' } |
        Select-Object -First 1
}
if (-not $LanAddress) { throw 'No private LAN address found. Pass -LanAddress with the computer Wi-Fi or Ethernet IPv4 address.' }
$parsedAddress = $null
if (-not [System.Net.IPAddress]::TryParse($LanAddress, [ref]$parsedAddress) -or $parsedAddress.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork) { throw 'LanAddress must be an IPv4 address.' }
if ($Port -lt 1024 -or $Port -gt 65535) { throw 'Port must be between 1024 and 65535.' }
$env:EXPO_NO_DOTENV = '1'
$env:REACT_NATIVE_PACKAGER_HOSTNAME = $LanAddress
Push-Location -LiteralPath $projectPath
try {
    Write-Host "Expo Go: exp://${LanAddress}:$Port"
    & npx.cmd expo start --go --lan --port $Port
} finally { Pop-Location }
