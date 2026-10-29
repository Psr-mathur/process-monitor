# stat.ps1
# Windows process monitoring: CPU, memory, threads, handles and I/O.
# Usage:
#   .\stat.ps1 --pid=21332,54342
#   .\stat.ps1 --port=5000,1433
#   .\stat.ps1 --pid=21332 --port=5000,1433 --interval=1
#
# Accuracy notes:
#   - Each counter is timestamped at the moment it is read, not at loop
#     start, so a slow iteration (machine under load, slow WMI) no longer
#     inflates CPU% or I/O rates.
#   - The monitor runs at High priority so it is less likely to be starved
#     by the processes it is watching.
#   - CPU_Percent is % of total machine capacity (0-100).
#     CPU_Cores = how many logical cores' worth of CPU were used.

$requestedPids  = [System.Collections.Generic.List[int]]::new()
$requestedPorts = [System.Collections.Generic.List[int]]::new()
$interval = 1.0
$outFile = "process-log.csv"
$lastMode = ""

# Parse command-line arguments
foreach ($arg in $args) {
    $s = [string]$arg

    if ($s -match '^--pid=(.*)$') {
        $lastMode = "pid"
        foreach ($v in ($Matches[1] -split '[,\s]+')) {
            if ($v -match '^\d+$') { $requestedPids.Add([int]$v) }
        }
    }
    elseif ($s -match '^--port=(.*)$') {
        $lastMode = "port"
        foreach ($v in ($Matches[1] -split '[,\s]+')) {
            if ($v -match '^\d+$') { $requestedPorts.Add([int]$v) }
        }
    }
    elseif ($s -match '^--interval=(\d+(\.\d+)?)$') {
        $interval = [double]$Matches[1]
        $lastMode = ""
    }
    elseif ($s -match '^--out=(.+)$') {
        $outFile = $Matches[1]
        $lastMode = ""
    }
    elseif ($s -match '^\d+$' -and $lastMode -eq "pid") {
        $requestedPids.Add([int]$s)
    }
    elseif ($s -match '^\d+$' -and $lastMode -eq "port") {
        $requestedPorts.Add([int]$s)
    }
}

if ($interval -le 0) {
    Write-Error "Interval must be greater than zero."
    exit 1
}

if ($requestedPids.Count -eq 0 -and $requestedPorts.Count -eq 0) {
    Write-Host "Usage: .\stat.ps1 --pid=1234,5678"
    Write-Host "   or: .\stat.ps1 --port=5000,1433"
    exit 1
}

$requestedPids  = @($requestedPids  | Select-Object -Unique)
$requestedPorts = @($requestedPorts | Select-Object -Unique)

# Run the monitor at High priority so a busy target can't starve it
try {
    [System.Diagnostics.Process]::GetCurrentProcess().PriorityClass =
        [System.Diagnostics.ProcessPriorityClass]::High
}
catch {
    Write-Host "Note: could not raise monitor priority (run as admin for best accuracy)."
}

$cores = [Environment]::ProcessorCount

# Initialize output file
$header = "Time,PID,Process,CPU_Percent,CPU_Cores,CPUSeconds,SampleSec,RAM_MB,Private_MB,Threads,Handles,IO_Read_BytesPerSec,IO_Write_BytesPerSec,IO_Other_BytesPerSec"
Set-Content -LiteralPath $outFile -Value $header

# Previous cumulative counters, each with its own read time
$previous = @{}

# Monotonic clock
$clock = [System.Diagnostics.Stopwatch]::StartNew()
$culture = [System.Globalization.CultureInfo]::InvariantCulture

Write-Host "Logging to: $((Resolve-Path $outFile).Path)"
Write-Host "Interval: $interval second(s), $cores logical processors. Press Ctrl+C to stop."

