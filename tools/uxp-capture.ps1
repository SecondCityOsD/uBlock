# uBlock Origin for UXP - screen capture of a test browser's windows
# Copyright (C) 2026-present uBlock-UXP contributors
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU General Public License as published by
# the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.
#
# Usage: powershell -File tools/uxp-capture.ps1 -ProcessId <pid> -OutFile <png>
#
# Captures the windows of one process, popups included, as they are stacked
# on the screen: each window draws itself (PrintWindow), so nothing else on
# the screen shows. A layered window (a popup) cannot draw itself: it is
# copied from the screen, and only if every point sampled across it belongs
# to the process (the popup, or the browser window beneath its transparent
# margin); else it is left out, magenta, and "occluded" printed: another
# application's window is over it. tools/uxp-test.mjs runs this for the
# debug harness (captureScreen()).

param([int]$ProcessId, [string]$OutFile)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class UxpCapture {
    public delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X, Y; }
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int index);
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT p);
    public static List<IntPtr> WindowsOf(uint pid) {
        var found = new List<IntPtr>();
        EnumWindows((h, l) => {
            uint owner;
            GetWindowThreadProcessId(h, out owner);
            if (owner == pid && IsWindowVisible(h)) { found.Add(h); }
            return true;
        }, IntPtr.Zero);
        return found;
    }
    // Whether the screen shows the process's own windows all over `r`.
    public static bool Shows(uint pid, RECT r) {
        for (int i = 0; i <= 8; i++) {
            for (int j = 0; j <= 8; j++) {
                var p = new POINT();
                p.X = r.Left + (r.Right - r.Left - 1) * i / 8;
                p.Y = r.Top + (r.Bottom - r.Top - 1) * j / 8;
                uint owner;
                GetWindowThreadProcessId(WindowFromPoint(p), out owner);
                if (owner != pid) { return false; }
            }
        }
        return true;
    }
}
'@
[void][UxpCapture]::SetProcessDPIAware()
$screenLeft = [UxpCapture]::GetSystemMetrics(76)
$screenTop = [UxpCapture]::GetSystemMetrics(77)
$screenRight = $screenLeft + [UxpCapture]::GetSystemMetrics(78)
$screenBottom = $screenTop + [UxpCapture]::GetSystemMetrics(79)
# Topmost first, as EnumWindows lists them.
$shown = @()
$left = $screenRight; $top = $screenBottom; $right = $screenLeft; $bottom = $screenTop
foreach ($window in [UxpCapture]::WindowsOf($ProcessId)) {
    $r = New-Object UxpCapture+RECT
    [void][UxpCapture]::GetWindowRect($window, [ref]$r)
    if (($r.Right - $r.Left) -lt 4 -or ($r.Bottom - $r.Top) -lt 4) { continue }
    $shown += ,@($window, $r)
    $left = [Math]::Min($left, $r.Left); $top = [Math]::Min($top, $r.Top)
    $right = [Math]::Max($right, $r.Right); $bottom = [Math]::Max($bottom, $r.Bottom)
}
$left = [Math]::Max($left, $screenLeft); $top = [Math]::Max($top, $screenTop)
$right = [Math]::Min($right, $screenRight); $bottom = [Math]::Min($bottom, $screenBottom)
$bitmap = New-Object System.Drawing.Bitmap ($right - $left), ($bottom - $top)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.Clear([System.Drawing.Color]::FromArgb(255, 255, 0, 255))
for ($i = $shown.Count - 1; $i -ge 0; $i--) {
    $window = $shown[$i][0]; $r = $shown[$i][1]
    $part = New-Object System.Drawing.Bitmap ($r.Right - $r.Left), ($r.Bottom - $r.Top)
    $partGraphics = [System.Drawing.Graphics]::FromImage($part)
    # GWL_EXSTYLE & WS_EX_LAYERED
    if (([UxpCapture]::GetWindowLong($window, -20) -band 0x80000) -ne 0) {
        if ([UxpCapture]::Shows($ProcessId, $r)) {
            $partGraphics.CopyFromScreen($r.Left, $r.Top, 0, 0, $part.Size)
        } else {
            $partGraphics.Clear([System.Drawing.Color]::FromArgb(255, 255, 0, 255))
            Write-Output 'occluded'
        }
    } else {
        $hdc = $partGraphics.GetHdc()
        # PW_RENDERFULLCONTENT: what DirectComposition shows, too.
        [void][UxpCapture]::PrintWindow($window, $hdc, 2)
        $partGraphics.ReleaseHdc($hdc)
    }
    $partGraphics.Dispose()
    $graphics.DrawImage($part, $r.Left - $left, $r.Top - $top)
    $part.Dispose()
}
$bitmap.Save($OutFile, [System.Drawing.Imaging.ImageFormat]::Png)
