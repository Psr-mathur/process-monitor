using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Runtime.InteropServices;
using System.Threading;
using Microsoft.Win32.SafeHandles;

namespace Stat
{
    /// <summary>
    /// Samples the target processes on a fixed cadence.
    ///
    /// Accuracy notes (carried over from stat.ps1):
    ///  - Each counter is timestamped at the moment it is read, not at pass start,
    ///    so a slow pass does not inflate CPU% or I/O rates.
    ///  - The pass duration is subtracted from the sleep so the cadence stays steady.
    ///  - CPU% is % of total machine capacity (0-100); cores = logical cores' worth used.
    ///  - A process handle is held open per instance, so a PID cannot be silently
    ///    reused by another process while we are watching it.
    /// </summary>
    internal sealed class Collector
    {
        private sealed class Tracker
        {
            public int Pid;
            public SafeProcessHandle Handle;
            public ProcessSeries Series;
            public bool HasBaseline;
            public long PrevCpu100ns;
            public double PrevCpuSec;
            public readonly double[] PrevIo = new double[3];
            public double PrevIoSec;
        }

        private readonly Options _options;
        private readonly Store _store;
        private readonly int _cores = Environment.ProcessorCount;
        private readonly Stopwatch _clock = Stopwatch.StartNew();
        private readonly long _startUnixMs;
        private readonly Dictionary<int, Tracker> _trackers = new Dictionary<int, Tracker>();
        // Creation time of each explicitly requested PID, so a reused PID is not mistaken for it.
        private readonly Dictionary<int, long> _requestedIdentity = new Dictionary<int, long>();
        // Last reported status per target, so each change is reported once instead of every pass.
        private readonly Dictionary<string, string> _status = new Dictionary<string, string>();

        public Collector(Options options, Store store, long startUnixMs)
        {
            _options = options;
            _store = store;
            _startUnixMs = startUnixMs;
        }

        /// <summary>Wall-clock unix ms derived from a monotonic clock, so clock changes don't skew rates.</summary>
        private long NowMs => _startUnixMs + (long)_clock.Elapsed.TotalMilliseconds;
        private double NowSec => _clock.Elapsed.TotalSeconds;

        public void Run(CancellationToken stop)
        {
            try
            {
                // Passes are scheduled against fixed deadlines (start + k * interval), so time spent
                // collecting and the coarse Windows sleep granularity never accumulate as drift.
                double interval = _options.IntervalSeconds;
                double nextDue = NowSec;
                while (!stop.IsCancellationRequested)
                {
                    CollectOnce();
                    _store.PublishTick(NowMs);

                    nextDue += interval;
                    double wait = nextDue - NowSec;
                    if (wait < -interval) nextDue = NowSec; // fell well behind (e.g. machine suspended): resync
                    else if (wait > 0) stop.WaitHandle.WaitOne(TimeSpan.FromSeconds(wait));
                }
            }
            finally
            {
                foreach (var t in _trackers.Values) t.Handle.Dispose();
                _trackers.Clear();
            }
        }

        private void CollectOnce()
        {
            // --- Resolve targets: requested PIDs plus current listeners on requested ports ---
            var targets = new Dictionary<int, List<string>>();
            foreach (int pid in _options.Pids) AddSource(targets, pid, "pid");

            if (_options.Ports.Count > 0)
            {
                Dictionary<int, HashSet<int>> listeners = null;
                try { listeners = Native.GetTcpListeners(); }
                catch (Exception ex) { Report("tcp-table", "error", "warn", $"Could not read the TCP listener table: {ex.Message}"); }

                if (listeners != null)
                {
                    foreach (int port in _options.Ports)
                    {
                        if (listeners.TryGetValue(port, out var pids) && pids.Count > 0)
                        {
                            foreach (int pid in pids) AddSource(targets, pid, $"port {port}");
                            Report($"port:{port}", "pids:" + string.Join(",", pids.OrderBy(p => p)), "info",
                                $"Port {port} is owned by PID {string.Join(", ", pids.OrderBy(p => p))}.");
                        }
                        else
                        {
                            Report($"port:{port}", "none", "warn", $"Nothing is listening on TCP port {port}.");
                        }
                    }
                }
            }

            Dictionary<int, Native.ProcessEntry> snapshot;
            try { snapshot = Native.SnapshotProcesses(); }
            catch { snapshot = new Dictionary<int, Native.ProcessEntry>(); }

            // --- Stop tracking processes that are no longer targets (e.g. stopped listening) ---
            foreach (int pid in _trackers.Keys.Where(p => !targets.ContainsKey(p)).ToList())
            {
                var t = _trackers[pid];
                bool exited = HasExited(t.Handle);
                Close(t, exited ? "exited" : "not-listening",
                    exited ? $"{Label(t.Series)} exited." : $"{Label(t.Series)} is no longer listening on the monitored ports.");
            }

            // --- Sample each target, adding every sample of this pass into the Total ---
            var total = new Sample();
            int sampled = 0;
            foreach (var kv in targets)
            {
                int pid = kv.Key;
                string source = string.Join(", ", kv.Value);
                if (!_trackers.TryGetValue(pid, out var tracker))
                {
                    tracker = Open(pid, source, snapshot);
                    if (tracker == null) continue;
                }
                else if (HasExited(tracker.Handle))
                {
                    Close(tracker, "exited", $"{Label(tracker.Series)} exited.");
                    continue;
                }

                if (snapshot.TryGetValue(pid, out var entry))
                {
                    if (!string.IsNullOrEmpty(entry.Name)) tracker.Series.Name = entry.Name;
                }
                tracker.Series.Source = source;
                var sample = Sample(tracker, snapshot.TryGetValue(pid, out entry) ? entry.Threads : -1);
                if (sample == null) continue;
                for (int i = 0; i < M.Count; i++) total.V[i] += sample.V[i];
                sampled++;
            }

            if (sampled > 0)
            {
                total.T = NowMs;
                total.V[M.Cpu] = Math.Min(100.0, total.V[M.Cpu]);
                _store.AddSample(_store.Total, total);
            }
        }