while ($true) {
    $loopStart = $clock.Elapsed.TotalSeconds

    # Resolve configured ports to current listening process IDs
    $targetPids = @($requestedPids)
    foreach ($port in $requestedPorts) {
        try {
            $connections = @(Get-NetTCPConnection -State Listen `
                -LocalPort $port -ErrorAction SilentlyContinue)
            foreach ($connection in $connections) {
                $targetPids += [int]$connection.OwningProcess
            }
        }
        catch { }
    }
    $targetPids = @($targetPids | Where-Object { $_ -gt 0 } | Select-Object -Unique)

    if ($targetPids.Count -gt 0) {
        $filter = ($targetPids | ForEach-Object { "ProcessId = $_" }) -join " OR "

        $lines = [System.Collections.Generic.List[string]]::new()

        foreach ($id in $targetPids) {
            try {
                # --- CPU / memory: read, then timestamp immediately ---
                $p = [System.Diagnostics.Process]::GetProcessById($id)
                $p.Refresh()
                $cpuSeconds = $p.TotalProcessorTime.TotalSeconds
                $cpuTicks   = $clock.Elapsed.TotalSeconds
                $timestamp  = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss.fff")

                # --- I/O: read, then timestamp immediately ---
                $c = Get-CimInstance Win32_Process -Filter "ProcessId = $id" `
                        -ErrorAction SilentlyContinue
                $ioTicks = $clock.Elapsed.TotalSeconds
                if ($null -eq $c) { continue }

                $readBytes  = [double]$c.ReadTransferCount
                $writeBytes = [double]$c.WriteTransferCount
                $otherBytes = [double]$c.OtherTransferCount

                $cpuPct = 0.0; $cpuCores = 0.0; $cpuDt = 0.0
                $readRate = 0.0; $writeRate = 0.0; $otherRate = 0.0

                if ($previous.ContainsKey($id)) {
                    $old = $previous[$id]

                    $cpuDt = $cpuTicks - $old.CpuTicks
                    if ($cpuDt -gt 0 -and $cpuSeconds -ge $old.CPU) {
                        $cpuCores = ($cpuSeconds - $old.CPU) / $cpuDt
                        $cpuPct   = 100.0 * $cpuCores / $cores
                        # Windows credits CPU time in clock-tick chunks; tiny
                        # windows can overshoot slightly. Clamp to physical max.
                        if ($cpuPct -gt 100.0) { $cpuPct = 100.0; $cpuCores = $cores }
                    }

                    $ioDt = $ioTicks - $old.IoTicks
                    if ($ioDt -gt 0) {
                        $readRate  = [math]::Max(0, ($readBytes  - $old.Read)  / $ioDt)
                        $writeRate = [math]::Max(0, ($writeBytes - $old.Write) / $ioDt)
                        $otherRate = [math]::Max(0, ($otherBytes - $old.Other) / $ioDt)
                    }
                }

                $previous[$id] = @{
                    CpuTicks = $cpuTicks
                    IoTicks  = $ioTicks
                    CPU      = $cpuSeconds
                    Read     = $readBytes
                    Write    = $writeBytes
                    Other    = $otherBytes
                }

                $lines.Add(([string]::Join(",", @(
                    $timestamp,
                    $id,
                    $p.ProcessName,
                    [math]::Round($cpuPct, 2).ToString($culture),
                    [math]::Round($cpuCores, 2).ToString($culture),
                    [math]::Round($cpuSeconds, 2).ToString($culture),
                    [math]::Round($cpuDt, 3).ToString($culture),
                    [math]::Round($p.WorkingSet64 / 1MB, 2).ToString($culture),
                    [math]::Round($p.PrivateMemorySize64 / 1MB, 2).ToString($culture),
                    $p.Threads.Count,
                    $p.HandleCount,
                    [math]::Round($readRate, 0).ToString($culture),
                    [math]::Round($writeRate, 0).ToString($culture),
                    [math]::Round($otherRate, 0).ToString($culture)
                ))))
            }
            catch {
                # Process may have exited or be inaccessible; drop its baseline
                $previous.Remove($id)
            }
        }

        if ($lines.Count -gt 0) {
            Add-Content -LiteralPath $outFile -Value $lines
        }
    }

    # Sleep only for what's left of the interval, so the cadence stays steady
    $spent = $clock.Elapsed.TotalSeconds - $loopStart
    $sleepMs = [int](($interval - $spent) * 1000)
    if ($sleepMs -gt 0) { Start-Sleep -Milliseconds $sleepMs }
}
