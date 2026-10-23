$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$proof = @{ ok = $false; reason = 'HELPER_FAILED' }
try {
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  if (-not [Environment]::UserInteractive) { throw 'UNSUPPORTED_PLATFORM' }
  try {
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
  } catch { throw 'UNSUPPORTED_PLATFORM' }
  Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
public static class HarnessDialog {
  public delegate bool Visit(IntPtr hwnd, IntPtr data);
  [DllImport("user32.dll")] public static extern bool EnumThreadWindows(uint thread, Visit visit, IntPtr data);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, Visit visit, IntPtr data);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hwnd, uint relation);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool IsChild(IntPtr parent, IntPtr child);
  [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern int GetDlgCtrlID(IntPtr hwnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder value, int count);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessageTimeout(IntPtr hwnd, uint message, IntPtr wparam, string value, uint flags, uint timeout, out IntPtr result);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hwnd, uint message, IntPtr wparam, IntPtr lparam);
  [DllImport("user32.dll")] public static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
  [DllImport("user32.dll")] public static extern bool CloseDesktop(IntPtr desktop);
  public static string Class(IntPtr hwnd) { var text = new StringBuilder(256); GetClassName(hwnd, text, text.Capacity); return text.ToString(); }
  public static uint Pid(IntPtr hwnd) { uint pid; GetWindowThreadProcessId(hwnd, out pid); return pid; }
  public static IntPtr[] Windows(int pid) {
    var result = new List<IntPtr>();
    Visit visit = (hwnd, data) => { result.Add(hwnd); return true; };
    using (var process = Process.GetProcessById(pid)) foreach (ProcessThread thread in process.Threads) EnumThreadWindows((uint)thread.Id, visit, IntPtr.Zero);
    return result.ToArray();
  }
  public static IntPtr[] Controls(IntPtr parent, string className, int id) {
    var result = new List<IntPtr>();
    Visit visit = (hwnd, data) => { if (Class(hwnd) == className && (id < 0 || GetDlgCtrlID(hwnd) == id)) result.Add(hwnd); return true; };
    EnumChildWindows(parent, visit, IntPtr.Zero);
    return result.ToArray();
  }
}
'@
  $desktop = [HarnessDialog]::OpenInputDesktop(0, $false, 1)
  if ($desktop -eq [IntPtr]::Zero) { throw 'UNSUPPORTED_PLATFORM' }
  [void][HarnessDialog]::CloseDesktop($desktop)
  $targetPid = [int]$request.pid
  $owner = [IntPtr][long]::Parse($request.owner)
  if (-not [HarnessDialog]::IsWindow($owner) -or [HarnessDialog]::Pid($owner) -ne $targetPid) { throw 'OWNER_MISMATCH' }
  if ($request.type -notin @('OPEN','SAVE') -or $request.action -notin @('CONFIRM','CANCEL') -or $request.timeout -lt 500 -or $request.timeout -gt 15000) { throw 'HELPER_FAILED' }
  $root = [IO.Path]::GetFullPath($request.root).TrimEnd('\')
  $target = [IO.Path]::GetFullPath($request.target)
  if ($root.StartsWith('\\') -or $target.StartsWith('\\') -or [IO.Path]::GetDirectoryName($target) -cne $root -or $target.Substring(2).Contains(':')) { throw 'HELPER_FAILED' }
  foreach ($candidate in @($root, $target)) {
    if ((Test-Path -LiteralPath $candidate) -and ((Get-Item -LiteralPath $candidate -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'HELPER_FAILED' }
  }
  $proof.pid = $targetPid
  $proof.owner = $request.owner
  $deadline = [DateTime]::UtcNow.AddMilliseconds($request.timeout)
  $dialog = [IntPtr]::Zero
  while ([DateTime]::UtcNow -lt $deadline) {
    if (-not [HarnessDialog]::IsWindow($owner) -or [HarnessDialog]::Pid($owner) -ne $targetPid) { throw 'OWNER_MISMATCH' }
    $matches = @([HarnessDialog]::Windows($targetPid) | Where-Object { [HarnessDialog]::Class($_) -eq '#32770' -and [HarnessDialog]::IsWindowVisible($_) -and [HarnessDialog]::GetWindow($_, 4) -eq $owner -and [HarnessDialog]::Pid($_) -eq $targetPid })
    if ($matches.Count -gt 1) { throw 'OWNER_MISMATCH' }
    if ($matches.Count -eq 1) { $dialog = $matches[0]; break }
    Start-Sleep -Milliseconds 75
  }
  if ($dialog -eq [IntPtr]::Zero) { throw 'DIALOG_NOT_FOUND' }
  $proof.dialog = $dialog.ToInt64().ToString()
  $proof.ownershipValidated = $true
  $proof.method = 'UIA'
  $proof.stage = 'LOCATE_CONTROLS'
  function Assert-Owner {
    if (-not [HarnessDialog]::IsWindow($dialog) -or [HarnessDialog]::Pid($dialog) -ne $targetPid -or [HarnessDialog]::GetWindow($dialog, 4) -ne $owner -or [HarnessDialog]::Pid($owner) -ne $targetPid) { throw 'OWNER_MISMATCH' }
  }
  function Assert-Fixture {
    $ancestor = $target
    while ($ancestor) {
      if ((Test-Path -LiteralPath $ancestor) -and ((Get-Item -LiteralPath $ancestor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'HELPER_FAILED' }
      $ancestor = [IO.Path]::GetDirectoryName($ancestor)
    }
    if ($request.action -eq 'CONFIRM') {
      if ($request.type -eq 'OPEN' -and -not [IO.File]::Exists($target)) { throw 'HELPER_FAILED' }
      if ($request.type -eq 'SAVE' -and (Test-Path -LiteralPath $target)) { throw 'HELPER_FAILED' }
    }
  }
  function Find-Control($element, $id) {
    $condition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty, $id)
    return $element.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)
  }
  $element = [System.Windows.Automation.AutomationElement]::FromHandle($dialog)
  $buttonId = if ($request.action -eq 'CANCEL') { '2' } else { '1' }
  $button = Find-Control $element $buttonId
  $field = Find-Control $element '1001'
  if (-not $field) { $field = Find-Control $element '1148' }
  $invoke = $null
  $value = $null
  $buttonHandle = if ($button) { [IntPtr]$button.Current.NativeWindowHandle } else { [IntPtr]::Zero }
  $uia = $button -and [HarnessDialog]::IsChild($dialog, $buttonHandle) -and [HarnessDialog]::GetDlgCtrlID($buttonHandle) -eq [int]$buttonId -and [HarnessDialog]::Class($buttonHandle) -eq 'Button' -and $button.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$invoke)
  if ($request.action -eq 'CANCEL') { $uia = $false }
  if ($request.action -eq 'CONFIRM') { $uia = $uia -and $field -and $field.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$value) }
  Assert-Owner
  Assert-Fixture
  if ($uia) {
    $proof.stage = 'UIA_VALUE'
    if ($request.action -eq 'CONFIRM') {
      if ($field.Current.ProcessId -ne $targetPid -or $value.Current.IsReadOnly) { throw 'CONTROL_UNAVAILABLE' }
      $value.SetValue($target)
    }
    Assert-Owner
    $proof.stage = 'UIA_INVOKE'
    if ($button.Current.ProcessId -ne $targetPid -or -not $button.Current.IsEnabled) { throw 'CONTROL_UNAVAILABLE' }
    $invoke.Invoke()
  } else {
    $proof.method = 'WIN32_CONTROL_ID'
    $proof.stage = 'WIN32_LOCATE'
    $buttons = @([HarnessDialog]::Controls($dialog, 'Button', [int]$buttonId))
    $fields = @([HarnessDialog]::Controls($dialog, 'Edit', 1001)) + @([HarnessDialog]::Controls($dialog, 'Edit', 1148))
    if ($buttons.Count -ne 1 -or ($request.action -eq 'CONFIRM' -and $fields.Count -ne 1)) { throw 'CONTROL_UNAVAILABLE' }
    $buttonHandle = $buttons[0]
    if (-not [HarnessDialog]::IsChild($dialog, $buttonHandle) -or [HarnessDialog]::Pid($buttonHandle) -ne $targetPid -or -not [HarnessDialog]::IsWindowEnabled($buttonHandle)) { throw 'CONTROL_UNAVAILABLE' }
    if ($request.action -eq 'CONFIRM') {
      $proof.stage = 'WIN32_VALUE'
      if (-not [HarnessDialog]::IsChild($dialog, $fields[0]) -or [HarnessDialog]::Pid($fields[0]) -ne $targetPid) { throw 'CONTROL_UNAVAILABLE' }
      $ignored = [IntPtr]::Zero
      if ([HarnessDialog]::SendMessageTimeout($fields[0], 12, [IntPtr]::Zero, $target, 2, 1000, [ref]$ignored) -eq [IntPtr]::Zero) { throw 'CONTROL_UNAVAILABLE' }
    }
    Assert-Owner
    $proof.stage = 'WIN32_INVOKE'
    if (-not [HarnessDialog]::PostMessage($buttonHandle, 245, [IntPtr]::Zero, [IntPtr]::Zero)) { throw 'CONTROL_UNAVAILABLE' }
  }
  $proof.stage = 'WAIT_CLOSED'
  while ([HarnessDialog]::IsWindow($dialog) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 75 }
  if ([HarnessDialog]::IsWindow($dialog)) {
    if ($request.action -eq 'CANCEL') { throw 'CANCEL_FAILED' }
    throw 'DIALOG_TIMEOUT'
  }
  $proof.ok = $true
  $proof.reason = $null
} catch {
  $allowed = @('UNSUPPORTED_PLATFORM','DIALOG_NOT_FOUND','OWNER_MISMATCH','CONTROL_UNAVAILABLE','DIALOG_TIMEOUT','CANCEL_FAILED','HELPER_FAILED')
  $reason = $_.Exception.Message
  if ($reason -in $allowed) { $proof.reason = $reason }
} finally {
  [Console]::WriteLine(($proof | ConvertTo-Json -Compress))
}
if (-not $proof.ok) { exit 1 }
