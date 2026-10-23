const fs = require('node:fs')
const path = require('node:path')
const { execFile } = require('node:child_process')
exports.accept = (ctx, destination) => {
  const helper = path.join(ctx.temporary, 'save-dialog.ps1')
  fs.writeFileSync(helper, `param([int]$TargetPid, [string]$Destination)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class OwnedDialog {
  public delegate bool Visit(IntPtr hwnd, IntPtr data);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, Visit callback, IntPtr data);
  [DllImport("user32.dll")] public static extern int GetDlgCtrlID(IntPtr hwnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hwnd, StringBuilder value, int count);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr hwnd, uint message, IntPtr parameter, string value);
}
"@
$deadline = [DateTime]::UtcNow.AddSeconds(18)
while ([DateTime]::UtcNow -lt $deadline) {
  $condition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $TargetPid)
  $windows = [System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $condition)
  foreach ($window in $windows) {
    if ($window.Current.ClassName -ne '#32770') { continue }
    $editCondition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty, '1001')
    $fields = New-Object System.Collections.Generic.List[System.IntPtr]
    $buttons = New-Object System.Collections.Generic.List[System.IntPtr]
    $visitor = [OwnedDialog+Visit] {
      param($handle, $unused)
      $className = New-Object System.Text.StringBuilder 256
      [void][OwnedDialog]::GetClassName($handle, $className, 256)
      $id = [OwnedDialog]::GetDlgCtrlID($handle)
      if ($className.ToString() -eq 'Edit') { Write-Output ('EDIT_ID: ' + $id) | Out-Null; $fields.Add($handle) }
      if ($className.ToString() -eq 'Button' -and $id -eq 1) { $buttons.Add($handle) }
      return $true
    }
    [void][OwnedDialog]::EnumChildWindows([IntPtr]$window.Current.NativeWindowHandle, $visitor, [IntPtr]::Zero)
    $edit = $fields | Where-Object { [OwnedDialog]::GetDlgCtrlID($_) -eq 1001 } | Select-Object -First 1
    if ($edit -and $buttons.Count -gt 0) {
      [void][OwnedDialog]::SendMessage($edit, 12, [IntPtr]::Zero, $Destination)
      [void][OwnedDialog]::SendMessage($buttons[0], 245, [IntPtr]::Zero, $null)
      Start-Sleep -Seconds 2
      $remaining = [System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $condition)
      $dialogs = @($remaining | Where-Object { $_.Current.ClassName -eq '#32770' })
      if ($dialogs.Count -gt 0) {
        foreach ($owned in $dialogs) {
          Write-Output ('DIALOG: ' + $owned.Current.Name)
          foreach ($control in $owned.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) {
            if ($control.Current.ControlType.ProgrammaticName -in @('ControlType.Edit','ControlType.Button','ControlType.Text')) { Write-Output ($control.Current.AutomationId + ': ' + $control.Current.Name) }
          }
        }
        throw 'Native save dialog remains open after invocation'
      }
      Write-Output 'NATIVE_SAVE_DIALOG_ACCEPTED'
      exit 0
    }
  }
  Start-Sleep -Milliseconds 100
}
throw 'Owned native Save dialog controls not found'
`)

  return new Promise((resolve, reject) => execFile('powershell.exe', ['-NoProfile', '-File', helper, '-TargetPid', String(process.pid), '-Destination', destination], { windowsHide: true, timeout: 22000 }, (error, stdout, stderr) => error ? reject(new Error(stdout + stderr || error.message)) : resolve(stdout)))
}
