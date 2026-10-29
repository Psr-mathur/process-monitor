Windows Process Statistics (stat.ps1)

A lightweight PowerShell-based process monitoring utility for Windows that collects CPU, memory, thread, handle, and process I/O statistics at configurable intervals.

Monitor specific processes by PID, discover processes by TCP listening port, or combine both approaches. Metrics are written to a CSV file for analysis, dashboards, and integration with win-mpstat.

Features
Monitor multiple Windows processes simultaneously.
Select processes by PID or TCP listening port.
Calculate process CPU utilization percentage.
Track cumulative CPU time.
Monitor physical working-set memory and private memory.
Record thread and handle counts.
Calculate process I/O read, write, and other transfer rates.
Configure the sampling interval.
Export metrics to CSV for historical analysis.
Rediscover processes listening on configured ports after application restarts.
Requirements
Windows 10, Windows 11, or Windows Server.
Windows PowerShell 5.1 or a compatible PowerShell version.
Permissions to query the target processes and their performance counters.
Administrator privileges may be required for some processes or server configurations.
Installation
Save the script as stat.ps1.
Open CMD or PowerShell.
Navigate to the directory containing the script.
Run the script with the desired arguments.

Example:

cmd
cd C:\Tools\win-mpstat
powershell -NoProfile -ExecutionPolicy Bypass -File .\stat.ps1 --pid=21332,54342

Usage
1. Monitor processes by PID
cmd
powershell -NoProfile -ExecutionPolicy Bypass -File .\stat.ps1 --pid=21332,54342,45634


The specified process IDs are monitored at the configured sampling interval.

2. Monitor processes by TCP port
cmd
powershell -NoProfile -ExecutionPolicy Bypass -File .\stat.ps1 --port=5000,1433


The script discovers the process IDs owning listening TCP sockets on the specified ports.

Example use cases:

Port 5000: an Express.js application.
Port 1433: a SQL Server instance using the default TCP port.

Important: Port numbers are examples. Confirm the actual listening ports on your server. If a reverse proxy owns a port, the discovered process may be the proxy rather than the application.

3. Monitor both PIDs and ports
cmd
powershell -NoProfile -ExecutionPolicy Bypass -File .\stat.ps1 --pid=21332,54342 --port=5000,1433


The script combines explicitly supplied PIDs with processes discovered through the configured listening ports and removes duplicate PIDs.

4. Configure the sampling interval

Use --interval to specify the interval in seconds.

cmd
powershell -NoProfile -ExecutionPolicy Bypass -File .\stat.ps1 --port=5000,1433 --interval=1


Example with a five-second interval:

cmd
powershell -NoProfile -ExecutionPolicy Bypass -File .\stat.ps1 --pid=21332 --interval=5


The interval is a target sampling delay, not a guaranteed exact sampling frequency. Actual timing depends on command execution and Windows scheduling.

5. Specify the output CSV file
cmd
powershell -NoProfile -ExecutionPolicy Bypass -File .\stat.ps1 --port=5000,1433 --out=stem-stats.csv


The default output file is:

text
process-log.csv


The output path is relative to the current working directory unless an absolute path is specified.

6. Stop monitoring

Press:

text
Ctrl+C


The script stops collecting samples.

Command-Line Arguments
Argument	Required	Description
--pid=PID1,PID2	One target option required	Comma-separated process IDs.
--port=PORT1,PORT2	One target option required	Comma-separated TCP listening ports.
--interval=SECONDS	No	Sampling interval in seconds. Default: 1.
--out=FILE	No	CSV output path. Default: process-log.csv.

At least one of --pid or --port must be supplied.

Arguments can be combined in one invocation.

Metrics Collected

Each CSV row represents one process sample.

Column	Unit	Description
Time	Local timestamp	Time when the sample was collected.
PID	Integer	Windows process identifier.
Process	Name	Executable process name.
CPU_Percent	Percentage	Process CPU utilization normalized to total logical CPU capacity.
CPUSeconds	Seconds	Cumulative CPU execution time consumed by the process.
RAM_MB	MB	Physical working-set memory.
Private_MB	MB	Private memory attributed to the process.
Threads	Count	Number of process threads.
Handles	Count	Number of open process handles.
IO_Read_BytesPerSec	Bytes/sec	Rate of process-attributed I/O read transfers.
IO_Write_BytesPerSec	Bytes/sec	Rate of process-attributed I/O write transfers.
IO_Other_BytesPerSec	Bytes/sec	Rate of other process-attributed I/O transfers.
CPU percentage calculation

The script calculates CPU utilization using the change in cumulative CPU time between consecutive samples:

