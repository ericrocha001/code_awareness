using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

internal sealed class Launch
{
    public string sessionId, operationId, directory, slotKey, executable, executableHash, cwd, spawn, graceful;
    public string[] args;
    public Dictionary<string, string> env;
    public int graceMs, forceMs, hostPid;
#if PREVIEW_TEST
    public string fault;
#endif
}
internal sealed class PreviewOwner : IDisposable
{
    private readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = 65536 };
    private IntPtr job, root, shutdown;
    private uint rootPid; private string rootCreated;
    private bool used, rootSignaled, launched, stopped, jobClosed, eventClosed;
    private uint? rootExitCode;
    private string rootExitAt, rootExitReason = "ROOT_NOT_EXITED";
    private bool rootExitJournaled;
    private Mutex slot; private bool ownsSlot;
    private string directory, sessionId, operationId, phase;
#if PREVIEW_TEST
    private IntPtr leakedReference;
    private bool exitCodeUnavailable;
#endif
    private static string JobName(string id) { return "Local\\CodeAwareness.Preview." + id; }
    private static string EventName(string id) { return "Local\\CodeAwareness.Preview.Stop." + id; }
    private void Journal(string next, object evidence)
    {
        var path = Path.Combine(directory, "native.jsonl");
        if (File.Exists(path) && new FileInfo(path).Length > 65536) throw new Exception("NATIVE_JOURNAL_LIMIT");
        var bytes = Encoding.UTF8.GetBytes(json.Serialize(new { schemaVersion = 1, sessionId = sessionId, operationId = operationId, phase = next, at = DateTime.UtcNow.ToString("o"), ownerPid = Process.GetCurrentProcess().Id, ownerCreated = Win32.Creation(Win32.GetCurrentProcess()).ToString(), evidence = evidence }) + "\n");
        using (var file = new FileStream(path, FileMode.Append, FileAccess.Write, FileShare.Read, 4096, FileOptions.WriteThrough)) { file.Write(bytes, 0, bytes.Length); file.Flush(true); }
        phase = next;
    }
    private bool Member(IntPtr process)
    {
        bool value; Win32.Check(Win32.IsProcessInJob(process, job, out value), "JOB_MEMBERSHIP_UNVERIFIED"); return value;
    }
    private bool HostOutside(int pid)
    {
        var handle = Win32.OpenProcess(0x1000, false, (uint)pid);
        if (handle == IntPtr.Zero) throw new NativeFailure("HOST_IDENTITY_UNVERIFIED", Marshal.GetLastWin32Error());
        try { return !Member(handle); } finally { Win32.CloseHandle(handle); }
    }
    internal object Start(Launch launch)
    {
        if (used) throw new Exception("OWNER_ALREADY_USED");
        used = true;
#if PREVIEW_TEST
        exitCodeUnavailable = launch.fault == "exit-code-unavailable";
#endif
        Guid parsed;
        if (!Guid.TryParse(launch.sessionId, out parsed) || !Guid.TryParse(launch.operationId, out parsed) || !Path.IsPathRooted(launch.directory) || !Path.IsPathRooted(launch.executable) || !Path.IsPathRooted(launch.cwd) || launch.spawn != "JOB_LIST_AT_CREATE") throw new Exception("INVALID_LAUNCH");
        if (launch.forceMs < 1 || launch.forceMs > 120000 || launch.graceMs < 0 || launch.graceMs > 120000 || (launch.graceful != "NONE" && launch.graceful != "SESSION_EVENT")) throw new Exception("INVALID_SHUTDOWN");
        sessionId = launch.sessionId; operationId = launch.operationId; directory = launch.directory;
        slot = new Mutex(false, "Local\\CodeAwareness.Preview.Slot." + launch.slotKey);
        try { ownsSlot = slot.WaitOne(0); } catch (AbandonedMutexException) { ownsSlot = true; }
        if (!ownsSlot) throw new Exception("PREVIEW_SESSION_BUSY");
        Journal("PREPARING", null);
        job = Win32.CreateJobObject(IntPtr.Zero, JobName(sessionId)); int jobError = Marshal.GetLastWin32Error();
        if (jobError == 183 && job != IntPtr.Zero) { Win32.CloseHandle(job); job = IntPtr.Zero; }
        if (job == IntPtr.Zero) throw new NativeFailure("JOB_CREATION_FAILED", jobError);
        var limits = new Win32.ExtendedLimits(); limits.basic.flags = Win32.KillOnClose;
        Win32.Check(Win32.SetInformationJobObject(job, 9, ref limits, Marshal.SizeOf(typeof(Win32.ExtendedLimits))), "JOB_POLICY_FAILED");
        shutdown = Win32.CreateEvent(IntPtr.Zero, true, false, EventName(sessionId)); int eventError = Marshal.GetLastWin32Error();
        if (eventError == 183 && shutdown != IntPtr.Zero) { Win32.CloseHandle(shutdown); shutdown = IntPtr.Zero; }
        if (shutdown == IntPtr.Zero) throw new NativeFailure("RESOURCE_COLLISION", eventError);
        if (Member(Win32.GetCurrentProcess()) || !HostOutside(launch.hostPid)) throw new Exception("HOST_ISOLATION_FAILED");
        Journal("PREPARED", new { killOnClose = true, breakaway = false, ownerOutsideJob = true, hostOutsideJob = true });
#if PREVIEW_TEST
        if (launch.fault == "before-create") throw new Exception("INJECTED_BEFORE_CREATE");
        if (launch.fault == "crash-before-create") Environment.FailFast("Controlled owner failure before native create");
#endif
        IntPtr size = IntPtr.Zero, attributes = IntPtr.Zero, jobList = IntPtr.Zero, environment = IntPtr.Zero;
        bool attributesReady = false;
        try {
            Win32.InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
            attributes = Marshal.AllocHGlobal(size);
            Win32.Check(Win32.InitializeProcThreadAttributeList(attributes, 1, 0, ref size), "JOB_ATTRIBUTE_UNAVAILABLE"); attributesReady = true;
            jobList = Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(jobList, job);
#if PREVIEW_TEST
            if (launch.fault == "assignment-failure") Marshal.WriteIntPtr(jobList, new IntPtr(-123));
#endif
            Win32.Check(Win32.UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x2000D), jobList, new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero), "JOB_ATTRIBUTE_UNAVAILABLE");
            var values = new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (var pair in launch.env) {
                if (pair.Key.IndexOfAny(new char[] { '\0', '=' }) >= 0 || pair.Value.IndexOf('\0') >= 0) throw new Exception("INVALID_ENVIRONMENT");
                values.Add(pair.Key, pair.Value);
            }
            var block = String.Join("\0", values.Select(p => p.Key + "=" + p.Value).ToArray()) + "\0\0";
            environment = Marshal.StringToHGlobalUni(block);
            var command = new StringBuilder(Win32.Quote(launch.executable));
            foreach (string argument in launch.args) command.Append(' ').Append(Win32.Quote(argument));
            if (command.Length > 30000) throw new Exception("COMMAND_LIMIT");
            var startup = new Win32.StartupInfoEx(); startup.startup.cb = Marshal.SizeOf(typeof(Win32.StartupInfoEx)); startup.attributes = attributes;
            Win32.ProcessInfo process;
            bool created; int createError;
            using (var image = new FileStream(launch.executable, FileMode.Open, FileAccess.Read, FileShare.Read)) {
                using (var sha = SHA256.Create()) {
                    string fingerprint = BitConverter.ToString(sha.ComputeHash(image)).Replace("-", "").ToLowerInvariant();
                    if (fingerprint != launch.executableHash) throw new Exception("EXECUTABLE_CHANGED");
                }
                Journal("CREATE_REQUESTED", null);
                created = Win32.CreateProcessW(launch.executable, command, IntPtr.Zero, IntPtr.Zero, false, 0x00080000 | 0x00000400 | 0x08000000, environment, launch.cwd, ref startup, out process);
                createError = Marshal.GetLastWin32Error();
            }
            if (!created) { Journal("CREATE_REJECTED", new { win32 = createError }); throw new NativeFailure("CREATE_PROCESS_FAILED", createError); }
            root = process.process; rootPid = process.pid; Win32.CloseHandle(process.thread); launched = true;
