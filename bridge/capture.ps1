# Screen-captures the top-left corner of the WoW client window and decodes the
# WoWAI pixel strip (see Codec.lua in the addon). Prints one JSON line per
# new message to stdout. Started by bridge.js; can also be run by hand.
#
#   capture.ps1 -TestImage strip.png    decode a PNG once and exit (used by tests)

param(
  [int]$Cell = 4,
  [int]$Cells = 200,
  [int]$MaxRows = 48,
  [int]$IntervalMs = 50,
  [string]$ProcessName = "Wow",
  [string]$ClientFolder = "",
  [string]$TestImage = ""
)

$ErrorActionPreference = "Continue"
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class CapWin {
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
}
"@

function Emit($obj) {
  [Console]::Out.WriteLine((ConvertTo-Json -Compress -InputObject $obj))
  [Console]::Out.Flush()
}

# These rules match capture_x11.py and capture_mac.py. Only five magic cells
# are wholly known: the sixth also contains two message-ID bits.
$Profiles = @(@{ display = "robust"; cell = $Cell })
if ($Cell -ne 4) { $Profiles += @{ display = "robust"; cell = 4 } }
$Profiles += @{ display = "compact"; cell = 2 }, @{ display = "quiet"; cell = 2 }, @{ display = "quiet4"; cell = 4 }
$MagicCells = @(6, 1, 6, 1, 5)
$script:Hint = $null

function Calibration($bmp, [int]$ox, [int]$oy, [int]$size) {
  $samples = @(for ($i = 0; $i -lt 5; $i++) {
    $px = $bmp.GetPixel($ox + $i * $size + [int][Math]::Floor($size / 2), $oy + [int][Math]::Floor($size / 2))
    ,@([double]$px.R, [double]$px.G, [double]$px.B)
  })
  $levels = @()
  for ($ch = 0; $ch -lt 3; $ch++) {
    $bit = 1 -shl (2 - $ch)
    $low = @(); $high = @()
    for ($i = 0; $i -lt 5; $i++) {
      if ($MagicCells[$i] -band $bit) { $high += $samples[$i][$ch] }
      else { $low += $samples[$i][$ch] }
    }
    $lo = ($low | Measure-Object -Average).Average
    $hi = ($high | Measure-Object -Average).Average
    $separation = $hi - $lo
    if ($separation -lt 12 -or $lo -gt 128 -or $hi -ge 192) { return $null }
    $residual = [Math]::Max(4, [Math]::Min(12, $separation * 0.25))
    foreach ($v in $low) { if ([Math]::Abs($v - $lo) -gt $residual) { return $null } }
    foreach ($v in $high) { if ([Math]::Abs($v - $hi) -gt $residual) { return $null } }
    $levels += ,@($lo, $hi)
  }
  return ,$levels
}

function CellValue($bmp, [int]$c, [int]$r, [int]$ox, [int]$oy, [int]$size, $levels) {
  $half = [int][Math]::Floor($size / 2)
  $px = $bmp.GetPixel($ox + $c * $size + $half, $oy + $r * $size + $half)
  $channels = @($px.R, $px.G, $px.B)
  $value = 0
  for ($ch = 0; $ch -lt 3; $ch++) {
    $v = $channels[$ch]
    if ($null -eq $levels) { $on = $v -ge 128 }
    else {
      $lo, $hi = $levels[$ch]
      $on = $v -ge (($lo + $hi) / 2)
      $expected = if ($on) { $hi } else { $lo }
      if ([Math]::Abs($v - $expected) -gt [Math]::Max(10, [Math]::Min(24, ($hi - $lo) * 0.35))) { return $null }
    }
    if ($on) { $value = $value -bor (1 -shl (2 - $ch)) }
  }
  return $value
}

