using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;

namespace Stat
{
    /// <summary>
    /// Small HTTP server for the live dashboard. Built on TcpListener rather than HttpListener
    /// so it needs no URL reservation or admin rights. GET only; Server-Sent Events for live data.
    /// </summary>
    internal sealed class WebServer
    {
        private const int MaxHeaderBytes = 16 * 1024;
        private static readonly TimeSpan HeartbeatEvery = TimeSpan.FromSeconds(15);

        private readonly Store _store;
        private readonly IPAddress _host;
        private readonly int _port;
        private readonly TcpListener _listener;
        private readonly List<Stream> _clients = new List<Stream>();
        private readonly BlockingCollection<string> _outbox = new BlockingCollection<string>(256);
        private volatile bool _running;

        public WebServer(Store store, IPAddress host, int port)
        {
            _store = store;
            _host = host;
            _port = port;
            _listener = new TcpListener(host, port) { ExclusiveAddressUse = true };
        }

        /// <summary>Starts listening. Throws <see cref="SocketException"/> if the port is unavailable.</summary>
        public void Start()
        {
            _listener.Start();
            _running = true;
            _store.Tick += json => _outbox.TryAdd("data: " + json + "\n\n");
            new Thread(AcceptLoop) { IsBackground = true, Name = "http-accept" }.Start();
            new Thread(BroadcastLoop) { IsBackground = true, Name = "http-sse" }.Start();
        }

        public void Stop()
        {
            _running = false;
            try { _listener.Stop(); } catch { }
            _outbox.CompleteAdding();
            lock (_clients)
            {
                foreach (var c in _clients) { try { c.Dispose(); } catch { } }
                _clients.Clear();
            }
        }

        private void AcceptLoop()
        {
            while (_running)
            {
                TcpClient client;
                try { client = _listener.AcceptTcpClient(); }
                catch { if (!_running) return; continue; }
                ThreadPool.QueueUserWorkItem(_ => Handle(client));
            }
        }

        private void BroadcastLoop()
        {
            var ping = Encoding.UTF8.GetBytes(": ping\n\n");
            while (!_outbox.IsCompleted)
            {
                byte[] payload;
                try
                {
                    payload = _outbox.TryTake(out string message, HeartbeatEvery)
                        ? Encoding.UTF8.GetBytes(message) : ping;
                }
                catch (InvalidOperationException) { return; }

                lock (_clients)
                {
                    for (int i = _clients.Count - 1; i >= 0; i--)
                    {
                        try { _clients[i].Write(payload, 0, payload.Length); _clients[i].Flush(); }
                        catch { try { _clients[i].Dispose(); } catch { } _clients.RemoveAt(i); }
                    }
                }
            }
        }

        private void Handle(TcpClient client)
        {
            bool keepOpen = false;
            try
            {
                client.NoDelay = true;
                var stream = client.GetStream();
                stream.ReadTimeout = 5000;
                stream.WriteTimeout = 5000;

                if (!ReadRequest(stream, out string method, out string path, out string hostHeader))
                {
                    Send(stream, 400, "text/plain", "Bad request");
                    return;
                }
                if (!HostAllowed(hostHeader))
                {
                    Send(stream, 403, "text/plain", "Forbidden: unexpected Host header");
                    return;
                }
                if (method != "GET" && method != "HEAD")
                {
                    Send(stream, 405, "text/plain", "Method not allowed", "Allow: GET, HEAD\r\n");
                    return;
                }

                int q = path.IndexOf('?');
                if (q >= 0) path = path.Substring(0, q);
                bool head = method == "HEAD";

                switch (path)
                {
                    case "/":
                    case "/index.html":
                        Send(stream, 200, "text/html; charset=utf-8", Assets.LivePage(), head: head); break;
                    case "/app.css":
                        Send(stream, 200, "text/css; charset=utf-8", Assets.AppCss, head: head); break;
                    case "/fonts.css":
                        Send(stream, 200, "text/css; charset=utf-8", Assets.FontCss, head: head); break;
                    case "/app.js":
                        Send(stream, 200, "text/javascript; charset=utf-8", Assets.AppJs, head: head); break;
                    case "/chart.umd.min.js":
                        Send(stream, 200, "text/javascript; charset=utf-8", Assets.ChartJs, head: head); break;
                    case "/api/state":
                        Send(stream, 200, "application/json; charset=utf-8", _store.StateJson(), head: head); break;
                    case "/api/series":
                        Send(stream, 200, "application/json; charset=utf-8", _store.SeriesJson(), head: head); break;
                    case "/events":
                        if (head) { Send(stream, 200, "text/event-stream", "", head: true); break; }
                        var headers = Encoding.ASCII.GetBytes(
                            // No Content-Length: the stream's body runs until the connection closes.
                            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream; charset=utf-8\r\nCache-Control: no-store\r\n" +
                            "Connection: close\r\nX-Content-Type-Options: nosniff\r\n\r\nretry: 2000\n\n");
                        stream.Write(headers, 0, headers.Length);
                        stream.Flush();
                        stream.WriteTimeout = 2000; // a stalled browser must not hold up the broadcaster
                        lock (_clients) _clients.Add(stream);
                        keepOpen = true;
                        break;
                    case "/favicon.ico":
                        Send(stream, 204, "text/plain", ""); break;
                    default:
                        Send(stream, 404, "text/plain", "Not found"); break;
                }
            }
            catch
            {
                // Client went away mid-request; nothing to do.
            }
            finally
            {
                if (!keepOpen) client.Close();
            }
        }

