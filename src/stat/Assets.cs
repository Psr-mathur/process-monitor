using System;
using System.IO;
using System.Reflection;
using System.Text;

namespace Stat
{
    /// <summary>Dashboard files embedded in the executable.</summary>
    internal static class Assets
    {
        public static readonly string IndexHtml = Load("web/index.html");
        public static readonly string AppCss = Load("web/app.css");
        public static readonly string AppJs = Load("web/app.js");
        public static readonly string ChartJs = Load("web/chart.umd.min.js");
        // B612 (SIL OFL) inlined as data URIs, so the live page and the offline report render identically.
        public static readonly string FontCss = FontFace("B612", 400, "web/fonts/b612-400.woff2")
                                              + FontFace("B612", 700, "web/fonts/b612-700.woff2");

        private static Stream Open(string name)
        {
            var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(name);
            if (stream == null) throw new FileNotFoundException("Embedded resource missing: " + name);
            return stream;
        }

        private static string Load(string name)
        {
            using (var reader = new StreamReader(Open(name), Encoding.UTF8))
                return reader.ReadToEnd();
        }

        private static string FontFace(string family, int weight, string resource)
        {
            using (var stream = Open(resource))
            using (var buffer = new MemoryStream())
            {
                stream.CopyTo(buffer);
                return "@font-face{font-family:\"" + family + "\";font-style:normal;font-weight:" + weight +
                       ";font-display:swap;src:url(data:font/woff2;base64," + Convert.ToBase64String(buffer.ToArray()) +
                       ") format(\"woff2\");}\n";
            }
        }

        /// <summary>The live page: assets are served as separate files and data comes from the API.</summary>
        public static string LivePage() => IndexHtml.Replace("<!--STAT:DATA-->", "");

        /// <summary>A self-contained page with every asset and the run data inlined.</summary>
        public static string ReportPage(string dataJson, string title)
        {
            return IndexHtml
                .Replace("<title>" + Brand.Product + "</title>", "<title>" + System.Net.WebUtility.HtmlEncode(title) + "</title>")
                .Replace("<link rel=\"stylesheet\" href=\"fonts.css\">", "<style>\n" + FontCss + "</style>")
                .Replace("<link rel=\"stylesheet\" href=\"app.css\">", "<style>\n" + AppCss + "\n</style>")
                .Replace("<script src=\"chart.umd.min.js\"></script>", "<script>\n" + EscapeScript(ChartJs) + "\n</script>")
                .Replace("<script src=\"app.js\"></script>", "<script>\n" + EscapeScript(AppJs) + "\n</script>")
                .Replace("<!--STAT:DATA-->", "<script id=\"stat-data\" type=\"application/json\">" + dataJson + "</script>");
        }

        // An inline script ends at the first "</script", wherever it appears.
        private static string EscapeScript(string js) => js.Replace("</script", "<\\/script");
    }
}