function Decode($bmp, [int]$ox, [int]$oy, [string]$display, [int]$size) {
  if ($ox + $Cells * $size -gt $bmp.Width -or $oy + $size -gt $bmp.Height) { return $null }
  $levels = $null
  if ($display -in @("quiet", "quiet4")) {
    $levels = Calibration $bmp $ox $oy $size
    if ($null -eq $levels) { return $null }
  }
  if ($null -eq $levels) {
    # Quiet can cross 128 under gamma, but its channel span stays small.
    $minimum = @(255, 255, 255); $maximum = @(0, 0, 0)
    for ($i = 0; $i -lt 5; $i++) {
      $px = $bmp.GetPixel($ox + $i * $size + [int][Math]::Floor($size / 2), $oy + [int][Math]::Floor($size / 2))
      $channels = @($px.R, $px.G, $px.B)
      for ($ch = 0; $ch -lt 3; $ch++) {
        $minimum[$ch] = [Math]::Min($minimum[$ch], $channels[$ch])
        $maximum[$ch] = [Math]::Max($maximum[$ch], $channels[$ch])
      }
    }
    if (($maximum[0] - $minimum[0]) -lt 96 -and ($maximum[1] - $minimum[1]) -lt 96 -and ($maximum[2] - $minimum[2]) -lt 96) { return $null }
  }
  $acc = 0; $nbits = 0
  $bytes = New-Object System.Collections.Generic.List[int]
  $needed = 6
  $total = $Cells * [Math]::Min($MaxRows, [Math]::Floor(($bmp.Height - $oy) / $size))
  for ($i = 0; $i -lt $total; $i++) {
    $v = CellValue $bmp ($i % $Cells) ([int][Math]::Floor($i / $Cells)) $ox $oy $size $levels
    if ($null -eq $v) { return $null }
    $acc = ($acc -shl 3) -bor $v
    $nbits += 3
    while ($nbits -ge 8) {
      $bytes.Add(($acc -shr ($nbits - 8)) -band 0xFF)
      $nbits -= 8
      $acc = $acc -band ((1 -shl $nbits) - 1)
      if ($bytes.Count -eq 2 -and ($bytes[0] -ne 0xC7 -or $bytes[1] -ne 0x1A)) { return $null }
      if ($bytes.Count -eq 6) {
        $len = ($bytes[4] * 256) + $bytes[5]
        $needed = 8 + $len
        if ($len -gt 3200 -or $needed -gt [Math]::Floor($total * 3 / 8)) { return @{ error = "length" } }
      }
      if ($bytes.Count -ge $needed) { break }
    }
    if ($bytes.Count -ge $needed) { break }
  }
  if ($bytes.Count -lt $needed) { return @{ error = "truncated" } }
  $len = ($bytes[4] * 256) + $bytes[5]
  $s1 = 0; $s2 = 0
  for ($k = 2; $k -lt (6 + $len); $k++) {
    $s1 = ($s1 + $bytes[$k]) % 255
    $s2 = ($s2 + $s1) % 255
  }
  if ($bytes[6 + $len] -ne $s1 -or $bytes[7 + $len] -ne $s2) { return @{ error = "checksum" } }
  $payload = New-Object byte[] $len
  for ($k = 0; $k -lt $len; $k++) { $payload[$k] = [byte]$bytes[6 + $k] }
  return @{ id = (($bytes[2] * 256) + $bytes[3]); text = [Text.Encoding]::UTF8.GetString($payload); display = $display }
}

