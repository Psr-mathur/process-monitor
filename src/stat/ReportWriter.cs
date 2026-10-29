using System;
using System.IO;
using System.Text;
using System.Threading;

namespace Stat
{
    /// <summary>Writes the self-contained HTML report periodically and on shutdown.</summary>
    internal sealed class ReportWriter
    {
        public static readonly TimeSpan SaveEvery = TimeSpan.FromSeconds(30);

        private readonly Store _store;
        private readonly string _path;
        private readonly object _writeLock = new object();
        private Timer _timer;

        public ReportWriter(Store store, string path)
        {
            _store = store;
            _path = path;
        }

        public string Path => _path;

        public void Start()
        {
            _timer = new Timer(_ => { try { Write(); } catch (Exception ex) { Console.Error.WriteLine($"Report save failed: {ex.Message}"); } },
                null, SaveEvery, SaveEvery);
        }

        public void Stop()
        {
            _timer?.Dispose();
            _timer = null;
        }

        /// <summary>Writes the report atomically (temp file, then replace) so a crash never leaves a half-written file.</summary>
        public void Write()
        {
            lock (_writeLock)
            {
                long now = (long)(DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds;
                var run = _store.Run;
                string title = $"stat report - {run.Host} - {DateTime.Now:yyyy-MM-dd HH:mm}";
                string html = Assets.ReportPage(_store.ReportJson(now), title);

                string temp = _path + ".tmp";
                File.WriteAllText(temp, html, new UTF8Encoding(false));
                if (File.Exists(_path)) File.Replace(temp, _path, null);
                else File.Move(temp, _path);
            }
        }
    }
}
