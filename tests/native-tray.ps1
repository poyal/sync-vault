param([Parameter(Mandatory)][string]$Item)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class VaultTrayMouse {
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint x, uint y, uint data, UIntPtr extra);
}
'@
$root = [System.Windows.Automation.AutomationElement]::RootElement
$scope = [System.Windows.Automation.TreeScope]
$any = [System.Windows.Automation.Condition]::TrueCondition
function Find-Icon {
  $found = @()
  foreach ($w in $root.FindAll($scope::Children, $any)) {
    if ($w.Current.ClassName -notin @('Shell_TrayWnd','Shell_SecondaryTrayWnd','NotifyIconOverflowWindow','TopLevelWindowForOverflowXamlIsland')) { continue }
    foreach ($e in $w.FindAll($scope::Descendants,$any)) {
      if ($e.Current.Name -eq 'Sync Vault Dev' -and !$e.Current.IsOffscreen -and $e.Current.BoundingRectangle.Width -gt 0) { $found += $e }
    }
  }
  return $found
}
function Click-Element($e, $right) {
  $r = $e.Current.BoundingRectangle
  if ($r.IsEmpty -or $r.Width -le 0) { throw 'Menu entry has no visible bounds' }
  [System.Windows.Forms.Cursor]::Position = [System.Drawing.Point]::new([int]($r.Left+$r.Width/2),[int]($r.Top+$r.Height/2))
  $down = if ($right) {8} else {2}
  [VaultTrayMouse]::mouse_event($down,0,0,0,[UIntPtr]::Zero)
  [VaultTrayMouse]::mouse_event($down*2,0,0,0,[UIntPtr]::Zero)
}
$pointer = [System.Windows.Forms.Cursor]::Position
try {
  $icons = @(Find-Icon)
  if (!$icons.Count) {
    $chevron = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ClassNameProperty,'SystemTray.ChevronIconView')
    $toggle = $root.FindFirst($scope::Descendants,$chevron)
    if (!$toggle) { throw 'Tray overflow toggle is unavailable' }
    Click-Element $toggle $false
    Start-Sleep -Milliseconds 450
    $icons = @(Find-Icon)
  }
  if ($icons.Count -ne 1) { throw "Expected exactly one Sync Vault Dev tray icon, found $($icons.Count)" }
  Click-Element $icons[0] $true
  $match = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NameProperty,$Item)
  for ($attempt=0; $attempt -lt 15; $attempt++) {
    Start-Sleep -Milliseconds 100
    foreach ($w in $root.FindAll($scope::Children,$any)) {
      if ($w.Current.ClassName -ne '#32768') { continue }
      $entry = $w.FindFirst($scope::Descendants,$match)
      if ($entry) { Click-Element $entry $false; return }
    }
  }
  throw "Tray menu entry unavailable: $Item"
} finally { [System.Windows.Forms.Cursor]::Position = $pointer }