        private static void AddSource(Dictionary<int, List<string>> targets, int pid, string source)
        {
            if (pid <= 0) return;
            if (!targets.TryGetValue(pid, out var list)) targets[pid] = list = new List<string>();
            if (!list.Contains(source)) list.Add(source);
        }

        private Tracker Open(int pid, string source, Dictionary<int, Native.ProcessEntry> snapshot)
        {
            string name = snapshot.TryGetValue(pid, out var entry) && !string.IsNullOrEmpty(entry.Name) ? entry.Name : null;
            string who = name != null ? $"{name} (PID {pid})" : $"PID {pid}";

            var handle = Native.OpenProcess(Native.PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
            if (handle.IsInvalid)
            {
                int error = Marshal.GetLastWin32Error();
                handle.Dispose();
                if (error == 5)
                    Report($"pid:{pid}", "denied", "warn", $"Access denied to {who}. Run stat.exe as Administrator to monitor it.");
                else if (error == 87)
                {
                    // Already reported as exited; "not running" would just repeat it.
                    if (_status.TryGetValue($"pid:{pid}", out string last) && last == "exited") _status[$"pid:{pid}"] = "missing";
                    else Report($"pid:{pid}", "missing", "warn", $"PID {pid} is not running.");
                }
                else
                    Report($"pid:{pid}", "error:" + error, "warn", $"Cannot open {who} (Windows error {error}).");
                return null;
            }

            if (!Native.GetProcessTimes(handle, out long creation, out long exitTime, out _, out _) || exitTime != 0)
            {
                handle.Dispose();
                Report($"pid:{pid}", "times", "warn", $"Cannot read process times for {who}.");
                return null;
            }

            if (_options.Pids.Contains(pid))
            {
                if (_requestedIdentity.TryGetValue(pid, out long known) && known != creation)
                {
                    handle.Dispose();
                    Report($"pid:{pid}", "reused", "warn",
                        $"PID {pid} now belongs to a different process ({name ?? "unknown"}); not monitoring it.");
                    return null;
                }
                _requestedIdentity[pid] = creation;
            }

            long startedAt = DateTime.FromFileTimeUtc(creation).Subtract(new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).Ticks
                             / TimeSpan.TicksPerMillisecond;
            var series = _store.GetOrAddSeries($"{pid}-{creation}", () => new ProcessSeries
            {
                Pid = pid,
                Name = name ?? $"PID {pid}",
                Source = source,
                StartedAt = startedAt,
            });
            string label = _store.LabelFor(pid, source);
            _store.Update(() =>
            {
                series.Status = "running";
                series.EndedAt = null;
                if (series.Label == null) series.Label = label;
            });

            var tracker = new Tracker { Pid = pid, Handle = handle, Series = series };
            _trackers[pid] = tracker;
            who = Label(series);
            Report($"pid:{pid}", "monitoring:" + creation, "info", $"Monitoring {who} via {source}.");
            return tracker;
        }

        private void Close(Tracker t, string status, string message)
        {
            t.Handle.Dispose();
            _trackers.Remove(t.Pid);
            long now = NowMs;
            _store.Update(() => { t.Series.Status = status; t.Series.EndedAt = now; });
            Report($"pid:{t.Pid}", status, status == "exited" ? "warn" : "info", message);
        }

        /// <summary>Reads one sample into the store. Returns null for the first (baseline) read or when the process is gone.</summary>
        private Sample Sample(Tracker t, int threads)
        {
            // --- CPU: read, then timestamp immediately ---
            if (!Native.GetProcessTimes(t.Handle, out _, out long exitTime, out long kernel, out long user) || exitTime != 0)
            {
                if (exitTime != 0) { Close(t, "exited", $"{Label(t.Series)} exited."); return null; }
                Close(t, "unavailable", $"Lost access to {Label(t.Series)}.");
                return null;
            }
            double cpuSec = NowSec;
            long sampleTime = NowMs;
            long cpu100ns = kernel + user;

            var mem = new Native.PROCESS_MEMORY_COUNTERS_EX { cb = (uint)Marshal.SizeOf(typeof(Native.PROCESS_MEMORY_COUNTERS_EX)) };
            bool memOk = Native.GetProcessMemoryInfo(t.Handle, out mem, mem.cb);
            bool handlesOk = Native.GetProcessHandleCount(t.Handle, out uint handles);

            // --- I/O: read, then timestamp immediately ---
            bool ioOk = Native.GetProcessIoCounters(t.Handle, out var io);
            double ioSec = NowSec;

            if (!memOk || !ioOk)
            {
                Close(t, "unavailable", $"Lost access to {Label(t.Series)}.");
                return null;
            }

            double readBytes = io.ReadTransferCount, writeBytes = io.WriteTransferCount, otherBytes = io.OtherTransferCount;
            double[] ioNow = { readBytes, writeBytes, otherBytes };

            if (!t.HasBaseline)
            {
                // First read is the baseline for rates; it produces no sample (avoids a fake 0% point).
                t.HasBaseline = true;
                t.PrevCpu100ns = cpu100ns; t.PrevCpuSec = cpuSec;
                Array.Copy(ioNow, t.PrevIo, 3); t.PrevIoSec = ioSec;
                _store.Update(() =>
                {
                    if (t.Series.IoBaseline == null) t.Series.IoBaseline = (double[])ioNow.Clone();
                    t.Series.IoLatest = ioNow;
                });
                return null;
            }

            var s = new Sample { T = sampleTime };
            double cpuDt = cpuSec - t.PrevCpuSec;
            if (cpuDt > 0 && cpu100ns >= t.PrevCpu100ns)
            {
                double coresUsed = (cpu100ns - t.PrevCpu100ns) / 1e7 / cpuDt;
                double pct = 100.0 * coresUsed / _cores;
                // Windows credits CPU time in clock-tick chunks; tiny windows can overshoot slightly.
                s.V[M.Cpu] = Math.Min(100.0, pct);
            }

            double ioDt = ioSec - t.PrevIoSec;
            if (ioDt > 0)
            {
                s.V[M.IoRead] = Math.Max(0, (readBytes - t.PrevIo[0]) / ioDt);
                s.V[M.IoWrite] = Math.Max(0, (writeBytes - t.PrevIo[1]) / ioDt);
                s.V[M.IoOther] = Math.Max(0, (otherBytes - t.PrevIo[2]) / ioDt);
            }

            s.V[M.WorkingSet] = mem.WorkingSetSize.ToUInt64() / 1048576.0;
            s.V[M.Private] = mem.PrivateUsage.ToUInt64() / 1048576.0;
            // Fall back to the last known value rather than inventing a 0.
            s.V[M.Threads] = threads >= 0 ? threads : t.Series.ThreadsLast;
            s.V[M.Handles] = handlesOk ? handles : t.Series.HandlesLast;

            t.PrevCpu100ns = cpu100ns; t.PrevCpuSec = cpuSec;
            Array.Copy(ioNow, t.PrevIo, 3); t.PrevIoSec = ioSec;

            _store.Update(() => t.Series.IoLatest = ioNow);
            _store.AddSample(t.Series, s);
            return s;
        }

        /// <summary>Records an event only when a target's status changes.</summary>
        private void Report(string target, string status, string level, string message)
        {
            if (_status.TryGetValue(target, out string previous) && previous == status) return;
            _status[target] = status;
            _store.AddEvent(NowMs, level, message);
        }

        /// <summary>A process that has exited reports a non-zero exit time.</summary>
        private static bool HasExited(SafeProcessHandle handle) =>
            Native.GetProcessTimes(handle, out _, out long exitTime, out _, out _) && exitTime != 0;

        private static string Label(ProcessSeries s) => $"{s.DisplayName} (PID {s.Pid})";
    }
}
