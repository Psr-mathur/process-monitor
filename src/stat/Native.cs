using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace Stat
{
    /// <summary>Win32 calls used by the collector. Everything here is read-only.</summary>
    internal static class Native
    {
        public const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

        [StructLayout(LayoutKind.Sequential)]
        public struct PROCESS_MEMORY_COUNTERS_EX
        {
            public uint cb;
            public uint PageFaultCount;
            public UIntPtr PeakWorkingSetSize;
            public UIntPtr WorkingSetSize;
            public UIntPtr QuotaPeakPagedPoolUsage;
            public UIntPtr QuotaPagedPoolUsage;
            public UIntPtr QuotaPeakNonPagedPoolUsage;
            public UIntPtr QuotaNonPagedPoolUsage;
            public UIntPtr PagefileUsage;
            public UIntPtr PeakPagefileUsage;
            public UIntPtr PrivateUsage;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct IO_COUNTERS
        {
            public ulong ReadOperationCount;
            public ulong WriteOperationCount;
            public ulong OtherOperationCount;
            public ulong ReadTransferCount;
            public ulong WriteTransferCount;
            public ulong OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct PROCESSENTRY32W
        {
            public uint dwSize;
            public uint cntUsage;
            public uint th32ProcessID;
            public IntPtr th32DefaultHeapID;
            public uint th32ModuleID;
            public uint cntThreads;
            public uint th32ParentProcessID;
            public int pcPriClassBase;
            public uint dwFlags;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
            public string szExeFile;
        }

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern SafeProcessHandle OpenProcess(uint access, bool inheritHandle, int processId);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool GetProcessTimes(SafeProcessHandle process,
            out long creationTime, out long exitTime, out long kernelTime, out long userTime);

        [DllImport("kernel32.dll", SetLastError = true, EntryPoint = "K32GetProcessMemoryInfo")]
        public static extern bool GetProcessMemoryInfo(SafeProcessHandle process,
            out PROCESS_MEMORY_COUNTERS_EX counters, uint size);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool GetProcessIoCounters(SafeProcessHandle process, out IO_COUNTERS counters);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool GetProcessHandleCount(SafeProcessHandle process, out uint handleCount);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern bool Process32FirstW(IntPtr snapshot, ref PROCESSENTRY32W entry);

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern bool Process32NextW(IntPtr snapshot, ref PROCESSENTRY32W entry);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr handle);

        [DllImport("iphlpapi.dll", SetLastError = true)]
        private static extern uint GetExtendedTcpTable(IntPtr table, ref int size, bool order,
            int addressFamily, int tableClass, uint reserved);

        public delegate bool ConsoleCtrlHandler(int ctrlType);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool SetConsoleCtrlHandler(ConsoleCtrlHandler handler, bool add);

        public struct ProcessEntry
        {
            public string Name;
            public int Threads;
        }

        /// <summary>One snapshot of every process: executable name and thread count, keyed by PID.</summary>
        public static Dictionary<int, ProcessEntry> SnapshotProcesses()
        {
            const uint TH32CS_SNAPPROCESS = 0x00000002;
            var result = new Dictionary<int, ProcessEntry>();
            IntPtr snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if (snapshot == IntPtr.Zero || snapshot == new IntPtr(-1))
                throw new Win32Exception(Marshal.GetLastWin32Error());
            try
            {
                var entry = new PROCESSENTRY32W { dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32W)) };
                if (!Process32FirstW(snapshot, ref entry)) return result;
                do
                {
                    string exe = entry.szExeFile ?? "";
                    string name = exe.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)
                        ? exe.Substring(0, exe.Length - 4) : exe;
                    result[(int)entry.th32ProcessID] = new ProcessEntry { Name = name, Threads = (int)entry.cntThreads };
                } while (Process32NextW(snapshot, ref entry));
            }
            finally
            {
                CloseHandle(snapshot);
            }
            return result;
        }

        /// <summary>Maps each listening TCP port (IPv4 and IPv6) to the PIDs that own it.</summary>
        public static Dictionary<int, HashSet<int>> GetTcpListeners()
        {
            var map = new Dictionary<int, HashSet<int>>();
            ReadListenerTable(2, 24, 8, 20, map);   // AF_INET:  MIB_TCPROW_OWNER_PID
            ReadListenerTable(23, 56, 20, 52, map); // AF_INET6: MIB_TCP6ROW_OWNER_PID
            return map;
        }

        private static void ReadListenerTable(int addressFamily, int rowSize, int portOffset, int pidOffset,
            Dictionary<int, HashSet<int>> map)
        {
            const int TCP_TABLE_OWNER_PID_LISTENER = 3;
            const uint ERROR_INSUFFICIENT_BUFFER = 122;
            int size = 0;
            uint rc = GetExtendedTcpTable(IntPtr.Zero, ref size, false, addressFamily, TCP_TABLE_OWNER_PID_LISTENER, 0);
            for (int attempt = 0; attempt < 5; attempt++)
            {
                if (rc != ERROR_INSUFFICIENT_BUFFER && rc != 0) return;
                IntPtr buffer = Marshal.AllocHGlobal(size);
                try
                {
                    rc = GetExtendedTcpTable(buffer, ref size, false, addressFamily, TCP_TABLE_OWNER_PID_LISTENER, 0);
                    if (rc == ERROR_INSUFFICIENT_BUFFER) continue; // table grew between calls
                    if (rc != 0) return;
                    int count = Marshal.ReadInt32(buffer);
                    for (int i = 0; i < count; i++)
                    {
                        int row = 4 + i * rowSize;
                        int rawPort = Marshal.ReadInt32(buffer, row + portOffset);
                        int port = ((rawPort & 0xFF) << 8) | ((rawPort >> 8) & 0xFF); // network byte order
                        int pid = Marshal.ReadInt32(buffer, row + pidOffset);
                        if (!map.TryGetValue(port, out var pids)) map[port] = pids = new HashSet<int>();
                        pids.Add(pid);
                    }
                    return;
                }
                finally
                {
                    Marshal.FreeHGlobal(buffer);
                }
            }
        }
    }
}
