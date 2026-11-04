using System;
using System.Diagnostics;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Security.Principal;
using System.Text;
using System.Threading;

namespace Stat
{
    internal static class Program
    {
        private static readonly CancellationTokenSource Stop = new CancellationTokenSource();
        private static readonly ManualResetEventSlim Finished = new ManualResetEventSlim(false);
        // Held in a static field so the GC never collects the delegate Windows calls back into.
        private static Native.ConsoleCtrlHandler _ctrlHandler;

        private static int Main(string[] args)
        {
            try { Console.OutputEncoding = Encoding.UTF8; } catch { }
            string version = Assembly.GetExecutingAssembly().GetName().Version.ToString(3);

            Options options;
            try
            {
                options = Options.Parse(args);
            }
            catch (ArgumentException ex)
            {
                Console.Error.WriteLine("Error: " + ex.Message);
                Console.Error.WriteLine($"Run '{Brand.Exe} --help' for usage.");
                return 1;
            }

            if (options.ShowVersion)
            {
                Console.WriteLine($"{Brand.Product} {version}");
                Console.WriteLine($"Built by {Brand.Author} - {Brand.RepoUrl}");
                return 0;
            }
            if (options.ShowHelp || (options.Pids.Count == 0 && options.Ports.Count == 0))
            {
                Console.WriteLine(Options.Usage);
                return options.ShowHelp ? 0 : 1;
            }

            bool admin = IsAdministrator();
            // Run the monitor at High priority so a busy target can't starve it.
            bool priorityRaised = true;
            try { Process.GetCurrentProcess().PriorityClass = ProcessPriorityClass.High; }
            catch { priorityRaised = false; }

            long startUnixMs = (long)(DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds;
            string hostForUrl = options.UiHost.Equals(IPAddress.Any) || options.UiHost.Equals(IPAddress.IPv6Any)
                ? "localhost"
                : options.UiHost.AddressFamily == AddressFamily.InterNetworkV6 ? $"[{options.UiHost}]" : options.UiHost.ToString();
            string dashboard = $"http://{hostForUrl}:{options.UiPort}/";

            var run = new RunInfo
            {
                Host = Environment.MachineName,
                Os = WindowsVersion(),
                Version = version,
                CommandLine = Brand.Exe + " " + string.Join(" ", args),
                Cores = Environment.ProcessorCount,
                Admin = admin,
                IntervalSeconds = options.IntervalSeconds,
                Pids = options.Pids.ToList(),
                Ports = options.Ports.ToList(),
                StartedAt = startUnixMs,
                UtcOffsetMinutes = (int)TimeZoneInfo.Local.GetUtcOffset(DateTime.Now).TotalMinutes,
                Dashboard = dashboard,
                ReportPath = options.OutFile,
            };
            var store = new Store(run);
            foreach (var label in options.Labels) store.SetTargetLabel(label.Key, label.Value);
            store.EventAdded += e =>
                Console.WriteLine($"[{DateTime.Now:HH:mm:ss}] {(e.Level == "warn" ? "! " : "")}{e.Message}");

            var server = new WebServer(store, options.UiHost, options.UiPort);
            try
            {
                server.Start();
            }
            catch (SocketException ex)
            {
                Console.Error.WriteLine(ex.SocketErrorCode == SocketError.AddressAlreadyInUse || ex.SocketErrorCode == SocketError.AccessDenied
                    ? $"Error: port {options.UiPort} is already in use. Pick another with --ui-port=PORT."
                    : $"Error: cannot start the dashboard on {options.UiHost}:{options.UiPort}: {ex.Message}");
                return 2;
            }

            ReportWriter report = null;
            if (options.OutFile != null)
            {
                report = new ReportWriter(store, options.OutFile);
                try
                {
                    report.Write(); // fail fast if the path isn't writable
                }
                catch (Exception ex)
                {
                    server.Stop();
                    Console.Error.WriteLine($"Error: cannot write report to {options.OutFile}: {ex.Message}");
                    return 2;
                }
                report.Start();
            }

            _ctrlHandler = OnConsoleCtrl;
            Native.SetConsoleCtrlHandler(_ctrlHandler, true);

            Console.WriteLine($"{Brand.Product} {version} by {Brand.Author} - {Brand.RepoUrl}");
            Console.WriteLine($"{run.Cores} logical processors, interval {options.IntervalSeconds:0.###} s");
            Console.WriteLine($"Dashboard: {dashboard}");
            if (!IPAddress.IsLoopback(options.UiHost))
                Console.WriteLine($"           (reachable from other machines on port {options.UiPort})");
            if (report != null)
                Console.WriteLine($"Report:    {report.Path} (saved every {ReportWriter.SaveEvery.TotalSeconds:0} s and on exit)");
            if (!admin)
                Console.WriteLine("Note: not running as Administrator; processes owned by other users or services may be inaccessible.");
            else if (!priorityRaised)
                Console.WriteLine("Note: could not raise monitor priority.");
            Console.WriteLine("Press Ctrl+C to stop.");
            Console.WriteLine();

            int exitCode = 0;
            try
            {
                new Collector(options, store, startUnixMs).Run(Stop.Token);
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine("Error: monitoring stopped unexpectedly: " + ex);
                exitCode = 3;
            }

            store.Update(() => run.EndedAt = (long)(DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds);
            store.PublishTick(run.EndedAt.Value); // lets open dashboards show "stopped"
            if (report != null)
            {
                report.Stop();
                try
                {
                    report.Write();
                    Console.WriteLine($"Report written: {report.Path}");
                }
                catch (Exception ex)
                {
                    Console.Error.WriteLine($"Error: final report could not be written: {ex.Message}");
                    exitCode = exitCode == 0 ? 2 : exitCode;
                }
            }
            Thread.Sleep(200); // give the broadcaster a moment to deliver the final tick
            server.Stop();
            Finished.Set();
            return exitCode;
        }

        /// <summary>Handles Ctrl+C, Ctrl+Break, console close, logoff and shutdown.</summary>
        private static bool OnConsoleCtrl(int ctrlType)
        {
            if (!Stop.IsCancellationRequested)
            {
                Console.WriteLine();
                Console.WriteLine("Stopping...");
            }
            Stop.Cancel();
            // For close/logoff/shutdown Windows ends the process when this returns,
            // so wait (within the ~5 s Windows allows) for the final report.
            if (ctrlType >= 2) Finished.Wait(TimeSpan.FromSeconds(4.5));
            return true;
        }

        /// <summary>
        /// Readable Windows version. Environment.OSVersion reports 6.2 for unmanifested
        /// .NET Framework apps, so read the registry instead.
        /// </summary>
        private static string WindowsVersion()
        {
            try
            {
                using (var key = Microsoft.Win32.Registry.LocalMachine.OpenSubKey(@"SOFTWARE\Microsoft\Windows NT\CurrentVersion"))
                {
                    string product = key?.GetValue("ProductName") as string ?? "Windows";
                    string build = key?.GetValue("CurrentBuild") as string ?? "";
                    string display = key?.GetValue("DisplayVersion") as string;
                    // Windows 11 still reports "Windows 10" in ProductName; build 22000+ is Windows 11.
                    if (int.TryParse(build, out int b) && b >= 22000 && product.StartsWith("Windows 10", StringComparison.Ordinal))
                        product = "Windows 11" + product.Substring("Windows 10".Length);
                    return product + (display != null ? " " + display : "") + (build.Length > 0 ? " (build " + build + ")" : "");
                }
            }
            catch
            {
                return Environment.OSVersion.VersionString;
            }
        }

        private static bool IsAdministrator()
        {
            try
            {
                using (var identity = WindowsIdentity.GetCurrent())
                    return new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator);
            }
            catch { return false; }
        }
    }
}
