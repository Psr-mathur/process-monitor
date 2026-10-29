# stat

A single-file Windows process monitor. `stat.exe` samples CPU, memory, threads, handles and I/O for the processes you choose, shows them on a **live web dashboard**, and can write a **self-contained HTML report** when you stop it, similar to k6's web dashboard and report.

- One `stat.exe` (about 300 KB). No installer, no runtime to install, no internet access needed.
- Pick processes by PID, by TCP listening port, or both.
- Live dashboard at `http://127.0.0.1:6565/` while it runs.
- Optional HTML report (`--out=report.html`) that opens offline in any browser and can be shared as one file.

## Requirements

- Windows 10 (1903 or later), Windows 11, or Windows Server 2022 or later. These include .NET Framework 4.8, which `stat.exe` uses. Older Windows Server versions work if .NET Framework 4.8 is installed.
- Administrator rights are optional but recommended: without them, processes owned by other users or running as services may be inaccessible.

## Quick start

```cmd
stat.exe --pid=21332,54342
```

Then open the dashboard URL it prints (`http://127.0.0.1:6565/`). Press `Ctrl+C` to stop.

To also produce a report:

```cmd
stat.exe --port=5000,1433 --out=report.html
```

## Usage

```text
stat.exe --pid=PID[,PID...] [--port=PORT[,PORT...]] [options]
```

| Argument | Default | Description |
|---|---|---|
| `--pid=PID,PID` | | Process IDs to monitor. Commas or spaces. |
| `--port=PORT,PORT` | | Monitor whatever process is listening on these TCP ports (IPv4 and IPv6). |
| `--interval=SECONDS` | `1` | Sampling interval. Decimals allowed, e.g. `0.5`. |
| `--ui-port=PORT` | `6565` | Port for the live dashboard. |
| `--ui-host=ADDRESS` | `127.0.0.1` | Address the dashboard binds to. Use `0.0.0.0` to allow other machines to connect. |
| `--out=FILE.html` | | Also write an HTML report. Saved every 30 seconds and when monitoring stops. |
| `--help` | | Show usage. |
| `--version` | | Show the version. |

At least one of `--pid` or `--port` is required. Values can be listed with spaces too: `--pid=21332 54342`.

Examples:

```cmd
:: An Express.js app on port 5000 and SQL Server on 1433, sampled twice a second
stat.exe --port=5000,1433 --interval=0.5

:: Specific PIDs, report written to a file
stat.exe --pid=21332,54342 --out=C:\perf\run-1.html

:: Dashboard on a different port, reachable from other machines
stat.exe --pid=21332 --ui-port=7000 --ui-host=0.0.0.0
```

Exit codes: `0` success, `1` bad arguments, `2` dashboard port or report file unavailable, `3` monitoring stopped unexpectedly.

## Live dashboard

The dashboard always runs while `stat.exe` is monitoring. It is styled like an engineering pad: traces drawn on millimetre graph paper, with a status lamp and an elapsed-time clock at the top. It shows:

- **CPU strip:** a wide chart where each process's trace ends in a pen labelled with its latest reading.
- **Processes table:** the key for every chart. Each row shows the process's ink colour and status lamp, CPU now, average, p95 and peak, working set, private memory and its change since the start, threads, handles and I/O totals. Untick a process to hide it from all charts.
- **Small charts:** working set and private memory, threads and handles, and I/O read, write and other.
- **Hover and zoom:** hover over any chart and every chart shows a crosshair and the values for all processes at that moment; drag across any chart to zoom all of them; double-click to reset.
- **Time range:** last 1, 5 or 15 minutes, or the whole run.
- **Logbook:** processes found, exited or inaccessible, and port listener changes. Warnings are marked in red.

Several browsers can watch at once. A browser opened late still gets the history collected so far.

The light theme is green engineering paper and the dark theme is blueprint blue. They follow the system setting; the **Theme** button overrides it.

## HTML report

With `--out=report.html`, `stat.exe` writes a single HTML file containing the whole run: run details, the processes table, all charts and the events list. It has no external dependencies, so it opens offline and can be emailed or attached to a ticket.

- The report is rewritten every 30 seconds and on `Ctrl+C`, `Ctrl+Break`, closing the console window, logoff or shutdown. Writes are atomic, so a crash leaves the last complete version.
- **Export CSV** in the report downloads the data in the report as CSV. When the run was long enough to be bucketed (see below), each row is a time bucket with average, min and max columns.
- The report file is overwritten if it already exists.

## Metrics

