param([Parameter(Mandatory)][string]$Item, [Parameter(Mandatory)][int]$AppProcess, [string]$OverflowLabel)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class VaultTrayMouse {
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint x, uint y, uint data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool SetPhysicalCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr handle);
}
'@
[void][VaultTrayMouse]::SetThreadDpiAwarenessContext([IntPtr]::new(-4))
$root = [System.Windows.Automation.AutomationElement]::RootElement
$scope = [System.Windows.Automation.TreeScope]
$any = [System.Windows.Automation.Condition]::TrueCondition
function Get-TrayElements {
  $found = @()
  foreach ($w in $root.FindAll($scope::Children, $any)) {
    if ($w.Current.ClassName -notmatch 'Shell_(Secondary)?TrayWnd|NotifyIconOverflow|OverflowXaml|XamlExplorerHostIsland') { continue }
    $found += @($w.FindAll($scope::Descendants,$any))
  }
  return $found
}
function Find-Icon {
  Get-TrayElements | Where-Object {
    $_.Current.Name.Trim() -eq 'Sync Vault Dev' -and !$_.Current.IsOffscreen -and $_.Current.BoundingRectangle.Width -gt 0
  }
}
function Click-Element($e, $right) {
  $r = $e.Current.BoundingRectangle
  if ($r.IsEmpty -or $r.Width -le 0) { throw 'Menu entry has no visible bounds' }
  if (!$right -and $e.Current.IsEnabled) {
    $invoke = $null
    if ($e.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$invoke)) {
      $invoke.Invoke()
      return
    }
  }
  $point = [System.Windows.Point]::new($r.Left+$r.Width/2, $r.Top+$r.Height/2)
  $clickable = [System.Windows.Point]::new(0, 0)
  if ($e.TryGetClickablePoint([ref]$clickable)) { $point = $clickable }
  if (![VaultTrayMouse]::SetPhysicalCursorPos([int]$point.X,[int]$point.Y)) { throw 'Pointer unavailable' }
  Start-Sleep -Milliseconds 80
  if ($right) {
    $hit = [System.Windows.Automation.AutomationElement]::FromPoint($point)
    $hitClass = $hit.Current.ClassName
    while ($hit -and $hit.Current.Name.Trim() -ne 'Sync Vault Dev') {
      $hit = [System.Windows.Automation.TreeWalker]::RawViewWalker.GetParent($hit)
    }
    if (!$hit) { throw "QA tray icon is obscured at $point (class $hitClass)" }
  }
  $down = if ($right) {8} else {2}
  [VaultTrayMouse]::mouse_event($down,0,0,0,[UIntPtr]::Zero)
  Start-Sleep -Milliseconds 80
  [VaultTrayMouse]::mouse_event($down*2,0,0,0,[UIntPtr]::Zero)
}
$pointer = [System.Windows.Forms.Cursor]::Position
function Open-TrayMenu {
  $icons = @(Find-Icon)
  if (!$icons.Count) {
    $toggle = Get-TrayElements | Where-Object {
      $_.Current.ClassName -eq 'SystemTray.ChevronIconView' -or
      ($_.Current.AutomationId -eq 'SystemTrayIcon' -and $_.Current.Name -in @('Show hidden icons', $OverflowLabel))
    } | Select-Object -First 1
    if (!$toggle) { throw 'Tray overflow toggle is unavailable' }
    Click-Element $toggle $false
    for ($attempt=0; $attempt -lt 8; $attempt++) {
      Start-Sleep -Milliseconds 150
      $icons = @(Find-Icon)
      if ($icons.Count) { break }
    }
  }
  if ($icons.Count -ne 1) {
    $panels = @($root.FindAll($scope::Children,$any) | ForEach-Object { $_.Current.ClassName } |
      Where-Object { $_ -match 'Tray|Xaml|Overflow' })
    $qa = @(Get-TrayElements | Where-Object { $_.Current.Name -like '*Sync Vault Dev*' } |
      ForEach-Object { $_.Current.ClassName + ' [' + $_.Current.Name + '] offscreen=' + $_.Current.IsOffscreen + ' bounds=' + $_.Current.BoundingRectangle })
    throw "Expected one Sync Vault Dev tray icon, found $($icons.Count). Shell panels: $panels. QA entries: $qa"
  }
  $owner = $icons[0]
  $walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
  while ($owner -and $owner.Current.ClassName -notmatch 'OverflowXaml|NotifyIconOverflow|Shell_(Secondary)?TrayWnd') {
    $owner = $walker.GetParent($owner)
  }
  if ($owner -and $owner.Current.NativeWindowHandle) {
    [void][VaultTrayMouse]::SetForegroundWindow([IntPtr]::new($owner.Current.NativeWindowHandle))
  }
  Click-Element $icons[0] $true
}
try {
  Open-TrayMenu
  $match = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NameProperty,$Item)
  for ($attempt=0; $attempt -lt 15; $attempt++) {
    Start-Sleep -Milliseconds 100
    foreach ($w in $root.FindAll($scope::Children,$any)) {
      if ($w.Current.ProcessId -ne $AppProcess -and $w.Current.ClassName -notmatch '32768|Popup|Menu|Overflow|Shell_TrayWnd') { continue }
      $entry = $w.FindFirst($scope::Descendants,$match)
      if ($entry) { Click-Element $entry $false; return }
    }
  }
  $seen = @($root.FindAll($scope::Children,$any) | Where-Object {
    $_.Current.ProcessId -eq $AppProcess -or $_.Current.ClassName -match 'Menu|32768|Overflow'
  } | ForEach-Object { $_.Current.ClassName + ':' + $_.Current.ProcessId + ':' + $_.Current.Name })
  throw "Tray menu entry unavailable: $Item; visible popup classes: $seen"
} finally { [System.Windows.Forms.Cursor]::Position = $pointer }
