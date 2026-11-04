using System;
using System.Collections.Generic;
using System.Linq;

namespace Stat
{
    /// <summary>Metric slots, in the order they are stored and sent to the browser.</summary>
    internal static class M
    {
        public const int Cpu = 0;       // % of total machine capacity
        public const int WorkingSet = 1; // MB
        public const int Private = 2;   // MB
        public const int Threads = 3;
        public const int Handles = 4;
        public const int IoRead = 5;    // bytes/sec
        public const int IoWrite = 6;   // bytes/sec
        public const int IoOther = 7;   // bytes/sec
        public const int Count = 8;
    }

    internal sealed class Sample
    {
        public long T;                          // unix ms
        public readonly double[] V = new double[M.Count];
    }

    /// <summary>Aggregate of all samples whose time falls in [T, T + width).</summary>
    internal sealed class Bucket
    {
        public long T;
        public int N;
        public readonly double[] Sum = new double[M.Count];
        public readonly double[] Min = new double[M.Count];
        public readonly double[] Max = new double[M.Count];

        public static Bucket From(Sample s, long t)
        {
            var b = new Bucket { T = t, N = 1 };
            for (int i = 0; i < M.Count; i++) b.Sum[i] = b.Min[i] = b.Max[i] = s.V[i];
            return b;
        }

        public Bucket Clone(long t)
        {
            var b = new Bucket { T = t, N = N };
            Array.Copy(Sum, b.Sum, M.Count);
            Array.Copy(Min, b.Min, M.Count);
            Array.Copy(Max, b.Max, M.Count);
            return b;
        }

        public void Add(Sample s)
        {
            N++;
            for (int i = 0; i < M.Count; i++)
            {
                Sum[i] += s.V[i];
                if (s.V[i] < Min[i]) Min[i] = s.V[i];
                if (s.V[i] > Max[i]) Max[i] = s.V[i];
            }
        }

        public void Add(Bucket o)
        {
            N += o.N;
            for (int i = 0; i < M.Count; i++)
            {
                Sum[i] += o.Sum[i];
                if (o.Min[i] < Min[i]) Min[i] = o.Min[i];
                if (o.Max[i] > Max[i]) Max[i] = o.Max[i];
            }
        }
    }

    internal sealed class StatEvent
    {
        public long T;
        public string Level; // "info" or "warn"
        public string Message;
    }

    /// <summary>One process instance (PID + creation time), its samples and running summary.</summary>
    internal sealed class ProcessSeries
    {
        public string Key;
        public int Pid;
        public string Name;
        public string Source;
        public long StartedAt;    // process creation time, unix ms
        public long FirstSample;
        public long LastSample;
        public long? EndedAt;
        public string Status = "running"; // running | exited | not-listening | unavailable
        public int Color;          // categorical slot, fixed for the life of the run; -2 = the Total series
        public string Label;       // user text shown after the name, e.g. "be" in "node:be"

        public string DisplayName => string.IsNullOrEmpty(Label) ? Name : Name + ":" + Label;

        // Full-resolution samples for the recent window, oldest first.
        public readonly List<Sample> Recent = new List<Sample>();
        // Older samples folded into buckets of ArchiveWidthMs.
        public readonly List<Bucket> Archive = new List<Bucket>();
        public long ArchiveWidthMs;

        // Running summary over every sample.
        public int N;
        public double CpuSum, CpuMax;
        public readonly int[] CpuHistogram = new int[1001]; // 0.1% resolution for p95
        public double WsFirst = double.NaN, WsLast, WsMax;
        public double PrivFirst = double.NaN, PrivLast, PrivMax;
        public double ThreadsLast, ThreadsMax, HandlesLast, HandlesMax;
        public double IoReadMax, IoWriteMax;
        // Cumulative I/O counters at the first and latest read, for run totals.
        public double[] IoBaseline;
        public double[] IoLatest;

        public double CpuP95
        {
            get
            {
                if (N == 0) return 0;
                int threshold = (int)Math.Ceiling(N * 0.95), seen = 0;
                for (int i = 0; i < CpuHistogram.Length; i++)
                {
                    seen += CpuHistogram[i];
                    if (seen >= threshold) return i / 10.0;
                }
                return 100;
            }
        }
    }

    internal sealed class RunInfo
    {
        public string Host, Os, Version, CommandLine;
        public string Product = Brand.Product, Author = Brand.Author, RepoUrl = Brand.RepoUrl;
        public int Cores;
        public bool Admin;
        public double IntervalSeconds;
        public List<int> Pids, Ports;
        public long StartedAt;
        public long? EndedAt;
        public int UtcOffsetMinutes;
        public string Dashboard;
        public string ReportPath;
    }

