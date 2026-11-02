param([Parameter(Mandatory=$true)][string]$ProfilePath, [string]$ButtonName = '允许')
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$owned = Get-CimInstance Win32_Process -Filter "Name='chrome.exe' OR Name='msedge.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($ProfilePath) }
$rootElement = [System.Windows.Automation.AutomationElement]::RootElement
foreach ($process in $owned) {
  $condition = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ProcessIdProperty, [int]$process.ProcessId)
  $windows = $rootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $condition)
  foreach ($window in $windows) {
    $buttons = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button))
    foreach ($button in $buttons) {
      $name = $button.Current.Name
      if ($name -eq $ButtonName) {
        $button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
        Write-Output "INVOKED: $ButtonName"
        exit 0
      }
    }
  }
}
throw "No '$ButtonName' button found in the run-owned Chromium window."
