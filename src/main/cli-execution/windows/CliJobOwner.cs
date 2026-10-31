using System;
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
    [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int which);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 65536 };
    private static void Send(StreamWriter writer, object value) { writer.WriteLine(Json.Serialize(value)); writer.Flush(); }
    private static void Main(string[] args)
    {
        try { Run(args); } catch { }
    }
    private static void Run(string[] args)
    {
        if (args.Length != 1) return;
        IntPtr job = IntPtr.Zero, root = IntPtr.Zero, thread = IntPtr.Zero;
        IntPtr attributes = IntPtr.Zero, jobs = IntPtr.Zero, handles = IntPtr.Zero;
        bool initialized = false, resumed = false;
        using (var pipe = new NamedPipeClientStream(".", args[0], PipeDirection.InOut)) {
            pipe.Connect(5000);
            using (var reader = new StreamReader(pipe, Encoding.UTF8))
            using (var writer = new StreamWriter(pipe, new UTF8Encoding(false))) {
                try {
                    Send(writer, new { phase = "READY", version = 1 });
                    var launch = Json.Deserialize<CliLaunch>(reader.ReadLine());
#if CLI_TEST
                    if (launch.fault == "job") throw new Exception("JOB_CREATION_FAILED");
#endif
                    job = Win32.CreateJobObject(IntPtr.Zero, null);
                    Win32.Check(job != IntPtr.Zero, "JOB_CREATION_FAILED");
                    var limits = new Win32.ExtendedLimits(); limits.basic.flags = Win32.KillOnClose;
                    Win32.Check(Win32.SetInformationJobObject(job, 9, ref limits, Marshal.SizeOf(typeof(Win32.ExtendedLimits))), "JOB_POLICY_FAILED");
                    IntPtr size = IntPtr.Zero;
                    Win32.InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref size);
                    attributes = Marshal.AllocHGlobal(size);
                    Win32.Check(Win32.InitializeProcThreadAttributeList(attributes, 2, 0, ref size), "ATTRIBUTE_FAILED"); initialized = true;
                    jobs = Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(jobs, job);
#if CLI_TEST
                    if (launch.fault == "assignment") Marshal.WriteIntPtr(jobs, new IntPtr(-123));
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
                        foreach (string arg in launch.args) command.Append(' ').Append(Win32.Quote(arg));
                        if (launch.commandLine != null) {
                            if (!String.Equals(Path.GetFileName(launch.executable), "cmd.exe", StringComparison.OrdinalIgnoreCase)) throw new Exception("INVALID_INTERPRETER");
                            command = new StringBuilder(launch.commandLine);
                        }
                        if (command.Length > 30000) throw new Exception("COMMAND_LIMIT");
                        Win32.ProcessInfo process;
                        Win32.Check(Win32.CreateProcessW(launch.executable, command, IntPtr.Zero, IntPtr.Zero, true, 0x00080000 | 0x08000000 | 4, IntPtr.Zero, launch.cwd, ref startup, out process), "CREATE_PROCESS_FAILED");
                        root = process.process; thread = process.thread;
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
                        if (stopping) Win32.Check(Win32.TerminateJobObject(job, 1), "JOB_TERMINATION_FAILED");
                        uint active = Win32.Active(job);
                        bool exited = Win32.WaitForSingleObject(root, 0) == Win32.WaitSignaled;
                        if (active == 0 && exited) {
                            uint code; Win32.Check(Win32.GetExitCodeProcess(root, out code), "EXIT_CODE_UNAVAILABLE");
                            Win32.Check(Win32.CloseHandle(root), "PROCESS_CLOSE_FAILED"); root = IntPtr.Zero;
                            Win32.Check(Win32.CloseHandle(job), "JOB_CLOSE_FAILED"); job = IntPtr.Zero;
                            Send(writer, new { phase = "TERMINAL", version = 1, activeProcesses = 0, handlesClosed = true, exitCode = code });
                            return;
                        }
                        Send(writer, new { phase = "OBSERVATION", version = 1, activeProcesses = active });
                        action = reader.ReadLine();
                        if (action == "terminate") stopping = true;
                        else if (action != "inspect") throw new Exception("CONTROL_LOST");
                        Thread.Sleep(10);
                    }
                } catch (Exception error) {
                    try {
                        bool drained = job == IntPtr.Zero;
                        if (job != IntPtr.Zero) {
                            Win32.Check(Win32.TerminateJobObject(job, 1), "JOB_TERMINATION_FAILED");
                            var deadline = DateTime.UtcNow.AddSeconds(3);
                            do { drained = Win32.Active(job) == 0; if (!drained) Thread.Sleep(10); } while (!drained && DateTime.UtcNow < deadline);
                        }
                        if (!drained || (root != IntPtr.Zero && Win32.WaitForSingleObject(root, 0) != Win32.WaitSignaled)) throw new Exception("TERMINATION_UNCONFIRMED");
                        foreach (IntPtr handle in new IntPtr[] { thread, root, job }) if (handle != IntPtr.Zero) Win32.Check(Win32.CloseHandle(handle), "HANDLE_CLOSE_FAILED");
                        thread = root = job = IntPtr.Zero;
                        Send(writer, new { phase = "TERMINAL", version = 1, activeProcesses = 0, handlesClosed = true, exitCode = 1, diagnostic = error is NativeFailure ? error.Message : "NATIVE_CONTROL_FAILED" });
                    } catch { try { Send(writer, new { phase = "ERROR", version = 1, code = "TERMINATION_UNCONFIRMED" }); } catch { } }
                } finally {
                    if (job != IntPtr.Zero) { Win32.TerminateJobObject(job, 1); Win32.CloseHandle(job); }
                    if (root != IntPtr.Zero) Win32.CloseHandle(root);
                    if (thread != IntPtr.Zero) Win32.CloseHandle(thread);
                    if (initialized) Win32.DeleteProcThreadAttributeList(attributes);
                    foreach (IntPtr value in new IntPtr[] { attributes, jobs, handles }) if (value != IntPtr.Zero) Marshal.FreeHGlobal(value);
                }
            }
        }
    }
}
