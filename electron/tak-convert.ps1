<#
  tak-convert.ps1 — converts an OptiTrack Motive take (.tak) with the Motive
  installed on this PC, through its NMotive API. Nothing from Motive is bundled
  with Hand Tracker: without Motive installed this reports MOTIVE_NOT_FOUND.

  powershell -NoProfile -ExecutionPolicy Bypass -File tak-convert.ps1 `
      -Take <file.tak> -OutDir <folder> [-Formats c3d,csv,trc,fbx,bvh] [-InfoOnly]

  Prints one line of JSON: { ok, motiveVersion, name, frameRate, frameCount, markers,
  rigidBodies, skeletons, outputs: [{ format, ok, path, message }] } or { ok: false, error }.
#>
param(
  [Parameter(Mandatory = $true)][string]$Take,
  [Parameter(Mandatory = $true)][string]$OutDir,
  [string]$Formats = "c3d",
  [switch]$InfoOnly
)
$ErrorActionPreference = "Stop"

function Emit($obj) {
  [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress -Depth 5))
}

function Find-Motive {
  $key = "HKLM:\SOFTWARE\NaturalPoint\Optitrack\InstallLocation"
  $dir = (Get-ItemProperty -Path $key -ErrorAction SilentlyContinue).'(default)'
  foreach ($candidate in @($dir, "C:\Program Files\OptiTrack\Motive")) {
    if ($candidate -and (Test-Path (Join-Path $candidate "MotiveBatchProcessor\NMotive.dll"))) { return $candidate.TrimEnd("\") }
  }
  return $null
}

try {
  $motive = Find-Motive
  if (-not $motive) { throw "MOTIVE_NOT_FOUND" }
  $mbp = Join-Path $motive "MotiveBatchProcessor"
  # NMotive needs its Qt/OpenCV DLLs and Qt's platform plugin from the batch processor folder.
  $env:PATH = "$mbp;$motive;$env:PATH"
  $env:QT_PLUGIN_PATH = $mbp
  $env:QT_QPA_PLATFORM_PLUGIN_PATH = Join-Path $mbp "platforms"
  [Environment]::CurrentDirectory = $mbp
  Set-Location $mbp
  Add-Type -Path (Join-Path $mbp "NMotive.dll")
  $version = (Get-Item (Join-Path $motive "Motive.exe") -ErrorAction SilentlyContinue).VersionInfo.ProductVersion

  New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
  # NMotive opens takes for writing, so it works on a copy: the original may be
  # read-only (e.g. under Program Files) or open in Motive.
  $work = Join-Path $OutDir ("source-" + [IO.Path]::GetFileName($Take))
  Copy-Item -LiteralPath $Take -Destination $work -Force
  $t = New-Object NMotive.Take($work)
  $scene = $t.Scene
  $skeletons = $scene.AllSkeletons()
  $base = [IO.Path]::GetFileNameWithoutExtension($Take)
  $start = $t.FullFrameRange.Start
  $end = $t.FullFrameRange.End

  $outputs = @()
  $wanted = @($Formats.Split(",") | ForEach-Object { $_.Trim().ToLower() } | Where-Object { $_ })
  if (-not $InfoOnly) {
    # CSV, FBX and BVH need solved rigid-body/skeleton data. Solving changes only
    # the working copy, never the original take.
    $solveError = $null
    if (@($wanted | Where-Object { $_ -in @("csv", "fbx", "bvh") }).Count -gt 0) {
      try { $null = $t.Solve() } catch { $solveError = $_.Exception.GetBaseException().Message }
    }
    foreach ($format in $wanted) {
      $path = Join-Path $OutDir "$base.$format"
      try {
        switch ($format) {
          "c3d" {
            # Z-up, millimetres: the usual C3D lab convention (OptiTrack's own example axes).
            $e = New-Object NMotive.C3DExporter
            $e.Units = [NMotive.LengthUnits]::Units_Millimeters
            $e.MarkerNameSyntax = [NMotive.C3DExporter+C3DMarkerNameSyntax]::Underscore
            $e.WriteUnlabeledMarkers = $true
            $e.UseZeroBasedFrameIndex = $true
            $e.XAxis = [NMotive.Axis]::Axis_NegativeX
            $e.YAxis = [NMotive.Axis]::Axis_PositiveZ
            $e.ZAxis = [NMotive.Axis]::Axis_PositiveY
          }
          "csv" {
            $e = New-Object NMotive.CSVExporter
            $e.Units = [NMotive.LengthUnits]::Units_Millimeters
            $e.RotationType = [NMotive.Rotation]::QuaternionFormat
            $e.WriteHeader = $true
            $e.WriteMarkers = $true
            $e.WriteRigidBodies = $true
            $e.WriteRigidBodyMarkers = $true
            $e.WriteBones = $true
            $e.WriteBoneMarkers = $true
          }
          "trc" {
            $e = New-Object NMotive.TRCExporter
            $e.Units = [NMotive.LengthUnits]::Units_Millimeters
          }
          "fbx" {
            $e = New-Object NMotive.FBXBinaryExporter
            $e.Units = [NMotive.LengthUnits]::Units_Centimeters
            $e.WriteMarkerNulls = $true
          }
          "bvh" {
            if ($skeletons.Count -eq 0) { throw "BVH needs a skeleton, and this take has none." }
            $e = New-Object NMotive.BVHExporter
            $e.Units = [NMotive.LengthUnits]::Units_Centimeters
            $e.SkeletonName = $skeletons[0].Name
          }
          default { throw "Unknown format '$format'." }
        }
        $e.StartFrame = $start
        $e.EndFrame = $end
        $r = $e.Export($t, $path, $true)
        $ok = [bool]$r.Success -and (Test-Path $path) -and ((Get-Item $path).Length -gt 0)
        $message = "$($r.Message)"
        if (-not $ok -and $solveError) { $message = "$message (solving the take failed: $solveError)" }
        $outputs += @{ format = $format; ok = $ok; path = $path; message = $message }
      } catch {
        $outputs += @{ format = $format; ok = $false; path = $path; message = $_.Exception.GetBaseException().Message }
      }
      # Don't leave empty or partial files behind.
      if (-not $outputs[-1].ok) { Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue }
    }
  }

  $info = @{
    ok = $true
    motiveVersion = "$version"
    name = $base
    frameRate = [double]$t.FrameRate
    frameCount = [int]($end - $start + 1)
    markers = [int]$scene.AllMarkers().Count
    rigidBodies = [int]$scene.AllRigidBodies().Count
    skeletons = [int]$skeletons.Count
    outputs = $outputs
  }
  $t.Dispose()
  Remove-Item -LiteralPath $work -Force -ErrorAction SilentlyContinue
  Emit $info
} catch {
  Emit @{ ok = $false; error = $_.Exception.GetBaseException().Message }
  exit 1
}
