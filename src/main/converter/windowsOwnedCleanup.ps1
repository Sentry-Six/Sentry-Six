$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
# Input is data on stdin, never interpolated into executable PowerShell.
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using Microsoft.Win32.SafeHandles;
public static class SentryOwnedCleanup {
  [StructLayout(LayoutKind.Sequential)]
  struct Info {
    public uint Attributes;
    public System.Runtime.InteropServices.ComTypes.FILETIME Creation, Access, Write;
    public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool GetFileInformationByHandle(SafeFileHandle handle, out Info info);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool SetFileInformationByHandle(SafeFileHandle handle, int type, ref uint flags, uint size);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool SetFileInformationByHandle(SafeFileHandle handle, int type, IntPtr buffer, uint size);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool FlushFileBuffers(SafeFileHandle handle);
  static string Verify(SafeFileHandle handle, string device, string inode, long size, string digest) {
    Info info;
    if (!GetFileInformationByHandle(handle, out info)) return "failed:" + Marshal.GetLastWin32Error();
    ulong id = ((ulong)info.IndexHigh << 32) | info.IndexLow;
    ulong length = ((ulong)info.SizeHigh << 32) | info.SizeLow;
    if ((info.Attributes & (0x10u | 0x400u)) != 0 || info.Volume.ToString() != device || id.ToString() != inode || length != (ulong)size) return "mismatch";
    // Borrow the handle for hashing; leave its owning SafeFileHandle alive.
    using (var borrowed = new SafeFileHandle(handle.DangerousGetHandle(), false))
    using (var stream = new FileStream(borrowed, FileAccess.Read))
    using (var sha = SHA256.Create()) {
      return BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", "").ToLowerInvariant() == digest ? "verified" : "mismatch";
    }
  }
  public static string Rename(string path, string destination, string device, string inode, long size, string digest) {
    using (var handle = CreateFile(path, 0x80010000, 1, IntPtr.Zero, 3, 0x00200000, IntPtr.Zero)) {
      if (handle.IsInvalid) return "failed:" + Marshal.GetLastWin32Error();
      string verified = Verify(handle, device, inode, size, digest);
      if (verified != "verified") return verified;
      byte[] name = System.Text.Encoding.Unicode.GetBytes(destination);
      // FILE_RENAME_INFO: BOOLEAN/union at 0, aligned HANDLE, DWORD, WCHAR[].
      int rootOffset = IntPtr.Size == 8 ? 8 : 4;
      int nameOffset = rootOffset + IntPtr.Size + 4;
      int bytes = nameOffset + name.Length + 2;
      IntPtr buffer = Marshal.AllocHGlobal(bytes);
      try {
        Marshal.Copy(new byte[bytes], 0, buffer, bytes); // ReplaceIfExists = FALSE
        Marshal.WriteInt32(buffer, rootOffset + IntPtr.Size, name.Length);
        Marshal.Copy(name, 0, IntPtr.Add(buffer, nameOffset), name.Length);
        return SetFileInformationByHandle(handle, 3, buffer, (uint)bytes) ? "renamed" : "failed:" + Marshal.GetLastWin32Error();
      } finally { Marshal.FreeHGlobal(buffer); }
    }
  }
  public static string GuardedRemove(string path, string device, string inode, long size, string digest,
      string guardPath, string guardDevice, string guardInode, long guardSize, string guardDigest) {
    // Write access is required by FlushFileBuffers. Sharing READ only keeps the
    // verified final immutable and undeletable until backup deletion completes.
    using (var guard = CreateFile(guardPath, 0xC0000000, 1, IntPtr.Zero, 3, 0x00200000, IntPtr.Zero)) {
      if (guard.IsInvalid) {
        int error = Marshal.GetLastWin32Error();
        return error == 2 || error == 3 ? "guard-missing" : "failed:" + error;
      }
      string verified = Verify(guard, guardDevice, guardInode, guardSize, guardDigest);
      if (verified != "verified") return verified == "mismatch" ? "guard-mismatch" : verified;
      if (!FlushFileBuffers(guard)) return "failed:" + Marshal.GetLastWin32Error();
      return Remove(path, device, inode, size, digest);
    }
  }
  public static string Remove(string path, string device, string inode, long size, string digest) {
    // READ + DELETE; share READ only: reject concurrent writers/deleters.
    // OPEN_EXISTING + OPEN_REPARSE_POINT: never follow a final symlink.
    using (var handle = CreateFile(path, 0x80010000, 1, IntPtr.Zero, 3, 0x00200000, IntPtr.Zero)) {
      if (handle.IsInvalid) {
        int error = Marshal.GetLastWin32Error();
        return error == 2 || error == 3 ? "missing" : "failed:" + error;
      }
      Info info;
      if (!GetFileInformationByHandle(handle, out info)) return "failed:" + Marshal.GetLastWin32Error();
      ulong id = ((ulong)info.IndexHigh << 32) | info.IndexLow;
      ulong length = ((ulong)info.SizeHigh << 32) | info.SizeLow;
      if ((info.Attributes & (0x10u | 0x400u)) != 0 || info.Volume.ToString() != device || id.ToString() != inode || length != (ulong)size)
        return "mismatch";
      using (var stream = new FileStream(handle, FileAccess.Read))
      using (var sha = SHA256.Create()) {
        string actual = BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
        if (actual != digest) return "mismatch";
        // FileDispositionInfoEx: DELETE | IGNORE_READONLY_ATTRIBUTE. This
        // applies only to the verified handle, never a newly resolved path.
        uint delete = 0x11;
        if (!SetFileInformationByHandle(handle, 21, ref delete, 4)) {
          // Older filesystems may support classic disposition for writable
          // files. Never change attributes through a path-based fallback.
          if ((info.Attributes & 1u) != 0) return "failed:" + Marshal.GetLastWin32Error();
          delete = 1;
          if (!SetFileInformationByHandle(handle, 4, ref delete, 4)) return "failed:" + Marshal.GetLastWin32Error();
        }
      }
    }
    return "removed";
  }
}
'@
if ($request.operation -eq 'rename') {
  $result = [SentryOwnedCleanup]::Rename([string]$request.target, [string]$request.destination, [string]$request.expected.device, [string]$request.expected.inode, [long]$request.expected.size, [string]$request.expected.sha256)
} elseif ($null -ne $request.guard) {
  $result = [SentryOwnedCleanup]::GuardedRemove([string]$request.target, [string]$request.expected.device, [string]$request.expected.inode, [long]$request.expected.size, [string]$request.expected.sha256, [string]$request.guard.target, [string]$request.guard.expected.device, [string]$request.guard.expected.inode, [long]$request.guard.expected.size, [string]$request.guard.expected.sha256)
} else {
  $result = [SentryOwnedCleanup]::Remove([string]$request.target, [string]$request.expected.device, [string]$request.expected.inode, [long]$request.expected.size, [string]$request.expected.sha256)
}
[Console]::Out.Write($result)
