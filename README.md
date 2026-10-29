# Windows Process Statistics (stat.ps1)

A lightweight PowerShell-based process monitoring utility for Windows that collects CPU, memory, thread, handle, and process I/O statistics at configurable intervals.

Monitor specific processes by PID, discover processes by TCP listening port, or combine both approaches. Metrics are written to a CSV file for analysis, dashboards, and integration with win-mpstat.

## Features

- Monitor multiple Windows processes simultaneously.
- Select processes by PID or TCP listening port.
- Calculate process CPU utilization as a percentage of total machine capacity and as logical cores used.
- Track cumulative CPU time.
- Monitor physical working-set memory and private memory.
- Record thread and handle counts.
- Calculate process I/O read, write, and other transfer rates.
- Configure the sampling interval, including sub-second intervals.
- Hold a steady sampling cadence by compensating for time spent collecting.
- Timestamp each counter at the moment it is read for accurate rates under load.
- Run the monitor at High priority so busy target processes are less likely to starve it.
- Export metrics to CSV for historical analysis.
- Rediscover processes listening on configured ports after application restarts.

## Requirements

- Windows 10, Windows 11, or Windows Server 2012 or later.
- Windows PowerShell 5.1 or PowerShell 7+.
- The `NetTCPIP` module (`Get-NetTCPConnection`), included with supported Windows versions, for port-based discovery.
- Permission to query the target processes through `System.Diagnostics.Process` and the `Win32_Process` CIM class.
- Administrator privileges are recommended. They may be required to query some processes (for example, services running as other accounts) and to raise the monitor to High priority.

## Installation

1. Save the script as `stat.ps1`.
2. Open CMD or PowerShell.
3. Navigate to the directory containing the script.
4. Run the script with the desired arguments.

Example:

```cmd
cd C:\Tools\stat-powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\stat.ps1 --pid=21332,54342
```

Running the script without `--pid` or `--port` prints a short usage message and exits.

## Usage

### 1. Monitor processes by PID

```cmd
powershell -NoProfile -ExecutionPolicy Bypass -File .\stat.ps1 --pid=21332,54342,45634
```

The specified process IDs are monitored at the configured sampling interval.

### 2. Monitor processes by TCP port

```cmd
powershell -NoProfile -ExecutionPolicy Bypass -File .\stat.ps1 --port=5000,1433
```

The script discovers the process IDs owning listening TCP sockets on the specified ports. Discovery is repeated on every sample, so a restarted application is picked up under its new PID.

Example use cases:

- Port 5000: an Express.js application.
- Port 1433: a SQL Server instance using the default TCP port.

> **Important:** Port numbers are examples. Confirm the actual listening ports on your server. If a reverse proxy owns a port, the discovered process may be the proxy rather than the application.

### 3. Monitor both PIDs and ports

```cmd
powershell -NoProfile -ExecutionPolicy Bypass -File .\stat.ps1 --pid=21332,54342 --port=5000,1433
```

The script combines explicitly supplied PIDs with processes discovered through the configured listening ports and removes duplicate PIDs.

### 4. Configure the sampling interval

Use `--interval` to specify the interval in seconds. Decimal values are accepted.

```cmd
powershell -NoProfile -ExecutionPolicy Bypass -File .\stat.ps1 --port=5000,1433 --interval=1
```

Example with a five-second interval:

```cmd
powershell -NoProfile -ExecutionPolicy Bypass -File .\stat.ps1 --pid=21332 --interval=5
```

Example with a half-second interval:

```cmd
powershell -NoProfile -ExecutionPolicy Bypass -File .\stat.ps1 --pid=21332 --interval=0.5
```

The script measures how long each collection pass takes and sleeps only for the remainder of the interval, so samples stay evenly spaced. If a collection pass takes longer than the interval (for example, many processes on a heavily loaded machine), the next pass starts immediately. The actual time between samples for each process is recorded in the `SampleSec` column.

The interval must be greater than zero.

### 5. Specify the output CSV file

```cmd
powershell -NoProfile -ExecutionPolicy Bypass -File .\stat.ps1 --port=5000,1433 --out=stem-stats.csv
```

The default output file is:

```text
process-log.csv
```

The output path is relative to the current working directory unless an absolute path is specified. The full resolved path is printed when the script starts.

> **Warning:** The output file is overwritten each time the script starts. Use a different `--out` value for each run if you need to keep earlier data.

