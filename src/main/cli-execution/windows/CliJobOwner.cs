using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

internal sealed class CliLaunch
{
    public string executable, cwd, commandLine;
    public string[] args;
#if CLI_TEST
    public string fault;
#endif
}
internal sealed class CliJobOwner
{
    internal const int ExitUnconfirmed = 1;
    internal const int ExitPreCreateConfirmed = 204;
    internal const int ExitCleanupConfirmed = 205;

    [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int which);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 65536 };
    private static void Send(StreamWriter writer, object value) { writer.WriteLine(Json.Serialize(value)); writer.Flush(); }
    private static int Main(string[] args)
    {
        Environment.ExitCode = ExitUnconfirmed;
        try
        {
            int code = Run(args);
            Environment.ExitCode = code;
            return code;
        }
        catch
        {
            Environment.ExitCode = ExitUnconfirmed;
            return ExitUnconfirmed;
        }
    }
#if CLI_TEST
    private static string ResolveFault(CliLaunch launch)
    {
        if (!String.IsNullOrEmpty(launch.fault)) return launch.fault;
        if (launch.args != null)
        {
            foreach (string arg in launch.args)
            {
                if (arg != null && arg.StartsWith("--ca-cli-test-fault="))
                    return arg.Substring("--ca-cli-test-fault=".Length);
            }
        }
        return null;
    }
    private static int Probe(string[] args)
    {
        string jobName = "Local\\" + args[1];
        IntPtr handle = Win32.OpenJobObject(4, false, jobName);
        int jobError = handle == IntPtr.Zero ? Marshal.GetLastWin32Error() : 0;
        uint? active = null;
        try
        {
            if (handle != IntPtr.Zero) active = Win32.Active(handle);
        }
        finally
        {
            if (handle != IntPtr.Zero) Win32.CloseHandle(handle);
        }
        var alivePids = new List<uint>();
        for (int i = 2; i < args.Length; i++)
        {
            uint pid;
            if (!UInt32.TryParse(args[i], out pid)) continue;
            IntPtr proc = Win32.OpenProcess(0x1000 | 0x100000, false, pid);
            if (proc != IntPtr.Zero)
            {
                try
                {
                    if (Win32.WaitForSingleObject(proc, 0) == Win32.WaitTimeout) alivePids.Add(pid);
                }
                finally { Win32.CloseHandle(proc); }
            }
        }
        Console.WriteLine(Json.Serialize(new
        {
            jobPresent = handle != IntPtr.Zero,
            jobQueryError = jobError,
            activeProcesses = active,
            alivePids = alivePids.ToArray()
        }));
        return ExitUnconfirmed;
    }