    /// <summary>Thread-safe in-memory store shared by the collector, web server and report writer.</summary>
    internal sealed class Store
    {
        public const long RecentWindowMs = 15 * 60 * 1000;
        public const int MaxArchiveBuckets = 2000;
        public const int MaxSeriesPoints = 2000;
        private const int MaxEvents = 1000;
        private const int PaletteSize = 8;
        public const string TotalKey = "total";
        public const int MaxLabelLength = 32;

        private readonly object _lock = new object();
        private readonly Dictionary<string, ProcessSeries> _series = new Dictionary<string, ProcessSeries>();
        private readonly List<ProcessSeries> _order = new List<ProcessSeries>();
        private readonly List<StatEvent> _events = new List<StatEvent>();
        private int _eventsDropped;
        // Labels by target ("port:4000" or "pid:21332"), so a process that restarts on the same port keeps its label.
        private readonly Dictionary<string, string> _labels = new Dictionary<string, string>();

        public RunInfo Run { get; }

        /// <summary>Sum of every monitored process, one sample per collection pass. Not part of _order.</summary>
        public ProcessSeries Total { get; }

        /// <summary>Raised (outside the lock) with a JSON tick after each collection pass.</summary>
        public event Action<string> Tick;
        /// <summary>Raised for every event so the console can echo it.</summary>
        public event Action<StatEvent> EventAdded;

        public Store(RunInfo run)
        {
            Run = run;
            Total = new ProcessSeries
            {
                Key = TotalKey, Name = "Total", Source = "", Color = -2, StartedAt = run.StartedAt,
                ArchiveWidthMs = Math.Max(1000, (long)Math.Ceiling(run.IntervalSeconds * 1000)),
            };
        }

        // ---- labels ---------------------------------------------------------------

        /// <summary>Targets a process was found through: "pid:N" and/or "port:N".</summary>
        private static IEnumerable<string> Targets(int pid, string source)
        {
            foreach (string part in (source ?? "").Split(new[] { ", " }, StringSplitOptions.RemoveEmptyEntries))
            {
                if (part == "pid") yield return "pid:" + pid;
                else if (part.StartsWith("port ", StringComparison.Ordinal)) yield return "port:" + part.Substring(5);
            }
        }

        /// <summary>Trims a label to something safe to show: one line, no leading colon, at most <see cref="MaxLabelLength"/> characters.</summary>
        public static string CleanLabel(string label)
        {
            if (label == null) return null;
            var sb = new System.Text.StringBuilder(label.Length);
            foreach (char c in label) sb.Append(char.IsControl(c) || char.IsWhiteSpace(c) ? ' ' : c);
            string s = System.Text.RegularExpressions.Regex.Replace(sb.ToString(), " {2,}", " ").Trim().TrimStart(':').Trim();
            if (s.Length > MaxLabelLength) s = s.Substring(0, MaxLabelLength).TrimEnd();
            return s.Length == 0 ? null : s;
        }

        /// <summary>Sets a label from the command line, before monitoring starts.</summary>
        public void SetTargetLabel(string target, string label)
        {
            lock (_lock) _labels[target] = CleanLabel(label);
        }

        /// <summary>The label for a newly found process: its ports first, then its PID.</summary>
        public string LabelFor(int pid, string source)
        {
            lock (_lock)
            {
                foreach (string t in Targets(pid, source).OrderBy(t => t.StartsWith("pid:", StringComparison.Ordinal) ? 1 : 0))
                    if (_labels.TryGetValue(t, out string label) && label != null) return label;
                return null;
            }
        }

        /// <summary>Labels a process from the dashboard. Returns false if <paramref name="key"/> is not a known process.</summary>
        public bool SetLabel(string key, string label, long now, out string applied)
        {
            applied = CleanLabel(label);
            string message;
            lock (_lock)
            {
                if (!_series.TryGetValue(key, out var s)) return false;
                // Also remembered for the process's port or PID, so a restart on the same port keeps it.
                foreach (string t in Targets(s.Pid, s.Source)) _labels[t] = applied;
                if (s.Label == applied) return true;
                string before = s.DisplayName;
                s.Label = applied;
                message = applied == null
                    ? $"Removed the label from {before} (PID {s.Pid})."
                    : $"Labelled {before} (PID {s.Pid}) as {s.DisplayName}.";
            }
            AddEvent(now, "info", message);
            return true;
        }

