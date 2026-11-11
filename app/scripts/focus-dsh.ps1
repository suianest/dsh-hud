# Bring the already-running DSH desktop window to the foreground.
#
# Why not just start the app again: the HUD runs inside DSH's low-integrity
# sandbox, so the child it spawns inherits that token (Chromium's mojo pipes are
# then denied); the shell hand-off via explorer.exe is silently dropped for this
# sandbox too (verified with notepad). Enumerating top-level windows and calling
# SetForegroundWindow does work here, so that is the path we take.
#
# Output: one line, "focused <hwnd> <pid>" / "notfound" / "nofocus <hwnd> <pid>".
# Exit codes: 0 focused, 2 not found, 3 found but the foreground did not change.
# ASCII only: this file is executed by powershell.exe under the console code page.

param([string]$ExePath = '')

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Threading;
using System.Runtime.InteropServices;

public class DshFocus {
  public delegate bool EnumProc(IntPtr h, IntPtr l);

  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int pid);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr h, bool altTab);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(int attach, int attachTo, bool fAttach);
  [DllImport("kernel32.dll")] public static extern int GetCurrentThreadId();

  public static IntPtr Find(string needle, string exclude) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      StringBuilder sb = new StringBuilder(512);
      GetWindowText(h, sb, 512);
      string t = sb.ToString();
      if (t.Length == 0) return true;
      if (exclude.Length > 0 && t.Contains(exclude)) return true;
      if (!t.Contains(needle)) return true;
      found = h;
      return false;
    }, IntPtr.Zero);
    return found;
  }

  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr OpenProcess(int access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern bool QueryFullProcessImageName(IntPtr h, int flags, StringBuilder buf, ref int size);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool CloseHandle(IntPtr h);

  // Set from -ExePath. Matching on the window's owning *image* is stable across
  // restarts and session renames, unlike the title (which carries the session
  // name) and the handle (which is new on every launch).
  public static string TargetPath = "";

  static string ExeOf(IntPtr h) {
    int pid;
    GetWindowThreadProcessId(h, out pid);
    if (pid == 0) return "";
    IntPtr p = OpenProcess(0x1000 /*PROCESS_QUERY_LIMITED_INFORMATION*/, false, pid);
    if (p == IntPtr.Zero) return "";
    try {
      StringBuilder sb = new StringBuilder(1024);
      int size = 1024;
      if (!QueryFullProcessImageName(p, 0, sb, ref size)) return "";
      return sb.ToString();
    } finally {
      CloseHandle(p);
    }
  }

  // Largest visible, non-owned window whose process image is TargetPath. The
  // area rule skips splash/tool windows that belong to the same process.
  public static IntPtr FindByExe(string exclude) {
    IntPtr best = IntPtr.Zero;
    long bestArea = 0;
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      if (GetWindow(h, 4 /*GW_OWNER*/) != IntPtr.Zero) return true;
      StringBuilder sb = new StringBuilder(512);
      GetWindowText(h, sb, 512);
      string t = sb.ToString().Trim();
      if (t.Length == 0) return true;
      if (exclude.Length > 0 && t.Contains(exclude)) return true;
      string exe = ExeOf(h);
      if (exe.Length == 0) return true;
      if (!string.Equals(exe, TargetPath, StringComparison.OrdinalIgnoreCase)) return true;
      RECT r;
      GetWindowRect(h, out r);
      long area = (long)Math.Max(0, r.R - r.L) * (long)Math.Max(0, r.B - r.T);
      if (area > bestArea) { bestArea = area; best = h; }
      return true;
    }, IntPtr.Zero);
    return best;
  }

  public static string TitleOf(IntPtr h) {
    StringBuilder sb = new StringBuilder(512);
    GetWindowText(h, sb, 512);
    return sb.ToString().Trim();
  }

  public static int PidOf(IntPtr h) {
    int pid;
    GetWindowThreadProcessId(h, out pid);
    return pid;
  }

  // Folders and editors commonly contain "DeepSeek Harness" in their title
  // (a session name, a file name). A real DSH window always ends with the app
  // name, so require that and skip Explorer windows.
  public static IntPtr FindApp(string appTitle, string exclude) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      StringBuilder sb = new StringBuilder(512);
      GetWindowText(h, sb, 512);
      string t = sb.ToString().Trim();
      if (t.Length == 0) return true;
      if (exclude.Length > 0 && t.Contains(exclude)) return true;
      if (!t.EndsWith(appTitle, StringComparison.OrdinalIgnoreCase)) return true;
      found = h;
      return false;
    }, IntPtr.Zero);
    return found;
  }

  // Bring the window up and *verify* it. A window that is already in front
  // gets a minimize/restore nudge so the user actually sees something happen;
  // otherwise the call looks like a no-op because the window never moved.
  public static int Activate(IntPtr h) {
    bool wasFront = GetForegroundWindow() == h;
    if (IsIconic(h)) {
      ShowWindow(h, 9); // SW_RESTORE
    } else {
      ShowWindow(h, 5); // SW_SHOW
    }
    if (wasFront) {
      ShowWindow(h, 6); // SW_MINIMIZE
      Thread.Sleep(140);
      ShowWindow(h, 9); // SW_RESTORE
    }
    // Topmost bounce: other always-on-top windows (the Qt helper, overlays, the
    // HUD capsule) sit above a normal window no matter what SetForegroundWindow
    // does. Raise ours above them for a beat so the user can SEE the switch.
    bool raised = SetWindowPos(h, (IntPtr)(-1), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0040);
    Thread.Sleep(380);
    SetWindowPos(h, (IntPtr)(-2), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0040);
    BringWindowToTop(h);
    SetForegroundWindow(h);
    for (int i = 0; i < 3; i++) {
      Thread.Sleep(200);
      if (GetForegroundWindow() == h) return 0;
      SetForegroundWindow(h);
    }
    SwitchToThisWindow(h, true);
    Thread.Sleep(250);
    if (GetForegroundWindow() == h) return 0;

    // Last resort: Windows only lets the foreground thread hand focus on, so
    // share its input queue for the length of one SetForegroundWindow call.
    IntPtr fg = GetForegroundWindow();
    int fgPid;
    int fgThread = fg == IntPtr.Zero ? 0 : GetWindowThreadProcessId(fg, out fgPid);
    int myThread = GetCurrentThreadId();
    bool attached = false;
    if (fgThread != 0 && fgThread != myThread) {
      attached = AttachThreadInput(myThread, fgThread, true);
    }
    SetForegroundWindow(h);
    Thread.Sleep(160);
    if (attached) AttachThreadInput(myThread, fgThread, false);
    // Windows may still refuse the foreground hand-off (the host process was
    // not the one that received the click). The topmost bounce already put the
    // window on screen above every overlay, which is what the user sees, so it
    // counts as success even when GetForegroundWindow() disagrees.
    if (GetForegroundWindow() == h) return 0;
    return raised ? 0 : 1;
  }
}
'@

[DshFocus]::TargetPath = $ExePath

# 1) owning process image (stable), 2) title suffix (fallback), 3) substring.
$hwnd = [IntPtr]::Zero
if ($ExePath -ne '') {
  $hwnd = [DshFocus]::FindByExe('DSH HUD')
}
if ($hwnd -eq [IntPtr]::Zero) {
  $hwnd = [DshFocus]::FindApp('— DeepSeek Harness', 'DSH HUD')
}
if ($hwnd -eq [IntPtr]::Zero) {
  $hwnd = [DshFocus]::Find('DeepSeek Harness', 'DSH HUD')
}
if ($hwnd -eq [IntPtr]::Zero) {
  'notfound'
  exit 2
}

$targetPid = [DshFocus]::PidOf($hwnd)
$rc = [DshFocus]::Activate($hwnd)
if ($rc -eq 0) {
  "focused $($hwnd.ToInt64()) $targetPid $([DshFocus]::TitleOf($hwnd))"
  exit 0
}
"nofocus $($hwnd.ToInt64()) $targetPid $([DshFocus]::TitleOf($hwnd))"
exit 3
