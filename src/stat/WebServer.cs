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
    /// so it needs no URL reservation or admin rights. Server-Sent Events for live data.
    /// Read-only except POST /api/label, which changes a display label and nothing else.
    /// </summary>
    internal sealed class WebServer
    {
        private const int MaxHeaderBytes = 16 * 1024;
        private const int MaxBodyBytes = 4 * 1024;
        // Browsers only send a custom header cross-origin after a CORS preflight, which this server never
        // approves, so requiring it stops other websites from posting to the dashboard.
        private const string RequestHeader = "X-Monitor-Request";

        private sealed class Request
        {
            public string Method, Path;
            public readonly Dictionary<string, string> Headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            public byte[] Body = new byte[0];
            public string Header(string name) => Headers.TryGetValue(name, out string v) ? v : null;
        }
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

                var request = ReadRequest(stream);
                if (request == null)
                {
                    Send(stream, 400, "text/plain", "Bad request");
                    return;
                }
                if (!HostAllowed(request.Header("Host")))
                {
                    Send(stream, 403, "text/plain", "Forbidden: unexpected Host header");
                    return;
                }

                string method = request.Method, path = request.Path;
                int q = path.IndexOf('?');
                if (q >= 0) path = path.Substring(0, q);

                if (method == "POST" && path == "/api/label")
                {
                    HandleLabel(stream, request);
                    return;
                }
                if (method != "GET" && method != "HEAD")
                {
                    Send(stream, 405, "text/plain", "Method not allowed", "Allow: GET, HEAD, POST\r\n");
                    return;
                }
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

        /// <summary>POST /api/label with a form body "k=KEY&amp;label=TEXT". An empty label removes it.</summary>
        private void HandleLabel(Stream stream, Request request)
        {
            if (request.Header(RequestHeader) != "1")
            {
                Send(stream, 403, "text/plain", "Forbidden: missing " + RequestHeader + " header");
                return;
            }
            string key = null, label = null;
            foreach (string pair in Encoding.UTF8.GetString(request.Body).Split('&'))
            {
                int eq = pair.IndexOf('=');
                if (eq <= 0) continue;
                string name = WebUtility.UrlDecode(pair.Substring(0, eq));
                string value = WebUtility.UrlDecode(pair.Substring(eq + 1));
                if (name == "k") key = value;
                else if (name == "label") label = value;
            }
            if (string.IsNullOrEmpty(key) || label == null)
            {
                Send(stream, 400, "text/plain", "Expected k and label");
                return;
            }
            long now = (long)(DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds;
            if (!_store.SetLabel(key, label, now, out string applied))
            {
                Send(stream, 404, "text/plain", "No such process");
                return;
            }
            Send(stream, 200, "application/json; charset=utf-8", new Json(64).BeginObject().Prop("label", applied).EndObject().ToString());
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

        /// <summary>Reads the request line, headers and (up to <see cref="MaxBodyBytes"/>) body. Null if malformed.</summary>
        private static Request ReadRequest(Stream stream)
        {
            var buffer = new byte[MaxHeaderBytes];
            int length = 0;
            while (true)
            {
                if (length == buffer.Length) return null;
                int read = stream.Read(buffer, length, buffer.Length - length);
                if (read <= 0) return null;
                length += read;
                // ASCII decoding maps each byte to one char, so char offsets are byte offsets.
                string text = Encoding.ASCII.GetString(buffer, 0, length);
                int end = text.IndexOf("\r\n\r\n", StringComparison.Ordinal);
                if (end < 0) continue;

                string[] lines = text.Substring(0, end).Split(new[] { "\r\n" }, StringSplitOptions.None);
                string[] requestLine = lines[0].Split(' ');
                if (requestLine.Length != 3 || !requestLine[2].StartsWith("HTTP/1.", StringComparison.Ordinal)) return null;
                var request = new Request { Method = requestLine[0], Path = requestLine[1] };
                if (!request.Path.StartsWith("/", StringComparison.Ordinal)) return null;
                for (int i = 1; i < lines.Length; i++)
                {
                    int colon = lines[i].IndexOf(':');
                    if (colon > 0) request.Headers[lines[i].Substring(0, colon).Trim()] = lines[i].Substring(colon + 1).Trim();
                }

                if (request.Header("Transfer-Encoding") != null) return null;
                string lengthHeader = request.Header("Content-Length");
                if (lengthHeader == null) return request;
                if (!int.TryParse(lengthHeader, out int bodyLength) || bodyLength < 0 || bodyLength > MaxBodyBytes) return null;

                request.Body = new byte[bodyLength];
                int have = Math.Min(bodyLength, length - (end + 4));
                Array.Copy(buffer, end + 4, request.Body, 0, have);
                while (have < bodyLength)
                {
                    int n = stream.Read(request.Body, have, bodyLength - have);
                    if (n <= 0) return null;
                    have += n;
                }
                return request;
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
