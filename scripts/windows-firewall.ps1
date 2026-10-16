param(
    [switch]$CheckOnly,
    [Parameter(Mandatory = $true)][string]$NodePath,
    [Parameter(Mandatory = $true)][ValidateRange(1, 65535)][int]$HttpPort,
    [Parameter(Mandatory = $true)][ValidateRange(1, 65535)][int]$DiscoveryPort
)

$ErrorActionPreference = 'Stop'
try {
    $rules = @(
        @{ Name = 'KosenChanbara.ScoreServer.HTTP'; Protocol = 'TCP'; Port = $HttpPort },
        @{ Name = 'KosenChanbara.ScoreServer.Discovery'; Protocol = 'UDP'; Port = $DiscoveryPort }
    )
    # A rejected Windows app prompt can leave explicit Block rules, which take
    # precedence over Allow. Only Windows-generated prompt rules for this exact
    # node.exe are disabled; administrator-defined Block rules are left alone.
    $promptBlocks = @(Get-NetFirewallApplicationFilter -Program $NodePath -ErrorAction SilentlyContinue |
        Get-NetFirewallRule | Where-Object {
            $_.Direction -eq 'Inbound' -and $_.Action -eq 'Block' -and
            $_.Enabled -eq 'True' -and $_.Name -match '^(TCP|UDP) Query User'
        })
    $ready = $promptBlocks.Count -eq 0
    foreach ($spec in $rules) {
        $rule = Get-NetFirewallRule -Name $spec.Name -ErrorAction SilentlyContinue
        if ($null -eq $rule) { $ready = $false; continue }
        $app = $rule | Get-NetFirewallApplicationFilter
        $port = $rule | Get-NetFirewallPortFilter
        $address = $rule | Get-NetFirewallAddressFilter
        if ($rule.Enabled -ne 'True' -or $rule.Direction -ne 'Inbound' -or
            $rule.Action -ne 'Allow' -or $rule.Profile -ne 'Any' -or
            $app.Program -ne $NodePath -or $port.Protocol -ne $spec.Protocol -or
            [string]$port.LocalPort -ne [string]$spec.Port -or
            [string]$address.RemoteAddress -ne 'LocalSubnet') { $ready = $false }
    }
    if ($CheckOnly) {
        if ($ready) { exit 0 }
        exit 10
    }
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Administrator privileges are required for the firewall helper.'
    }
    foreach ($spec in $rules) {
        $existing = Get-NetFirewallRule -Name $spec.Name -ErrorAction SilentlyContinue
        $parameters = @{
            Direction = 'Inbound'; Action = 'Allow'; Enabled = 'True'; Profile = 'Any'
            Program = $NodePath; Protocol = $spec.Protocol; LocalPort = $spec.Port
            RemoteAddress = 'LocalSubnet'; EdgeTraversalPolicy = 'Block'
        }
        if ($null -eq $existing) {
            New-NetFirewallRule -Name $spec.Name -DisplayName $spec.Name @parameters | Out-Null
        } else {
            $existing | Set-NetFirewallRule @parameters | Out-Null
        }
    }
    foreach ($rule in $promptBlocks) { $rule | Disable-NetFirewallRule | Out-Null }
    exit 0
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