function FindAndDecode($bmp) {
  $rejected = $null
  if ($null -ne $script:Hint) {
    $h = $script:Hint
    if ($h.display -in @("quiet", "quiet4")) {
      $endpoint = if ($h.cell -eq 2) { "compact" } else { "robust" }
      $msg = Decode $bmp $h.x $h.y $endpoint $h.cell
      if ($msg -and -not $msg.error) {
        $script:Hint = @{ x = $h.x; y = $h.y; display = $endpoint; cell = $h.cell }
        return $msg
      }
    }
    $msg = Decode $bmp $h.x $h.y $h.display $h.cell
    if ($msg -and -not $msg.error) { return $msg }
    $rejected = $msg
  }
  foreach ($profile in $Profiles) {
    for ($oy = 0; $oy -le 8; $oy++) {
      for ($ox = 0; $ox -le 8; $ox++) {
        if ($script:Hint -and $ox -eq $script:Hint.x -and $oy -eq $script:Hint.y -and $profile.display -eq $script:Hint.display -and $profile.cell -eq $script:Hint.cell) { continue }
        $msg = Decode $bmp $ox $oy $profile.display $profile.cell
        if ($msg -and -not $msg.error) {
          $script:Hint = @{ x = $ox; y = $oy; display = $profile.display; cell = $profile.cell }
          return $msg
        }
        if ($msg) { $rejected = $msg }
      }
    }
  }
  return $rejected
}

if ($TestImage -ne "") {
  # A directory decodes a sorted sequence using the same live origin/profile cache.
  $images = if (Test-Path -LiteralPath $TestImage -PathType Container) {
    @(Get-ChildItem -LiteralPath $TestImage -Filter "*.png" -File | Sort-Object Name | ForEach-Object { $_.FullName })
  } else { @($TestImage) }
  foreach ($image in $images) {
    $bmp = [System.Drawing.Bitmap]::FromFile($image)
    try { $msg = FindAndDecode $bmp }
    finally { $bmp.Dispose() }
    if ($msg) { Emit $msg } else { Emit @{ error = "no valid strip in image" } }
  }
  exit 0
}

[void][CapWin]::SetProcessDPIAware()

$lastId = -1
$lastWarn = [DateTime]::MinValue
$proc = $null
$w = $Cells * [Math]::Max($Cell, 4) + 8
$h = $MaxRows * [Math]::Max($Cell, 4) + 8
while ($true) {
  if (-not $proc -or $proc.HasExited) {
    # Retail's exe is also Wow.exe: skip a game running from another client folder.
    $proc = Get-Process $ProcessName -ErrorAction SilentlyContinue | Where-Object {
      $_.MainWindowHandle -ne 0 -and (-not $ClientFolder -or -not $_.Path -or (Split-Path -Leaf (Split-Path -Parent $_.Path)) -eq $ClientFolder)
    } | Select-Object -First 1
    if (-not $proc) {
      Emit @{ info = "waiting for $ProcessName window$(if ($ClientFolder) { " in $ClientFolder" })" }
      Start-Sleep -Seconds 3
      continue
    }
    Emit @{ info = "attached to '$($proc.MainWindowTitle)' (pid $($proc.Id))" }
  }
  $hwnd = $proc.MainWindowHandle
  if ([CapWin]::IsIconic($hwnd)) { Start-Sleep -Milliseconds 1000; continue }
  $pt = New-Object CapWin+POINT
  [void][CapWin]::ClientToScreen($hwnd, [ref]$pt)
  $bmp = New-Object System.Drawing.Bitmap $w, $h
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $ok = $true
  try { $g.CopyFromScreen($pt.X, $pt.Y, 0, 0, $bmp.Size) } catch { $ok = $false }
  $g.Dispose()
  if ($ok) {
    $msg = FindAndDecode $bmp
    if ($msg -and $msg.error) {
      # Magic matched but the frame didn't validate: say so, at most every 5 s.
      if (([DateTime]::Now - $lastWarn).TotalSeconds -ge 5) {
        $lastWarn = [DateTime]::Now
        Emit @{ warn = "strip seen but rejected: $($msg.error)" }
      }
    } elseif ($msg) {
      $key = "$($msg.display):$($msg.id):$($msg.text)"
      if ($key -ne $lastId) {
        $lastId = $key
        Emit $msg
      }
    }
  }
  $bmp.Dispose()
  Start-Sleep -Milliseconds $IntervalMs
}
