// Queries the inherited stdin handle only. Never opens a file by name.
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class ReadHandle {
    [StructLayout(LayoutKind.Sequential)]
    public struct FileTime { public uint Low; public uint High; }
    [StructLayout(LayoutKind.Sequential)]
    public struct Info {
        public uint Attributes;
        public FileTime Creation, Access, Write;
        public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr GetStdHandle(int which);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern uint GetFinalPathNameByHandleW(IntPtr handle, StringBuilder text, uint length, uint flags);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetFileInformationByHandle(IntPtr handle, out Info info);

    public static int Main() {
        IntPtr h = GetStdHandle(-10);
        Info info;
        if (h == IntPtr.Zero || h == new IntPtr(-1) || !GetFileInformationByHandle(h, out info)) return 2;
        var text = new StringBuilder(32768);
        uint length = GetFinalPathNameByHandleW(h, text, (uint)text.Capacity, 0);
        if (length == 0 || length >= text.Capacity) return 3;
        string real = text.ToString();
        // A local DOS path is the only accepted native response. UNC stays unknown.
        if (!real.StartsWith(@"\\?\") || real.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase)) return 4;
        real = real.Substring(4);
        ulong id = ((ulong)info.IndexHigh << 32) | info.IndexLow;
        Console.WriteLine("{0}|{1}|{2}|{3}", Convert.ToBase64String(Encoding.UTF8.GetBytes(real)), info.Volume, id, info.Links);
        return 0;
    }
}
