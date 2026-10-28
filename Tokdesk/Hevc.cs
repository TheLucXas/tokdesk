using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Text.RegularExpressions;

namespace Tokdesk;

/// <summary>
/// Instala gratis la extensión HEVC oficial de Microsoft («HEVC Video Extensions from Device Manufacturer»).
/// La Store a veces dice que no funciona en el equipo, así que se pide el paquete directamente al servicio
/// de entregas de Microsoft (el mismo que usa la Store), se descarga de su CDN y se instala solo para el
/// usuario con Add-AppxPackage, que verifica la firma de Microsoft.
/// </summary>
static class Hevc
{
    const string Endpoint = "https://fe3cr.delivery.mp.microsoft.com/ClientWebService/client.asmx";
    const string Category = "5e60c346-7f52-4a6f-98c0-70fef2dd1d01"; // del catálogo de la Store (9N4WGH0Z6VHQ)
    const string Ns = "xmlns=\"http://www.microsoft.com/SoftwareDistribution/Server/ClientWebService\"";
    const string Attrs = "BranchReadinessLevel=CB;CurrentBranch=rs_prerelease;FlightRing=Retail;AttrDataVer=21;InstallLanguage=en-US;OSUILocale=en-US;InstallationType=Client;FlightingBranchName=external;App=WU;AppVer=10.0.19044.1;OSArchitecture=AMD64;IsFlightingEnabled=0;TelemetryLevel=1;OSVersion=10.0.19044.1;DeviceFamily=Windows.Desktop;";

    static string Envelope(string action, string to, string body) =>
        "<s:Envelope xmlns:a=\"http://www.w3.org/2005/08/addressing\" xmlns:s=\"http://www.w3.org/2003/05/soap-envelope\"><s:Header>" +
        $"<a:Action s:mustUnderstand=\"1\">http://www.microsoft.com/SoftwareDistribution/Server/ClientWebService/{action}</a:Action>" +
        $"<a:MessageID>urn:uuid:{Guid.NewGuid()}</a:MessageID><a:To s:mustUnderstand=\"1\">{to}</a:To>" +
        "<o:Security s:mustUnderstand=\"1\" xmlns:o=\"http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd\">" +
        "<Timestamp xmlns=\"http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd\"><Created>2017-08-05T02:03:05.038Z</Created><Expires>2017-08-05T02:08:05.038Z</Expires></Timestamp>" +
        "<wuws:WindowsUpdateTicketsToken wsu:id=\"ClientMSA\" xmlns:wsu=\"http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd\" xmlns:wuws=\"http://schemas.microsoft.com/msus/2014/10/WindowsUpdateAuthorization\">" +
        "<TicketType Name=\"MSA\" Version=\"1.0\" Policy=\"MBI_SSL\"><user></user></TicketType></wuws:WindowsUpdateTicketsToken></o:Security></s:Header>" +
        $"<s:Body>{body}</s:Body></s:Envelope>";

    static async Task<string> Post(HttpClient http, string url, string body)
    {
        using var content = new StringContent(body, Encoding.UTF8, "application/soap+xml");
        using var resp = await http.PostAsync(url, content);
        resp.EnsureSuccessStatusCode();
        return await resp.Content.ReadAsStringAsync();
    }