        /// <summary>
        /// When bound to loopback, only accept loopback Host headers. This blocks DNS-rebinding
        /// attacks where a web page in the user's browser tries to read the dashboard.
        /// </summary>
        private bool HostAllowed(string host)
        {
            if (!IPAddress.IsLoopback(_host)) return true;
            if (string.IsNullOrEmpty(host)) return false;
            string h = host.ToLowerInvariant();
            return h == $"127.0.0.1:{_port}" || h == $"localhost:{_port}" || h == $"[::1]:{_port}"
                || (_port == 80 && (h == "127.0.0.1" || h == "localhost" || h == "[::1]"));
        }

        private static bool ReadRequest(Stream stream, out string method, out string path, out string host)
        {
            method = path = host = null;
            var buffer = new byte[MaxHeaderBytes];
            int length = 0;
            while (true)
            {
                if (length == buffer.Length) return false;
                int read = stream.Read(buffer, length, buffer.Length - length);
                if (read <= 0) return false;
                length += read;
                string text = Encoding.ASCII.GetString(buffer, 0, length);
                int end = text.IndexOf("\r\n\r\n", StringComparison.Ordinal);
                if (end < 0) continue;

                string[] lines = text.Substring(0, end).Split(new[] { "\r\n" }, StringSplitOptions.None);
                string[] requestLine = lines[0].Split(' ');
                if (requestLine.Length != 3 || !requestLine[2].StartsWith("HTTP/1.", StringComparison.Ordinal)) return false;
                method = requestLine[0];
                path = requestLine[1];
                if (!path.StartsWith("/", StringComparison.Ordinal)) return false;
                for (int i = 1; i < lines.Length; i++)
                {
                    int colon = lines[i].IndexOf(':');
                    if (colon > 0 && lines[i].Substring(0, colon).Trim().Equals("Host", StringComparison.OrdinalIgnoreCase))
                        host = lines[i].Substring(colon + 1).Trim();
                }
                return true;
            }
        }

        private static void Send(Stream stream, int status, string contentType, string body,
            string extraHeaders = "", bool head = false)
        {
            byte[] content = Encoding.UTF8.GetBytes(body);
            string reason = status switch
            {
                200 => "OK", 204 => "No Content", 400 => "Bad Request", 403 => "Forbidden",
                404 => "Not Found", 405 => "Method Not Allowed", _ => "Error",
            };
            var sb = new StringBuilder();
            sb.Append("HTTP/1.1 ").Append(status).Append(' ').Append(reason).Append("\r\n");
            sb.Append("Content-Type: ").Append(contentType).Append("\r\n");
            sb.Append("Content-Length: ").Append(content.Length).Append("\r\n");
            sb.Append("Cache-Control: no-store\r\n");
            sb.Append("X-Content-Type-Options: nosniff\r\n");
            sb.Append("Referrer-Policy: no-referrer\r\n");
            sb.Append("Content-Security-Policy: default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; frame-ancestors 'none'\r\n");
            sb.Append("Connection: close\r\n");
            sb.Append(extraHeaders);
            sb.Append("\r\n");
            byte[] header = Encoding.ASCII.GetBytes(sb.ToString());
            stream.Write(header, 0, header.Length);
            if (!head && content.Length > 0) stream.Write(content, 0, content.Length);
            stream.Flush();
        }
    }
}
