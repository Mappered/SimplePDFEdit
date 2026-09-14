// The single-file executable of the app.
//
// The app, the Electron runtime and qpdf travel inside this exe as an embedded
// payload.zip. On first run (or after a new build) the payload is unpacked into
// %LOCALAPPDATA%\PDFStreamEditor; then the app is started from there and this exe
// exits immediately, leaving the app running on its own.
//
// Command line arguments are passed on to the app, so opening a PDF from the shell or
// by dropping a file onto the exe works:
//     PDFStreamEditor.exe "C:\path\to\document.pdf"
//
// Compiled with /target:winexe (no console window) and /win32icon. Diagnostics go to
// %TEMP%\pdfstream-editor-launch.log. __STAMP__ is replaced per build by build.ps1.
using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Text;

internal static class Starter
{
    private const string Stamp = "__STAMP__";
    private const string AppFolder = "__APPFOLDER__";
    private const string PayloadName = "payload.zip";

    private static readonly string LogPath = Path.Combine(Path.GetTempPath(), "pdfstream-editor-launch.log");

    [STAThread]
    private static int Main(string[] args)
    {
        try
        {
            string target = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), AppFolder);
            string exe = Path.Combine(Path.Combine(target, "runtime"), "electron.exe");
            string appDir = Path.Combine(target, "app");
            string stampFile = Path.Combine(target, "stamp.txt");
            string have = File.Exists(stampFile) ? File.ReadAllText(stampFile).Trim() : string.Empty;

            if (!string.Equals(have, Stamp, StringComparison.OrdinalIgnoreCase))
            {
                Log("unpacking into " + target);
                bool unpacked = false;
                try
                {
                    if (Directory.Exists(target)) Directory.Delete(target, true);
                    Directory.CreateDirectory(target);
                    using (Stream payload = Assembly.GetExecutingAssembly().GetManifestResourceStream(PayloadName))
                    {
                        if (payload == null) throw new FileNotFoundException("the embedded " + PayloadName + " is missing");
                        using (ZipArchive zip = new ZipArchive(payload, ZipArchiveMode.Read))
                        {
                            Extract(zip, target);
                        }
                    }
                    File.WriteAllText(stampFile, Stamp);
                    unpacked = true;
                }
                catch (Exception ex)
                {
                    // Most likely a previous copy is still running and holding its files.
                    Log("unpack failed (" + ex.Message + ")");
                }

                if (!unpacked && !File.Exists(exe))
                {
                    Log("giving up: nothing runnable at " + exe);
                    return 1;
                }
                Log(unpacked ? "unpacked" : "continuing with the existing copy");
            }

            ProcessStartInfo psi = new ProcessStartInfo(exe);
            psi.Arguments = Quote(appDir) + ForwardArgs(args);
            psi.WorkingDirectory = target;
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            Process.Start(psi);
            Log("started " + exe + " with [" + string.Join("] [", args) + "] -> " + psi.Arguments);
            return 0;
        }
        catch (Exception ex)
        {
            Log("FAILED: " + ex);
            return 1;
        }
    }

    private static void Extract(ZipArchive zip, string target)
    {
        string root = Path.GetFullPath(target) + Path.DirectorySeparatorChar;
        foreach (ZipArchiveEntry entry in zip.Entries)
        {
            string path = Path.GetFullPath(Path.Combine(target, entry.FullName));
            if (!path.StartsWith(root, StringComparison.OrdinalIgnoreCase))
                throw new IOException("refusing to extract outside the target folder: " + entry.FullName);
            if (entry.Name.Length == 0)
            {
                Directory.CreateDirectory(path);
                continue;
            }
            Directory.CreateDirectory(Path.GetDirectoryName(path));
            entry.ExtractToFile(path, true);
        }
    }

    // Passes the user's arguments on unchanged, except that paths that resolve relative
    // to the shell's directory are made absolute - the app runs with its install folder
    // as the working directory, where a relative path would no longer resolve.
    private static string ForwardArgs(string[] args)
    {
        if (args == null || args.Length == 0) return string.Empty;

        StringBuilder sb = new StringBuilder();
        string cwd = Directory.GetCurrentDirectory();
        foreach (string arg in args)
        {
            string value = arg;
            if (value.Length > 0 && value[0] != '-' && value[0] != '/' && !Path.IsPathRooted(value))
            {
                try
                {
                    string full = Path.GetFullPath(Path.Combine(cwd, value));
                    if (File.Exists(full)) value = full;
                }
                catch (Exception ex)
                {
                    Log("could not resolve \"" + arg + "\" (" + ex.Message + ")");
                }
            }
            sb.Append(' ').Append(Quote(value));
        }
        return sb.ToString();
    }

    // Windows command line quoting (backslashes are doubled before a quote).
    private static string Quote(string value)
    {
        if (value.Length > 0 && value.IndexOfAny(new[] { ' ', '\t', '"' }) < 0) return value;

        StringBuilder sb = new StringBuilder("\"");
        int backslashes = 0;
        foreach (char c in value)
        {
            if (c == '\\') { backslashes++; continue; }
            if (c == '"') { sb.Append('\\', (backslashes * 2) + 1).Append('"'); backslashes = 0; continue; }
            sb.Append('\\', backslashes).Append(c);
            backslashes = 0;
        }
        sb.Append('\\', backslashes * 2).Append('"');
        return sb.ToString();
    }

    private static void Log(string message)
    {
        try
        {
            File.AppendAllText(LogPath, "[" + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "] " + message + Environment.NewLine);
        }
        catch
        {
            // logging must never get in the way
        }
    }
}