    /// <summary>Pide a Microsoft la dirección de descarga de la última versión del paquete.</summary>
    static async Task<string> ResolveUrl(HttpClient http)
    {
        var cookieXml = await Post(http, Endpoint, Envelope("GetCookie", Endpoint,
            $"<GetCookie {Ns}><oldCookie></oldCookie><lastChange>2015-10-21T17:01:07.1472913Z</lastChange><currentTime>{DateTime.UtcNow:o}</currentTime><protocolVersion>1.40</protocolVersion></GetCookie>"));
        var cookie = Regex.Match(cookieXml, "<EncryptedData>(.*?)</EncryptedData>").Groups[1].Value;

        // Categorías de Windows Update que el servicio espera ver como instaladas
        var ids = (AppInfo.Resource("hevc-ids.txt") ?? "").Split('\n');
        static string Ints(string line) => string.Concat(line.Split(',', StringSplitOptions.RemoveEmptyEntries).Select(x => $"<int>{x.Trim()}</int>"));
        var sync = $"<SyncUpdates {Ns}><cookie><Expiration>2045-03-11T02:02:48Z</Expiration><EncryptedData>{cookie}</EncryptedData></cookie><parameters>" +
            $"<ExpressQuery>false</ExpressQuery><InstalledNonLeafUpdateIDs>{Ints(ids[0])}</InstalledNonLeafUpdateIDs><OtherCachedUpdateIDs>{(ids.Length > 1 ? Ints(ids[1]) : "")}</OtherCachedUpdateIDs>" +
            "<SkipSoftwareSync>false</SkipSoftwareSync><NeedTwoGroupOutOfScopeUpdates>true</NeedTwoGroupOutOfScopeUpdates>" +
            $"<FilterAppCategoryIds><CategoryIdentifier><Id>{Category}</Id></CategoryIdentifier></FilterAppCategoryIds><TreatAppCategoryIdsAsInstalled>true</TreatAppCategoryIdsAsInstalled>" +
            "<AlsoPerformRegularSync>false</AlsoPerformRegularSync><ComputerSpec/><ExtendedUpdateInfoParameters><XmlUpdateFragmentTypes><XmlUpdateFragmentType>Extended</XmlUpdateFragmentType></XmlUpdateFragmentTypes>" +
            "<Locales><string>en-US</string></Locales></ExtendedUpdateInfoParameters><ClientPreferredLanguages><string>en-US</string></ClientPreferredLanguages>" +
            $"<ProductsParameters><SyncCurrentVersionOnly>false</SyncCurrentVersionOnly><DeviceAttributes>{Attrs}</DeviceAttributes><CallerAttributes>Interactive=1;IsSeeker=0;</CallerAttributes><Products/></ProductsParameters></parameters></SyncUpdates>";
        var x = WebUtility.HtmlDecode(await Post(http, Endpoint, Envelope("SyncUpdates", Endpoint, sync)));

        // Las versiones nuevas pueden pedir Windows 11: se elige la más nueva que acepte este Windows
        var os = Environment.OSVersion.Version;
        var osPacked = ((ulong)os.Major << 48) | ((ulong)os.Minor << 32) | ((ulong)os.Build << 16);
        (Version ver, string id, string rev) best = default;
        foreach (Match m in Regex.Matches(x, @"<UpdateInfo>[\s\S]*?</UpdateInfo>"))
        {
            var p = Regex.Match(m.Value, "PackageMoniker=\"Microsoft\\.HEVCVideoExtension_([\\d.]+)_");
            var u = Regex.Match(m.Value, "UpdateID=\"([^\"]+)\" RevisionNumber=\"(\\d+)\"");
            var min = Regex.Match(m.Value, "\"platform\\.minVersion\":(\\d+)");
            if (min.Success && ulong.Parse(min.Groups[1].Value) > osPacked) continue;
            if (p.Success && u.Success && Version.TryParse(p.Groups[1].Value, out var v) && (best.ver == null || v > best.ver))
                best = (v, u.Groups[1].Value, u.Groups[2].Value);
        }
        if (best.ver == null) throw new InvalidOperationException("Microsoft no tiene una versión para este Windows");

        var info = await Post(http, Endpoint + "/secured", Envelope("GetExtendedUpdateInfo2", Endpoint + "/secured",
            $"<GetExtendedUpdateInfo2 {Ns}><updateIDs><UpdateIdentity><UpdateID>{best.id}</UpdateID><RevisionNumber>{best.rev}</RevisionNumber></UpdateIdentity></updateIDs>" +
            $"<infoTypes><XmlUpdateFragmentType>FileUrl</XmlUpdateFragmentType><XmlUpdateFragmentType>FileDecryption</XmlUpdateFragmentType></infoTypes><deviceAttributes>{Attrs}</deviceAttributes></GetExtendedUpdateInfo2>"));
        // Vienen varios archivos (metadatos en .cab y el paquete): se elige el que empieza como ZIP ("PK"), que es el .appxbundle
        foreach (var url in Regex.Matches(info, "<Url>(.*?)</Url>").Select(m => WebUtility.HtmlDecode(m.Groups[1].Value)))
        {
            if (!new Uri(url).Host.EndsWith("delivery.mp.microsoft.com", StringComparison.OrdinalIgnoreCase)) continue;
            using var req = new HttpRequestMessage(HttpMethod.Get, url);
            req.Headers.Range = new System.Net.Http.Headers.RangeHeaderValue(0, 1);
            using var resp = await http.SendAsync(req);
            var head = await resp.Content.ReadAsByteArrayAsync();
            if (head.Length >= 2 && head[0] == (byte)'P' && head[1] == (byte)'K')
            {
                Log.Write($"HEVC: versión {best.ver}");
                return url;
            }
        }
        throw new InvalidOperationException("Microsoft no devolvió la dirección de descarga");
    }

    /// <summary>Descarga e instala el paquete. <paramref name="progress"/> recibe (etapa, porcentaje).</summary>
    public static async Task<string> Install(HttpClient http, Action<string, int> progress)
    {
        var file = Path.Combine(Path.GetTempPath(), "Tokdesk-HEVC.appxbundle");
        try
        {
            progress("resolving", 0);
            var url = await ResolveUrl(http);
            progress("downloading", 0);
            using (var resp = await http.GetAsync(url, HttpCompletionOption.ResponseHeadersRead))
            {
                resp.EnsureSuccessStatusCode();
                var total = resp.Content.Headers.ContentLength ?? 0;
                await using var src = await resp.Content.ReadAsStreamAsync();
                await using var dst = File.Create(file);
                var buf = new byte[81920];
                long done = 0; int read, last = -1;
                while ((read = await src.ReadAsync(buf)) > 0)
                {
                    await dst.WriteAsync(buf.AsMemory(0, read));
                    done += read;
                    var pct = total > 0 ? (int)(done * 100 / total) : 0;
                    if (pct != last) { last = pct; progress("downloading", pct); }
                }
            }
            progress("installing", 100);
            // Instalación por usuario (sin administrador); Windows verifica la firma del paquete
            var psi = new ProcessStartInfo("powershell.exe",
                $"-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command \"[Console]::OutputEncoding = [Text.Encoding]::UTF8; Add-AppxPackage -Path '{file.Replace("'", "''")}'\"")
            { UseShellExecute = false, CreateNoWindow = true, RedirectStandardError = true, StandardErrorEncoding = Encoding.UTF8 };
            using var p = Process.Start(psi)!;
            var err = await p.StandardError.ReadToEndAsync();
            await p.WaitForExitAsync();
            if (p.ExitCode != 0) throw new InvalidOperationException(err.Trim().Split('\n')[0]);
            Log.Write("HEVC: instalada");
            return null;
        }
        catch (Exception ex)
        {
            Log.Write("HEVC: " + ex.Message);
            return ex.Message;
        }
        finally { try { File.Delete(file); } catch { } }
    }
}