### 6. Stop monitoring

Press `Ctrl+C`. The script stops collecting samples.

## Command-Line Arguments

| Argument | Required | Description |
|---|---|---|
| `--pid=PID1,PID2` | One target option required | Process IDs, separated by commas or spaces. |
| `--port=PORT1,PORT2` | One target option required | TCP listening ports, separated by commas or spaces. |
| `--interval=SECONDS` | No | Sampling interval in seconds, decimals allowed. Default: `1`. |
| `--out=FILE` | No | CSV output path. Default: `process-log.csv`. |

At least one of `--pid` or `--port` must be supplied. Arguments can be combined in one invocation, and values may also be listed with spaces after the option:

```powershell
.\stat.ps1 --pid=21332 54342 --port=5000 1433
```

## Metrics Collected

Each CSV row represents one process sample.

| Column | Unit | Description |
|---|---|---|
| `Time` | Local timestamp | Time when the process's CPU and memory counters were read. |
| `PID` | Integer | Windows process identifier. |
| `Process` | Name | Executable process name. |
| `CPU_Percent` | Percentage (0-100) | Process CPU utilization normalized to total logical CPU capacity. |
| `CPU_Cores` | Logical cores | Number of logical cores' worth of CPU used during the sample. |
| `CPUSeconds` | Seconds | Cumulative CPU execution time consumed by the process. |
| `SampleSec` | Seconds | Measured time between this CPU reading and the previous one for the process. |
| `RAM_MB` | MB | Physical working-set memory. |
| `Private_MB` | MB | Private memory attributed to the process. |
| `Threads` | Count | Number of process threads. |
| `Handles` | Count | Number of open process handles. |
| `IO_Read_BytesPerSec` | Bytes/sec | Rate of process-attributed I/O read transfers. |
| `IO_Write_BytesPerSec` | Bytes/sec | Rate of process-attributed I/O write transfers. |
| `IO_Other_BytesPerSec` | Bytes/sec | Rate of other process-attributed I/O transfers. |

### CPU calculation

The script calculates CPU utilization from the change in cumulative CPU time between consecutive samples:

```text
CPU_Cores   = (CPUSeconds_Current - CPUSeconds_Previous) / SampleSec
CPU_Percent = CPU_Cores / LogicalProcessorCount * 100
```

For example, on a machine with eight logical processors, a process consuming one full logical processor for one second reports `CPU_Cores` of approximately 1.00 and `CPU_Percent` of approximately 12.5%.

`CPU_Percent` differs from tools that report one fully utilized logical processor as 100%. Use `CPU_Cores` for that view (multiply by 100 for a per-core percentage).

Notes:

- The first sample for each process reports `0` for `CPU_Percent`, `CPU_Cores`, `SampleSec`, and the I/O rates because no previous sample is available.
- Windows credits CPU time in clock-tick chunks, so very short sample windows can slightly overshoot. `CPU_Percent` is capped at 100 and `CPU_Cores` at the logical processor count.

### Timing accuracy

- Elapsed time is measured with a monotonic `Stopwatch`, so system clock changes do not affect rates.
- CPU and I/O counters are each timestamped immediately after they are read, not at the start of the collection pass. A slow iteration (machine under load, slow WMI query) therefore does not inflate CPU percentages or I/O rates.
- The monitor process runs at High priority so a busy target process is less likely to delay sampling. If the priority cannot be raised, a note is printed and monitoring continues at normal priority.

### Memory metrics

- `RAM_MB` measures the process working set, which represents physical memory currently resident for that process.
- `Private_MB` measures private memory attributed to the process.

These metrics represent different aspects of memory and should not be treated as interchangeable.

### Process I/O metrics

The script derives I/O rates from differences in the cumulative `ReadTransferCount`, `WriteTransferCount`, and `OtherTransferCount` values reported by `Win32_Process`.

These are process-attributed I/O transfer rates, not guaranteed physical disk throughput. They may include cached or buffered operations, network I/O, and device I/O, and are not sufficient to calculate disk latency.

For physical disk throughput, queue length, and latency, collect Windows physical-disk performance counters separately.

## Example Output

