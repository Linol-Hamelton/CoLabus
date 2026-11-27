// Answers, for one absolute local path at a time, the Win32 code of FSCTL_GET_REPARSE_POINT on the entry itself
// (0: the entry carries a reparse tag; 4390: it is not a reparse point; anything else: the error of the open or the query).
// It never follows the entry, never writes, and returns no path. Wire, version 1, over the inherited stdin and stdout:
//   at start      H reparse-query 1\n
//   request       Q <id> <length>\n followed by <length> bytes of strict UTF-8 (ids count up from 1)
//   answer        A <id> <code>\n
// Any request that does not follow this grammar ends the process with exit code 2; end of input ends it with 0.
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

public static class ReparseQuery {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr security, uint disposition,
        uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool DeviceIoControl(SafeFileHandle handle, uint code, IntPtr input, uint inputSize, byte[] output,
        uint outputSize, out uint returned, IntPtr overlapped);

    const uint GenericRead = 0x80000000;
    // The narrowest share mode: an entry another process holds open for writing or deletion is not answered here.
    const uint ShareRead = 0x00000001;
    const uint OpenExisting = 3;
    const uint OpenReparsePoint = 0x00200000, BackupSemantics = 0x02000000;
    const uint GetReparsePoint = 0x000900A8;
    const int MaxPathBytes = 32768;
    const uint InvalidName = 123, InvalidFunction = 1, NotAReparsePoint = 4390;

    public static int Main() {
        Stream input = Console.OpenStandardInput();
        Stream output = Console.OpenStandardOutput();
        UTF8Encoding strict = new UTF8Encoding(false, true);
        Send(output, "H reparse-query 1\n");
        long expected = 1;
        while (true) {
            string header = ReadHeader(input);
            if (header == null) return 0;
            if (header.Length == 0) return 2;
            string[] parts = header.Split(' ');
            if (parts.Length != 3 || parts[0] != "Q" || !Decimal(parts[1], 18) || !Decimal(parts[2], 5)) return 2;
            if (long.Parse(parts[1]) != expected) return 2;
            int length = int.Parse(parts[2]);
            if (length < 1 || length > MaxPathBytes) return 2;
            byte[] bytes = ReadExact(input, length);
            if (bytes == null) return 2;
            string name;
            try { name = strict.GetString(bytes); } catch (ArgumentException) { return 2; }
            uint code = Query(name);
            Send(output, "A " + parts[1] + " " + code.ToString() + "\n");
            expected++;
        }
    }

    // A decimal without sign, leading zero or any other character, at most `digits` long.
    static bool Decimal(string text, int digits) {
        if (text.Length == 0 || text.Length > digits || text[0] == '0') return false;
        foreach (char c in text) if (c < '0' || c > '9') return false;
        return true;
    }

    // One header line of printable ASCII; null at end of input before its first byte, "" for anything malformed.
    static string ReadHeader(Stream input) {
        StringBuilder line = new StringBuilder();
        while (true) {
            int b = input.ReadByte();
            if (b < 0) return line.Length == 0 ? null : "";
            if (b == '\n') return line.ToString();
            if (b < 0x20 || b > 0x7e || line.Length >= 32) return "";
            line.Append((char)b);
        }
    }

    static byte[] ReadExact(Stream input, int length) {
        byte[] bytes = new byte[length];
        int read = 0;
        while (read < length) {
            int n = input.Read(bytes, read, length - read);
            if (n <= 0) return null;
            read += n;
        }
        return bytes;
    }

    static void Send(Stream output, string text) {
        byte[] bytes = Encoding.ASCII.GetBytes(text);
        output.Write(bytes, 0, bytes.Length);
        output.Flush();
    }

    // Only a plain local drive path is opened, under the extended prefix, so the entry asked about is the one this exact
    // spelling names; every other form (UNC, a device or extended prefix of the caller, a relative path, a component that
    // Win32 would rewrite or that names a stream) answers ERROR_INVALID_NAME and stays with the caller's own query.
    static uint Query(string name) {
        if (!Plain(name)) return InvalidName;
        using (SafeFileHandle handle = CreateFileW(@"\\?\" + name, GenericRead, ShareRead, IntPtr.Zero, OpenExisting,
                OpenReparsePoint | BackupSemantics, IntPtr.Zero)) {
            if (handle.IsInvalid) {
                uint open = (uint)Marshal.GetLastWin32Error();
                // Only the query itself may say "not a reparse point".
                return open == NotAReparsePoint || open == 0 ? InvalidFunction : open;
            }
            byte[] buffer = new byte[16384];
            uint returned;
            if (DeviceIoControl(handle, GetReparsePoint, IntPtr.Zero, 0, buffer, (uint)buffer.Length, out returned, IntPtr.Zero)) return 0;
            uint query = (uint)Marshal.GetLastWin32Error();
            return query == 0 ? InvalidFunction : query;
        }
    }

    static bool Plain(string name) {
        if (name.Length < 3 || name.Length > 32000) return false;
        char drive = name[0];
        if (!((drive >= 'A' && drive <= 'Z') || (drive >= 'a' && drive <= 'z')) || name[1] != ':' || name[2] != '\\') return false;
        if (name.Length == 3) return true;
        string[] components = name.Substring(3).Split('\\');
        foreach (string component in components) {
            if (component.Length == 0 || component == "." || component == "..") return false;
            char last = component[component.Length - 1];
            if (last == '.' || last == ' ') return false;
            foreach (char c in component) {
                if (c < 0x20 || c == '/' || c == ':' || c == '*' || c == '?' || c == '"' || c == '<' || c == '>' || c == '|') return false;
            }
        }
        return true;
    }
}