text
CPU_Percent =
    (CPUSeconds_Current - CPUSeconds_Previous)
    / ElapsedSeconds
    / LogicalProcessorCount
    * 100


For example, on a machine with eight logical processors, a process consuming one full logical processor for one second reports approximately 12.5% of total machine capacity.

The first sample reports 0% because no previous sample is available.

This definition differs from tools that report one fully utilized logical processor as 100%.

Memory metrics
RAM_MB measures the process working set, which represents physical memory currently resident for that process.
Private_MB measures private memory attributed to the process.

These metrics represent different aspects of memory and should not be treated as interchangeable.

Process I/O metrics

The script derives I/O rates from differences in cumulative process I/O counters.

These are process-attributed I/O transfer rates, not guaranteed physical disk throughput. They may include cached or buffered operations and are not sufficient to calculate disk latency.

For physical disk throughput, queue length, and latency, collect Windows physical-disk performance counters separately.

Example Output
csv
Time,PID,Process,CPU_Percent,CPUSeconds,RAM_MB,Private_MB,Threads,Handles,IO_Read_BytesPerSec,IO_Write_BytesPerSec,IO_Other_BytesPerSec
2026-10-29 11:00:01.000,21332,node,12.50,45.62,185.25,142.10,24,512,2048,4096,0
2026-10-29 11:00:02.000,21332,node,18.75,45.77,185.80,142.50,25,516,8192,1024,0
2026-10-29 11:00:01.000,54342,sqlservr,25.00,120.50,2048.00,1850.00,145,2300,16384,32768,0


Note: The sample values above are illustrative and do not represent actual measurements. Rows from different processes are collected sequentially, so timestamps and effective sampling intervals may differ slightly.

Monitoring Express.js Applications

For multiple Express.js applications running on the same Windows server, use their listening ports to identify the relevant processes.

Example:

cmd
powershell -NoProfile -ExecutionPolicy Bypass -File .\stat.ps1 --port=5000 --interval=1 --out=stem-stats.csv


This monitors the process or processes discovered through port 5000.

If multiple applications use child processes, worker processes, or a reverse proxy, port ownership alone may not identify every process belonging to the application. Use a process-tree or application-specific discovery strategy when aggregating all workers.

This script measures operating-system process resources. It does not independently identify slow Express routes, request latency, event-loop delays, or individual SQL queries.

Monitoring SQL Server

Example:

cmd
powershell -NoProfile -ExecutionPolicy Bypass -File .\stat.ps1 --port=1433 --interval=1 --out=sqlserver-stats.csv


Confirm that SQL Server is actually listening on port 1433. Named instances and custom configurations may use other ports.

Process-level metrics help identify CPU and memory consumption, but query-level performance analysis requires SQL Server diagnostic facilities such as Dynamic Management Views, Extended Events, or Query Store.

Operational Considerations
Process restarts and PID reuse

Port-based discovery runs repeatedly and can discover a new PID after a restart. However, a robust production collector should associate samples with process start time as well as PID, reset CPU and I/O baselines when the process changes, and avoid treating a reused PID as the same process.

Sampling overhead

A one-second sampling interval is suitable for many monitoring scenarios, but the script invokes Windows management queries during collection. Monitor its own resource consumption when tracking many processes.

CSV growth

The script appends samples continuously, so the CSV file grows over time. For long-running deployments, consider log rotation, retention policies, or a time-series database.

Permissions

If a process cannot be queried, some metrics may be unavailable. Run the collector with appropriate permissions and review PowerShell errors when troubleshooting access issues.

Data interpretation
CPU and I/O rates require consecutive samples.
A process that exits between discovery and sampling may be skipped.
Process I/O is not equivalent to physical disk I/O.
Port discovery covers TCP listening sockets, not UDP endpoints or every process associated with an application.
Integration with win-mpstat

This script can serve as a prototype or supplementary collector for win-mpstat.

For production integration, consider implementing the collection loop directly in the existing agent using native Windows APIs:

GetProcessTimes for cumulative process CPU time.
GetProcessMemoryInfo for working-set and memory information.
GetProcessIoCounters for process I/O transfer counters.
Windows process APIs for threads and handles.
TCP connection tables or Windows networking APIs for port-to-process discovery.

Keep process metrics separate from system-wide and per-core CPU metrics so that dashboards can display both system utilization and individual application resource consumption.

License

Specify the license for your project here before distributing it.

Contributing

Contributions are welcome. Suggested improvements include:

Process-tree tracking and worker aggregation.
Process start-time detection and PID-reuse protection.
Physical disk throughput and latency.
Structured logging and configurable retention.
Integration with a time-series database.
Alerting for CPU, memory, and I/O thresholds.