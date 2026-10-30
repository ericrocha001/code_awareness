using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

internal sealed class CliJobOwner
{
    private static void Main(string[] args)
    {
        if (args.Length < 1)
        {
            Console.WriteLine("{\"success\":false,\"error\":\"MISSING_PID\"}");
            return;
        }
        uint pid;
        if (!uint.TryParse(args[0], out pid))
        {
            Console.WriteLine("{\"success\":false,\"error\":\"INVALID_PID\"}");
            return;
        }

        IntPtr job = Win32.CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero)
        {
            Console.WriteLine("{\"success\":false,\"error\":\"JOB_CREATION_FAILED\",\"code\":" + Marshal.GetLastWin32Error() + "}");
            return;
        }

        var limits = new Win32.ExtendedLimits();
        limits.basic.flags = Win32.KillOnClose;
        if (!Win32.SetInformationJobObject(job, 9, ref limits, Marshal.SizeOf(typeof(Win32.ExtendedLimits))))
        {
            Win32.CloseHandle(job);
            Console.WriteLine("{\"success\":false,\"error\":\"JOB_POLICY_FAILED\",\"code\":" + Marshal.GetLastWin32Error() + "}");
            return;
        }

        IntPtr process = Win32.OpenProcess(0x1F0FFF, false, pid);
        if (process == IntPtr.Zero)
        {
            Win32.CloseHandle(job);
            Console.WriteLine("{\"success\":false,\"error\":\"PROCESS_OPEN_FAILED\",\"code\":" + Marshal.GetLastWin32Error() + "}");
            return;
        }

        if (!Win32.AssignProcessToJobObject(job, process))
        {
            int err = Marshal.GetLastWin32Error();
            Win32.CloseHandle(process);
            Win32.CloseHandle(job);
            Console.WriteLine("{\"success\":false,\"error\":\"JOB_ASSIGNMENT_FAILED\",\"code\":" + err + "}");
            return;
        }

        Console.WriteLine("{\"success\":true,\"assignedPid\":" + pid + "}");
        Console.Out.Flush();

        string line;
        while ((line = Console.ReadLine()) != null)
        {
            line = line.Trim();
            if (line == "terminate")
            {
                Win32.TerminateJobObject(job, 1);
                Win32.WaitForSingleObject(process, 1000);
                uint active = Win32.Active(job);
                Console.WriteLine("{\"success\":true,\"action\":\"terminated\",\"activeProcesses\":" + active + "}");
                Console.Out.Flush();
                break;
            }
            else if (line == "inspect")
            {
                uint active = Win32.Active(job);
                Console.WriteLine("{\"success\":true,\"activeProcesses\":" + active + "}");
                Console.Out.Flush();
            }
        }

        Win32.CloseHandle(process);
        Win32.CloseHandle(job);
    }
}
