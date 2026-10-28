using System.Buffers.Binary;
using System.IO;
using System.Net.Http;
using System.Net.Http.Headers;

namespace Tokdesk;

/// <summary>
/// Saca solo el sonido de un MP4 remoto sin bajar la imagen: lee el índice (moov), pide por rangos
/// únicamente los trozos de la pista de audio y arma un .m4a local con esa pista.
/// Se usa cuando la variante HEVC de un video llega sin audio: la imagen sigue en HEVC y el sonido sale de la H.264.
/// </summary>
static class Mp4Audio
{
    public static readonly string Dir = Path.Combine(Offline.Dir, "audio");
    const int Keep = 40;

    record Box(string Type, long Start, long Size, int Header);

    static IEnumerable<Box> Boxes(byte[] b, long from, long to)
    {
        var p = from;
        while (p + 8 <= to)
        {
            long size = BinaryPrimitives.ReadUInt32BigEndian(b.AsSpan((int)p));
            var type = System.Text.Encoding.ASCII.GetString(b, (int)p + 4, 4);
            var header = 8;
            if (size == 1) { size = (long)BinaryPrimitives.ReadUInt64BigEndian(b.AsSpan((int)p + 8)); header = 16; }
            else if (size == 0) size = to - p;
            if (size < header || p + size > to) yield break;
            yield return new Box(type, p, size, header);
            p += size;
        }
    }

    static Box Child(byte[] b, Box parent, string type, int skip = 0) =>
        Boxes(b, parent.Start + parent.Header + skip, parent.Start + parent.Size).FirstOrDefault(x => x.Type == type);