```csv
Time,PID,Process,CPU_Percent,CPU_Cores,CPUSeconds,SampleSec,RAM_MB,Private_MB,Threads,Handles,IO_Read_BytesPerSec,IO_Write_BytesPerSec,IO_Other_BytesPerSec
2026-10-29 11:00:01.000,21332,node,0,0,45.62,0,185.25,142.1,24,512,0,0,0
2026-10-29 11:00:01.020,54342,sqlservr,0,0,120.5,0,2048,1850,145,2300,0,0,0
2026-10-29 11:00:02.000,21332,node,18.75,1.5,47.12,1,185.8,142.5,25,516,8192,1024,0
2026-10-29 11:00:02.021,54342,sqlservr,25,2,122.5,1.001,2048,1850,145,2301,16384,32768,0
```

> **Note:** The sample values above are illustrative (8 logical processors) and do not represent actual measurements. Rows from different processes are collected sequentially, so timestamps differ slightly between processes. Numbers use invariant culture formatting (`.` as the decimal separator) regardless of system locale.

## Monitoring Express.js Applications

For multiple Express.js applications running on the same Windows server, use their listening ports to identify the relevant processes.

Example:

```cmd
powershell -NoProfile -ExecutionPolicy Bypass -File .\stat.ps1 --port=5000 --interval=1 --out=stem-stats.csv
```

This monitors the process or processes discovered through port 5000.

If multiple applications use child processes, worker processes, or a reverse proxy, port ownership alone may not identify every process belonging to the application. Use a process-tree or application-specific discovery strategy when aggregating all workers.

This script measures operating-system process resources. It does not independently identify slow Express routes, request latency, event-loop delays, or individual SQL queries.

## Monitoring SQL Server

Example:

```cmd
powershell -NoProfile -ExecutionPolicy Bypass -File .\stat.ps1 --port=1433 --interval=1 --out=sqlserver-stats.csv
```

Confirm that SQL Server is actually listening on port 1433. Named instances and custom configurations may use other ports.

Process-level metrics help identify CPU and memory consumption, but query-level performance analysis requires SQL Server diagnostic facilities such as Dynamic Management Views, Extended Events, or Query Store.

## Operational Considerations

### Process restarts and PID reuse

Port-based discovery runs on every sample and picks up a new PID after a restart. When a process exits or cannot be queried, its previous CPU and I/O readings are discarded, so its next successful sample starts a fresh baseline (reported as `0`) instead of producing a bogus rate.

The script does not track process start time, so if Windows reuses a PID for a different process between two samples, the two may be treated as the same process for one sample. A robust production collector should associate samples with process start time as well as PID.

### Sampling overhead

A one-second sampling interval is suitable for many monitoring scenarios, but the script runs a CIM query per process and a TCP connection lookup per port on every pass. Monitor its own resource consumption when tracking many processes or using sub-second intervals. Because the monitor runs at High priority, keep its workload modest on busy servers.

### CSV growth

Within a run, the script appends samples continuously, so the CSV file grows over time. For long-running deployments, consider log rotation, retention policies, or a time-series database. Remember that restarting the script overwrites the output file.

### Permissions

If a process cannot be queried, it is skipped for that sample and no row is written. Run the collector as Administrator when monitoring services or processes owned by other accounts.

### Data interpretation

- CPU and I/O rates require consecutive samples.
- A process that exits between discovery and sampling is skipped.
- Process I/O is not equivalent to physical disk I/O.
- Port discovery covers TCP listening sockets, not UDP endpoints or every process associated with an application.

## Integration with win-mpstat

This script can serve as a prototype or supplementary collector for win-mpstat.

For production integration, consider implementing the collection loop directly in the existing agent using native Windows APIs:

- `GetProcessTimes` for cumulative process CPU time.
- `GetProcessMemoryInfo` for working-set and memory information.
- `GetProcessIoCounters` for process I/O transfer counters.
- Windows process APIs for threads and handles.
- TCP connection tables (`GetExtendedTcpTable`) for port-to-process discovery.

Keep process metrics separate from system-wide and per-core CPU metrics so that dashboards can display both system utilization and individual application resource consumption.

## License

Specify the license for your project here before distributing it.

## Contributing

Contributions are welcome. Suggested improvements include:

- Process-tree tracking and worker aggregation.
- Process start-time detection and PID-reuse protection.
- Physical disk throughput and latency.
- Structured logging and configurable retention.
- Option to append to an existing output file instead of overwriting it.
- Integration with a time-series database.
- Alerting for CPU, memory, and I/O thresholds.
