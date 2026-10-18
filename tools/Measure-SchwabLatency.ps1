[CmdletBinding()]
param(
    [ValidateRange(1, 30)][int]$NewConnectionSamples = 6,
    [ValidateRange(1, 60)][int]$ReusedConnectionSamples = 12,
    [uri]$ProxyUrl = 'http://127.0.0.1:7897'
)

# Only unauthenticated GET requests are sent. No keys, tokens or orders are used.
$ErrorActionPreference = 'Stop'
if ($ProxyUrl.Scheme -notin @('http', 'https') -or $ProxyUrl.UserInfo) {
    throw 'Use an HTTP(S) proxy URL without embedded credentials.'
}
$runStarted = Get-Date
$outputDirectory = Join-Path (Split-Path $PSScriptRoot -Parent) ('reports/latency-' + $runStarted.ToString('yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
$csvPath = Join-Path $outputDirectory 'samples.csv'
$errorsPath = Join-Path $outputDirectory 'curl-errors.txt'
$rows = [System.Collections.Generic.List[object]]::new()
$culture = [System.Globalization.CultureInfo]::InvariantCulture
$writeOut = '%{urlnum},%{http_code},%{exitcode},%{time_namelookup},%{time_connect},%{time_appconnect},%{time_pretransfer},%{time_starttransfer},%{time_total},%{remote_ip},%{remote_port},%{http_version},%{num_connects},%{proxy_used},%{size_download}\n'
$headers = @('UrlIndex', 'HttpStatus', 'CurlExit', 'Dns', 'Connect', 'AppConnect', 'Pretransfer', 'FirstByte', 'Total', 'RemoteIp', 'RemotePort', 'HttpVersion', 'NewConnections', 'ProxyUsed', 'Bytes')
$endpoints = [ordered]@{
    accounts = 'https://api.schwabapi.com/trader/v1/accounts/accountNumbers'
    quotes = 'https://api.schwabapi.com/marketdata/v1/quotes?symbols=AAPL'
}

function Invoke-ProbeBatch([string]$Route, [string]$Endpoint, [string]$Mode, [int]$Count) {
    $batchStarted = (Get-Date).ToUniversalTime().ToString('o')
    $arguments = @('--disable', '--silent', '--show-error', '--http1.1', '--request', 'GET',
        '--connect-timeout', '8', '--max-time', '15', '--rate', '60/m', '--write-out', $writeOut)
    if ($Route -eq 'direct') {
        $arguments += @('--noproxy', '*')
    } else {
        $arguments += @('--proxy', $ProxyUrl.AbsoluteUri, '--noproxy', '')
    }
    for ($index = 0; $index -lt $Count; $index++) {
        $arguments += @('--output', 'NUL', '--url', $endpoints[$Endpoint])
    }
    $lines = @(& curl.exe @arguments 2>> $errorsPath)
    if ($lines.Count -ne $Count) {
        throw "Expected $Count timing rows, got $($lines.Count). See $errorsPath"
    }
    foreach ($item in ($lines | ConvertFrom-Csv -Header $headers)) {
        $times = @{}
        foreach ($field in @('Dns', 'Connect', 'AppConnect', 'Pretransfer', 'FirstByte', 'Total')) {
            $times[$field] = 1000 * [double]::Parse($item.$field, $culture)
        }
        $phase = if ($Mode -eq 'new') { 'new' }
            elseif ([int]$item.UrlIndex -eq 0) { 'warmup' }
            elseif ([int]$item.NewConnections -eq 0 -and [int]$item.CurlExit -eq 0) { 'reused' }
            else { 'reopened-or-failed' }
        $row = [pscustomobject][ordered]@{
            BatchStartedUTC = $batchStarted
            Route = $Route
            Endpoint = $Endpoint
            Phase = $phase
            BatchIndex = [int]$item.UrlIndex
            HttpStatus = [int]$item.HttpStatus
            CurlExit = [int]$item.CurlExit
            DnsMs = [math]::Round($times.Dns, 3)
            TcpMs = [math]::Round([math]::Max(0.0, $times.Connect - $times.Dns), 3)
            TlsAndTunnelMs = [math]::Round([math]::Max(0.0, $times.AppConnect - $times.Connect), 3)
            RequestToFirstByteMs = [math]::Round([math]::Max(0.0, $times.FirstByte - $times.Pretransfer), 3)
            FirstByteMs = [math]::Round($times.FirstByte, 3)
            TotalMs = [math]::Round($times.Total, 3)
            RemoteIp = $item.RemoteIp
            RemotePort = [int]$item.RemotePort
            HttpVersion = $item.HttpVersion
            NewConnections = [int]$item.NewConnections
            ProxyUsed = [int]$item.ProxyUsed
            Bytes = [int]$item.Bytes
        }
        $rows.Add($row)
        $row | Export-Csv -LiteralPath $csvPath -NoTypeInformation -Append -Encoding utf8
        if ($row.HttpStatus -eq 429) { throw 'Rate limit response received; stopping probes.' }
    }
}

# Alternate routes for new connections to reduce time-of-test bias.
foreach ($endpoint in $endpoints.Keys) {
    for ($sample = 1; $sample -le $NewConnectionSamples; $sample++) {
        foreach ($route in @('direct', 'system-proxy')) {
            Invoke-ProbeBatch $route $endpoint 'new' 1
        }
        Write-Host "$endpoint new connections: pair $sample/$NewConnectionSamples"
    }
}
# curl reuses connections within a process. The first request is excluded.
# Reverse route order on the second endpoint to reduce a fixed ordering effect.
foreach ($endpoint in $endpoints.Keys) {
    $routes = if ($endpoint -eq 'accounts') { @('direct', 'system-proxy') } else { @('system-proxy', 'direct') }
    foreach ($route in $routes) {
        Write-Host "$endpoint ${route}: measuring $ReusedConnectionSamples reused requests"
        Invoke-ProbeBatch $route $endpoint 'warm' ($ReusedConnectionSamples + 1)
    }
}

function Get-Percentile([double[]]$Values, [double]$Percentile) {
    $sorted = @($Values | Sort-Object)
    if ($sorted.Count -eq 0) { return $null }
    $position = ($sorted.Count - 1) * $Percentile
    $lower = [int][math]::Floor($position)
    $upper = [int][math]::Ceiling($position)
    return [math]::Round($sorted[$lower] + ($sorted[$upper] - $sorted[$lower]) * ($position - $lower), 2)
}

$summaries = @(
    foreach ($group in ($rows | Group-Object Route, Endpoint, Phase)) {
        $successful = @($group.Group | Where-Object { $_.CurlExit -eq 0 -and $_.HttpStatus -eq 401 })
        [pscustomobject][ordered]@{
            Route = $group.Group[0].Route
            Endpoint = $group.Group[0].Endpoint
            Phase = $group.Group[0].Phase
            Count = $group.Count
            Expected401 = $successful.Count
            CurlFailures = @($group.Group | Where-Object CurlExit -ne 0).Count
            MedianTotalMs = Get-Percentile @($successful.TotalMs) 0.5
            P95TotalMs = Get-Percentile @($successful.TotalMs) 0.95
            MinTotalMs = if ($successful.Count) { ($successful.TotalMs | Measure-Object -Minimum).Minimum } else { $null }
            MaxTotalMs = if ($successful.Count) { ($successful.TotalMs | Measure-Object -Maximum).Maximum } else { $null }
            MedianDnsMs = Get-Percentile @($successful.DnsMs) 0.5
            MedianTcpMs = Get-Percentile @($successful.TcpMs) 0.5
            MedianTlsAndTunnelMs = Get-Percentile @($successful.TlsAndTunnelMs) 0.5
            MedianRequestToFirstByteMs = Get-Percentile @($successful.RequestToFirstByteMs) 0.5
        }
    }
)
$report = [ordered]@{
    StartedAt = $runStarted.ToString('o')
    FinishedAt = (Get-Date).ToString('o')
    Method = 'Unauthenticated HTTPS GET; verified certificates; HTTP/1.1; no redirects or retries; response bodies discarded.'
    Scope = 'API gateway 401 responses only, not authenticated account/quote retrieval, execution latency, or thinkorswim launch time.'
    DirectRoute = 'curl explicit no-proxy; transparent VPN/TUN or upstream routing is not ruled out.'
    ProxyRoute = $ProxyUrl.AbsoluteUri
    TimingNotes = 'New means a fresh curl process/connection, with OS DNS cache retained. Proxy TcpMs is only the local proxy connection; TlsAndTunnelMs includes CONNECT and upstream setup. Warmup requests are excluded from reused summaries. P95 uses linear interpolation and is exploratory with small samples.'
    CurlVersion = (& curl.exe --version | Select-Object -First 1)
    SampleCount = $rows.Count
    Summaries = $summaries
}
$report | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $outputDirectory 'summary.json') -Encoding utf8
$summaries | Where-Object Phase -in @('new', 'reused', 'reopened-or-failed') | Format-Table Route,Endpoint,Phase,Count,Expected401,MedianTotalMs,P95TotalMs,MedianTcpMs,MedianTlsAndTunnelMs -AutoSize
Write-Host "RESULT_DIRECTORY=$outputDirectory"
