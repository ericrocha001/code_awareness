using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Threading;

internal static class ControlledHelper
{
    internal static int Main(string[] args)
    {
        var mode = args.Length == 0 ? "wait" : args[0];
        var directory = Environment.GetEnvironmentVariable("PREVIEW_SESSION_DIRECTORY");
        var session = Environment.GetEnvironmentVariable("PREVIEW_SESSION_ID");
        var eventHandle = Win32.OpenEvent(0x100000, false, "Local\\CodeAwareness.Preview.Stop." + session);
        IntPtr nested = IntPtr.Zero;
        if (mode == "nested") {
            nested = Win32.CreateJobObject(IntPtr.Zero, null);
            var limits = new Win32.ExtendedLimits(); limits.basic.flags = Win32.KillOnClose;
            Win32.Check(Win32.SetInformationJobObject(nested, 9, ref limits, Marshal.SizeOf(typeof(Win32.ExtendedLimits))), "NESTED_POLICY_FAILED");
            Win32.Check(Win32.AssignProcessToJobObject(nested, Win32.GetCurrentProcess()), "NESTED_ASSIGNMENT_FAILED");
        }
        if (mode == "tree" || mode == "orphan" || mode == "nested") {
            for (int i = 0; i < 4; i++) {
                var child = Process.Start(new ProcessStartInfo(Process.GetCurrentProcess().MainModule.FileName, "wait") { UseShellExecute = false, CreateNoWindow = true });
                child.Dispose();
            }
        }
        if (mode == "breakaway") {
            var startup = new Win32.StartupInfoEx(); startup.startup.cb = Marshal.SizeOf(typeof(Win32.StartupInfo));
            Win32.ProcessInfo child;
            bool escaped = Win32.CreateProcessW(Process.GetCurrentProcess().MainModule.FileName, new System.Text.StringBuilder("\"" + Process.GetCurrentProcess().MainModule.FileName + "\" wait"), IntPtr.Zero, IntPtr.Zero, false, 0x01000000, IntPtr.Zero, directory, ref startup, out child);
            File.WriteAllText(Path.Combine(directory, "breakaway.txt"), escaped ? "ESCAPED" : Marshal.GetLastWin32Error().ToString());
            if (escaped) { Win32.CloseHandle(child.thread); Win32.CloseHandle(child.process); }
        }
        TcpListener listener = null;
        if (mode == "listener") {
            listener = new TcpListener(IPAddress.Loopback, 0); listener.Start();
            File.WriteAllText(Path.Combine(directory, "port.txt"), ((IPEndPoint)listener.LocalEndpoint).Port.ToString());
        }
        File.WriteAllText(Path.Combine(directory, Process.GetCurrentProcess().Id + ".ready"), Win32.Creation(Win32.GetCurrentProcess()).ToString());
        if (mode == "orphan") return 0;
        if (mode == "ignore" || eventHandle == IntPtr.Zero) Thread.Sleep(120000);
        else Win32.WaitForSingleObject(eventHandle, 120000);
        if (listener != null) listener.Stop();
        if (eventHandle != IntPtr.Zero) Win32.CloseHandle(eventHandle);
        if (nested != IntPtr.Zero) Win32.CloseHandle(nested);
        return 0;
    }
}