        public ProcessSeries GetOrAddSeries(string key, Func<ProcessSeries> create)
        {
            lock (_lock)
            {
                if (_series.TryGetValue(key, out var s)) return s;
                s = create();
                s.Key = key;
                s.Color = _order.Count < PaletteSize ? _order.Count : -1; // -1 = neutral, past the palette
                s.ArchiveWidthMs = Math.Max(1000, (long)Math.Ceiling(Run.IntervalSeconds * 1000));
                _series[key] = s;
                _order.Add(s);
                return s;
            }
        }

        public void Update(Action action)
        {
            lock (_lock) action();
        }

        public void AddEvent(long t, string level, string message)
        {
            var e = new StatEvent { T = t, Level = level, Message = message };
            lock (_lock)
            {
                _events.Add(e);
                if (_events.Count > MaxEvents) { _events.RemoveAt(0); _eventsDropped++; }
                _pendingEvents.Add(e);
            }
            EventAdded?.Invoke(e);
        }

        private readonly List<StatEvent> _pendingEvents = new List<StatEvent>();
        private readonly List<KeyValuePair<ProcessSeries, Sample>> _pendingSamples = new List<KeyValuePair<ProcessSeries, Sample>>();

        public void AddSample(ProcessSeries s, Sample sample)
        {
            lock (_lock)
            {
                if (s.N == 0) s.FirstSample = sample.T;
                s.LastSample = sample.T;
                s.Recent.Add(sample);
                Summarize(s, sample);
                ArchiveOld(s, sample.T - RecentWindowMs);
                _pendingSamples.Add(new KeyValuePair<ProcessSeries, Sample>(s, sample));
            }
        }

        /// <summary>Publishes everything added since the last call as one tick for live clients.</summary>
        public void PublishTick(long now)
        {
            string json;
            lock (_lock)
            {
                var j = new Json(2048);
                j.BeginObject().Prop("t", now).Prop("endedAt", Run.EndedAt);
                j.Name("samples").BeginArray();
                foreach (var kv in _pendingSamples)
                {
                    j.BeginObject().Prop("k", kv.Key.Key).Name("p");
                    WriteRaw(j, kv.Value);
                    j.EndObject();
                }
                j.EndArray();
                j.Name("processes"); WriteProcesses(j);
                j.Name("events"); WriteEvents(j, _pendingEvents);
                j.EndObject();
                _pendingSamples.Clear();
                _pendingEvents.Clear();
                json = j.ToString();
            }
            Tick?.Invoke(json);
        }

        private static void Summarize(ProcessSeries s, Sample x)
        {
            double[] v = x.V;
            s.N++;
            s.CpuSum += v[M.Cpu];
            if (v[M.Cpu] > s.CpuMax) s.CpuMax = v[M.Cpu];
            s.CpuHistogram[Math.Max(0, Math.Min(1000, (int)Math.Round(v[M.Cpu] * 10)))]++;
            if (double.IsNaN(s.WsFirst)) s.WsFirst = v[M.WorkingSet];
            s.WsLast = v[M.WorkingSet];
            if (v[M.WorkingSet] > s.WsMax) s.WsMax = v[M.WorkingSet];
            if (double.IsNaN(s.PrivFirst)) s.PrivFirst = v[M.Private];
            s.PrivLast = v[M.Private];
            if (v[M.Private] > s.PrivMax) s.PrivMax = v[M.Private];
            s.ThreadsLast = v[M.Threads];
            if (v[M.Threads] > s.ThreadsMax) s.ThreadsMax = v[M.Threads];
            s.HandlesLast = v[M.Handles];
            if (v[M.Handles] > s.HandlesMax) s.HandlesMax = v[M.Handles];
            if (v[M.IoRead] > s.IoReadMax) s.IoReadMax = v[M.IoRead];
            if (v[M.IoWrite] > s.IoWriteMax) s.IoWriteMax = v[M.IoWrite];
        }

        /// <summary>Moves samples older than <paramref name="cutoff"/> into the archive, coarsening it when it grows too long.</summary>
        private static void ArchiveOld(ProcessSeries s, long cutoff)
        {
            int move = 0;
            while (move < s.Recent.Count && s.Recent[move].T < cutoff) move++;
            if (move == 0) return;

            for (int i = 0; i < move; i++)
            {
                Sample x = s.Recent[i];
                long t = Floor(x.T, s.ArchiveWidthMs);
                Bucket last = s.Archive.Count > 0 ? s.Archive[s.Archive.Count - 1] : null;
                if (last != null && last.T == t) last.Add(x);
                else s.Archive.Add(Bucket.From(x, t));
            }
            s.Recent.RemoveRange(0, move);

            while (s.Archive.Count > MaxArchiveBuckets)
            {
                s.ArchiveWidthMs *= 2;
                var merged = Rebucket(s.Archive, s.ArchiveWidthMs);
                s.Archive.Clear();
                s.Archive.AddRange(merged);
            }
        }

