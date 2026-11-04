using System;
using System.Globalization;
using System.Text;

namespace Stat
{
    /// <summary>Minimal forward-only JSON writer (the runtime has no built-in serializer we can rely on).</summary>
    internal sealed class Json
    {
        private readonly StringBuilder _sb;
        private bool _needComma;

        public Json(int capacity = 4096) { _sb = new StringBuilder(capacity); }

        public override string ToString() => _sb.ToString();

        public Json BeginObject() { Sep(); _sb.Append('{'); _needComma = false; return this; }
        public Json EndObject() { _sb.Append('}'); _needComma = true; return this; }
        public Json BeginArray() { Sep(); _sb.Append('['); _needComma = false; return this; }
        public Json EndArray() { _sb.Append(']'); _needComma = true; return this; }

        public Json Name(string name)
        {
            Sep();
            WriteString(name);
            _sb.Append(':');
            _needComma = false;
            return this;
        }

        public Json Value(string s) { Sep(); if (s == null) _sb.Append("null"); else WriteString(s); _needComma = true; return this; }
        public Json Value(bool b) { Sep(); _sb.Append(b ? "true" : "false"); _needComma = true; return this; }
        public Json Value(long n) { Sep(); _sb.Append(n.ToString(CultureInfo.InvariantCulture)); _needComma = true; return this; }
        public Json Value(long? n) { return n.HasValue ? Value(n.Value) : Null(); }
        public Json Null() { Sep(); _sb.Append("null"); _needComma = true; return this; }

        /// <summary>Writes a number rounded to <paramref name="decimals"/> places; NaN/Infinity become null.</summary>
        public Json Value(double d, int decimals = 3)
        {
            Sep();
            if (double.IsNaN(d) || double.IsInfinity(d)) _sb.Append("null");
            else _sb.Append(Math.Round(d, decimals).ToString("R", CultureInfo.InvariantCulture));
            _needComma = true;
            return this;
        }

        public Json Prop(string name, string v) => Name(name).Value(v);
        public Json Prop(string name, bool v) => Name(name).Value(v);
        public Json Prop(string name, long v) => Name(name).Value(v);
        public Json Prop(string name, long? v) => Name(name).Value(v);
        public Json Prop(string name, double v, int decimals = 3) => Name(name).Value(v, decimals);

        /// <summary>Appends an already-serialized JSON value.</summary>
        public Json Raw(string json) { Sep(); _sb.Append(json); _needComma = true; return this; }

        private void Sep()
        {
            if (_needComma) _sb.Append(',');
        }

        private void WriteString(string s)
        {
            _sb.Append('"');
            foreach (char c in s)
            {
                switch (c)
                {
                    case '"': _sb.Append("\\\""); break;
                    case '\\': _sb.Append("\\\\"); break;
                    case '\n': _sb.Append("\\n"); break;
                    case '\r': _sb.Append("\\r"); break;
                    case '\t': _sb.Append("\\t"); break;
                    // Escaping < > & keeps the JSON safe to embed inside an HTML <script> block.
                    case '<': _sb.Append("\\u003c"); break;
                    case '>': _sb.Append("\\u003e"); break;
                    case '&': _sb.Append("\\u0026"); break;
                    case (char)0x2028: _sb.Append("\\u2028"); break; // JS line separators
                    case (char)0x2029: _sb.Append("\\u2029"); break;
                    default:
                        if (c < 0x20) _sb.Append("\\u").Append(((int)c).ToString("x4"));
                        else _sb.Append(c);
                        break;
                }
            }
            _sb.Append('"');
        }
    }
}