    static async Task<byte[]> Range(HttpClient http, string url, long from, long to, Action<HttpRequestMessage> headers)
    {
        using var req = new HttpRequestMessage(HttpMethod.Get, url);
        headers(req);
        req.Headers.Range = new RangeHeaderValue(from, to);
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(15));
        using var resp = await http.SendAsync(req, cts.Token);
        resp.EnsureSuccessStatusCode();
        return await resp.Content.ReadAsByteArrayAsync();
    }

    /// <summary>
    /// Pide varios rangos en una sola petición. Devuelve false si el servidor no responde con
    /// multipart/byteranges (o falta algún trozo); en ese caso no se usa este método.
    /// </summary>
    static async Task<bool> MultiRange(HttpClient http, string url, int[] idx, long[] offsets, long[] sizes, byte[][] data, Action<HttpRequestMessage> headers)
    {
        try
        {
            using var req = new HttpRequestMessage(HttpMethod.Get, url);
            headers(req);
            var rh = new RangeHeaderValue();
            foreach (var c in idx) rh.Ranges.Add(new RangeItemHeaderValue(offsets[c], offsets[c] + sizes[c] - 1));
            req.Headers.Range = rh;
            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(20));
            using var resp = await http.SendAsync(req, cts.Token);
            var ct = resp.Content.Headers.ContentType;
            if ((int)resp.StatusCode != 206 || ct?.MediaType != "multipart/byteranges") return false;
            var boundary = ct.Parameters.FirstOrDefault(p => p.Name == "boundary")?.Value?.Trim('"');
            if (string.IsNullOrEmpty(boundary)) return false;
            var body = await resp.Content.ReadAsByteArrayAsync();
            // Cada parte: --boundary, cabeceras (Content-Range: bytes a-b/total), línea vacía y los datos
            var byStart = idx.ToDictionary(c => offsets[c]);
            var marker = System.Text.Encoding.ASCII.GetBytes("--" + boundary);
            var pos = 0;
            while (true)
            {
                var m = body.AsSpan(pos).IndexOf(marker);
                if (m < 0) break;
                pos += m + marker.Length;
                if (pos + 2 <= body.Length && body[pos] == '-' && body[pos + 1] == '-') break; // fin
                var headEnd = body.AsSpan(pos).IndexOf("\r\n\r\n"u8);
                if (headEnd < 0) break;
                var head = System.Text.Encoding.ASCII.GetString(body, pos, headEnd);
                pos += headEnd + 4;
                var r = System.Text.RegularExpressions.Regex.Match(head, @"bytes (\d+)-(\d+)", System.Text.RegularExpressions.RegexOptions.IgnoreCase);
                if (!r.Success) return false;
                long a = long.Parse(r.Groups[1].Value), b = long.Parse(r.Groups[2].Value);
                var len = (int)(b - a + 1);
                if (pos + len > body.Length) return false;
                if (byStart.TryGetValue(a, out var c)) data[c] = body.AsSpan(pos, len).ToArray();
                pos += len;
            }
            return idx.All(c => data[c] != null && data[c].Length == sizes[c]);
        }
        catch { return false; }
    }

    /// <summary>Devuelve la ruta del .m4a (lo arma si no existe) o null si no se pudo.</summary>
    public static async Task<string> Extract(HttpClient http, string id, string url, Action<HttpRequestMessage> headers)
    {
        Directory.CreateDirectory(Dir);
        var safe = string.Concat((id ?? "").Where(char.IsLetterOrDigit));
        var file = Path.Combine(Dir, safe + ".m4a");
        if (File.Exists(file)) return file;
        try
        {
            Log.Write("Audio aparte: buscando el sonido de " + safe);
            var sw = System.Diagnostics.Stopwatch.StartNew();
            // La dirección de TikTok redirige al CDN: se resuelve una vez y los rangos van directo
            using (var probe = new HttpRequestMessage(HttpMethod.Get, url)) { headers(probe); probe.Headers.Range = new RangeHeaderValue(0, 0); using var cts0 = new CancellationTokenSource(TimeSpan.FromSeconds(15)); using var r0 = await http.SendAsync(probe, HttpCompletionOption.ResponseHeadersRead, cts0.Token); url = r0.RequestMessage?.RequestUri?.ToString() ?? url; }
            Log.Write($"Audio aparte: CDN en {sw.ElapsedMilliseconds} ms");
            // 1) Índice: casi siempre al principio (faststart); si no, se busca por su tamaño
            var head = await Range(http, url, 0, 256 * 1024 - 1, headers);
            var top = Boxes(head, 0, head.Length).ToList();
            var moovBox = top.FirstOrDefault(x => x.Type == "moov");
            byte[] moov;
            if (moovBox != null && moovBox.Start + moovBox.Size <= head.Length) moov = head.AsSpan((int)moovBox.Start, (int)moovBox.Size).ToArray();
            else
            {
                // moov después del mdat: se salta de caja en caja leyendo solo sus cabeceras
                long pos = 0;
                moov = null;
                for (var guard = 0; guard < 20 && moov == null; guard++)
                {
                    var hdr = pos + 16 <= head.Length ? head.AsSpan((int)pos, 16).ToArray() : await Range(http, url, pos, pos + 15, headers);
                    long size = BinaryPrimitives.ReadUInt32BigEndian(hdr);
                    var type = System.Text.Encoding.ASCII.GetString(hdr, 4, 4);
                    if (size == 1) size = (long)BinaryPrimitives.ReadUInt64BigEndian(hdr.AsSpan(8));
                    if (size < 8) return null;
                    if (type == "moov") moov = await Range(http, url, pos, pos + size - 1, headers);
                    pos += size;
                }
                if (moov == null) return null;
            }
            var root = new Box("moov", 0, moov.Length, 8);

            // 2) Pista de sonido: el trak cuyo hdlr dice "soun"
            Box sound = null;
            foreach (var trak in Boxes(moov, 8, moov.Length).Where(x => x.Type == "trak"))
            {
                var mdia = Child(moov, trak, "mdia");
                var hdlr = mdia == null ? null : Child(moov, mdia, "hdlr");
                if (hdlr != null && System.Text.Encoding.ASCII.GetString(moov, (int)hdlr.Start + 16, 4) == "soun") { sound = trak; break; }
            }
            if (sound == null) { Log.Write("Audio aparte: la variante H.264 tampoco trae sonido"); return null; }
            var stbl = Child(moov, Child(moov, Child(moov, sound, "mdia"), "minf"), "stbl");
            var stsz = Child(moov, stbl, "stsz");
            var stsc = Child(moov, stbl, "stsc");
            var stco = Child(moov, stbl, "stco");
            var co64 = Child(moov, stbl, "co64");
            if (stsz == null || stsc == null || (stco == null && co64 == null)) return null;

            // Tamaños de muestra
            var zp = (int)stsz.Start + 12;
            var fixedSize = BinaryPrimitives.ReadUInt32BigEndian(moov.AsSpan(zp));
            var count = (int)BinaryPrimitives.ReadUInt32BigEndian(moov.AsSpan(zp + 4));
            var sizes = new long[count];
            for (var i = 0; i < count; i++) sizes[i] = fixedSize != 0 ? fixedSize : BinaryPrimitives.ReadUInt32BigEndian(moov.AsSpan(zp + 8 + i * 4));

            // Posición de cada trozo (chunk)
            var co = co64 ?? stco;
            var cp = (int)co.Start + 12;
            var chunks = (int)BinaryPrimitives.ReadUInt32BigEndian(moov.AsSpan(cp));
            var offsets = new long[chunks];
            for (var i = 0; i < chunks; i++)
                offsets[i] = co64 != null ? (long)BinaryPrimitives.ReadUInt64BigEndian(moov.AsSpan(cp + 4 + i * 8)) : BinaryPrimitives.ReadUInt32BigEndian(moov.AsSpan(cp + 4 + i * 4));

            // Muestras por trozo (stsc: tramos de first_chunk / samples_per_chunk)
            var sp = (int)stsc.Start + 12;
            var runs = (int)BinaryPrimitives.ReadUInt32BigEndian(moov.AsSpan(sp));
            var perChunk = new int[chunks];
            for (var r = 0; r < runs; r++)
            {
                var firstChunk = (int)BinaryPrimitives.ReadUInt32BigEndian(moov.AsSpan(sp + 4 + r * 12)) - 1;
                var samples = (int)BinaryPrimitives.ReadUInt32BigEndian(moov.AsSpan(sp + 8 + r * 12));
                var next = r + 1 < runs ? (int)BinaryPrimitives.ReadUInt32BigEndian(moov.AsSpan(sp + 4 + (r + 1) * 12)) - 1 : chunks;
                for (var c = firstChunk; c < next && c < chunks; c++) perChunk[c] = samples;
            }
            var chunkSize = new long[chunks];
            for (int c = 0, s = 0; c < chunks; c++)
                for (var k = 0; k < perChunk[c] && s < count; k++, s++) chunkSize[c] += sizes[s];

            Log.Write($"Audio aparte: índice en {sw.ElapsedMilliseconds} ms, {chunks} trozos, {sizes.Length} muestras");
            // 3) Se bajan solo los trozos de audio. Primero se prueba pedir muchos rangos por petición
            //    (multipart/byteranges); si el servidor no lo acepta, de a uno en paralelo
            var data = new byte[chunks][];
            for (var c = 0; c < chunks; c++) if (chunkSize[c] == 0) data[c] = Array.Empty<byte>();
            var pending = Enumerable.Range(0, chunks).Where(c => data[c] == null).ToList();
            const int Batch = 120;
            var batches = pending.Chunk(Batch).ToList();
            var multi = batches.Count > 0 && await MultiRange(http, url, batches[0], offsets, chunkSize, data, headers);
            using (var gate = new SemaphoreSlim(multi ? 6 : 16))
            {
                if (multi)
                    await Task.WhenAll(batches.Skip(1).Select(async b =>
                    {
                        await gate.WaitAsync();
                        try
                        {
                            // Si una tanda llega incompleta, solo esa se vuelve a pedir de a un rango
                            if (!await MultiRange(http, url, b, offsets, chunkSize, data, headers))
                                foreach (var c in b.Where(c => data[c] == null || data[c].Length != chunkSize[c]))
                                    data[c] = await Range(http, url, offsets[c], offsets[c] + chunkSize[c] - 1, headers);
                        }
                        finally { gate.Release(); }
                    }));
                else
                    await Task.WhenAll(pending.Select(async c =>
                    {
                        await gate.WaitAsync();
                        try { data[c] = await Range(http, url, offsets[c], offsets[c] + chunkSize[c] - 1, headers); }
                        finally { gate.Release(); }
                    }));
            }
            Log.Write($"Audio aparte: datos en {sw.ElapsedMilliseconds} ms ({(multi ? "rangos múltiples" : "de a uno")})");

            // 4) .m4a: ftyp + moov (mvhd + trak de sonido, con las posiciones nuevas) + mdat
            var ftyp = top.FirstOrDefault(x => x.Type == "ftyp");
            var ftypBytes = ftyp != null ? head.AsSpan((int)ftyp.Start, (int)ftyp.Size).ToArray()
                : new byte[] { 0, 0, 0, 20, (byte)'f', (byte)'t', (byte)'y', (byte)'p', (byte)'M', (byte)'4', (byte)'A', (byte)' ', 0, 0, 2, 0, (byte)'i', (byte)'s', (byte)'o', (byte)'m' };
            var mvhd = Child(moov, root, "mvhd");
            var mvhdBytes = moov.AsSpan((int)mvhd.Start, (int)mvhd.Size).ToArray();
            var trakBytes = moov.AsSpan((int)sound.Start, (int)sound.Size).ToArray();
            var moovSize = 8 + mvhdBytes.Length + trakBytes.Length;
            var dataStart = ftypBytes.Length + moovSize + 8L;
            long cursor = dataStart;
            var coInTrak = (int)(co.Start - sound.Start) + 16; // primera entrada dentro del trak copiado
            for (var c = 0; c < chunks; c++)
            {
                if (co64 != null) BinaryPrimitives.WriteUInt64BigEndian(trakBytes.AsSpan(coInTrak + c * 8), (ulong)cursor);
                else BinaryPrimitives.WriteUInt32BigEndian(trakBytes.AsSpan(coInTrak + c * 4), (uint)cursor);
                cursor += data[c].Length;
            }
            var mdatSize = cursor - dataStart + 8;
            var tmp = file + ".part";
            await using (var fs = File.Create(tmp))
            {
                fs.Write(ftypBytes);
                var h = new byte[8];
                BinaryPrimitives.WriteUInt32BigEndian(h, (uint)moovSize); "moov"u8.CopyTo(h.AsSpan(4)); fs.Write(h);
                fs.Write(mvhdBytes); fs.Write(trakBytes);
                BinaryPrimitives.WriteUInt32BigEndian(h, (uint)mdatSize); "mdat"u8.CopyTo(h.AsSpan(4)); fs.Write(h);
                foreach (var d in data) fs.Write(d);
            }
            File.Move(tmp, file, true);
            foreach (var old in new DirectoryInfo(Dir).GetFiles("*.m4a").OrderByDescending(f => f.LastWriteTimeUtc).Skip(Keep))
                try { old.Delete(); } catch { }
            Log.Write($"Audio aparte: {safe} listo ({chunks} trozos, {(cursor - dataStart) / 1024} KB)");
            return file;
        }
        catch (Exception ex)
        {
            Log.Write("Audio aparte: no se pudo sacar el sonido de " + safe + ": " + ex.Message);
            return null;
        }
    }
}