        private static long Floor(long t, long width) => t - (((t % width) + width) % width);

        private static List<Bucket> Rebucket(IEnumerable<Bucket> source, long width)
        {
            var result = new List<Bucket>();
            foreach (var b in source)
            {
                long t = Floor(b.T, width);
                var last = result.Count > 0 ? result[result.Count - 1] : null;
                if (last != null && last.T == t) last.Add(b);
                else result.Add(b.Clone(t));
            }
            return result;
        }

        /// <summary>
        /// Points for the whole run: raw samples when they fit in <see cref="MaxSeriesPoints"/>,
        /// otherwise buckets wide enough to fit. Returns the bucket width (0 = raw).
        /// </summary>
        private long SeriesPoints(ProcessSeries s, out List<Bucket> buckets)
        {
            buckets = null;
            if (s.Archive.Count == 0 && s.Recent.Count <= MaxSeriesPoints) return 0;

            long first = s.Archive.Count > 0 ? s.Archive[0].T : s.Recent[0].T;
            long last = s.Recent.Count > 0 ? s.Recent[s.Recent.Count - 1].T : s.Archive[s.Archive.Count - 1].T;
            long width = s.ArchiveWidthMs;
            while ((last - first) / width >= MaxSeriesPoints) width *= 2;

            buckets = Rebucket(s.Archive, width);
            foreach (var x in s.Recent)
            {
                long t = Floor(x.T, width);
                var tail = buckets.Count > 0 ? buckets[buckets.Count - 1] : null;
                if (tail != null && tail.T == t) tail.Add(x);
                else buckets.Add(Bucket.From(x, t));
            }
            return width;
        }

        // ---- JSON ----------------------------------------------------------------

        /// <summary>Initial state for a newly connected dashboard: run info, processes, events, recent raw samples.</summary>
        /// <summary>Every series written to the browser: the processes, then the Total.</summary>
        private IEnumerable<ProcessSeries> AllSeries() => _order.Concat(new[] { Total });

