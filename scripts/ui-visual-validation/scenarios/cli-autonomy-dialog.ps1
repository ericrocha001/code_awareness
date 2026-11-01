$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class CliConsentOwner {
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hwnd, uint relation);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsChild(IntPtr parent, IntPtr child);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hwnd, uint message, IntPtr wparam, IntPtr lparam);
}
'@
try {
  $deadline = [DateTime]::UtcNow.AddSeconds(12)
  $observations = @()
  while ([DateTime]::UtcNow -lt $deadline) {
    $processCondition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, [int]$request.processId)
    $typeCondition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Window)
    $condition = New-Object System.Windows.Automation.AndCondition($processCondition, $typeCondition)
    $windows = [System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)
    foreach ($window in $windows) {
      $handle = [IntPtr]$window.Current.NativeWindowHandle
      $observations = @($observations + ($window.Current.Name + ':' + [CliConsentOwner]::GetWindow($handle, 4).ToInt64()) | Select-Object -Unique)
      if ([CliConsentOwner]::GetWindow($handle, 4).ToInt64() -ne [long]$request.owner) { continue }
      [uint32]$observedProcess = 0
      [void][CliConsentOwner]::GetWindowThreadProcessId($handle, [ref]$observedProcess)
      if ($observedProcess -ne [uint32]$request.processId -or [CliConsentOwner]::GetWindow($handle, 4).ToInt64() -ne [long]$request.owner) { throw 'OWNER_MISMATCH' }
      $elements = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
      $names = @($elements | ForEach-Object { $_.Current.Name })
      $content = $names -join "`n"
      foreach ($required in @($request.required)) {
        if (-not $content.Contains($required)) { throw 'INCOMPLETE_TRUST_DISCLOSURE' }
      }
      $expectedButton = [string]($request.button)
      $button = @($elements | Where-Object { $_.Current.Name -eq $expectedButton })
      if ($button.Count -ne 1) { throw ('CONSENT_BUTTON_UNAVAILABLE:' + $expectedButton + ':' + (($elements | Where-Object { $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button } | ForEach-Object { $_.Current.Name }) -join ',')) }
      $nativeButton = [IntPtr]$button[0].Current.NativeWindowHandle
      [uint32]$buttonProcess = 0
      [void][CliConsentOwner]::GetWindowThreadProcessId($nativeButton, [ref]$buttonProcess)
      if ($nativeButton -eq [IntPtr]::Zero -or $buttonProcess -ne [uint32]$request.processId -or -not [CliConsentOwner]::IsChild($handle, $nativeButton)) { throw 'CONSENT_BUTTON_OWNER_MISMATCH' }
      if (-not [CliConsentOwner]::PostMessage($nativeButton, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero)) { throw 'CONSENT_BUTTON_FAILED' }
      [Console]::Out.WriteLine('{"state":"ACCEPTED","ownerVerified":true,"disclosureVerified":true}')
      exit 0
    }
    Start-Sleep -Milliseconds 80
  }
  throw ('NATIVE_CONSENT_NOT_FOUND:' + ($observations -join ','))
} catch {
  [Console]::Out.WriteLine((@{ state = 'FAILED'; reason = $_.Exception.Message } | ConvertTo-Json -Compress))
  exit 1
}
