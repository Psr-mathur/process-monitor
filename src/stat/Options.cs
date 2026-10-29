using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net;
using System.Text.RegularExpressions;

namespace Stat
{
    internal sealed class Options
    {
        public List<int> Pids { get; } = new List<int>();
        public List<int> Ports { get; } = new List<int>();
        public double IntervalSeconds { get; private set; } = 1.0;
        public int UiPort { get; private set; } = 6565;
        public IPAddress UiHost { get; private set; } = IPAddress.Loopback;
        public string OutFile { get; private set; }
        public bool ShowHelp { get; private set; }
        public bool ShowVersion { get; private set; }

        public const string Usage =
@"stat - Windows process monitor with a live dashboard and HTML report

Usage:
  stat.exe --pid=21332,54342
  stat.exe --port=5000,1433
  stat.exe --pid=21332 --port=5000,1433 --interval=0.5 --out=report.html

Targets (at least one required):
  --pid=PID[,PID...]       Process IDs to monitor (commas or spaces)
  --port=PORT[,PORT...]    Monitor whatever process listens on these TCP ports

Options:
  --interval=SECONDS       Sampling interval, decimals allowed (default 1)
  --ui-port=PORT           Port for the live dashboard (default 6565)
  --ui-host=ADDRESS        Address the dashboard binds to (default 127.0.0.1).
                           Use 0.0.0.0 to allow access from other machines.
  --out=FILE.html          Also write a self-contained HTML report. It is saved
                           every 30 seconds and when monitoring stops.
  --help                   Show this help
  --version                Show the version

The live dashboard always runs at http://<ui-host>:<ui-port>/.
Press Ctrl+C to stop.";

        /// <summary>Parses the command line. Throws <see cref="ArgumentException"/> with a user-facing message.</summary>
        public static Options Parse(string[] args)
        {
            var o = new Options();
            string lastList = null; // "pid" or "port": bare numbers that follow are added to it

            foreach (string arg in args)
            {
                string name, value;
                var m = Regex.Match(arg, @"^--([a-z-]+)(?:=(.*))?$", RegexOptions.IgnoreCase);
                if (m.Success)
                {
                    name = m.Groups[1].Value.ToLowerInvariant();
                    value = m.Groups[2].Success ? m.Groups[2].Value : null;
                }
                else if (arg == "-h" || arg == "/?")
                {
                    o.ShowHelp = true;
                    continue;
                }
                else if (lastList != null && Regex.IsMatch(arg, @"^[\d,\s]+$"))
                {
                    AddNumbers(lastList == "pid" ? o.Pids : o.Ports, arg, lastList);
                    continue;
                }
                else
                {
                    throw new ArgumentException($"Unexpected argument '{arg}'.");
                }

                lastList = null;
                switch (name)
                {
                    case "pid":
                        AddNumbers(o.Pids, value ?? "", "pid");
                        lastList = "pid";
                        break;
                    case "port":
                        AddNumbers(o.Ports, value ?? "", "port");
                        lastList = "port";
                        break;
                    case "interval":
                        if (!double.TryParse(RequireValue(name, value), NumberStyles.Float, CultureInfo.InvariantCulture, out double interval)
                            || double.IsNaN(interval) || double.IsInfinity(interval) || interval <= 0)
                            throw new ArgumentException("--interval must be a number of seconds greater than zero.");
                        o.IntervalSeconds = interval;
                        break;
                    case "ui-port":
                        if (!int.TryParse(RequireValue(name, value), out int uiPort) || uiPort < 1 || uiPort > 65535)
                            throw new ArgumentException("--ui-port must be between 1 and 65535.");
                        o.UiPort = uiPort;
                        break;
                    case "ui-host":
                        string host = RequireValue(name, value);
                        if (host.Equals("localhost", StringComparison.OrdinalIgnoreCase)) o.UiHost = IPAddress.Loopback;
                        else if (IPAddress.TryParse(host, out var address)) o.UiHost = address;
                        else throw new ArgumentException("--ui-host must be an IP address such as 127.0.0.1 or 0.0.0.0.");
                        break;
                    case "out":
                        string file = RequireValue(name, value).Trim('"');
                        string ext = Path.GetExtension(file).ToLowerInvariant();
                        if (ext != ".html" && ext != ".htm")
                            throw new ArgumentException("--out writes an HTML report; give it a .html file name, e.g. --out=report.html.");
                        o.OutFile = Path.GetFullPath(file);
                        break;
                    case "help":
                        o.ShowHelp = true;
                        break;
                    case "version":
                        o.ShowVersion = true;
                        break;
                    default:
                        throw new ArgumentException($"Unknown option '--{name}'.");
                }
            }

            var pids = o.Pids.Distinct().ToList();
            o.Pids.Clear(); o.Pids.AddRange(pids);
            var ports = o.Ports.Distinct().ToList();
            o.Ports.Clear(); o.Ports.AddRange(ports);
            return o;
        }

        private static string RequireValue(string name, string value)
        {
            if (string.IsNullOrWhiteSpace(value))
                throw new ArgumentException($"--{name} needs a value, e.g. --{name}=...");
            return value.Trim();
        }

        private static void AddNumbers(List<int> target, string text, string kind)
        {
            foreach (string part in Regex.Split(text, @"[,\s]+"))
            {
                if (part.Length == 0) continue;
                if (!int.TryParse(part, NumberStyles.None, CultureInfo.InvariantCulture, out int n)
                    || n <= 0 || (kind == "port" && n > 65535))
                    throw new ArgumentException($"'{part}' is not a valid {(kind == "pid" ? "process ID" : "port")}.");
                target.Add(n);
            }
        }
    }
}