| Metric | Unit | Meaning |
|---|---|---|
| CPU | % | Share of **total machine capacity** (0-100). On 8 logical processors, one fully busy core is 12.5%. |
| Cores | logical cores | CPU expressed as cores' worth used (CPU% x cores / 100). Shown in tooltips and the table. |
| Working set | MB | Physical memory currently resident for the process. Goes up and down as Windows trims memory and as runtimes collect garbage. |
| Private memory | MB | Committed memory private to the process. Steadier than working set; a better signal of real growth or leaks. |
| Threads | count | Threads in the process. |
| Handles | count | Open kernel handles. Steady growth often indicates a leak. |
| I/O read / write / other | bytes/sec | Process-attributed I/O transfer rates. Includes cached, network and device I/O, so it is **not** the same as physical disk throughput. |

How values are calculated:

- CPU and I/O rates come from the change in each process's cumulative counters between two samples, divided by the time between the two reads.
- Each counter is timestamped at the moment it is read, using a monotonic clock, so a slow pass or a system clock change does not distort rates.
- Samples are scheduled against fixed deadlines, so time spent collecting does not make the sampling cadence drift. Windows sleep granularity (about 15 ms) still adds small jitter to individual samples.
- `stat.exe` raises itself to High priority so busy target processes are less likely to delay sampling.
- The first read of each process is only a baseline; its first point appears one interval later. Charts never show a made-up 0.
- CPU is capped at 100%, because Windows credits CPU time in clock-tick chunks and very short samples can overshoot slightly.

## Long runs and memory use

`stat.exe` keeps every sample for the most recent 15 minutes. Older samples are merged into time buckets that record the average, minimum and maximum, and buckets are widened as the run grows. Memory use and report size therefore stay roughly constant however long it runs.

The whole-run view and the report show at most about 2000 points per process. When a run is longer than that, each point is a bucket: the line is the average and the shaded band is the min-max range (toggle with **Show min-max range**). Tooltips show how many samples a point covers.

Summary figures in the cards and table (average, p95, max, totals) are calculated from every sample, not from the buckets.

## Process discovery

- **By PID:** the process is opened once and its handle held, so if it exits it is reported as exited, and a later process reusing the same PID is **not** mistaken for it.
- **By port:** listening sockets are re-read on every sample from the same table `netstat` uses. If the application restarts, its new PID is picked up automatically and shown as a separate row. If a reverse proxy owns the port, the proxy is what gets monitored.
- A process that cannot be opened (not running, access denied) is reported once in the events list and retried on later samples.

## Security

- By default the dashboard listens on `127.0.0.1` only, and rejects requests whose `Host` header isn't a loopback name. This stops other websites open in your browser from reading it.
- `--ui-host=0.0.0.0` exposes process names, PIDs, resource usage and the command line to anyone who can reach the port. There is no authentication; use it only on trusted networks.
- The dashboard is read-only: it accepts only `GET` requests and cannot control or change processes.
- The report contains the same information plus the full command line. Review it before sharing outside your team.

## Building from source

Requires the .NET SDK 8 or later (the build targets .NET Framework 4.8; the SDK downloads the reference assemblies automatically).

```cmd
cd src\stat
dotnet build -c Release
```

The executable is written to `src\stat\bin\Release\net48\stat.exe`. It is self-contained: the dashboard files and Chart.js are embedded in it.

Project layout:

| Path | Contents |
|---|---|
| `src/stat/Program.cs` | Entry point, startup, shutdown handling |
| `src/stat/Options.cs` | Command-line parsing |
| `src/stat/Collector.cs` | Sampling loop and rate calculations |
| `src/stat/Native.cs` | Win32 calls (process counters, TCP listener table) |
| `src/stat/Store.cs` | In-memory samples, buckets, summaries and JSON |
| `src/stat/WebServer.cs` | Dashboard HTTP server and live event stream |
| `src/stat/ReportWriter.cs` | HTML report writing |
| `src/stat/web/` | Dashboard page, styles, script and vendored Chart.js |

## Troubleshooting

| Symptom | Fix |
|---|---|
| `port 6565 is already in use` | Another program (or another `stat.exe`) is using the port. Use `--ui-port=7000`. |
| `Access denied to ... (PID n)` | Run `stat.exe` from an elevated (Administrator) prompt. |
| `Nothing is listening on TCP port n` | The application isn't listening yet, or listens on a different port. `stat.exe` keeps checking. |
| Dashboard not reachable from another machine | Start with `--ui-host=0.0.0.0` and allow the port through Windows Firewall. |
| SmartScreen warns about the exe | Expected for unsigned executables. Choose **More info > Run anyway**, or sign the binary. |

## Third-party software

The dashboard and reports include:

- [Chart.js](https://www.chartjs.org/) 4.4.7, (c) Chart.js Contributors, MIT licence. See `src/stat/web/vendor/LICENSE-chartjs.md`.
- The [B612](https://github.com/polarsys/b612) typeface, (c) The B612 Project Authors, SIL Open Font License 1.1. See `src/stat/web/vendor/fonts/LICENSE-B612.txt`.
