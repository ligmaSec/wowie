# Launch exactly one provider in a kill-on-close Job Object. This process owns
# the sole job handle; even forced termination kills every contained descendant.
$ErrorActionPreference = 'Stop'
$specFile = $env:WOWIE_PROVIDER_SPEC_FILE
Remove-Item Env:WOWIE_PROVIDER_SPEC_FILE
$spec = [IO.File]::ReadAllText($specFile) | ConvertFrom-Json
Remove-Item -LiteralPath $specFile
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public static class WowieOwnedProvider {
    [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS {
        public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
        public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }
    [StructLayout(LayoutKind.Sequential)] struct BASIC_LIMITS {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)] struct EXTENDED_LIMITS {
        public BASIC_LIMITS BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct STARTUPINFO {
        public uint cb;
        public string lpReserved, lpDesktop, lpTitle;
        public uint dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public ushort wShowWindow, cbReserved2;
        public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }
    [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION {
        public IntPtr hProcess, hThread;
        public uint dwProcessId, dwThreadId;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref EXTENDED_LIMITS info, uint size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int kind);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateProcess(string application, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string directory, ref STARTUPINFO startup, out PROCESS_INFORMATION process);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] static extern void ExitProcess(uint code);

    static string Quote(string value) {
        var result = new StringBuilder("\"");
        int slashes = 0;
        foreach (char c in value) {
            if (c == '\\') { slashes++; continue; }
            result.Append('\\', c == '"' ? slashes * 2 + 1 : slashes);
            result.Append(c); slashes = 0;
        }
        result.Append('\\', slashes * 2); result.Append('"');
        return result.ToString();
    }
    static void Check(bool success) { if (!success) throw new Win32Exception(Marshal.GetLastWin32Error()); }
    public static void Run(string file, string[] args, string directory, string environment) {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        Check(job != IntPtr.Zero);
        var limits = new EXTENDED_LIMITS();
        limits.BasicLimitInformation.LimitFlags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        Check(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(EXTENDED_LIMITS))));
        Check(AssignProcessToJobObject(job, GetCurrentProcess()));
        var command = new StringBuilder(Quote(file));
        foreach (string arg in args) { command.Append(' '); command.Append(Quote(arg)); }
        var startup = new STARTUPINFO();
        startup.cb = (uint)Marshal.SizeOf(typeof(STARTUPINFO));
        startup.dwFlags = 0x100; // STARTF_USESTDHANDLES: preserve the provider's actual streams
        startup.hStdInput = GetStdHandle(-10); startup.hStdOutput = GetStdHandle(-11); startup.hStdError = GetStdHandle(-12);
        PROCESS_INFORMATION process;
        IntPtr environmentBlock = Marshal.StringToHGlobalUni(environment);
        try { Check(CreateProcess(null, command, IntPtr.Zero, IntPtr.Zero, true, 0x08000400, environmentBlock, directory, ref startup, out process)); }
        finally { Marshal.FreeHGlobal(environmentBlock); }
        CloseHandle(process.hThread);
        Check(WaitForSingleObject(process.hProcess, 0xffffffff) == 0);
        uint code; Check(GetExitCodeProcess(process.hProcess, out code));
        CloseHandle(process.hProcess);
        // ExitProcess preserves the real exit status while kernel handle teardown
        // closes our sole job handle and terminates any surviving descendants.
        ExitProcess(code);
    }
}
'@
[WowieOwnedProvider]::Run([string]$spec.file, [string[]]$spec.args, [string]$spec.cwd, [string]$spec.environment)