#if PREVIEW_TEST
            if (launch.fault == "crash-before-create-receipt") Environment.FailFast("Controlled loss of native create acknowledgement");
#endif
            rootCreated = Win32.Creation(root).ToString();
            if (!Member(root)) throw new Exception("JOB_ASSIGNMENT_FAILURE");
#if PREVIEW_TEST
            if (launch.fault == "receipt-after-create") {
                using (var locked = new FileStream(Path.Combine(directory, "native.jsonl"), FileMode.Open, FileAccess.Read, FileShare.Read)) Journal("RUNNING", null);
            }
#endif
            Journal("RUNNING", new { pid = rootPid, created = rootCreated, assignedAtCreation = true });
#if PREVIEW_TEST
            if (launch.fault == "after-create") throw new Exception("INJECTED_AFTER_CREATE");
            if (launch.fault == "retain-reference") Win32.Check(Win32.DuplicateHandle(Win32.GetCurrentProcess(), root, Win32.GetCurrentProcess(), out leakedReference, 0, false, 2), "DUPLICATE_FAILED");
#endif
            return Observe();
        } finally {
            if (attributesReady) Win32.DeleteProcThreadAttributeList(attributes);
            foreach (var pointer in new IntPtr[] { attributes, jobList, environment }) if (pointer != IntPtr.Zero) Marshal.FreeHGlobal(pointer);
        }
    }
    private void ReleaseExitedRoot()
    {
        if (root != IntPtr.Zero) {
            uint wait = Win32.WaitForSingleObject(root, 0);
            if (wait == Win32.WaitSignaled) {
                if (!rootSignaled) {
                    rootSignaled = true; rootExitAt = DateTime.UtcNow.ToString("o");
                    uint code;
#if PREVIEW_TEST
                    if (exitCodeUnavailable) rootExitReason = "EXIT_CODE_UNAVAILABLE";
                    else
#endif
                    if (Win32.GetExitCodeProcess(root, out code)) { rootExitCode = code; rootExitReason = "EXIT_CODE_OBSERVED"; }
                    else rootExitReason = "EXIT_CODE_UNAVAILABLE";
                }
                Win32.Check(Win32.CloseHandle(root), "PROCESS_HANDLE_CLOSE_FAILED"); root = IntPtr.Zero;
            } else if (wait != Win32.WaitTimeout) throw new NativeFailure("PROCESS_WAIT_FAILED", Marshal.GetLastWin32Error());
        }
        if (rootSignaled && !rootExitJournaled) {
            Journal("ROOT_EXITED", new { pid = rootPid, created = rootCreated, rootExit = RootExit() });
            rootExitJournaled = true;
        }
    }
    private object RootExit() { return new { status = rootExitCode.HasValue ? "KNOWN" : "UNKNOWN", code = rootExitCode, reasonCode = launched ? rootExitReason : "ROOT_NOT_CREATED", observedAt = rootExitAt }; }
    private bool HandlesClosed()
    {
#if PREVIEW_TEST
        if (leakedReference != IntPtr.Zero) return false;
#endif
        return root == IntPtr.Zero;
    }
    internal object Observe()
    {
        if (job == IntPtr.Zero && !stopped) throw new Exception("OWNERSHIP_UNVERIFIED");
        ReleaseExitedRoot();
        return new { pid = rootPid, created = rootCreated, rootSignaled = rootSignaled, knownHandlesClosed = HandlesClosed(), activeProcesses = jobClosed ? 0 : Win32.Active(job), jobClosed = jobClosed, eventClosed = eventClosed, assignedAtCreation = launched, ownerOutsideJob = jobClosed || !Member(Win32.GetCurrentProcess()), phase = phase, rootExit = RootExit() };
    }
    private bool Drained()
    {
        ReleaseExitedRoot();
        return (!launched || rootSignaled) && HandlesClosed() && Win32.Active(job) == 0;
    }
    private bool WaitDrain(int timeout)
    {
        var clock = Stopwatch.StartNew();
        do { if (Drained()) return true; Thread.Sleep(10); } while (clock.ElapsedMilliseconds < timeout);
        return Drained();
    }
    internal object Stop(int graceMs, int forceMs, bool graceful, bool noTerminate)
    {
        if (stopped) return Observe();
        if (job == IntPtr.Zero) throw new Exception("OWNERSHIP_UNVERIFIED");
        if (graceMs < 0 || graceMs > 120000 || forceMs < 1 || forceMs > 120000) throw new Exception("INVALID_SHUTDOWN");
        if (graceful) Win32.Check(Win32.SetEvent(shutdown), "GRACEFUL_SIGNAL_FAILED");
        bool drained = WaitDrain(graceful ? graceMs : 0);
        if (!drained && !noTerminate) { Win32.Check(Win32.TerminateJobObject(job, 1), "JOB_TERMINATION_FAILED"); drained = WaitDrain(forceMs); }
        if (!drained) { Journal("CLEANUP_INCOMPLETE", Observe()); return Observe(); }
        if (shutdown != IntPtr.Zero) Win32.Check(Win32.CloseHandle(shutdown), "EVENT_CLOSE_FAILED"); shutdown = IntPtr.Zero; eventClosed = true;
        Win32.Check(Win32.CloseHandle(job), "JOB_CLOSE_FAILED"); job = IntPtr.Zero; jobClosed = true; stopped = true;
        Journal("DRAINED", Observe());
        return Observe();
    }
    internal static object Reconcile(string id, uint pid, string created)
    {
        Guid parsed; if (!Guid.TryParse(id, out parsed)) throw new Exception("INVALID_SESSION_ID");
        var handle = Win32.OpenJobObject(4, false, JobName(id)); int error = Marshal.GetLastWin32Error();
        uint? active = null;
        try { if (handle != IntPtr.Zero) active = Win32.Active(handle); }
        finally { if (handle != IntPtr.Zero) Win32.CloseHandle(handle); }
        bool? sameProcessAlive = null;
        if (pid != 0 && created != null) {
            var process = Win32.OpenProcess(0x1000 | 0x100000, false, pid);
            if (process != IntPtr.Zero) {
                try { sameProcessAlive = Win32.Creation(process).ToString() == created && Win32.WaitForSingleObject(process, 0) == Win32.WaitTimeout; }
                finally { Win32.CloseHandle(process); }
            } else if (Marshal.GetLastWin32Error() == 87) sameProcessAlive = false;
        }
        return new { jobPresent = handle != IntPtr.Zero, jobQueryError = handle == IntPtr.Zero ? error : 0, activeProcesses = active, sameProcessAlive = sameProcessAlive, adopted = false, terminated = false };
    }
    private object Endpoint(int port)
    {
        if (port < 1 || port > 65535 || (job == IntPtr.Zero && !stopped)) throw new Exception("INVALID_ENDPOINT");
        int size = 0;
        Win32.GetExtendedTcpTable(IntPtr.Zero, ref size, true, 2, 3, 0);
        if (size < 4 || size > 16777216) throw new Exception("ENDPOINT_TABLE_UNAVAILABLE");
        var table = Marshal.AllocHGlobal(size);
        var matches = new List<object>();
        try {
            uint error = Win32.GetExtendedTcpTable(table, ref size, true, 2, 3, 0);
            if (error != 0) throw new NativeFailure("ENDPOINT_TABLE_UNAVAILABLE", (int)error);
            int count = Marshal.ReadInt32(table);
            if (count < 0 || 4L + count * 24L > size) throw new Exception("ENDPOINT_TABLE_INVALID");
            for (int i = 0; i < count; i++) {
                var row = IntPtr.Add(table, 4 + i * 24);
                uint rawPort = (uint)Marshal.ReadInt32(row, 8);
                if ((((rawPort & 255) << 8) | ((rawPort >> 8) & 255)) != port) continue;
                uint pid = (uint)Marshal.ReadInt32(row, 20);
                uint address = (uint)Marshal.ReadInt32(row, 4);
                var process = Win32.OpenProcess(0x1000, false, pid);
                if (process == IntPtr.Zero) throw new NativeFailure("ENDPOINT_OWNER_UNVERIFIABLE", Marshal.GetLastWin32Error());
                try { matches.Add(new { pid = pid, created = Win32.Creation(process).ToString(), member = !jobClosed && Member(process), loopback = address == 0x0100007f }); }
                finally { Win32.CloseHandle(process); }
            }
        } finally { Marshal.FreeHGlobal(table); }
        return new { port = port, listeners = matches.ToArray() };
    }
    private object Processes(bool metrics = false)
    {
        if (job == IntPtr.Zero) throw new Exception("OWNERSHIP_UNVERIFIED");
        int size = 8 + 128 * IntPtr.Size;
        var buffer = Marshal.AllocHGlobal(size);
        var processes = new List<object>();
        try {
            Win32.Check(Win32.QueryInformationJobObject(job, 3, buffer, size, IntPtr.Zero), "PROCESS_COVERAGE_UNVERIFIABLE");
            int count = Marshal.ReadInt32(buffer, 4);
            if (count < 0 || count > 128) throw new Exception("PROCESS_COVERAGE_LIMIT");
            for (int i = 0; i < count; i++) {
                uint pid = checked((uint)Marshal.ReadIntPtr(buffer, 8 + i * IntPtr.Size).ToInt64());
                var handle = Win32.OpenProcess(0x1000, false, pid);
                if (handle == IntPtr.Zero) throw new NativeFailure("PROCESS_COVERAGE_UNVERIFIABLE", Marshal.GetLastWin32Error());
                try {
                    if (!Member(handle)) throw new Exception("PROCESS_COVERAGE_CHANGED");
                    if (metrics) {
                        var memory = new Win32.MemoryCounters(); memory.cb = (uint)Marshal.SizeOf(typeof(Win32.MemoryCounters));
                        Win32.Check(Win32.GetProcessMemoryInfo(handle, ref memory, memory.cb), "PROCESS_MEMORY_UNVERIFIABLE");
                        long created, exited, kernel, user;
                        Win32.Check(Win32.GetProcessTimes(handle, out created, out exited, out kernel, out user), "PROCESS_CPU_UNVERIFIABLE");
                        processes.Add(new { pid = pid, created = created.ToString(), workingSetBytes = memory.workingSet.ToUInt64(),
                            privateWorkingSetBytes = memory.privateWorkingSet.ToUInt64(), privateBytes = memory.privateUsage.ToUInt64(), cpuMs = (kernel + user) / 10000.0 });
                    } else processes.Add(new { pid = pid, created = Win32.Creation(handle).ToString() });
                } finally { Win32.CloseHandle(handle); }
            }
        } finally { Marshal.FreeHGlobal(buffer); }
        return new { processes = processes.ToArray() };
    }
    public void Dispose()
    {
#if PREVIEW_TEST
        if (leakedReference != IntPtr.Zero) { Win32.CloseHandle(leakedReference); leakedReference = IntPtr.Zero; }
#endif
        foreach (var handle in new IntPtr[] { root, shutdown, job }) if (handle != IntPtr.Zero) Win32.CloseHandle(handle);
        root = shutdown = job = IntPtr.Zero;
        if (ownsSlot) { slot.ReleaseMutex(); ownsSlot = false; }
        if (slot != null) slot.Dispose();
    }
    private object Command(Dictionary<string, object> message)
    {
        var action = (string)message["action"];
        if (action == "start") return Start(json.ConvertToType<Launch>(message["launch"]));
        if (action == "inspect") return Observe();
        if (action == "endpoint") return Endpoint(Convert.ToInt32(message["port"]));
        if (action == "processes") return Processes();
        if (action == "metrics") return Processes(true);
        if (action == "stop") {
            bool noTerminate = false;
#if PREVIEW_TEST
            noTerminate = message.ContainsKey("noTerminate") && (bool)message["noTerminate"];
#else
            if (message.ContainsKey("noTerminate")) throw new Exception("INVALID_ARGUMENT");
#endif
            return Stop(Convert.ToInt32(message["graceMs"]), Convert.ToInt32(message["forceMs"]), (bool)message["graceful"], noTerminate);
        }
        if (action == "reconcile") return Reconcile((string)message["sessionId"], Convert.ToUInt32(message["pid"]), message["created"] as string);
#if PREVIEW_TEST
        if (action == "crash-member") {
            uint pid = Convert.ToUInt32(message["pid"]);
            var process = Win32.OpenProcess(0x1000 | 1, false, pid);
            if (process == IntPtr.Zero) throw new Exception("TEST_TARGET_UNVERIFIABLE");
            try {
                if (!Member(process) || Win32.Creation(process).ToString() != (string)message["created"]) throw new Exception("TEST_TARGET_NOT_OWNED");
                Win32.Check(Win32.TerminateProcess(process, 99), "TEST_CRASH_FAILED");
            } finally { Win32.CloseHandle(process); }
            return Observe();
        }
        if (action == "release-reference") { if (leakedReference != IntPtr.Zero) Win32.CloseHandle(leakedReference); leakedReference = IntPtr.Zero; return Observe(); }
#endif
        throw new Exception("INVALID_ACTION");
    }
    internal static int Main()
    {
        using (var owner = new PreviewOwner()) {
            string line;
            while ((line = Console.ReadLine()) != null) {
                object id = null;
                bool starting = false;
                try {
                    if (line.Length > 65536) throw new Exception("REQUEST_LIMIT");
                    var message = owner.json.Deserialize<Dictionary<string, object>>(line); id = message["id"];
                    starting = (string)message["action"] == "start" && !owner.used;
                    var result = owner.Command(message);
                    Console.WriteLine(owner.json.Serialize(new { id = id, success = true, result = result }));
                } catch (Exception error) {
                    object cleanup = null;
                    try { if (starting && owner.job != IntPtr.Zero) cleanup = owner.Stop(0, 5000, false, false); } catch { }
                    Console.WriteLine(owner.json.Serialize(new { id = id, success = false, code = error is NativeFailure ? error.Message : error.Message.StartsWith("INJECTED_") ? error.Message : "NATIVE_OPERATION_FAILED", win32 = error is NativeFailure ? ((NativeFailure)error).NativeCode : 0, cleanup = cleanup }));
                }
                Console.Out.Flush();
            }
        }
        return 0;
    }
}