        public string StateJson()
        {
            lock (_lock)
            {
                var j = new Json(64 * 1024);
                j.BeginObject();
                j.Prop("mode", "live");
                j.Prop("now", (long)(DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds);
                j.Name("run"); WriteRun(j);
                j.Name("processes"); WriteProcesses(j);
                j.Name("events"); WriteEvents(j, _events);
                j.Name("recent").BeginObject();
                foreach (var s in AllSeries())
                {
                    j.Name(s.Key).BeginArray();
                    foreach (var x in s.Recent) WriteRaw(j, x);
                    j.EndArray();
                }
                j.EndObject();
                j.EndObject();
                return j.ToString();
            }
        }

        /// <summary>Whole-run series, downsampled to at most <see cref="MaxSeriesPoints"/> points each.</summary>
        public string SeriesJson()
        {
            lock (_lock)
            {
                var j = new Json(64 * 1024);
                j.BeginObject();
                WriteSeries(j);
                j.EndObject();
                return j.ToString();
            }
        }

        /// <summary>Everything the static HTML report needs.</summary>
        public string ReportJson(long generatedAt)
        {
            lock (_lock)
            {
                var j = new Json(256 * 1024);
                j.BeginObject();
                j.Prop("mode", "report");
                j.Prop("generatedAt", generatedAt);
                j.Name("run"); WriteRun(j);
                j.Name("processes"); WriteProcesses(j);
                j.Name("events"); WriteEvents(j, _events);
                j.Prop("eventsDropped", _eventsDropped);
                WriteSeries(j);
                j.EndObject();
                return j.ToString();
            }
        }

        private void WriteSeries(Json j)
        {
            j.Name("series").BeginObject();
            foreach (var s in AllSeries())
            {
                long width = SeriesPoints(s, out var buckets);
                j.Name(s.Key).BeginObject().Prop("width", width).Name("points").BeginArray();
                if (buckets == null) foreach (var x in s.Recent) WriteRaw(j, x);
                else foreach (var b in buckets) WriteBucket(j, b);
                j.EndArray().EndObject();
            }
            j.EndObject();
        }

        // Raw point:    [t, cpu, ws, priv, threads, handles, ioR, ioW, ioO]
        private static void WriteRaw(Json j, Sample x)
        {
            j.BeginArray().Value(x.T);
            for (int i = 0; i < M.Count; i++) j.Value(x.V[i], Decimals(i));
            j.EndArray();
        }

        // Bucket point: [t, n, avg x8, min x8, max x8]
        private static void WriteBucket(Json j, Bucket b)
        {
            j.BeginArray().Value(b.T).Value(b.N);
            for (int i = 0; i < M.Count; i++) j.Value(b.Sum[i] / b.N, Decimals(i));
            for (int i = 0; i < M.Count; i++) j.Value(b.Min[i], Decimals(i));
            for (int i = 0; i < M.Count; i++) j.Value(b.Max[i], Decimals(i));
            j.EndArray();
        }

        private static int Decimals(int metric) =>
            metric == M.Cpu ? 2 : metric == M.WorkingSet || metric == M.Private ? 2 : metric >= M.IoRead ? 0 : 1;

        private void WriteRun(Json j)
        {
            var r = Run;
            j.BeginObject()
                .Prop("host", r.Host).Prop("os", r.Os).Prop("version", r.Version)
                .Prop("commandLine", r.CommandLine).Prop("cores", r.Cores).Prop("admin", r.Admin)
                .Prop("interval", r.IntervalSeconds, 3)
                .Prop("startedAt", r.StartedAt).Prop("endedAt", r.EndedAt)
                .Prop("utcOffsetMinutes", r.UtcOffsetMinutes)
                .Prop("dashboard", r.Dashboard)
                .Prop("product", r.Product).Prop("author", r.Author).Prop("repo", r.RepoUrl);
            j.Name("pids").BeginArray(); foreach (int p in r.Pids) j.Value(p); j.EndArray();
            j.Name("ports").BeginArray(); foreach (int p in r.Ports) j.Value(p); j.EndArray();
            j.EndObject();
        }

        private void WriteProcesses(Json j)
        {
            j.BeginArray();
            foreach (var s in AllSeries())
            {
                bool total = s == Total;
                string status = !total ? s.Status : _order.Any(x => x.Status == "running") ? "running" : "stopped";
                j.BeginObject()
                    .Prop("k", s.Key).Prop("pid", s.Pid).Prop("name", s.Name).Prop("label", s.Label).Prop("source", s.Source)
                    .Prop("color", s.Color).Prop("status", status).Prop("total", total)
                    .Prop("startedAt", s.StartedAt).Prop("firstSample", s.N > 0 ? s.FirstSample : (long?)null)
                    .Prop("lastSample", s.N > 0 ? s.LastSample : (long?)null).Prop("endedAt", s.EndedAt)
                    .Prop("n", s.N);
                if (s.N > 0)
                {
                    j.Prop("cpuAvg", s.CpuSum / s.N, 2).Prop("cpuP95", s.CpuP95, 1).Prop("cpuMax", s.CpuMax, 2)
                     .Prop("wsFirst", s.WsFirst, 2).Prop("wsLast", s.WsLast, 2).Prop("wsMax", s.WsMax, 2)
                     .Prop("privFirst", s.PrivFirst, 2).Prop("privLast", s.PrivLast, 2).Prop("privMax", s.PrivMax, 2)
                     .Prop("threadsLast", s.ThreadsLast, 0).Prop("threadsMax", s.ThreadsMax, 0)
                     .Prop("handlesLast", s.HandlesLast, 0).Prop("handlesMax", s.HandlesMax, 0)
                     .Prop("ioReadMax", s.IoReadMax, 0).Prop("ioWriteMax", s.IoWriteMax, 0);
                }
                var io = total ? IoTotals(_order) : IoTotals(new[] { s });
                if (io != null)
                    j.Prop("ioReadTotal", io[0], 0).Prop("ioWriteTotal", io[1], 0).Prop("ioOtherTotal", io[2], 0);
                j.EndObject();
            }
            j.EndArray();
        }

        /// <summary>Bytes read, written and other over the run, summed over <paramref name="list"/>; null if none has counters yet.</summary>
        private static double[] IoTotals(IEnumerable<ProcessSeries> list)
        {
            double[] sum = null;
            foreach (var s in list)
            {
                if (s.IoBaseline == null || s.IoLatest == null) continue;
                if (sum == null) sum = new double[3];
                for (int i = 0; i < 3; i++) sum[i] += Math.Max(0, s.IoLatest[i] - s.IoBaseline[i]);
            }
            return sum;
        }

        private static void WriteEvents(Json j, IEnumerable<StatEvent> events)
        {
            j.BeginArray();
            foreach (var e in events)
                j.BeginObject().Prop("t", e.T).Prop("level", e.Level).Prop("msg", e.Message).EndObject();
            j.EndArray();
        }

        public int SeriesCount { get { lock (_lock) return _order.Count; } }
    }
}