#endif
    private static int Run(string[] args)
    {
#if CLI_TEST
        if (args.Length >= 2 && args[0] == "--probe") return Probe(args);
#endif
        if (args.Length != 1) return ExitUnconfirmed;
        IntPtr job = IntPtr.Zero, root = IntPtr.Zero, thread = IntPtr.Zero;
        IntPtr attributes = IntPtr.Zero, jobs = IntPtr.Zero, handles = IntPtr.Zero;
        bool initialized = false, resumed = false, processCreated = false;
        int outcome = ExitUnconfirmed;
#if CLI_TEST
        string fault = null;
        bool delayedDrain = false;
#endif
        StreamReader reader = null;
        StreamWriter writer = null;
        using (var pipe = new NamedPipeClientStream(".", args[0], PipeDirection.InOut)) {
            try {
                pipe.Connect(5000);
                reader = new StreamReader(pipe, Encoding.UTF8);
                writer = new StreamWriter(pipe, new UTF8Encoding(false));
                Send(writer, new { phase = "READY", version = 1 });
                string launchLine = reader.ReadLine();
                if (String.IsNullOrEmpty(launchLine)) throw new Exception("CONTROL_LOST");
                var launch = Json.Deserialize<CliLaunch>(launchLine);
                if (launch == null) throw new Exception("CONTROL_LOST");
#if CLI_TEST
                fault = ResolveFault(launch);
                if (fault == "precreate-delay") { Thread.Sleep(900); throw new NativeFailure("PRE_CREATE_ABORT", 0); }
                if (fault == "precreate-unconfirmed") { Thread.Sleep(900); return ExitUnconfirmed; }
                if (fault == "job") throw new Exception("JOB_CREATION_FAILED");
#endif
                job = Win32.CreateJobObject(IntPtr.Zero, "Local\\" + args[0]);
                int jobError = Marshal.GetLastWin32Error();
                if (jobError == 183 && job != IntPtr.Zero) { Win32.CloseHandle(job); job = IntPtr.Zero; }
                if (job == IntPtr.Zero) throw new NativeFailure("JOB_CREATION_FAILED", jobError);
                var limits = new Win32.ExtendedLimits(); limits.basic.flags = Win32.KillOnClose;
                Win32.Check(Win32.SetInformationJobObject(job, 9, ref limits, Marshal.SizeOf(typeof(Win32.ExtendedLimits))), "JOB_POLICY_FAILED");
                IntPtr size = IntPtr.Zero;
                Win32.InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref size);
                attributes = Marshal.AllocHGlobal(size);
                Win32.Check(Win32.InitializeProcThreadAttributeList(attributes, 2, 0, ref size), "ATTRIBUTE_FAILED"); initialized = true;
                jobs = Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(jobs, job);
#if CLI_TEST
                if (fault == "assignment") Marshal.WriteIntPtr(jobs, new IntPtr(-123));
#endif
                Win32.Check(Win32.UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x2000D), jobs, new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero), "JOB_ASSIGNMENT_FAILED");
                var inherited = new IntPtr[3];
                try {
                    for (int i = 0; i < 3; i++) Win32.Check(Win32.DuplicateHandle(Win32.GetCurrentProcess(), GetStdHandle(-10-i), Win32.GetCurrentProcess(), out inherited[i], 0, true, 2), "IO_HANDLE_FAILED");
                    handles = Marshal.AllocHGlobal(IntPtr.Size * 3);
                    for (int i = 0; i < 3; i++) Marshal.WriteIntPtr(handles, IntPtr.Size*i, inherited[i]);
                    Win32.Check(Win32.UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x20002), handles, new IntPtr(IntPtr.Size*3), IntPtr.Zero, IntPtr.Zero), "IO_ATTRIBUTE_FAILED");
                    var startup = new Win32.StartupInfoEx(); startup.startup.cb = Marshal.SizeOf(typeof(Win32.StartupInfoEx)); startup.attributes = attributes;
                    startup.startup.flags = 0x100; startup.startup.input = inherited[0]; startup.startup.output = inherited[1]; startup.startup.error = inherited[2];
                    var command = new StringBuilder(Win32.Quote(launch.executable));
                    if (launch.args != null) foreach (string arg in launch.args) command.Append(' ').Append(Win32.Quote(arg));
                    if (launch.commandLine != null) {
                        if (!String.Equals(Path.GetFileName(launch.executable), "cmd.exe", StringComparison.OrdinalIgnoreCase)) throw new Exception("INVALID_INTERPRETER");
                        command = new StringBuilder(launch.commandLine);
                    }
                    if (command.Length > 30000) throw new Exception("COMMAND_LIMIT");
                    Win32.ProcessInfo process;
                    bool created = Win32.CreateProcessW(launch.executable, command, IntPtr.Zero, IntPtr.Zero, true, 0x00080000 | 0x08000000 | 4, IntPtr.Zero, launch.cwd, ref startup, out process);
                    int createError = Marshal.GetLastWin32Error();
                    if (created) { root = process.process; thread = process.thread; processCreated = true; }
                    if (!created) throw new NativeFailure("CREATE_PROCESS_FAILED", createError);
                    bool member;
                    Win32.Check(Win32.IsProcessInJob(root, job, out member) && member, "JOB_MEMBERSHIP_UNVERIFIED");
                    Send(writer, new { phase = "OWNED", version = 1, pid = process.pid, activeProcesses = Win32.Active(job), assignedAtCreation = true, suspended = true });
                } finally { foreach (IntPtr handle in inherited) if (handle != IntPtr.Zero) Win32.CloseHandle(handle); }
                string action = reader.ReadLine();
                if (action == "resume") {
                    Win32.Check(ResumeThread(thread) != UInt32.MaxValue, "RESUME_FAILED"); resumed = true;
                    Send(writer, new { phase = "RUNNING", version = 1 });
                } else if (action != "terminate") throw new Exception("AUTHORIZATION_REVOKED");
                Win32.Check(Win32.CloseHandle(thread), "THREAD_CLOSE_FAILED"); thread = IntPtr.Zero;
                bool stopping = !resumed;
                while (true) {
#if CLI_TEST
                    if (stopping && fault == "postcreate-drain-delay" && !delayedDrain) { delayedDrain = true; Thread.Sleep(350); }
                    if (stopping && (fault == "active-job" || fault == "handle-close")) throw new Exception(fault == "active-job" ? "TERMINATION_UNCONFIRMED" : "HANDLE_CLOSE_FAILED");
#endif
                    if (stopping) Win32.Check(Win32.TerminateJobObject(job, 1), "JOB_TERMINATION_FAILED");
                    uint active = Win32.Active(job);
                    bool exited = Win32.WaitForSingleObject(root, 0) == Win32.WaitSignaled;
                    if (active == 0 && exited) {
                        uint code; Win32.Check(Win32.GetExitCodeProcess(root, out code), "EXIT_CODE_UNAVAILABLE");
                        Win32.Check(Win32.CloseHandle(root), "PROCESS_CLOSE_FAILED"); root = IntPtr.Zero;
                        Win32.Check(Win32.CloseHandle(job), "JOB_CLOSE_FAILED"); job = IntPtr.Zero;
#if CLI_TEST
                        if (fault == "unknown-exit") return 77;
                        if (fault == "drop-terminal") { outcome = ExitCleanupConfirmed; return outcome; }
#endif
                        outcome = ExitCleanupConfirmed;
                        try { Send(writer, new { phase = "TERMINAL", version = 1, activeProcesses = 0, handlesClosed = true, exitCode = code }); } catch { }
                        return outcome;
                    }
                    Send(writer, new { phase = "OBSERVATION", version = 1, activeProcesses = active });
                    action = reader.ReadLine();
                    if (action == "terminate") stopping = true;
                    else if (action != "inspect") throw new Exception("CONTROL_LOST");
                    Thread.Sleep(10);
                }
            } catch (Exception error) {
                try {
                    if (outcome == ExitUnconfirmed) {
#if CLI_TEST
                        if (fault == "postcreate-drain-delay" && processCreated && !delayedDrain) { delayedDrain = true; Thread.Sleep(350); }
#endif
                        bool drained = job == IntPtr.Zero && (root == IntPtr.Zero || Win32.WaitForSingleObject(root, 0) == Win32.WaitSignaled);
                        if (job != IntPtr.Zero) {
                            Win32.Check(Win32.TerminateJobObject(job, 1), "JOB_TERMINATION_FAILED");
                            var deadline = DateTime.UtcNow.AddSeconds(3);
                            do {
                                drained = Win32.Active(job) == 0 && (root == IntPtr.Zero || Win32.WaitForSingleObject(root, 0) == Win32.WaitSignaled);
                                if (!drained) Thread.Sleep(10);
                            } while (!drained && DateTime.UtcNow < deadline);
                        }
#if CLI_TEST
                        if (fault == "active-job") drained = false;
#endif
                        if (!drained || (root != IntPtr.Zero && Win32.WaitForSingleObject(root, 0) != Win32.WaitSignaled)) throw new Exception("TERMINATION_UNCONFIRMED");
#if CLI_TEST
                        if (fault == "handle-close") throw new Exception("HANDLE_CLOSE_FAILED");
#endif
                        foreach (IntPtr handle in new IntPtr[] { thread, root, job }) if (handle != IntPtr.Zero) Win32.Check(Win32.CloseHandle(handle), "HANDLE_CLOSE_FAILED");
                        thread = root = job = IntPtr.Zero;
#if CLI_TEST
                        if (fault == "unknown-exit") { outcome = 77; return outcome; }
                        if (fault == "drop-terminal") { outcome = processCreated ? ExitCleanupConfirmed : ExitPreCreateConfirmed; return outcome; }
#endif
                        outcome = processCreated ? ExitCleanupConfirmed : ExitPreCreateConfirmed;
                    }
                    if (writer != null) {
                        Send(writer, new { phase = "TERMINAL", version = 1, activeProcesses = 0, handlesClosed = true, exitCode = 1, diagnostic = error is NativeFailure ? error.Message : "NATIVE_CONTROL_FAILED" });
                    }
                } catch {
                    if (outcome == ExitUnconfirmed && writer != null) {
                        try { Send(writer, new { phase = "ERROR", version = 1, code = "TERMINATION_UNCONFIRMED" }); } catch { }
                    }
                }
            } finally {
                if (job != IntPtr.Zero) { Win32.TerminateJobObject(job, 1); Win32.CloseHandle(job); }
                if (root != IntPtr.Zero) Win32.CloseHandle(root);
                if (thread != IntPtr.Zero) Win32.CloseHandle(thread);
                if (initialized) Win32.DeleteProcThreadAttributeList(attributes);
                foreach (IntPtr value in new IntPtr[] { attributes, jobs, handles }) if (value != IntPtr.Zero) Marshal.FreeHGlobal(value);
                if (writer != null) { try { writer.Dispose(); } catch { } }
                if (reader != null) { try { reader.Dispose(); } catch { } }
            }
        }
        return outcome;
    }
}
